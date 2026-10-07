//! What source rooms need from the server beyond the room task: the room
//! layer the publication handoff drives (`sources::Rooms`), the joins it
//! counts as in a room, and the source timers (refresh scheduler, rebuild
//! sweep, maintenance pause poll), as `collaboration/src/server.ts` ran them.

use std::collections::{HashMap, HashSet};
use std::sync::Weak;
use std::time::{Duration, Instant};

use serde_json::Value;
use sources::handoff::SourcePublish;
use sources::{BoxFuture, Channel, ChannelId, SourceError, SourceRoom};
use tokio::sync::oneshot;

use crate::app::{App, Shared};
use crate::observe;
use crate::room::RoomCmd;

/// A join counts as in the room this long at most (the handoff's window).
const JOIN_WINDOW: Duration = Duration::from_secs(30);
/// A join that never ended is forgotten after this long.
const JOIN_FORGET: Duration = Duration::from_secs(60);
const REFRESH_TICK: Duration = Duration::from_secs(5);
const REBUILD_TICK: Duration = Duration::from_secs(60);
/// A rebuild found in use waits this long; one that failed, longer.
const REBUILD_BUSY_BACKOFF: Duration = Duration::from_secs(5 * 60);
const REBUILD_ERROR_BACKOFF: Duration = Duration::from_secs(10 * 60);
const PAUSE_TICK: Duration = Duration::from_secs(5);

#[allow(clippy::unwrap_used)]
pub fn start_join(app: &App, key: (u64, u64), room: &str) {
    let mut joins = app.source_joins.lock().unwrap();
    let now = Instant::now();
    joins.retain(|_, (_, since)| now.duration_since(*since) < JOIN_FORGET);
    joins.insert(key, (room.to_owned(), now));
}

#[allow(clippy::unwrap_used)]
pub fn end_join(app: &App, key: (u64, u64)) {
    app.source_joins.lock().unwrap().remove(&key);
}

#[allow(clippy::unwrap_used)]
fn joining(app: &App, room: &str) -> bool {
    let now = Instant::now();
    app.source_joins
        .lock()
        .unwrap()
        .values()
        .any(|(joined, since)| joined == room && now.duration_since(*since) < JOIN_WINDOW)
}

/// The room layer as the handoff sees it.
pub struct ServerRooms {
    pub app: Weak<App>,
}

impl ServerRooms {
    /// Sends a command to a loaded room, in order with what this task sent.
    fn send(&self, room: &str, command: RoomCmd) {
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let Some(handle) = app.rooms.get(room) else {
            return;
        };
        if let Err(tokio::sync::mpsc::error::TrySendError::Full(command)) =
            handle.tx.try_send(command)
        {
            tokio::spawn(async move {
                let _ = handle.tx.send(command).await;
            });
        }
    }
}

impl sources::Rooms for ServerRooms {
    fn broadcast(&self, room: &str, payload: String) {
        self.send(room, RoomCmd::Broadcast(payload));
    }

    fn channels(&self, room: &str) -> Vec<Channel> {
        self.app
            .upgrade()
            .and_then(|app| app.rooms.get(room))
            .map(|handle| handle.view.get().channels)
            .unwrap_or_default()
    }

    fn loaded(&self, room: &str) -> bool {
        self.app
            .upgrade()
            .and_then(|app| app.rooms.get(room))
            .is_some_and(|handle| handle.view.get().loaded)
    }

    fn set_read_only(&self, room: &str, channel: ChannelId) {
        self.send(room, RoomCmd::SetReadOnly(channel));
    }

    fn restore_access(&self, room: &str) {
        self.send(room, RoomCmd::RestoreAccess);
    }

    fn close(&self, room: &str, channel: Option<ChannelId>, code: Option<u16>, reason: &str) {
        self.send(
            room,
            RoomCmd::CloseChannels {
                channel,
                code,
                reason: reason.to_owned(),
            },
        );
    }

    fn persist(&self, room: &str) -> BoxFuture<Result<(), String>> {
        let handle = self.app.upgrade().and_then(|app| app.rooms.get(room));
        Box::pin(async move {
            let Some(handle) = handle else { return Ok(()) };
            let (reply, answer) = oneshot::channel();
            if handle.tx.send(RoomCmd::Persist(reply)).await.is_err() {
                return Ok(());
            }
            answer.await.unwrap_or(Ok(()))
        })
    }

    fn busy(&self, room: &str, writers_only: bool) -> bool {
        let Some(app) = self.app.upgrade() else {
            return false;
        };
        if joining(&app, room) {
            return true;
        }
        let Some(handle) = app.rooms.get(room) else {
            return false;
        };
        let view = handle.view.get();
        // Loading counts as in the room.
        view.storing
            || !view.loaded
            || !writers_only
            || view.channels.iter().any(|channel| !channel.read_only)
    }

    fn unload(&self, room: &str) -> BoxFuture<()> {
        let handle = self.app.upgrade().and_then(|app| app.rooms.get(room));
        Box::pin(async move {
            let Some(handle) = handle else { return };
            let (reply, answer) = oneshot::channel();
            if handle.tx.send(RoomCmd::Unload(reply)).await.is_ok() {
                let _ = answer.await;
            }
        })
    }
}

/// The internal publish route's body as the handoff takes it.
pub async fn publish(app: &Shared, input: Value) -> Result<Value, SourceError> {
    let input: SourcePublish = serde_json::from_value(input)
        .map_err(|_| SourceError::request(400, "Invalid source publication", None))?;
    app.handoff().publish(&input).await
}

/// Requests due refreshes, exports claimed candidates and indexes idle notes
/// every 5 s, one run at a time.
pub async fn run_refreshes(app: Shared) {
    let mut tick = tokio::time::interval(REFRESH_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let publisher = app.clone();
        let publish_one = move |input: Value| -> BoxFuture<Result<Value, SourceError>> {
            let app = publisher.clone();
            Box::pin(async move { publish(&app, input).await })
        };
        if let Err(error) = app.sources.schedule_refreshes(Some(&publish_one)).await {
            observe::capture(&error.to_string(), None, &[("stage", "source_refresh")]);
        }
    }
}

/// Rebuilds a room-unload trigger missed (another instance still had the
/// room, a restart): every minute, files with a pending rebuild, skipping one
/// found in use for five minutes and one that failed for ten.
pub async fn run_rebuilds(app: Shared) {
    let mut backoff: HashMap<String, Instant> = HashMap::new();
    let mut tick = tokio::time::interval(REBUILD_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await;
    loop {
        tick.tick().await;
        let now = Instant::now();
        backoff.retain(|_, until| *until > now);
        let skip: Vec<String> = backoff.keys().cloned().collect();
        let pending = match app.sources.pending_rebuilds(&skip).await {
            Ok(pending) => pending,
            Err(error) => {
                observe::capture(&error.to_string(), None, &[("stage", "source_rebuild")]);
                continue;
            }
        };
        for file_id in pending {
            match app.handoff().rebuild(&file_id).await {
                Ok(true) => {}
                Ok(false) => {
                    backoff.insert(file_id, now + REBUILD_BUSY_BACKOFF);
                }
                Err(error) => {
                    observe::capture(&error.to_string(), None, &[("stage", "source_rebuild")]);
                    backoff.insert(file_id, now + REBUILD_ERROR_BACKOFF);
                }
            }
        }
    }
}

/// The maintenance pause reaches this instance within 5 s: each loaded
/// Office room flushes, persists and closes its writers once (the handoff's
/// `pause`), then refuses writer updates until a writer joins after the pause
/// ended. A room mid-publication, or loaded later, follows on a later tick.
pub async fn run_pause_poll(app: Shared) {
    // Rooms checked during this pause, by name and load.
    let mut checked: HashSet<(String, u64)> = HashSet::new();
    let mut tick = tokio::time::interval(PAUSE_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let paused = match app.db.get().await {
            Ok(client) => client
                .query_one("SELECT EXISTS(SELECT 1 FROM office_editing_pause)", &[])
                .await
                .map(|row| row.get::<_, bool>(0))
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        let paused = match paused {
            Ok(paused) => paused,
            Err(error) => {
                observe::capture(&error, None, &[("stage", "office_pause")]);
                continue;
            }
        };
        if !paused {
            for (room, id) in checked.drain() {
                if let Some(handle) = app.rooms.get(&room).filter(|handle| handle.id == id) {
                    let _ = handle.tx.send(RoomCmd::SetPaused(false)).await;
                }
            }
            continue;
        }
        let mut due = Vec::new();
        for name in app.rooms.names() {
            let (Some(room), Some(handle)) = (SourceRoom::parse(&name), app.rooms.get(&name))
            else {
                continue;
            };
            if app.handoff().busy(&name) || !checked.insert((name, handle.id)) {
                continue;
            }
            due.push((room, handle));
        }
        let pauses = due.into_iter().map(|(room, handle)| {
            let app = app.clone();
            async move {
                match app.sources.editing_paused(&room).await {
                    Ok(true) => {}
                    Ok(false) => return,
                    Err(error) => {
                        observe::capture(&error.to_string(), None, &[("stage", "office_pause")]);
                        return;
                    }
                }
                app.handoff().pause(&room).await;
                let _ = handle.tx.send(RoomCmd::SetPaused(true)).await;
            }
        });
        futures::future::join_all(pauses).await;
    }
}
