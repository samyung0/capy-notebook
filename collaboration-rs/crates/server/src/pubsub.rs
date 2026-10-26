//! Redis pub/sub (DESIGN.md 9): the Go outbox's evictions, user evictions
//! and comment invalidations. Channels, keys and payloads are the Node
//! server's.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::app::Shared;
use crate::auth::RoomName;
use crate::note_store;
use crate::observe::{self, Level, log};
use crate::room::RoomCmd;

pub const EVICT: &str = "capy:collaboration:evict";
pub const USER_EVICT: &str = "capy:collaboration:user-evict";
pub const DELIVERED: &str = "capy:collaboration:eviction-delivered";
pub const COMMENTS: &str = "capy:collaboration:comments";
/// An eviction id is remembered this long, so a redelivery runs once.
const COMPLETED_TTL: Duration = Duration::from_secs(600);

/// Eviction ids already run.
#[derive(Default)]
pub struct Completed {
    completed: Mutex<HashMap<String, Instant>>,
}

impl Completed {
    /// Whether `id` already ran (and remembers it now if not).
    #[allow(clippy::unwrap_used)]
    pub fn seen(&self, id: &str) -> bool {
        let mut completed = self.completed.lock().unwrap();
        let now = Instant::now();
        completed.retain(|_, at| now.duration_since(*at) < COMPLETED_TTL);
        completed.insert(id.to_owned(), now).is_some()
    }
}

/// Subscribes and handles messages; reconnects after a lost connection.
pub async fn run(app: Shared) {
    loop {
        if let Err(error) = listen(&app).await {
            log(
                Level::Warn,
                "collaboration pub/sub lost",
                json!({ "error": error }),
            );
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn listen(app: &Shared) -> Result<(), String> {
    let mut pubsub = app
        .redis_client
        .get_async_pubsub()
        .await
        .map_err(|error| error.to_string())?;
    for channel in [
        EVICT,
        USER_EVICT,
        COMMENTS,
        sources::handoff::SOURCE_HANDOFF_CHANNEL,
    ] {
        pubsub
            .subscribe(channel)
            .await
            .map_err(|error| error.to_string())?;
    }
    let mut messages = pubsub.on_message();
    while let Some(message) = messages.next().await {
        let channel = message.get_channel_name().to_owned();
        let Ok(payload) = message.get_payload::<String>() else {
            continue;
        };
        let app = app.clone();
        tokio::spawn(async move { handle(&app, &channel, payload).await });
    }
    Err("subscription ended".into())
}

/// A discard this instance started, for every other instance's copy of the
/// room (`publishRoomEviction`).
pub async fn publish_eviction(app: &Shared, payload: &str) -> Result<(), String> {
    let mut redis = app.redis.clone();
    redis::cmd("PUBLISH")
        .arg(EVICT)
        .arg(payload)
        .query_async::<i64>(&mut redis)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn publish(app: &Shared, channel: &str, payload: &Value) -> Result<(), String> {
    let mut redis = app.redis.clone();
    redis::cmd("PUBLISH")
        .arg(channel)
        .arg(payload.to_string())
        .query_async::<i64>(&mut redis)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn delivered(app: &Shared, eviction: Option<&str>, ok: bool) {
    let Some(eviction) = eviction else { return };
    let payload = json!({ "evictionId": eviction, "instanceId": app.instance_id, "ok": ok });
    if let Err(error) = publish(app, DELIVERED, &payload).await {
        observe::capture(&error, None, &[("stage", "eviction_ack_publish")]);
    }
}

async fn handle(app: &Shared, channel: &str, raw: String) {
    if channel == sources::handoff::SOURCE_HANDOFF_CHANNEL {
        if let Err(error) = app.handoff().handle(&raw).await {
            observe::capture(&error.to_string(), None, &[("stage", "source_handoff")]);
        }
        return;
    }
    let Ok(event) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let text = |key: &str| event[key].as_str().map(str::to_owned);
    match channel {
        USER_EVICT => {
            let Some(user) = text("userId") else { return };
            // Only a discard closes the user's channels; a drain only acknowledges.
            if event["mode"] != "drain" {
                for name in app.rooms.names() {
                    if let Some(handle) = app.rooms.get(&name) {
                        let _ = handle
                            .tx
                            .send(RoomCmd::CloseUser(
                                user.clone(),
                                4403,
                                "account access changed".into(),
                            ))
                            .await;
                    }
                }
            }
            delivered(app, text("evictionId").as_deref(), true).await;
        }
        // Relayed to the named note room's editors as the API sent them.
        COMMENTS => {
            let Some(room) = text("room") else { return };
            if let Some(handle) = app.rooms.get(&room) {
                let mut payload = event.clone();
                payload["type"] = json!("comments-invalidated");
                let _ = handle
                    .tx
                    .send(RoomCmd::Broadcast(payload.to_string()))
                    .await;
            }
        }
        EVICT => {
            let Some(room) = text("room") else { return };
            let eviction = text("evictionId");
            let drain = event["mode"] == "drain";
            let result = match RoomName::parse(&room) {
                Some(RoomName::Source { .. }) => {
                    evict_local(app, &room, drain, Some(raw.clone()), eviction.as_deref()).await
                }
                Some(RoomName::Material { material_id, .. }) => {
                    if text("materialId").is_some_and(|id| id != material_id) {
                        return;
                    }
                    if event["type"] == "account-access-restored" && drain {
                        // Restoration widens access: keep the room and its
                        // channels, only make what is pending durable.
                        persist_local(app, &room).await
                    } else {
                        match evict_material_epochs(
                            app,
                            &material_id,
                            &room,
                            drain,
                            &raw,
                            eviction.as_deref(),
                        )
                        .await
                        {
                            Ok(()) => {
                                evict_children(app, &material_id, drain, &raw, eviction.as_deref())
                                    .await
                            }
                            Err(error) => Err(error),
                        }
                    }
                }
                None => return,
            };
            if let Err(error) = &result {
                observe::capture(error, None, &[("room", &room), ("stage", "event_eviction")]);
            }
            delivered(app, eviction.as_deref(), result.is_ok()).await;
        }
        _ => {}
    }
}

/// A note's embedded quizzes and sets are reachable exactly as the note is,
/// so an access event of the note evicts their rooms too (live-items).
async fn evict_children(
    app: &Shared,
    material_id: &str,
    drain: bool,
    raw: &str,
    eviction: Option<&str>,
) -> Result<(), String> {
    let children: Vec<String> = {
        let client = app.db.get().await.map_err(|error| error.to_string())?;
        client
            .query(
                "SELECT id FROM materials WHERE parent_material_id=$1",
                &[&material_id],
            )
            .await
            .map_err(|error| error.to_string())?
            .iter()
            .map(|row| row.get(0))
            .collect()
    };
    for child in children {
        let current = note_store::current_room(&app.db, &child)
            .await
            .map_err(|error| error.to_string())?;
        if let Some(room) = current {
            evict_material_epochs(app, &child, &room, drain, raw, eviction).await?;
        }
    }
    Ok(())
}

/// `evictMaterialRoomEpoch`: evicts the named room and any later epoch that
/// became current before delivery finished.
async fn evict_material_epochs(
    app: &Shared,
    material_id: &str,
    first: &str,
    drain: bool,
    raw: &str,
    eviction: Option<&str>,
) -> Result<(), String> {
    let mut room = first.to_owned();
    let mut done = HashSet::new();
    loop {
        evict_local(
            app,
            &room,
            drain,
            Some(raw.to_owned()),
            eviction.map(|id| format!("{id}:{room}")).as_deref(),
        )
        .await?;
        // A quiz's keys room goes with its content room (live-items).
        if let Some(keys) = room
            .strip_prefix("material:")
            .map(|rest| format!("keys:{rest}"))
        {
            evict_local(
                app,
                &keys,
                drain,
                Some(raw.to_owned()),
                eviction.map(|id| format!("{id}:{keys}")).as_deref(),
            )
            .await?;
        }
        done.insert(room.clone());
        let current = note_store::current_room(&app.db, material_id)
            .await
            .map_err(|error| error.to_string())?;
        match current {
            Some(current) if !done.contains(&current) => room = current,
            _ => return Ok(()),
        }
    }
}

/// Runs an eviction of a room loaded here (nothing to do otherwise). A
/// repeated operation id runs once.
async fn evict_local(
    app: &Shared,
    room: &str,
    drain: bool,
    notification: Option<String>,
    operation: Option<&str>,
) -> Result<(), String> {
    if operation.is_some_and(|id| app.pubsub.seen(id)) {
        return Ok(());
    }
    let Some(handle) = app.rooms.get(room) else {
        return Ok(());
    };
    app.evictions.begin(room, drain);
    let (reply, answer) = oneshot::channel();
    let sent = handle
        .tx
        .send(RoomCmd::Evict {
            drain,
            notification,
            reply,
        })
        .await;
    let result = match sent {
        Ok(()) => answer.await.unwrap_or(Ok(())),
        // The room unloaded meanwhile: nothing left to evict.
        Err(_) => Ok(()),
    };
    app.evictions.end(room, drain);
    result
}

async fn persist_local(app: &Shared, room: &str) -> Result<(), String> {
    let Some(handle) = app.rooms.get(room) else {
        return Ok(());
    };
    let (reply, answer) = oneshot::channel();
    if handle.tx.send(RoomCmd::Persist(reply)).await.is_err() {
        return Ok(());
    }
    answer.await.unwrap_or(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operations_run_once() {
        let waiters = Completed::default();
        assert!(!waiters.seen("e1"));
        assert!(waiters.seen("e1"));
        assert!(!waiters.seen("e2"));
    }
}
