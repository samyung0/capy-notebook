//! The engine process: `capy-collaboration engine` runs [`serve`], which reads
//! one request frame at a time from stdin, runs it on this thread and writes
//! its answer to stdout. Nothing else may write to stdout (the frame magic
//! catches a stray print as a corrupt pipe); logs go to stderr.

use std::io::{self, BufReader, BufWriter};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::Instant;

use serde::Serialize;
use serde_json::{Value, json};

use super::frame::Frame;
use super::office;

/// Environment the pool sets on each engine process (never user config).
pub const ENV_REPLICA_BUDGET: &str = "CAPY_ENGINE_REPLICA_BUDGET";
pub const ENV_MEMORY_LIMIT: &str = "CAPY_ENGINE_MEMORY_LIMIT";

/// Why a call failed in the engine (office-service `Error`'s kinds).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FailureKind {
    Edit,
    Rebase,
    Invalid,
    Engine,
    Panic,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub kind: FailureKind,
    pub message: String,
}

impl Failure {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: FailureKind::Invalid,
            message: message.into(),
        }
    }
}

/// A call's result: a JSON value and byte results.
pub type Answer = Result<(Value, Vec<Vec<u8>>), Failure>;

/// The production engine process (Office engines over office-service).
pub fn serve() -> io::Result<()> {
    serve_with(office::dispatch)
}

/// Serves frames with `call` until stdin closes. A panic outside the engines'
/// own guard (in the glue) answers as an engine panic and keeps serving.
pub fn serve_with(mut call: impl FnMut(&Frame) -> Answer) -> io::Result<()> {
    apply_limits();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = BufReader::with_capacity(1 << 16, stdin.lock());
    let mut output = BufWriter::with_capacity(1 << 16, stdout.lock());
    while let Some(request) = Frame::read_from(&mut input)? {
        let cpu = cpu_time::ProcessTime::try_now().ok();
        let wall = Instant::now();
        let answer = catch_unwind(AssertUnwindSafe(|| call(&request))).unwrap_or_else(|panic| {
            Err(Failure {
                kind: FailureKind::Panic,
                message: panic
                    .downcast_ref::<&str>()
                    .map(|text| (*text).to_owned())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".into()),
            })
        });
        let usage = json!({
            "cpuMs": cpu.and_then(|cpu| cpu.try_elapsed().ok()).map(|cpu| cpu.as_secs_f64() * 1000.0),
            "runMs": wall.elapsed().as_secs_f64() * 1000.0,
            "rss": memory_stats::memory_stats().map(|memory| memory.physical_mem as u64),
            "peakRss": peak_rss(),
            "replicas": office::replica_stats_json(),
        });
        let frame = match answer {
            Ok((value, blobs)) => Frame::new(
                "ok",
                serde_json::to_vec(&json!({ "value": value, "usage": usage }))?,
                blobs,
            ),
            Err(failure) => Frame::new(
                "error",
                serde_json::to_vec(&json!({
                    "kind": failure.kind,
                    "message": failure.message,
                    "usage": usage,
                }))?,
                Vec::new(),
            ),
        };
        frame.write_to(&mut output)?;
    }
    Ok(())
}

/// The memory cap (Linux): RLIMIT_DATA, which since Linux 4.7 counts the heap
/// and private anonymous mappings (what engine allocations use), so an engine
/// past it fails its allocation and the process aborts; the pool answers that
/// call as transient and starts a new process. `oom_score_adj` 1000 makes an
/// engine process, not the server, the kernel's first choice when the
/// container's cgroup limit is reached. Elsewhere (Windows dev builds) no cap.
fn apply_limits() {
    #[cfg(target_os = "linux")]
    {
        if let Some(limit) = std::env::var(ENV_MEMORY_LIMIT)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
        {
            if let Err(error) = rlimit::setrlimit(rlimit::Resource::DATA, limit, limit) {
                tracing::warn!(%error, "engine memory limit not applied");
            }
        }
        if let Err(error) = std::fs::write("/proc/self/oom_score_adj", "1000") {
            tracing::warn!(%error, "engine oom_score_adj not applied");
        }
    }
}

/// The process's resident high-water mark (Linux VmHWM), when the OS keeps one.
fn peak_rss() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        let line = status.lines().find(|line| line.starts_with("VmHWM:"))?;
        let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kib * 1024)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}
