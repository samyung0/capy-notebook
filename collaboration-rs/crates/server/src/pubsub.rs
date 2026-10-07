//! Redis pub/sub (DESIGN.md 9): the Go outbox's evictions, user evictions,
//! comment invalidations, the eviction lease's drain requests and their
//! acknowledgements, and the idle-room lineage compaction that uses them.
//! Channels, keys and payloads are the Node server's.

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
pub const EVICT_REQUEST: &str = "capy:collaboration:evict-request";
pub const EVICT_ACK: &str = "capy:collaboration:evict-ack";
pub const USER_EVICT: &str = "capy:collaboration:user-evict";
pub const DELIVERED: &str = "capy:collaboration:eviction-delivered";
pub const COMMENTS: &str = "capy:collaboration:comments";
/// The API's "an embedded quiz or flashcard set changed" (Epo 2026-10-07).
pub const EMBEDS: &str = "capy:collaboration:embeds";
pub const INSTANCES: &str = "capy:collaboration:instances";
const EVICTING_PREFIX: &str = "capy:collaboration:evicting:";
/// An instance whose heartbeat is older than this is gone.
const INSTANCE_STALE: Duration = Duration::from_secs(60);
const EVICTION_TIMEOUT: Duration = Duration::from_secs(15);
/// An eviction id is remembered this long, so a redelivery runs once.
const COMPLETED_TTL: Duration = Duration::from_secs(600);

/// One drain request: the instances expected, those that answered, the reply.
type Waiting = (
    HashSet<String>,
    HashSet<String>,
    Option<oneshot::Sender<bool>>,
);

/// Eviction requests this instance waits on, and eviction ids already run.
#[derive(Default)]
pub struct Waiters {
    waiting: Mutex<HashMap<String, Waiting>>,
    completed: Mutex<HashMap<String, Instant>>,
}

impl Waiters {
    #[allow(clippy::unwrap_used)]
    fn ack(&self, request: &str, instance: &str, ok: bool) {
        let mut waiting = self.waiting.lock().unwrap();
        let Some((expected, received, reply)) = waiting.get_mut(request) else {
            return;
        };
        if !ok {
            if let Some(reply) = reply.take() {
                let _ = reply.send(false);
            }
            waiting.remove(request);
            return;
        }
        if !expected.contains(instance) {
            return;
        }
        received.insert(instance.to_owned());
        if received.len() >= expected.len() {
            if let Some(reply) = reply.take() {
                let _ = reply.send(true);
            }
            waiting.remove(request);
        }
    }

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
        EVICT_REQUEST,
        EVICT_ACK,
        USER_EVICT,
        COMMENTS,
        EMBEDS,
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
        EVICT_REQUEST => {
            let (Some(request), Some(room)) = (text("requestID"), text("room")) else {
                return;
            };
            let notification = json!({ "room": room, "type": "compaction-evict" }).to_string();
            let ok = match evict_local(app, &room, true, Some(notification), Some(&request)).await {
                Ok(()) => true,
                Err(error) => {
                    observe::capture(&error, None, &[("room", &room), ("stage", "eviction")]);
                    false
                }
            };
            let ack = json!({ "instanceID": app.instance_id, "ok": ok, "requestID": request, "room": room });
            if let Err(error) = publish(app, EVICT_ACK, &ack).await {
                observe::capture(&error, None, &[("stage", "eviction_ack_publish")]);
            }
        }
        EVICT_ACK => {
            if let (Some(request), Some(instance)) = (text("requestID"), text("instanceID")) {
                app.pubsub.ack(&request, &instance, event["ok"] == true);
            }
        }
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
        COMMENTS | EMBEDS => {
            let Some(room) = text("room") else { return };
            if let Some(handle) = app.rooms.get(&room) {
                let mut payload = event.clone();
                payload["type"] = json!(if channel == COMMENTS {
                    "comments-invalidated"
                } else {
                    "embed-changed"
                });
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
                    if event["type"] == "compaction-complete" {
                        evict_local(app, &room, false, Some(raw.clone()), eviction.as_deref()).await
                    } else if event["type"] == "account-access-restored" && drain {
                        // Restoration widens access: keep the room and its
                        // channels, only make what is pending durable.
                        persist_local(app, &room).await
                    } else {
                        evict_material_epochs(
                            app,
                            &material_id,
                            &room,
                            drain,
                            &raw,
                            eviction.as_deref(),
                        )
                        .await
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

/// Instances that heartbeat within the last minute, this one included.
async fn active_instances(app: &Shared) -> Result<HashSet<String>, String> {
    let mut redis = app.redis.clone();
    let entries: HashMap<String, String> = redis::cmd("HGETALL")
        .arg(INSTANCES)
        .query_async(&mut redis)
        .await
        .map_err(|error| error.to_string())?;
    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
        - INSTANCE_STALE.as_millis() as i64;
    let mut active: HashSet<String> = entries
        .into_iter()
        .filter(|(_, at)| at.parse::<i64>().is_ok_and(|at| at >= cutoff))
        .map(|(id, _)| id)
        .collect();
    active.insert(app.instance_id.clone());
    Ok(active)
}

/// `withDistributedEviction`: takes the room's eviction lease, has every
/// instance drain the room, then runs `action`. `None` when the lease was
/// taken or an instance could not drain.
async fn with_lease<T, F: std::future::Future<Output = Result<T, String>>>(
    app: &Shared,
    room: &str,
    action: impl FnOnce() -> F,
) -> Result<Option<T>, String> {
    let key = format!("{EVICTING_PREFIX}{room}");
    let request = uuid::Uuid::new_v4().to_string();
    let mut redis = app.redis.clone();
    let taken: Option<String> = redis::cmd("SET")
        .arg(&key)
        .arg(&request)
        .arg("PX")
        .arg(EVICTION_TIMEOUT.as_millis() as u64 * 4)
        .arg("NX")
        .query_async(&mut redis)
        .await
        .map_err(|error| error.to_string())?;
    if taken.is_none() {
        return Ok(None);
    }
    let expected = active_instances(app).await?;
    let (reply, answer) = oneshot::channel();
    #[allow(clippy::unwrap_used)]
    app.pubsub
        .waiting
        .lock()
        .unwrap()
        .insert(request.clone(), (expected, HashSet::new(), Some(reply)));
    let drained = async {
        publish(
            app,
            EVICT_REQUEST,
            &json!({ "instanceID": app.instance_id, "requestID": request, "room": room }),
        )
        .await?;
        Ok::<bool, String>(
            tokio::time::timeout(EVICTION_TIMEOUT, answer)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(false),
        )
    }
    .await;
    #[allow(clippy::unwrap_used)]
    app.pubsub.waiting.lock().unwrap().remove(&request);
    let result = match drained {
        Ok(true) => action().await.map(Some),
        Ok(false) => Ok(None),
        Err(error) => Err(error),
    };
    if result.is_ok() {
        let _ = redis::cmd("DEL")
            .arg(&key)
            .query_async::<i64>(&mut redis)
            .await;
    }
    result
}

/// Idle rooms whose stored state grew past `max(floor, size × multiplier)`
/// are rebuilt from their projection under a new room schema, every
/// compaction interval.
pub async fn run_compaction(app: Shared) {
    let mut tick = tokio::time::interval(app.config.compaction_interval);
    tick.tick().await;
    loop {
        tick.tick().await;
        if let Err(error) = compact_idle(&app).await {
            app.stats
                .store_failures
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            observe::capture(&error, None, &[("stage", "compaction")]);
        }
    }
}

async fn compact_idle(app: &Shared) -> Result<(), String> {
    let config = &app.config;
    let candidates = note_store::compaction_candidates(
        &app.db,
        config.compaction_idle.as_secs_f64(),
        config.compaction_floor_bytes as i64,
        config.compaction_multiplier as i64,
        config.compaction_max_rooms as i64,
    )
    .await
    .map_err(|error| error.to_string())?;
    for (material_id, schema, bytes) in candidates {
        let room = format!("material:{material_id}:schema:{schema}");
        if app.rooms.get(&room).is_some() {
            continue;
        }
        let compacted = with_lease(app, &room, || async {
            note_store::compact(&app.db, &material_id, schema)
                .await
                .map_err(|error| error.to_string())
        })
        .await?;
        let Some(Some((new_room, new_bytes))) = compacted else {
            continue;
        };
        let event = json!({
            "evictionId": uuid::Uuid::new_v4().to_string(),
            "materialId": material_id,
            "newRoom": new_room,
            "room": room,
            "type": "compaction-complete",
        });
        publish(app, EVICT, &event).await?;
        log(
            Level::Info,
            "compacted",
            json!({ "materialId": material_id, "before": bytes, "after": new_bytes }),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acks_complete_once_every_expected_instance_answered() {
        let waiters = Waiters::default();
        let (reply, mut answer) = oneshot::channel();
        waiters.waiting.lock().unwrap().insert(
            "r".into(),
            (
                HashSet::from(["a".to_owned(), "b".to_owned()]),
                HashSet::new(),
                Some(reply),
            ),
        );
        waiters.ack("r", "x", true);
        waiters.ack("r", "a", true);
        assert!(answer.try_recv().is_err());
        waiters.ack("r", "b", true);
        assert_eq!(answer.try_recv(), Ok(true));
    }

    #[test]
    fn a_refusal_fails_the_request() {
        let waiters = Waiters::default();
        let (reply, mut answer) = oneshot::channel();
        waiters.waiting.lock().unwrap().insert(
            "r".into(),
            (HashSet::from(["a".to_owned()]), HashSet::new(), Some(reply)),
        );
        waiters.ack("r", "a", false);
        assert_eq!(answer.try_recv(), Ok(false));
    }

    #[test]
    fn operations_run_once() {
        let waiters = Waiters::default();
        assert!(!waiters.seen("e1"));
        assert!(waiters.seen("e1"));
        assert!(!waiters.seen("e2"));
    }
}
