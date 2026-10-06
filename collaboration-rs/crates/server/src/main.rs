//! The Capy collaboration server (rust-core). Design:
//! capy-harness/2026-10-06-rust-round/rust-core/DESIGN.md.

mod access;
mod app;
mod auth;
mod config;
mod eviction;
mod health;
mod http;
mod incidents;
mod markers;
mod note_store;
mod observe;
mod projection;
mod protocol;
mod pubsub;
mod room;
mod socket;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::app::App;
use crate::config::Config;
use crate::observe::{Level, log};

const INSTANCE_REGISTRY: &str = "capy:collaboration:instances";
const INSTANCE_HEARTBEAT: Duration = Duration::from_secs(15);

fn main() {
    // Before any connection is accepted, so a startup failure is reported.
    let _sentry = observe::init();
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            observe::capture(&error.to_string(), None, &[("stage", "config")]);
            std::process::exit(1);
        }
    };
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

async fn serve(config: Config) -> Result<(), String> {
    let db = {
        let pg: tokio_postgres::Config = config
            .database_url
            .parse()
            .map_err(|error: tokio_postgres::Error| error.to_string())?;
        let manager = deadpool_postgres::Manager::new(pg, tokio_postgres::NoTls);
        deadpool_postgres::Pool::builder(manager)
            .max_size(10)
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
        health: Default::default(),
        unplaced: Default::default(),
        projection_failures: Default::default(),
        pubsub: Default::default(),
        next_connection: Default::default(),
    });
    tokio::spawn(health::run(app.clone()));
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
    axum::serve(listener, http::router(app.clone()))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| error.to_string())?;
    log(Level::Info, "flushing collaboration documents", json!({}));
    shutdown(&app).await;
    Ok(())
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
/// container's shutdown grace period covers it).
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
}
