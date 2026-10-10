//! What source rooms need from the server beyond the room task: the room
//! layer the publication handoff drives (`sources::Rooms`), the joins it
//! counts as in a room, and the source timers (refresh scheduler, rebuild
//! sweep, maintenance pause poll), as the Node server's `server.ts` ran them.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde_json::Value;
use sources::handoff::SourcePublish;
use sources::{BoxFuture, Channel, ChannelId, SourceError, SourceRoom};
use tokio::sync::mpsc::Sender;
use tokio::sync::mpsc::error::TrySendError;
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

/// Commands a full room queue held back, by room name and load, in order.
type Backlog = Arc<Mutex<HashMap<(String, u64), VecDeque<RoomCmd>>>>;

/// The room layer as the handoff sees it.
pub struct ServerRooms {
    pub app: Weak<App>,
    pub backlog: Backlog,
}

impl ServerRooms {
    fn send(&self, room: &str, command: RoomCmd) {
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let Some(handle) = app.rooms.get(room) else {
            return;
        };
        send_in_order(
            &self.backlog,
            (room.to_owned(), handle.id),
            &handle.tx,
            command,
        );
    }
}

/// Sends a command to a room without waiting, in the order sent: while a
/// full queue holds one back, later ones wait behind it.
#[allow(clippy::unwrap_used)]
fn send_in_order(backlog: &Backlog, key: (String, u64), tx: &Sender<RoomCmd>, command: RoomCmd) {
    let mut waiting = backlog.lock().unwrap();
    if let Some(queue) = waiting.get_mut(&key) {
        queue.push_back(command);
        return;
    }
    let Err(TrySendError::Full(command)) = tx.try_send(command) else {
        return;
    };
    waiting.insert(key.clone(), VecDeque::from([command]));
    let (backlog, tx) = (backlog.clone(), tx.clone());
    tokio::spawn(async move {
        loop {
            let next = {
                let mut waiting = backlog.lock().unwrap();
                let next = waiting.get_mut(&key).and_then(VecDeque::pop_front);
                if next.is_none() {
                    waiting.remove(&key);
                }
                next
            };
            let Some(command) = next else { return };
            let _ = tx.send(command).await;
        }
    });
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

    /// Persist and unload queue behind any command a full queue held back,
    /// as the others do, then wait for the room's answer.
    fn persist(&self, room: &str) -> BoxFuture<Result<(), String>> {
        let (reply, answer) = oneshot::channel();
        self.send(room, RoomCmd::Persist(reply));
        // No room here, or it ended before answering: nothing to persist.
        Box::pin(async move { answer.await.unwrap_or(Ok(())) })
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
        let (reply, answer) = oneshot::channel();
        self.send(room, RoomCmd::Unload(reply));
        Box::pin(async move {
            let _ = answer.await;
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
                    // Tagged with the file: the sweep runs outside any request.
                    observe::capture(
                        &error.to_string(),
                        None,
                        &[("stage", "source_rebuild"), ("file_id", &file_id)],
                    );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn commands_held_back_by_a_full_queue_keep_their_order() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let backlog = Backlog::default();
        let key = ("room".to_owned(), 1);
        let send = |n: u32| {
            send_in_order(
                &backlog,
                key.clone(),
                &tx,
                RoomCmd::Broadcast(n.to_string()),
            );
        };
        let mut got = Vec::new();
        async fn take(rx: &mut tokio::sync::mpsc::Receiver<RoomCmd>) -> String {
            match rx.recv().await {
                Some(RoomCmd::Broadcast(payload)) => payload,
                _ => panic!("unexpected command"),
            }
        }
        // 1 waits behind the full queue; 2 then finds a free slot.
        send(0);
        send(1);
        got.push(take(&mut rx).await);
        send(2);
        send(3);
        for _ in 0..3 {
            got.push(take(&mut rx).await);
        }
        assert_eq!(got, ["0", "1", "2", "3"]);
        tokio::task::yield_now().await;
        assert!(backlog.lock().unwrap().is_empty());
    }
}
