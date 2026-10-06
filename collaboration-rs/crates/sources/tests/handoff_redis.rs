//! The handoff's room side (sourceHandoff.test.ts) against Redis and a
//! stand-in room layer: ready receipts, the maintenance pause, probes,
//! complete and cancel.

#![allow(clippy::unwrap_used)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use redis::AsyncCommands;
use serde_json::{Value, json};
use sources::engine::PoolConfig;
use sources::handoff::{EDITING_PAUSED, HANDOFF_TIMED_OUT, Handoff, OFFICE_EDITING_PAUSED_REASON};
use sources::{BoxFuture, Channel, ChannelId, Rooms, SourceRoom, Sources, SourcesConfig};

#[derive(Default)]
struct FakeRooms {
    channels: Mutex<Vec<Channel>>,
    events: Mutex<Vec<String>>,
    persist_fails: Mutex<bool>,
    busy: Mutex<bool>,
}

impl FakeRooms {
    fn log(&self, event: String) {
        self.events.lock().unwrap().push(event);
    }
    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }
}

impl Rooms for FakeRooms {
    fn broadcast(&self, _room: &str, payload: String) {
        let payload: Value = serde_json::from_str(&payload).unwrap();
        self.log(format!("broadcast {}", payload["type"].as_str().unwrap()));
    }
    fn channels(&self, _room: &str) -> Vec<Channel> {
        self.channels.lock().unwrap().clone()
    }
    fn loaded(&self, _room: &str) -> bool {
        !self.channels.lock().unwrap().is_empty()
    }
    fn set_read_only(&self, _room: &str, channel: ChannelId) {
        for entry in self.channels.lock().unwrap().iter_mut() {
            if entry.id == channel {
                entry.read_only = true;
            }
        }
        self.log(format!("read-only {channel}"));
    }
    fn restore_access(&self, _room: &str) {
        for entry in self.channels.lock().unwrap().iter_mut() {
            entry.read_only = !entry.write;
        }
        self.log("restore".into());
    }
    fn close(&self, _room: &str, channel: Option<ChannelId>, code: Option<u16>, reason: &str) {
        self.log(format!("close {channel:?} {code:?} {reason}"));
    }
    fn persist(&self, _room: &str) -> BoxFuture<Result<(), String>> {
        let fails = *self.persist_fails.lock().unwrap();
        self.log("persist".into());
        Box::pin(async move {
            if fails {
                Err("store failed".into())
            } else {
                Ok(())
            }
        })
    }
    fn busy(&self, _room: &str, writers_only: bool) -> bool {
        *self.busy.lock().unwrap()
            || self
                .channels
                .lock()
                .unwrap()
                .iter()
                .any(|channel| !writers_only || !channel.read_only)
    }
    fn unload(&self, _room: &str) -> BoxFuture<()> {
        self.log("unload".into());
        Box::pin(async {})
    }
}

fn writer(id: ChannelId) -> Channel {
    Channel {
        id,
        write: true,
        read_only: false,
    }
}

async fn setup() -> (Arc<Handoff>, Arc<FakeRooms>, redis::aio::ConnectionManager) {
    let url = std::env::var("SOURCES_TEST_REDIS_URL").expect("SOURCES_TEST_REDIS_URL");
    let redis = redis::Client::open(url)
        .unwrap()
        .get_connection_manager()
        .await
        .unwrap();
    let mut config = deadpool_postgres::Config::new();
    config.url = Some("postgres://unused@localhost:1/unused".into());
    let db = config
        .create_pool(
            Some(deadpool_postgres::Runtime::Tokio1),
            tokio_postgres::NoTls,
        )
        .unwrap();
    let sources = Arc::new(Sources::new(
        SourcesConfig {
            api_url: "http://127.0.0.1:1".into(),
            secret: "secret".into(),
            engine: PoolConfig {
                program: PathBuf::from(env!("CARGO_BIN_EXE_sources-test-engine")),
                args: Vec::new(),
                save_processes: 1,
                background_processes: 1,
                call_timeout: Duration::from_secs(120),
                replica_budget_bytes: 0,
                memory_limit_bytes: None,
            },
        },
        db,
        reqwest::Client::new(),
    ));
    let rooms = Arc::new(FakeRooms::default());
    let handoff = Handoff::new(
        "instance-1".into(),
        redis.clone(),
        sources,
        rooms.clone(),
        false,
    );
    (handoff, rooms, redis)
}

fn room() -> SourceRoom {
    SourceRoom {
        file_id: format!("f{}", std::process::id()),
        epoch: 2,
    }
}

fn prepare(room: &SourceRoom, id: &str) -> String {
    json!({ "checkpoint": 7, "epoch": room.epoch, "fileId": room.file_id, "id": id, "room": room.name(), "type": "prepare" })
        .to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Redis (docker compose -p rust-sources)"]
async fn a_publication_prepare_waits_for_clean_ready_receipts_then_persists() {
    let (handoff, rooms, mut redis) = setup().await;
    let room = room();
    *rooms.channels.lock().unwrap() = vec![
        writer(1),
        writer(2),
        Channel {
            id: 3,
            write: false,
            read_only: true,
        },
    ];
    let prepared = {
        let handoff = handoff.clone();
        let raw = prepare(&room, "h1");
        tokio::spawn(async move { handoff.handle(&raw).await.unwrap() })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(handoff.busy(&room.name()));
    let ready = |id: &str, checkpoint: u64, clean: bool| json!({ "id": id, "epoch": 2, "checkpoint": checkpoint, "clean": clean });
    // Only the matching handoff, epoch and checkpoint from a clean editor counts.
    assert!(!handoff.ready(&room.name(), 1, &ready("other", 7, true)));
    assert!(!handoff.ready(&room.name(), 1, &ready("h1", 6, true)));
    assert!(!handoff.ready(&room.name(), 1, &ready("h1", 7, false)));
    assert!(!handoff.ready(&room.name(), 3, &ready("h1", 7, true)));
    assert!(handoff.ready(&room.name(), 1, &ready("h1", 7, true)));
    // The other writer leaves instead of answering: no longer waited for.
    handoff.closed(&room.name(), 2);
    prepared.await.unwrap();
    let answer: Option<String> = redis
        .hget("capy:source-handoff:h1", "instance-1")
        .await
        .unwrap();
    assert_eq!(answer.as_deref(), Some("ready"));
    assert_eq!(
        rooms.events(),
        ["broadcast source-handoff-prepare", "persist"]
    );
    // The coordinator's cancel restores editing and tells the room.
    let cancel = json!({ "epoch": 2, "fileId": room.file_id, "id": "h1", "room": room.name(), "type": "cancel" });
    handoff.handle(&cancel.to_string()).await.unwrap();
    assert!(!handoff.busy(&room.name()));
    assert_eq!(
        &rooms.events()[2..],
        ["restore", "broadcast source-handoff-cancel"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Redis (docker compose -p rust-sources)"]
async fn a_silent_writer_is_closed_after_the_window_and_the_room_still_persists() {
    let (handoff, rooms, mut redis) = setup().await;
    let room = room();
    *rooms.channels.lock().unwrap() = vec![writer(1)];
    handoff.handle(&prepare(&room, "h2")).await.unwrap();
    let answer: Option<String> = redis
        .hget("capy:source-handoff:h2", "instance-1")
        .await
        .unwrap();
    assert_eq!(answer.as_deref(), Some("ready"));
    assert_eq!(
        rooms.events(),
        [
            "broadcast source-handoff-prepare".to_owned(),
            "read-only 1".to_owned(),
            format!("close Some(1) Some({HANDOFF_TIMED_OUT}) Source handoff timed out"),
            "persist".to_owned(),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Redis (docker compose -p rust-sources)"]
async fn the_pause_persists_tells_saved_writers_and_closes_them() {
    let (handoff, rooms, _) = setup().await;
    let room = room();
    *rooms.channels.lock().unwrap() = vec![Channel {
        id: 4,
        write: false,
        read_only: true,
    }];
    assert!(handoff.pause(&room).await);
    assert_eq!(
        rooms.events(),
        ["persist", "broadcast source-editing-paused", "restore"]
    );
    // A failed persist closes the writers without claiming they were saved.
    let (handoff, rooms, _) = setup().await;
    *rooms.channels.lock().unwrap() = vec![Channel {
        id: 5,
        write: true,
        read_only: true,
    }];
    *rooms.persist_fails.lock().unwrap() = true;
    assert!(!handoff.pause(&room).await);
    assert_eq!(
        rooms.events(),
        [
            "persist".to_owned(),
            format!("close Some(5) Some({EDITING_PAUSED}) {OFFICE_EDITING_PAUSED_REASON}"),
            "restore".to_owned(),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs Redis (docker compose -p rust-sources)"]
async fn probes_answer_busy_while_the_room_is_in_use_and_complete_moves_it_on() {
    let (handoff, rooms, mut redis) = setup().await;
    let room = room();
    let probe = |id: &str, writers_only: bool| {
        json!({ "epoch": 2, "fileId": room.file_id, "id": id, "room": room.name(), "type": "probe", "writersOnly": writers_only })
            .to_string()
    };
    handoff.handle(&probe("p1", false)).await.unwrap();
    *rooms.busy.lock().unwrap() = true;
    handoff.handle(&probe("p2", false)).await.unwrap();
    *rooms.busy.lock().unwrap() = false;
    // During the pause a room with only viewers left is free.
    *rooms.channels.lock().unwrap() = vec![Channel {
        id: 6,
        write: false,
        read_only: true,
    }];
    handoff.handle(&probe("p3", true)).await.unwrap();
    handoff.handle(&probe("p4", false)).await.unwrap();
    for (id, want) in [
        ("p1", "idle"),
        ("p2", "busy"),
        ("p3", "idle"),
        ("p4", "busy"),
    ] {
        let answer: Option<String> = redis
            .hget(format!("capy:source-handoff:{id}"), "instance-1")
            .await
            .unwrap();
        assert_eq!(answer.as_deref(), Some(want), "{id}");
    }
    let complete = json!({ "epoch": 2, "fileId": room.file_id, "id": "c1", "newEpoch": 3, "room": room.name(), "type": "complete" });
    handoff.handle(&complete.to_string()).await.unwrap();
    assert_eq!(
        rooms.events(),
        [
            "broadcast source-epoch-changed",
            "close None None ",
            "restore",
            "unload"
        ]
    );
}
