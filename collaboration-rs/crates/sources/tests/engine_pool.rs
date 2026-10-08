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
