//! The Office engine pool (Epo 2026-10-07): engine calls run in child
//! processes of the server binary (`capy-collaboration engine`, [`serve`]),
//! bytes and JSON over pipes ([`frame`]). Two lanes, so exports and agent
//! work never queue behind saves (#11): `Save` (save effects, seeds for a
//! load, replica drops) and `Background` (exports, rebases, inspect, agent
//! commands, locate, assets). Within a lane a room's calls go to one process
//! (its XLSX replica stays warm there); a call without a room goes to the
//! least busy one. Each process runs one call at a time. A call that runs past
//! the timeout (120 s, officeRuntime's `CALL_TIMEOUT_MS`) kills its process;
//! a process that dies (a crash, an abort on its memory cap) or answers
//! garbage fails its call; both are transient (the same call may pass) and
//! the next call starts a new process. An engine refusal or a panic the
//! engines catch is an ordinary answer and keeps the process.

pub mod child;
pub mod frame;
pub mod office;

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::BufReader;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

pub use child::{Failure, FailureKind, serve, serve_with};
pub use frame::Frame;

/// officeRuntime.ts `CALL_TIMEOUT_MS`.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// A call this long or longer logs a `slow_office_call` line (Epo 2026-10-06).
pub const SLOW_OFFICE_CALL: Duration = Duration::from_secs(2);
/// The XLSX replica budget (Epo 2026-10-05), split evenly over the save
/// processes since a room's replica lives in its own process.
pub const OFFICE_REPLICA_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct PoolConfig {
    /// The engine process: the server binary and its `engine` subcommand.
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub save_processes: usize,
    pub background_processes: usize,
    pub call_timeout: Duration,
    /// The whole replica budget; each save process keeps its share.
    pub replica_budget_bytes: u64,
    /// RLIMIT_DATA per engine process on Linux; `None` sets no cap.
    pub memory_limit_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Lane {
    Save,
    Background,
}

/// A call that did not answer: officeRuntime.ts `OfficeEngineError`.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EngineError {
    /// The engine refused or failed the call; the same call fails again.
    #[error("{}", .0.message)]
    Refused(Failure),
    /// It timed out, or its process died or answered garbage: the same call
    /// may pass on a new process.
    #[error("{0}")]
    Transient(String),
}

impl EngineError {
    pub fn transient(&self) -> bool {
        matches!(self, EngineError::Transient(_))
    }
}

/// What the engine process measured for one call.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub cpu_ms: Option<f64>,
    pub run_ms: f64,
    pub rss: Option<u64>,
    pub peak_rss: Option<u64>,
    #[serde(default)]
    pub replicas: ReplicaCounters,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaCounters {
    pub replicas: u64,
    pub replica_bytes: u64,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

/// An answered call.
#[derive(Debug)]
pub struct Reply {
    pub value: Value,
    pub blobs: Vec<Vec<u8>>,
    pub usage: Usage,
}

#[derive(Deserialize)]
struct OkAnswer {
    value: Value,
    usage: Usage,
}

#[derive(Deserialize)]
struct ErrorAnswer {
    kind: FailureKind,
    message: String,
    usage: Usage,
}

struct Job {
    request: Frame,
    room: Option<String>,
    queued_at: Instant,
    reply: oneshot::Sender<Result<Reply, EngineError>>,
}

/// One interval of a lane for `collab_health` (officeRuntime's
/// takeOfficeStats, per lane, plus the process counts).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct LaneStats {
    pub processes: usize,
    pub restarts: u64,
    pub crashes: u64,
    pub timeouts: u64,
    pub queue: usize,
    pub queue_max: usize,
    pub calls: usize,
    pub busy_ms: u64,
    pub run_max_ms: u64,
    pub run_p95_ms: u64,
    pub wait_max_ms: u64,
    pub wait_p95_ms: u64,
    pub replicas: u64,
    pub replica_mib: u64,
    pub replica_hits: u64,
    pub replica_misses: u64,
    pub replica_evictions: u64,
    /// The engine processes' resident memory at their last answers.
    pub rss_mib: u64,
}

#[derive(Default)]
struct Interval {
    runs: Vec<f64>,
    waits: Vec<f64>,
    busy_ms: f64,
    queue_max: usize,
    timeouts: u64,
    crashes: u64,
    restarts: u64,
}

#[derive(Default)]
struct ProcessState {
    rss: u64,
    /// Replica counters as last reported, and as of the last summary.
    reported: ReplicaCounters,
    counted: ReplicaCounters,
}

struct LaneShared {
    interval: Mutex<Interval>,
    processes: Vec<Mutex<ProcessState>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding a stats lock leaves plain numbers behind.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct ProcessHandle {
    jobs: mpsc::UnboundedSender<Job>,
    /// Calls queued and not yet started.
    depth: Arc<AtomicUsize>,
    alive: Arc<AtomicBool>,
}

struct LaneHandle {
    processes: Vec<ProcessHandle>,
    shared: Arc<LaneShared>,
}

pub struct EnginePool {
    save: LaneHandle,
    background: LaneHandle,
}

impl EnginePool {
    /// Starts the lanes' supervisors (processes start on their first call).
    /// Needs a tokio runtime.
    pub fn new(config: PoolConfig) -> Self {
        let budget = config.replica_budget_bytes / config.save_processes.max(1) as u64;
        Self {
            save: LaneHandle::start("save", config.save_processes, budget, &config),
            background: LaneHandle::start("background", config.background_processes, 0, &config),
        }
    }

    fn lane(&self, lane: Lane) -> &LaneHandle {
        match lane {
            Lane::Save => &self.save,
            Lane::Background => &self.background,
        }
    }

    /// Runs one call on `lane`, on `room`'s process when it names one.
    pub async fn call(
        &self,
        lane: Lane,
        room: Option<&str>,
        request: Frame,
    ) -> Result<Reply, EngineError> {
        let lane = self.lane(lane);
        let index = match room {
            Some(room) => affinity(room, lane.processes.len()),
            None => lane.least_busy(),
        };
        let process = &lane.processes[index];
        let (reply, answer) = oneshot::channel();
        let depth = process.depth.fetch_add(1, Ordering::Relaxed) + 1;
        {
            let mut interval = lock(&lane.shared.interval);
            interval.queue_max = interval.queue_max.max(lane.queued().max(depth));
        }
        let job = Job {
            request,
            room: room.map(str::to_owned),
            queued_at: Instant::now(),
            reply,
        };
        if process.jobs.send(job).is_err() {
            process.depth.fetch_sub(1, Ordering::Relaxed);
            return Err(EngineError::Transient("Office engine pool stopped".into()));
        }
        answer
            .await
            .unwrap_or_else(|_| Err(EngineError::Transient("Office engine pool stopped".into())))
    }

    /// Whether `room`'s save process is running (it holds the room's replica).
    pub fn holds_room(&self, room: &str) -> bool {
        let lane = &self.save;
        lane.processes[affinity(room, lane.processes.len())]
            .alive
            .load(Ordering::Relaxed)
    }

    /// This interval's summary per lane; the next interval starts empty.
    pub fn take_stats(&self) -> (LaneStats, LaneStats) {
        (self.save.take_stats(), self.background.take_stats())
    }
}

impl LaneHandle {
    fn start(name: &'static str, count: usize, replica_budget: u64, config: &PoolConfig) -> Self {
        let count = count.max(1);
        let shared = Arc::new(LaneShared {
            interval: Mutex::new(Interval::default()),
            processes: (0..count)
                .map(|_| Mutex::new(ProcessState::default()))
                .collect(),
        });
        let processes = (0..count)
            .map(|index| {
                let (jobs, receiver) = mpsc::unbounded_channel();
                let handle = ProcessHandle {
                    jobs,
                    depth: Arc::new(AtomicUsize::new(0)),
                    alive: Arc::new(AtomicBool::new(false)),
                };
                let supervisor = Supervisor {
                    lane: name,
                    index,
                    config: config.clone(),
                    replica_budget,
                    depth: handle.depth.clone(),
                    alive: handle.alive.clone(),
                    shared: shared.clone(),
                    running: None,
                };
                tokio::spawn(supervisor.run(receiver));
                handle
            })
            .collect();
        Self { processes, shared }
    }

    fn queued(&self) -> usize {
        self.processes
            .iter()
            .map(|process| process.depth.load(Ordering::Relaxed))
            .sum()
    }

    fn least_busy(&self) -> usize {
        (0..self.processes.len())
            .min_by_key(|&index| self.processes[index].depth.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    fn take_stats(&self) -> LaneStats {
        let mut interval = lock(&self.shared.interval);
        let taken = std::mem::take(&mut *interval);
        let queue = self.queued();
        interval.queue_max = queue;
        drop(interval);
        let mut stats = LaneStats {
            processes: self
                .processes
                .iter()
                .filter(|process| process.alive.load(Ordering::Relaxed))
                .count(),
            restarts: taken.restarts,
            crashes: taken.crashes,
            timeouts: taken.timeouts,
            queue,
            queue_max: taken.queue_max,
            calls: taken.runs.len(),
            busy_ms: taken.busy_ms.round() as u64,
            run_max_ms: max_ms(&taken.runs),
            run_p95_ms: p95_ms(taken.runs),
            wait_max_ms: max_ms(&taken.waits),
            wait_p95_ms: p95_ms(taken.waits),
            ..LaneStats::default()
        };
        let mut rss = 0;
        let mut replica_bytes = 0;
        for process in &self.shared.processes {
            let mut process = lock(process);
            rss += process.rss;
            let (now, then) = (process.reported, process.counted);
            stats.replicas += now.replicas;
            replica_bytes += now.replica_bytes;
            stats.replica_hits += now.hits.saturating_sub(then.hits);
            stats.replica_misses += now.misses.saturating_sub(then.misses);
            stats.replica_evictions += now.evictions.saturating_sub(then.evictions);
            process.counted = now;
        }
        stats.rss_mib = rss >> 20;
        stats.replica_mib = replica_bytes >> 20;
        stats
    }
}

fn max_ms(values: &[f64]) -> u64 {
    values.iter().copied().fold(0.0, f64::max).round() as u64
}

fn p95_ms(mut values: Vec<f64>) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_by(f64::total_cmp);
    let at = ((0.95 * values.len() as f64).ceil() as usize).clamp(1, values.len()) - 1;
    values[at].round() as u64
}

/// A room's process in a lane of `count`: stable for the room's life and
/// across restarts (FNV-1a of its name).
fn affinity(room: &str, count: usize) -> usize {
    let hash = room.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    });
    (hash % count.max(1) as u64) as usize
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// Owns one engine process slot: runs its calls in order, starts the process
/// on demand and replaces it after a timeout or a death.
struct Supervisor {
    lane: &'static str,
    index: usize,
    config: PoolConfig,
    replica_budget: u64,
    depth: Arc<AtomicUsize>,
    alive: Arc<AtomicBool>,
    shared: Arc<LaneShared>,
    running: Option<Running>,
}

enum Outcome {
    Answer(Frame),
    TimedOut,
    Died(String),
}

impl Supervisor {
    async fn run(mut self, mut jobs: mpsc::UnboundedReceiver<Job>) {
        while let Some(job) = jobs.recv().await {
            self.depth.fetch_sub(1, Ordering::Relaxed);
            let result = self.handle(&job).await;
            let _ = job.reply.send(result);
        }
        self.stop().await;
    }

    fn spawn(&self) -> std::io::Result<Running> {
        let mut command = Command::new(&self.config.program);
        command
            .args(&self.config.args)
            .env(child::ENV_REPLICA_BUDGET, self.replica_budget.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if let Some(limit) = self.config.memory_limit_bytes {
            command.env(child::ENV_MEMORY_LIMIT, limit.to_string());
        }
        let mut child = command.spawn()?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(std::io::Error::other("engine process without pipes"));
        };
        Ok(Running {
            child,
            stdin,
            stdout: BufReader::with_capacity(1 << 16, stdout),
        })
    }

    async fn handle(&mut self, job: &Job) -> Result<Reply, EngineError> {
        let started = Instant::now();
        let method = job.request.head.clone();
        if self.running.is_none() {
            match self.spawn() {
                Ok(running) => {
                    self.running = Some(running);
                    self.alive.store(true, Ordering::Relaxed);
                    *lock(&self.shared.processes[self.index]) = ProcessState::default();
                }
                Err(error) => {
                    return Err(EngineError::Transient(format!(
                        "Office engine process failed to start: {error}"
                    )));
                }
            }
        }
        let outcome = self.exchange(&job.request).await;
        let ran = started.elapsed();
        {
            let mut interval = lock(&self.shared.interval);
            interval.runs.push(ms(ran));
            interval.waits.push(ms(started - job.queued_at));
            interval.busy_ms += ms(ran);
            match outcome {
                Outcome::TimedOut => {
                    interval.timeouts += 1;
                    interval.restarts += 1;
                }
                Outcome::Died(_) => {
                    interval.crashes += 1;
                    interval.restarts += 1;
                }
                Outcome::Answer(_) => {}
            }
        }
        if ran >= SLOW_OFFICE_CALL {
            crate::observe::log(
                "warn",
                "slow_office_call",
                serde_json::json!({
                    // The byte arguments: the base, states, the exported file.
                    "bytes": job.request.blobs.iter().map(Vec::len).sum::<usize>(),
                    "lane": self.lane,
                    "method": method,
                    "ms": ran.as_millis() as u64,
                    "room": job.room,
                    "wait_ms": (started - job.queued_at).as_millis() as u64,
                }),
            );
        }
        match outcome {
            Outcome::Answer(frame) => match self.decode(frame) {
                Ok(result) => result,
                Err(garbage) => {
                    self.replace().await;
                    let mut interval = lock(&self.shared.interval);
                    interval.crashes += 1;
                    interval.restarts += 1;
                    Err(EngineError::Transient(garbage))
                }
            },
            Outcome::TimedOut => {
                self.replace().await;
                Err(EngineError::Transient(format!("Office {method} timed out")))
            }
            Outcome::Died(cause) => {
                let status = self.replace().await;
                Err(EngineError::Transient(format!(
                    "Office engine process exited ({}): {cause}",
                    status.unwrap_or_else(|| "unknown status".into())
                )))
            }
        }
    }

    async fn exchange(&mut self, request: &Frame) -> Outcome {
        let Some(running) = self.running.as_mut() else {
            return Outcome::Died("not running".into());
        };
        let exchange = async {
            request.write_async(&mut running.stdin).await?;
            Frame::read_async(&mut running.stdout).await
        };
        match tokio::time::timeout(self.config.call_timeout, exchange).await {
            Err(_) => Outcome::TimedOut,
            Ok(Ok(Some(frame))) => Outcome::Answer(frame),
            Ok(Ok(None)) => Outcome::Died("closed its pipe".into()),
            Ok(Err(error)) => Outcome::Died(error.to_string()),
        }
    }

    /// The answer, or why it is not one (the process is then replaced).
    fn decode(&self, frame: Frame) -> Result<Result<Reply, EngineError>, String> {
        let garbage = |error: serde_json::Error| format!("Office engine answered garbage: {error}");
        let (result, usage) = match frame.head.as_str() {
            "ok" => {
                let answer: OkAnswer = serde_json::from_slice(&frame.json).map_err(garbage)?;
                let usage = answer.usage.clone();
                (
                    Ok(Reply {
                        value: answer.value,
                        blobs: frame.blobs,
                        usage: answer.usage,
                    }),
                    usage,
                )
            }
            "error" => {
                let answer: ErrorAnswer = serde_json::from_slice(&frame.json).map_err(garbage)?;
                (
                    Err(EngineError::Refused(Failure {
                        kind: answer.kind,
                        message: answer.message,
                    })),
                    answer.usage,
                )
            }
            other => return Err(format!("Office engine answered garbage: head {other:?}")),
        };
        let mut process = lock(&self.shared.processes[self.index]);
        process.rss = usage.rss.unwrap_or(process.rss);
        process.reported = usage.replicas;
        Ok(result)
    }

    /// Ends the process (killing it if needed) and forgets its replicas; the
    /// next call starts a new one. The exit status, when known.
    async fn replace(&mut self) -> Option<String> {
        self.alive.store(false, Ordering::Relaxed);
        *lock(&self.shared.processes[self.index]) = ProcessState::default();
        let mut running = self.running.take()?;
        let _ = running.child.start_kill();
        running
            .child
            .wait()
            .await
            .ok()
            .map(|status| status.to_string())
    }

    async fn stop(&mut self) {
        if let Some(mut running) = self.running.take() {
            drop(running.stdin);
            // A clean end of stdin ends `serve`; a call still running is killed.
            if tokio::time::timeout(Duration::from_secs(5), running.child.wait())
                .await
                .is_err()
            {
                let _ = running.child.start_kill();
                let _ = running.child.wait().await;
            }
        }
        self.alive.store(false, Ordering::Relaxed);
    }
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}
