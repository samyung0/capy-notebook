//! The engine process pool against a real child process (the test engine:
//! the Office dispatcher plus misbehaving `test.*` methods).

#![allow(clippy::unwrap_used)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sources::engine::{EngineError, EnginePool, FailureKind, Frame, Lane, PoolConfig};

fn config(save: usize, background: usize) -> PoolConfig {
    PoolConfig {
        program: PathBuf::from(env!("CARGO_BIN_EXE_sources-test-engine")),
        args: Vec::new(),
        save_processes: save,
        background_processes: background,
        call_timeout: Duration::from_secs(20),
        replica_budget_bytes: 0,
        memory_limit_bytes: None,
    }
}

fn request(method: &str, args: Value) -> Frame {
    Frame::new(method, serde_json::to_vec(&args).unwrap(), Vec::new())
}

async fn pid(pool: &EnginePool, lane: Lane, room: Option<&str>) -> u64 {
    let reply = pool
        .call(lane, room, request("test.echo", json!({})))
        .await
        .unwrap();
    reply.value["pid"].as_u64().unwrap()
}

/// Two rooms that land on different processes of a two-process lane.
async fn two_rooms(pool: &EnginePool) -> (String, String) {
    let first = "source:f_0:epoch:1".to_owned();
    let home = pid(pool, Lane::Save, Some(&first)).await;
    for n in 1..64 {
        let other = format!("source:f_{n}:epoch:1");
        if pid(pool, Lane::Save, Some(&other)).await != home {
            return (first, other);
        }
    }
    panic!("no room landed on the second process");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_room_keeps_its_process_and_rooms_spread_over_the_lane() {
    let pool = EnginePool::new(config(2, 1));
    let room = "source:f_a:epoch:3";
    let first = pid(&pool, Lane::Save, Some(room)).await;
    for _ in 0..5 {
        assert_eq!(pid(&pool, Lane::Save, Some(room)).await, first);
    }
    let (a, b) = two_rooms(&pool).await;
    assert_ne!(
        pid(&pool, Lane::Save, Some(&a)).await,
        pid(&pool, Lane::Save, Some(&b)).await
    );
    // Bytes and JSON travel both ways unchanged.
    let blob: Vec<u8> = (0..=255).cycle().take(3 << 20).collect();
    let reply = pool
        .call(
            Lane::Save,
            Some(room),
            Frame::new(
                "test.echo",
                br#"{"k":"v"}"#.to_vec(),
                vec![blob.clone(), Vec::new()],
            ),
        )
        .await
        .unwrap();
    assert_eq!(reply.value["args"], json!({ "k": "v" }));
    assert_eq!(reply.blobs, vec![blob, Vec::new()]);
    assert!(reply.usage.rss.unwrap_or(1) > 0);
    assert!(pool.holds_room(room));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_rooms_run_in_parallel_and_exports_never_wait_behind_saves() {
    let pool = EnginePool::new(config(2, 1));
    let (a, b) = two_rooms(&pool).await;
    let sleep = |room: String| {
        let pool = &pool;
        async move {
            pool.call(
                Lane::Save,
                Some(&room),
                request("test.sleep", json!({ "ms": 800 })),
            )
            .await
            .unwrap()
        }
    };
    let started = Instant::now();
    let (one, two) = tokio::join!(sleep(a.clone()), sleep(b.clone()));
    assert_ne!(one.value["pid"], two.value["pid"]);
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "{:?}",
        started.elapsed()
    );

    // A save keeps room `a`'s process busy; an export for the same room runs
    // at once on the background lane, and a second save for `a` waits.
    let busy = pool.call(
        Lane::Save,
        Some(&a),
        request("test.sleep", json!({ "ms": 1500 })),
    );
    let export = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let started = Instant::now();
        pool.call(Lane::Background, Some(&a), request("test.echo", json!({})))
            .await
            .unwrap();
        started.elapsed()
    };
    let queued = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let started = Instant::now();
        pool.call(Lane::Save, Some(&a), request("test.echo", json!({})))
            .await
            .unwrap();
        started.elapsed()
    };
    let stats_probe = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        pool.take_stats()
    };
    let (busy, export, queued, (save, background)) =
        tokio::join!(busy, export, queued, stats_probe);
    busy.unwrap();
    assert!(
        export < Duration::from_millis(500),
        "export waited {export:?}"
    );
    assert!(
        queued > Duration::from_millis(1000),
        "save did not queue: {queued:?}"
    );
    assert_eq!(save.queue, 1);
    assert_eq!(save.processes, 2);
    // The export answered within the probe's interval, the saves after it.
    assert_eq!(background.calls, 1);
    let (save, _) = pool.take_stats();
    assert_eq!(save.calls, 2, "{save:?}");
    assert!(save.wait_max_ms >= 1000, "{save:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_fails_its_call_as_transient_and_only_that_process_restarts() {
    let pool = EnginePool::new(config(2, 1));
    let (a, b) = two_rooms(&pool).await;
    let (before_a, before_b) = (
        pid(&pool, Lane::Save, Some(&a)).await,
        pid(&pool, Lane::Save, Some(&b)).await,
    );
    let _ = pool.take_stats();
    for method in ["test.abort", "test.exit"] {
        let error = pool
            .call(Lane::Save, Some(&a), request(method, json!({})))
            .await
            .unwrap_err();
        assert!(error.transient(), "{error:?}");
        assert!(
            error
                .to_string()
                .starts_with("Office engine process exited"),
            "{error}"
        );
    }
    let after_a = pid(&pool, Lane::Save, Some(&a)).await;
    assert_ne!(after_a, before_a);
    assert_eq!(pid(&pool, Lane::Save, Some(&b)).await, before_b);
    let (save, _) = pool.take_stats();
    assert_eq!((save.crashes, save.restarts, save.timeouts), (2, 2, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_call_crashing_a_fresh_process_again_is_refused() {
    let pool = EnginePool::new(config(1, 1));
    let room = "source:f_c:epoch:1";
    let crash = |n: u64| request("test.abort", json!({ "n": n }));
    let first = pool
        .call(Lane::Save, Some(room), crash(1))
        .await
        .unwrap_err();
    assert!(first.transient(), "{first:?}");
    // The new process serves another call first, so the repeat gets its own.
    pid(&pool, Lane::Save, Some(room)).await;
    let _ = pool.take_stats();
    let second = pool
        .call(Lane::Save, Some(room), crash(1))
        .await
        .unwrap_err();
    assert!(
        matches!(&second, EngineError::Refused(failure) if failure.kind == FailureKind::Engine),
        "{second:?}"
    );
    // Another call that crashes is a first crash.
    let other = pool
        .call(Lane::Save, Some(room), crash(2))
        .await
        .unwrap_err();
    assert!(other.transient(), "{other:?}");
    let (save, _) = pool.take_stats();
    // The repeat's own process (a restart), its crash, the other's crash.
    assert_eq!((save.crashes, save.restarts), (2, 3), "{save:?}");
    // A call that passes after its crash is forgotten.
    let flaky = request("test.echo", json!({ "flaky": true }));
    pool.call(Lane::Save, Some(room), flaky).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_timed_out_call_kills_its_process_and_the_queue_moves_to_a_new_one() {
    let mut config = config(1, 1);
    config.call_timeout = Duration::from_millis(600);
    let pool = EnginePool::new(config);
    let room = "source:f_t:epoch:1";
    let before = pid(&pool, Lane::Save, Some(room)).await;
    let hung = pool.call(
        Lane::Save,
        Some(room),
        request("test.sleep", json!({ "ms": 30_000 })),
    );
    let queued = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        pool.call(Lane::Save, Some(room), request("test.echo", json!({})))
            .await
            .unwrap()
    };
    // The hung call fails as timed out (its sleep would answer after 30 s)
    // and the queued one runs on a new process.
    let (hung, queued) = tokio::join!(hung, queued);
    assert_eq!(
        hung.unwrap_err(),
        EngineError::Transient("Office test.sleep timed out".into())
    );
    assert_ne!(queued.value["pid"].as_u64().unwrap(), before);
    let (save, _) = pool.take_stats();
    assert_eq!((save.timeouts, save.restarts, save.crashes), (1, 1, 0));
}

/// `count` calls of `method` queued on `room`'s background process, each on
/// its own task.
fn queue(
    pool: &std::sync::Arc<EnginePool>,
    room: &str,
    method: &'static str,
    args: Value,
    count: usize,
) -> Vec<tokio::task::JoinHandle<Result<sources::engine::Reply, EngineError>>> {
    (0..count)
        .map(|_| {
            let (pool, room, args) = (pool.clone(), room.to_owned(), args.clone());
            tokio::spawn(async move {
                pool.call(Lane::Background, Some(&room), request(method, args))
                    .await
            })
        })
        .collect()
}

/// Waits until `ready` holds, polling every 5 ms for at most 10 s (review r1
/// L6: the pool's state, not fixed sleeps).
async fn settle(mut ready: impl FnMut() -> bool) {
    for _ in 0..2_000 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the pool never reached the state");
}

/// Whether `room`'s background process holds exactly `queued` calls not
/// started (`admit` reads that depth).
fn queued(pool: &EnginePool, room: &str, queued: usize) -> bool {
    pool.admit(Lane::Background, room, queued).is_err()
        && pool.admit(Lane::Background, room, queued + 1).is_ok()
}

/// Security regression (the background lane's bound for the agent's by-id
/// read, the Editor's calls 2026-10-24): a bounded read is busy once its
/// room's background process holds 4 queued calls, counted per process;
/// other calls queue past that and all run.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bounded_read_is_busy_at_four_queued_calls_and_others_still_run() {
    let pool = std::sync::Arc::new(EnginePool::new(config(1, 1)));
    let room = "source:f_q:epoch:1";
    pid(&pool, Lane::Background, Some(room)).await;
    // Two long calls, one running and one queued (tasks enqueue in any
    // order), then two more queued behind them.
    let mut calls = queue(&pool, room, "test.sleep", json!({ "ms": 5_000 }), 2);
    settle(|| queued(&pool, room, 1)).await;
    calls.extend(queue(&pool, room, "test.echo", json!({}), 2));
    settle(|| queued(&pool, room, 3)).await;
    pool.admit(Lane::Background, room, 4).unwrap();
    calls.extend(queue(&pool, room, "test.echo", json!({}), 1));
    settle(|| queued(&pool, room, 4)).await;
    assert_eq!(
        pool.admit(Lane::Background, room, 4).unwrap_err(),
        sources::engine::busy()
    );
    // The save lane and its own processes are not counted.
    pool.admit(Lane::Save, room, 4).unwrap();
    // Unbounded calls are never refused at any depth: a fifth queues and runs.
    calls.extend(queue(&pool, room, "test.echo", json!({}), 1));
    for call in calls {
        call.await.unwrap().unwrap();
    }
    pool.admit(Lane::Background, room, 4).unwrap();
}

/// Security regression (the by-id read's wait rule): a bounded call that
/// waited past its limit behind a long one answers busy without running,
/// and one whose caller is gone is skipped; an unbounded call that waited
/// as long still runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bounded_call_is_busy_after_its_wait_and_skipped_when_its_caller_is_gone() {
    let pool = std::sync::Arc::new(EnginePool::new(config(1, 1)));
    let room = "source:f_w:epoch:1";
    pid(&pool, Lane::Background, Some(room)).await;
    let _ = pool.take_stats();
    // Two long calls: once one is queued, every later call waits behind it.
    let long = queue(&pool, room, "test.sleep", json!({ "ms": 1_500 }), 2);
    settle(|| pool.admit(Lane::Background, room, 1).is_err()).await;
    let bounded = {
        let pool = pool.clone();
        tokio::spawn(async move {
            pool.call_bounded(
                Lane::Background,
                Some(room),
                request("test.echo", json!({})),
                Duration::from_millis(300),
            )
            .await
        })
    };
    // The caller gives up before the call would start.
    let abandoned = tokio::time::timeout(
        Duration::from_millis(100),
        pool.call_bounded(
            Lane::Background,
            Some(room),
            request("test.echo", json!({ "abandoned": true })),
            Duration::from_secs(60),
        ),
    )
    .await;
    assert!(abandoned.is_err());
    let unbounded = queue(&pool, room, "test.echo", json!({}), 1);
    assert_eq!(bounded.await.unwrap().unwrap_err(), sources::engine::busy());
    for call in long.into_iter().chain(unbounded) {
        call.await.unwrap().unwrap();
    }
    // The long sleeps and the unbounded echo ran; the busy and the skipped
    // calls did not.
    let (_, background) = pool.take_stats();
    assert_eq!(background.calls, 3, "{background:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn running_out_of_memory_aborts_only_that_process() {
    let mut config = config(1, 1);
    // Linux (CI): RLIMIT_DATA in the child makes the allocator fail, then
    // abort, before it holds 1 GiB (security regression: the engine memory
    // cap). Elsewhere the test engine aborts at 64 MiB by itself.
    config.memory_limit_bytes = Some(512 << 20);
    let pool = EnginePool::new(config);
    let room = "source:f_m:epoch:1";
    let before = pid(&pool, Lane::Save, Some(room)).await;
    let mib = if cfg!(target_os = "linux") { 1024 } else { 64 };
    let error = pool
        .call(
            Lane::Save,
            Some(room),
            request("test.allocate", json!({ "mib": mib })),
        )
        .await
        .unwrap_err();
    assert!(error.transient(), "{error:?}");
    assert_ne!(pid(&pool, Lane::Save, Some(room)).await, before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refusals_and_glue_panics_answer_and_keep_the_process() {
    let pool = EnginePool::new(config(1, 1));
    let room = "source:f_r:epoch:1";
    let before = pid(&pool, Lane::Save, Some(room)).await;
    let refused = pool
        .call(
            Lane::Save,
            Some(room),
            request("seedOffice", json!({ "format": "docx" })),
        )
        .await
        .unwrap_err();
    let EngineError::Refused(failure) = refused else {
        panic!("{refused:?}");
    };
    assert_eq!(failure.kind, FailureKind::Invalid);
    let panicked = pool
        .call(Lane::Save, Some(room), request("test.panic", json!({})))
        .await
        .unwrap_err();
    assert!(
        matches!(&panicked, EngineError::Refused(failure) if failure.kind == FailureKind::Panic && failure.message == "engine glue panicked"),
        "{panicked:?}"
    );
    assert!(!panicked.transient());
    assert_eq!(pid(&pool, Lane::Save, Some(room)).await, before);
    let (save, _) = pool.take_stats();
    assert_eq!((save.restarts, save.crashes), (0, 0));
}

/// Security regression (the Office engine sandbox, Epo 2026-10-20): an
/// engine keeps none of the server's environment, opens no network socket,
/// starts no process, execs nothing and cannot change its process group,
/// parent-death signal or dumpability while its threads still start, runs
/// with no_new_privs, seccomp, its limits and its own process group, holds
/// no descriptor it inherited, reads no file outside its own /proc entries,
/// and signals nothing and reaches no abstract Unix socket outside its
/// sandbox.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_engine_runs_inside_its_sandbox() {
    const EPERM: i64 = 1;
    const EACCES: i64 = 13;
    let outside = std::env::temp_dir().join(format!("capy-engine-reach-{}", std::process::id()));
    std::fs::write(&outside, b"outside the sandbox").unwrap();
    use std::os::linux::net::SocketAddrExt;
    let name = format!("capy-engine-reach-{}", std::process::id());
    let _listener = std::os::unix::net::UnixListener::bind_addr(
        &std::os::unix::net::SocketAddr::from_abstract_name(&name).unwrap(),
    )
    .unwrap();
    // A descriptor without close-on-exec, which the engine inherits.
    let inherited = nix::unistd::dup(std::fs::File::open(&outside).unwrap()).unwrap();
    let mut config = config(1, 1);
    config.memory_limit_bytes = Some(3 << 30);
    let pool = EnginePool::new(config);
    let reply = pool
        .call(
            Lane::Save,
            None,
            request("test.reach", json!({ "path": outside, "abstract": name })),
        )
        .await;
    drop(inherited);
    std::fs::remove_file(&outside).unwrap();
    let reach = reply.unwrap().value;

    // PATH is set here and absent there; every name it has is allowed.
    assert!(std::env::var_os("PATH").is_some());
    let env: Vec<&str> = reach["env"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap())
        .collect();
    assert!(
        env.iter()
            .all(|name| sources::engine::sandbox::passes(name)),
        "{env:?}"
    );
    assert!(env.contains(&"CAPY_ENGINE_REPLICA_BUDGET"), "{env:?}");
    // Each refusal names the rule that made it (sandbox.rs's errnos).
    assert_eq!(reach["udp"], json!(EACCES), "{reach}");
    assert_eq!(reach["spawn"], json!(EPERM), "{reach}");
    assert_eq!(reach["exec"], json!(EACCES), "{reach}");
    assert_eq!(reach["thread"], json!(7), "{reach}");
    assert_eq!(reach["no_new_privs"], json!("1"), "{reach}");
    assert_eq!(reach["seccomp"], json!("2"), "{reach}");
    // Its filters (three, and the x32 one on x86_64) on top of what it
    // inherited from this process.
    let filters = |status: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix("Seccomp_filters:"))
            .and_then(|count| count.trim().parse::<u64>().ok())
    };
    let inherited_filters =
        filters(&std::fs::read_to_string("/proc/self/status").unwrap()).unwrap();
    assert_eq!(
        reach["seccomp_filters"]
            .as_str()
            .and_then(|count| count.parse::<u64>().ok()),
        Some(inherited_filters + if cfg!(target_arch = "x86_64") { 4 } else { 3 }),
        "{reach}"
    );
    assert_eq!(reach["nofile"], json!([64, 64]), "{reach}");
    assert_eq!(reach["core"], json!([0, 0]), "{reach}");
    assert_eq!(reach["data"], json!([3u64 << 30, 3u64 << 30]), "{reach}");
    // No file-size cap of its own: an engine whose stderr is a file logs.
    assert_eq!(
        reach["fsize"],
        json!(rlimit::Resource::FSIZE.get().unwrap()),
        "{reach}"
    );
    assert_eq!(reach["own_group"], json!(true), "{reach}");
    assert_eq!(reach["setpgid"], json!(EPERM), "{reach}");
    assert_eq!(reach["prctl_pdeathsig"], json!(EPERM), "{reach}");
    assert_eq!(reach["prctl_dumpable"], json!(EPERM), "{reach}");
    assert_eq!(reach["fds"], json!([]), "{reach}");
    assert_eq!(reach["file"], json!(EACCES), "{reach}");
    assert_ne!(reach["parent_environ"], json!("ok"), "{reach}");
    // Landlock's scoping (ABI 6), which a production server requires: CI's
    // kernel must have it; elsewhere a kernel without it skips, loudly.
    if std::env::var("CI").is_ok_and(|ci| ci == "true") {
        assert_eq!(sources::engine::sandbox::check_host(), Ok(None));
    } else if let gap @ (Ok(Some(_)) | Err(_)) = sources::engine::sandbox::check_host() {
        eprintln!("SKIPPED the Landlock scoping checks on this kernel: {gap:?}");
        return;
    }
    assert_eq!(reach["signal_parent"], json!(EPERM), "{reach}");
    assert_eq!(reach["abstract_unix"], json!(EPERM), "{reach}");
}

/// Security regression (the Office engine sandbox, Epo 2026-10-20): an
/// engine dies with the process running its pool, even in the middle of a
/// call (an idle one would also end at the end of its stdin).
#[cfg(target_os = "linux")]
#[test]
fn an_engine_dies_with_its_server_even_mid_call() {
    use std::io::BufRead;
    let mut server = std::process::Command::new(env!("CARGO_BIN_EXE_sources-test-engine"))
        .arg("pool")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufReader::new(server.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let engine: u32 = line.trim().parse().unwrap();
    server.kill().unwrap();
    server.wait().unwrap();
    // Gone, or a zombie nobody reaped yet.
    let running = || {
        std::fs::read_to_string(format!("/proc/{engine}/stat")).is_ok_and(|stat| {
            !stat
                .rsplit(')')
                .next()
                .is_some_and(|rest| rest.trim_start().starts_with('Z'))
        })
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while running() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!running(), "engine {engine} outlived its server");
}

/// Security regression (the Office engine sandbox, Epo 2026-10-20): an
/// engine outlives the tokio worker that asked for it. A worker that hands
/// its core away (`block_in_place`) later retires; an engine started on it
/// would get its parent-death signal then, so engines start on the pool's
/// own spawner thread.
#[cfg(target_os = "linux")]
#[test]
fn an_engine_outlives_the_worker_thread_that_started_its_call() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .thread_keep_alive(Duration::from_millis(50))
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let pool = EnginePool::new(config(1, 1));
        let first = pid(&pool, Lane::Save, None).await;
        // The only worker (it ran the supervisor) gives its core away.
        tokio::spawn(async {
            tokio::task::block_in_place(|| std::thread::sleep(Duration::from_millis(20)));
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(pid(&pool, Lane::Save, None).await, first);
    });
}

/// Security regression (the Office engine sandbox, Epo 2026-10-20): the
/// process that runs engines (the server) is not dumpable, so an engine of
/// the same uid cannot read its environment or memory through /proc.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_server_running_engines_is_not_dumpable() {
    let _pool = EnginePool::new(config(1, 1));
    assert!(!nix::sys::prctl::get_dumpable().unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stray_print_on_stdout_is_a_corrupt_pipe() {
    let pool = EnginePool::new(config(1, 1));
    let room = "source:f_p:epoch:1";
    let before = pid(&pool, Lane::Save, Some(room)).await;
    let error = pool
        .call(Lane::Save, Some(room), request("test.print", json!({})))
        .await
        .unwrap_err();
    assert!(error.transient(), "{error:?}");
    assert_ne!(pid(&pool, Lane::Save, Some(room)).await, before);
}
