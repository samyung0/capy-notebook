//! The Capy collaboration server (rust-core). Design:
//! capy-harness/2026-10-06-rust-round/rust-core/DESIGN.md.

// A room survives a panic on one update only by unwinding (room.rs on_sync).
#[cfg(panic = "abort")]
compile_error!("the collaboration server needs panic = \"unwind\": rooms catch update panics");

mod access;
mod app;
mod auth;
mod children;
mod config;
mod drafts;
mod edits;
mod eviction;
mod health;
mod http;
mod incidents;
mod markers;
mod model;
mod note_store;
mod observe;
mod projection;
mod protocol;
mod pubsub;
mod rate;
mod room;
mod socket;
mod source_rooms;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::app::App;
use crate::config::Config;
use crate::observe::{Level, log};

const INSTANCE_REGISTRY: &str = "capy:collaboration:instances";
const INSTANCE_HEARTBEAT: Duration = Duration::from_secs(15);

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        None => {}
        // An Office engine process of the server's pool (DESIGN.md 6.3):
        // frames on stdin and stdout, so every line goes to stderr.
        Some("engine") => {
            observe::log_to_stderr();
            let _sentry = observe::init();
            observe::install_for_sources();
            if let Err(error) = sources::engine::serve() {
                observe::capture(&error.to_string(), None, &[("stage", "engine")]);
                std::process::exit(1);
            }
            return;
        }
        // The pin bump's seed check (openwiki/deployment-runbook.md).
        Some("seed-check") => std::process::exit(seed_check(args.next())),
        Some(other) => {
            eprintln!(
                "unknown command {other:?}; usage: capy-collaboration [engine | seed-check [manifest]]"
            );
            std::process::exit(2);
        }
    }
    // Before any connection is accepted, so a startup failure is reported.
    let _sentry = observe::init();
    observe::install_for_sources();
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            observe::capture(&error.to_string(), None, &[("stage", "config")]);
            std::process::exit(1);
        }
    };
    #[cfg(target_os = "linux")]
    match raise_open_files() {
        Ok(limit) => log(Level::Info, "open_files_limit", json!({ "soft": limit })),
        Err(error) => {
            observe::capture(&error, None, &[("stage", "open_files_limit")]);
            std::process::exit(1);
        }
    }
    #[allow(clippy::expect_used)]
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("the tokio runtime starts");
    if let Err(error) = runtime.block_on(serve(config)) {
        observe::capture(&error, None, &[("stage", "startup")]);
        std::process::exit(1);
    }
}

/// Raises the open-file soft limit to the hard limit, as Go's and Node's
/// runtimes do at startup: every client socket, gateway call and database
/// connection is a descriptor, and Docker gives a container a soft limit of
/// 1024 (prod Phase B: the server stopped near 1,000 connections). The server
/// does not start under a limit it could not raise.
#[cfg(target_os = "linux")]
fn raise_open_files() -> Result<u64, String> {
    use rlimit::Resource;
    let (_, hard) = Resource::NOFILE
        .get()
        .map_err(|error| format!("reading the open-file limit: {error}"))?;
    Resource::NOFILE
        .set(hard, hard)
        .map_err(|error| format!("raising the open-file limit to {hard}: {error}"))?;
    let (soft, hard) = Resource::NOFILE
        .get()
        .map_err(|error| format!("reading the open-file limit: {error}"))?;
    if soft != hard {
        return Err(format!(
            "the open-file limit is {soft} after raising it to {hard}"
        ));
    }
    Ok(soft)
}

/// The longest wait for a pooled database connection.
const DB_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

async fn serve(config: Config) -> Result<(), String> {
    let db = {
        let pg: tokio_postgres::Config = config
            .database_url
            .parse()
            .map_err(|error: tokio_postgres::Error| error.to_string())?;
        let manager = deadpool_postgres::Manager::new(pg, tokio_postgres::NoTls);
        // A connection held across slow work starved the pool once (the
        // source fold, rust-core REVIEW1 M2): a wait this long fails the
        // caller instead of hanging every room.
        deadpool_postgres::Pool::builder(manager)
            .max_size(10)
            .wait_timeout(Some(DB_WAIT))
            .runtime(deadpool_postgres::Runtime::Tokio1)
            .build()
            .map_err(|error| error.to_string())?
    };
    let redis_client =
        redis::Client::open(config.redis_url.as_str()).map_err(|error| error.to_string())?;
    let redis = redis_client
        .get_connection_manager()
        .await
        .map_err(|error| error.to_string())?;
    let http = reqwest::Client::builder()
        .build()
        .map_err(|error| error.to_string())?;
    let address = format!("{}:{}", config.host, config.port);
    let sources = Arc::new(
        sources::Sources::new(
            sources::SourcesConfig {
                api_url: config.api_url.clone(),
                secret: config.secret.clone(),
                engine: engine_pool(
                    config.engine_save_processes as usize,
                    config.engine_background_processes as usize,
                    Some(config.engine_memory_limit_bytes),
                )?,
                disk_dir: config.source_disk_dir.clone(),
                disk_bytes: config.source_disk_bytes,
            },
            db.clone(),
            http.clone(),
        )
        .map_err(|error| {
            format!(
                "source disk store {}: {error}",
                config.source_disk_dir.display()
            )
        })?,
    );
    let markdown = match &config.markdown_bundle {
        None => None,
        Some(path) => {
            let bundle = std::fs::read_to_string(path)
                .map_err(|error| format!("markdown bundle {path}: {error}"))?;
            Some(
                notes::markdown::Converter::new(&bundle)
                    .map_err(|error| format!("markdown bundle {path}: {error}"))?,
            )
        }
    };
    let publication_hold = config.uat_publication_hold;
    let allowances = crate::rate::Allowances::new(config.update_limits, std::time::Instant::now());
    let app = Arc::new(App {
        instance_id: format!("{}-{}", std::process::id(), uuid::Uuid::new_v4()),
        config,
        db,
        redis,
        redis_client,
        http,
        rooms: Default::default(),
        evictions: Default::default(),
        stats: Default::default(),
        allowances,
        health: Default::default(),
        unplaced: Default::default(),
        projection_failures: Default::default(),
        projection_refused: Default::default(),
        pubsub: Default::default(),
        next_connection: Default::default(),
        next_channel: Default::default(),
        sources: sources.clone(),
        handoff: Default::default(),
        source_joins: Default::default(),
        markdown,
    });
    let rooms: Arc<dyn sources::Rooms> = Arc::new(source_rooms::ServerRooms {
        app: Arc::downgrade(&app),
        backlog: Default::default(),
    });
    let handoff = sources::handoff::Handoff::new(
        app.instance_id.clone(),
        app.redis.clone(),
        sources,
        rooms,
        publication_hold,
    );
    if app.handoff.set(handoff).is_err() {
        return Err("the source handoff was set twice".into());
    }
    tokio::spawn(health::run(app.clone()));
    tokio::spawn(source_rooms::run_refreshes(app.clone()));
    tokio::spawn(source_rooms::run_rebuilds(app.clone()));
    tokio::spawn(source_rooms::run_pause_poll(app.clone()));
    tokio::spawn(projection::run_pending(app.clone()));
    tokio::spawn(heartbeat(app.clone()));
    tokio::spawn(pubsub::run(app.clone()));
    tokio::spawn(pubsub::run_compaction(app.clone()));
    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .map_err(|error| error.to_string())?;
    log(
        Level::Info,
        "collaboration service listening",
        json!({ "address": address }),
    );
    let stopping = app.clone();
    // Upgraded sockets are not waited for: every room stores first, then the
    // listener stops and the process exits (clients reconnect elsewhere).
    axum::serve(listener, http::router(app.clone()))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            log(Level::Info, "flushing collaboration documents", json!({}));
            shutdown(&stopping).await;
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// The Office engine pool: child processes of this binary (`engine`).
fn engine_pool(
    save: usize,
    background: usize,
    memory_limit_bytes: Option<u64>,
) -> Result<sources::engine::PoolConfig, String> {
    let program = std::env::current_exe().map_err(|error| error.to_string())?;
    Ok(sources::engine::PoolConfig {
        program,
        args: vec!["engine".into()],
        save_processes: save,
        background_processes: background,
        call_timeout: sources::engine::CALL_TIMEOUT,
        replica_budget_bytes: sources::engine::OFFICE_REPLICA_BUDGET_BYTES,
        memory_limit_bytes,
    })
}

/// `seed-check [manifest]`: re-seeds every base the manifest (JSON lines of
/// `office-maintenance seed-manifest`, from the file or stdin) names with this
/// build's engines and prints the report. Exits 1 when a seed changed (the
/// maintenance window comes first), 2 when the check could not run.
fn seed_check(manifest: Option<String>) -> i32 {
    let text = match manifest {
        Some(path) => std::fs::read_to_string(&path).map_err(|error| format!("{path}: {error}")),
        None => std::io::read_to_string(std::io::stdin()).map_err(|error| error.to_string()),
    };
    let lines: Result<Vec<sources::seed_check::SeedManifestLine>, String> = text.and_then(|text| {
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).map_err(|error| error.to_string()))
            .collect()
    });
    let lines = match lines {
        Ok(lines) => lines,
        Err(error) => {
            eprintln!("seed-check: {error}");
            return 2;
        }
    };
    #[allow(clippy::expect_used)]
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("the tokio runtime starts");
    let checked = runtime.block_on(async {
        // A developer machine's run: one process per lane, no memory cap.
        let pool = sources::engine::EnginePool::new(engine_pool(1, 1, None)?);
        let http = reqwest::Client::new();
        sources::seed_check::check_seeds(&lines, &pool, |url| {
            let (http, url) = (http.clone(), url.to_owned());
            async move { sources::store::read_source_bytes(&http, &url).await }
        })
        .await
        .map_err(|error| error.to_string())
    });
    match checked {
        Ok(checks) => {
            let (report, changed) = sources::seed_check::report(&checks);
            #[allow(clippy::print_stdout)]
            {
                print!("{report}");
            }
            i32::from(changed)
        }
        Err(error) => {
            eprintln!("seed-check: {error}");
            2
        }
    }
}

/// Keeps this instance in the registry other instances and the gateway read.
async fn heartbeat(app: app::Shared) {
    let mut tick = tokio::time::interval(INSTANCE_HEARTBEAT);
    loop {
        tick.tick().await;
        let mut redis = app.redis.clone();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        let result = redis::cmd("HSET")
            .arg(INSTANCE_REGISTRY)
            .arg(&app.instance_id)
            .arg(now)
            .query_async::<i64>(&mut redis)
            .await;
        if let Err(error) = result {
            log(
                Level::Warn,
                "instance heartbeat failed",
                json!({ "error": error.to_string() }),
            );
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

/// Every loaded room stores what it holds before the process exits (the
/// container's shutdown grace period covers it), then the source disk store's
/// files go (Epo 2026-10-17; a crash leaves them for the next start's wipe).
async fn shutdown(app: &app::Shared) {
    let mut waits = Vec::new();
    for name in app.rooms.names() {
        if let Some(handle) = app.rooms.get(&name) {
            let (reply, answer) = tokio::sync::oneshot::channel();
            if handle.tx.send(room::RoomCmd::Persist(reply)).await.is_ok() {
                waits.push(answer);
            }
        }
    }
    for wait in waits {
        let _ = wait.await;
    }
    if let Err(error) = app.sources.clear_disk().await {
        log(
            Level::Warn,
            "source disk store not cleared",
            json!({ "error": error.to_string() }),
        );
    }
}

#[cfg(test)]
mod tests {
    // Epo 2026-10-17: a graceful stop deletes the source disk store's files
    // once the rooms stored, by the start wipe's name rule.
    #[tokio::test]
    async fn a_graceful_stop_deletes_the_source_disk_stores_files() {
        let app = crate::http::tests::offline_app();
        let dir = app.config.source_disk_dir.clone();
        let ours = format!("base-{}", "a".repeat(64));
        for name in [ours.as_str(), "tmp-3", "notes.txt"] {
            std::fs::write(dir.join(name), b"left").unwrap();
        }
        super::shutdown(&app).await;
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(left, ["notes.txt"]);
    }

    /// The kernel's own view (`/proc/self/limits`) after the raise: soft
    /// equals hard (prod Phase B: soft 1024 under a hard 524288). The soft
    /// limit is lowered first, as a container starts it, so a raise that does
    /// nothing fails here even where the runner's soft already equals hard.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_open_file_limit_is_raised_to_the_hard_limit() {
        let (_, hard) = rlimit::Resource::NOFILE.get().expect("read");
        rlimit::Resource::NOFILE
            .set(hard.min(1024), hard)
            .expect("lowered");
        let raised = super::raise_open_files().expect("raised");
        let files = rlimit::ProcLimits::read_self()
            .expect("/proc/self/limits")
            .max_open_files
            .expect("Max open files");
        assert_eq!(files.soft_limit, Some(raised));
        assert_eq!(files.soft_limit, files.hard_limit);
    }
}
