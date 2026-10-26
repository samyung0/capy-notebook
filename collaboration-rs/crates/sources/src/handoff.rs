//! Publication handoff, maintenance pause and deferred rebuild
//! (sourceHandoff.ts). Redis keys, channels and payloads are unchanged.
//!
//! Editors answer ready within [`READY_WINDOW`] or are closed; each instance
//! then persists the room and acknowledges. The coordinator waits
//! [`ACK_WAIT`] for that, then rebases and publishes within about one engine
//! call. The room lock covers both, and each instance's watchdog outlasts the
//! lock so it never restores editing while the coordinator can still publish.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use redis::AsyncCommands;
use redis::aio::ConnectionManager;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::engine::CALL_TIMEOUT;
use crate::gateway::{SourceSession, encode};
use crate::store::{Job, SourceRebase, Sources, rebase_refused};
use crate::{ChannelId, Rooms, SourceError, SourceFormat, SourceRoom};

pub const SOURCE_HANDOFF_CHANNEL: &str = "capy:collaboration:source-handoff";
pub const EVICTION_KEY_PREFIX: &str = "capy:collaboration:evicting:";
pub const INSTANCE_REGISTRY_KEY: &str = "capy:collaboration:instances";
const INSTANCE_TTL: Duration = Duration::from_secs(30);

pub const READY_WINDOW: Duration = Duration::from_secs(10);
pub const ACK_WAIT: Duration = Duration::from_secs(60);
pub const LOCK: Duration = Duration::from_secs(ACK_WAIT.as_secs() + CALL_TIMEOUT.as_secs());
pub const WATCHDOG: Duration = Duration::from_secs(LOCK.as_secs() + 5);
/// A rebuild locks the room only to confirm nobody has it open and to swap;
/// every step runs against the lock's expiry.
pub const PROBE_WAIT: Duration = Duration::from_secs(2);
pub const REBUILD_REQUEST: Duration = Duration::from_secs(15);
pub const REBUILD_MARGIN: Duration = Duration::from_secs(3);
pub const REBUILD_LOCK: Duration = Duration::from_secs(30);

/// UAT only (COLLABORATION_UAT_PUBLICATION_HOLD): a publication waits after
/// its capture while its file's name holds the marker, at most 60 s.
pub const PUBLICATION_HOLD_MARKER: &str = "[hold-publication]";
const PUBLICATION_HOLD: Duration = Duration::from_secs(60);

/// Authentication refusal reasons (the provider retries the first shortly
/// and shows the pause for the second).
pub const SOURCE_PUBLISHING_REASON: &str = "source-publishing";
pub const OFFICE_EDITING_PAUSED_REASON: &str = "office-editing-paused";
/// Close codes the browser knows.
pub const HANDOFF_TIMED_OUT: u16 = 4408;
pub const EDITING_PAUSED: u16 = 4423;

const RELEASE_LOCK: &str = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

/// What the gateway's publication takes (the internal publish route's body).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePublish {
    pub attempt_id: i64,
    pub checkpoint: u64,
    pub epoch: u64,
    pub file_id: String,
    pub job_id: String,
    pub lease_token: String,
    /// Every other field travels to the gateway unchanged.
    #[serde(flatten)]
    pub rest: serde_json::Map<String, Value>,
}

impl SourcePublish {
    /// The body without `fileId` (the gateway takes it in the route).
    fn publication(&self) -> serde_json::Map<String, Value> {
        let mut body = self.rest.clone();
        body.insert("attemptId".into(), json!(self.attempt_id));
        body.insert("checkpoint".into(), json!(self.checkpoint));
        body.insert("epoch".into(), json!(self.epoch));
        body.insert("jobId".into(), json!(self.job_id));
        body.insert("leaseToken".into(), json!(self.lease_token));
        body
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    room: String,
    #[serde(default)]
    file_id: String,
    #[serde(default)]
    epoch: u64,
    #[serde(default)]
    checkpoint: u64,
    #[serde(default)]
    writers_only: bool,
}

struct LocalHandoff {
    id: String,
    epoch: u64,
    checkpoint: u64,
    ready: HashSet<ChannelId>,
    sockets: HashSet<ChannelId>,
    done: Option<oneshot::Sender<bool>>,
    watchdog: tokio::task::JoinHandle<()>,
}

impl LocalHandoff {
    fn settle(&mut self, ok: bool) {
        if let Some(done) = self.done.take() {
            let _ = done.send(ok);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn redis_error(error: redis::RedisError) -> SourceError {
    SourceError::Other(format!("redis: {error}"))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

pub struct Handoff {
    instance_id: String,
    redis: ConnectionManager,
    sources: Arc<Sources>,
    rooms: Arc<dyn Rooms>,
    publication_hold: bool,
    local: Mutex<HashMap<String, LocalHandoff>>,
    /// Maintenance pauses in progress; a publication prepare waits for its room's.
    pausing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Handoff {
    pub fn new(
        instance_id: String,
        redis: ConnectionManager,
        sources: Arc<Sources>,
        rooms: Arc<dyn Rooms>,
        publication_hold: bool,
    ) -> Arc<Self> {
        Arc::new(Self {
            instance_id,
            redis,
            sources,
            rooms,
            publication_hold,
            local: Mutex::new(HashMap::new()),
            pausing: Mutex::new(HashMap::new()),
        })
    }

    /// A writer answered `source-handoff-ready`: true when it counts (the
    /// matching handoff, epoch and checkpoint, a clean editor, a waited-for
    /// channel); the server then makes that channel read-only.
    pub fn ready(&self, room: &str, channel: ChannelId, event: &Value) -> bool {
        let mut local = lock(&self.local);
        let Some(waiting) = local.get_mut(room) else {
            return false;
        };
        if event["id"].as_str() != Some(&waiting.id)
            || event["epoch"].as_u64() != Some(waiting.epoch)
            || event["checkpoint"].as_u64() != Some(waiting.checkpoint)
            || event["clean"] != Value::Bool(true)
            || !waiting.sockets.contains(&channel)
        {
            return false;
        }
        waiting.ready.insert(channel);
        if waiting.ready.len() == waiting.sockets.len() {
            waiting.settle(true);
        }
        true
    }

    /// A channel of `room` closed: a handoff stops waiting for it.
    pub fn closed(&self, room: &str, channel: ChannelId) {
        let mut local = lock(&self.local);
        let Some(waiting) = local.get_mut(room) else {
            return;
        };
        if waiting.ready.contains(&channel) {
            return;
        }
        waiting.sockets.remove(&channel);
        if waiting.ready.len() == waiting.sockets.len() {
            waiting.settle(true);
        }
    }

    /// A room whose publication handoff is under way; the pause waits for it.
    pub fn busy(&self, room: &str) -> bool {
        lock(&self.local).contains_key(room)
    }

    fn reset(&self, room: &str) {
        if let Some(waiting) = lock(&self.local).remove(room) {
            waiting.watchdog.abort();
        }
        self.rooms.restore_access(room);
    }

    fn broadcast(&self, room: &str, event: &Value, kind: &str) {
        let mut payload = event.clone();
        payload["type"] = json!(kind);
        self.rooms.broadcast(room, payload.to_string());
    }

    /// A handoff event from Redis (every instance receives every event).
    pub async fn handle(self: &Arc<Self>, raw: &str) -> Result<(), SourceError> {
        let Ok(value) = serde_json::from_str::<Value>(raw) else {
            return Ok(());
        };
        let Ok(event) = serde_json::from_value::<Event>(value.clone()) else {
            return Ok(());
        };
        if event.id.is_empty() || event.room.is_empty() || event.file_id.is_empty() {
            return Ok(());
        }
        let mut redis = self.redis.clone();
        match event.kind.as_str() {
            "probe" => {
                let key = format!("capy:source-handoff:{}", event.id);
                let busy =
                    self.busy(&event.room) || self.rooms.busy(&event.room, event.writers_only);
                let _: () = redis
                    .hset(&key, &self.instance_id, if busy { "busy" } else { "idle" })
                    .await
                    .map_err(redis_error)?;
                let _: () = redis.expire(&key, 30).await.map_err(redis_error)?;
            }
            "complete" => {
                self.broadcast(&event.room, &value, "source-epoch-changed");
                self.rooms.close(&event.room, None, None, "");
                self.reset(&event.room);
                if self.rooms.loaded(&event.room) {
                    self.rooms.unload(&event.room).await;
                }
            }
            "cancel" => {
                let cancelled = {
                    let mut local = lock(&self.local);
                    match local.get_mut(&event.room) {
                        Some(waiting) if waiting.id == event.id => {
                            waiting.settle(false);
                            true
                        }
                        _ => false,
                    }
                };
                if cancelled {
                    self.reset(&event.room);
                    self.broadcast(&event.room, &value, "source-handoff-cancel");
                }
            }
            "prepare" => {
                let pausing = lock(&self.pausing).get(&event.room).cloned();
                if let Some(pausing) = pausing {
                    drop(pausing.lock().await);
                }
                let current = lock(&self.local)
                    .get(&event.room)
                    .map(|waiting| waiting.id.clone());
                if current.as_deref() == Some(event.id.as_str()) {
                    return Ok(());
                }
                if current.is_some() {
                    self.reset(&event.room);
                }
                let ok =
                    !self.rooms.loaded(&event.room) || self.flush(&event, &value).await.is_ok();
                let key = format!("capy:source-handoff:{}", event.id);
                let _: () = redis
                    .hset(&key, &self.instance_id, if ok { "ready" } else { "failed" })
                    .await
                    .map_err(redis_error)?;
                let _: () = redis.expire(&key, 120).await.map_err(redis_error)?;
            }
            _ => {}
        }
        Ok(())
    }

    /// Every writer goes read-only and answers ready once the server holds
    /// its updates; one silent after the window is disconnected (it
    /// reconnects, and unsaved changes go to recovery), one that leaves stops
    /// being waited for. Then the room persists once.
    async fn flush(self: &Arc<Self>, event: &Event, raw: &Value) -> Result<(), SourceError> {
        let writers: Vec<ChannelId> = self
            .rooms
            .channels(&event.room)
            .into_iter()
            .filter(|channel| !channel.read_only)
            .map(|channel| channel.id)
            .collect();
        let (done, settled) = oneshot::channel();
        let watchdog = {
            let this = self.clone();
            let event = event.clone();
            tokio::spawn(async move {
                tokio::time::sleep(WATCHDOG).await;
                this.recover_later(event).await;
            })
        };
        let mut waiting = LocalHandoff {
            id: event.id.clone(),
            epoch: event.epoch,
            checkpoint: event.checkpoint,
            ready: HashSet::new(),
            sockets: writers.iter().copied().collect(),
            done: Some(done),
            watchdog,
        };
        if writers.is_empty() {
            waiting.settle(true);
        }
        lock(&self.local).insert(event.room.clone(), waiting);
        if !writers.is_empty() {
            self.broadcast(&event.room, raw, "source-handoff-prepare");
        }
        match tokio::time::timeout(READY_WINDOW, settled).await {
            Ok(Ok(true)) => {}
            Ok(_) => return Err(SourceError::Other("Source handoff cancelled".into())),
            Err(_) => {
                let ready = lock(&self.local)
                    .get(&event.room)
                    .map(|waiting| waiting.ready.clone())
                    .unwrap_or_default();
                for writer in writers.iter().filter(|writer| !ready.contains(writer)) {
                    self.rooms.set_read_only(&event.room, *writer);
                    self.rooms.close(
                        &event.room,
                        Some(*writer),
                        Some(HANDOFF_TIMED_OUT),
                        "Source handoff timed out",
                    );
                }
            }
        }
        self.rooms
            .persist(&event.room)
            .await
            .map_err(SourceError::Other)
    }

    /// [`Self::recover`] behind a box, which ends the type cycle of
    /// flush -> watchdog -> recover -> handle -> flush.
    fn recover_later(self: Arc<Self>, event: Event) -> crate::BoxFuture<()> {
        Box::pin(async move { self.recover(&event).await })
    }

    /// A lost coordinator: complete an epoch that moved, else cancel; with the
    /// API unavailable close the room's channels (they reconnect and check
    /// the epoch before sending anything buffered).
    async fn recover(self: &Arc<Self>, event: &Event) {
        if lock(&self.local)
            .get(&event.room)
            .map(|waiting| waiting.id.as_str())
            != Some(event.id.as_str())
        {
            return;
        }
        match self.sources.current(&event.file_id).await {
            Ok(current) => {
                let kind = if current.epoch == event.epoch {
                    "cancel"
                } else {
                    "complete"
                };
                let raw = json!({
                    "checkpoint": event.checkpoint,
                    "epoch": event.epoch,
                    "fileId": event.file_id,
                    "id": event.id,
                    "newEpoch": current.epoch,
                    "room": event.room,
                    "type": kind,
                });
                let _ = self.handle(&raw.to_string()).await;
            }
            Err(_) => {
                self.rooms.close(&event.room, None, None, "");
                self.reset(&event.room);
            }
        }
    }

    /// The maintenance pause: the handoff flush, then every writer closes
    /// (4423). After a successful persist each writer first hears
    /// `source-editing-paused`. Whether the room was saved.
    pub async fn pause(self: &Arc<Self>, room: &SourceRoom) -> bool {
        let name = room.name();
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let held = gate.clone().lock_owned().await;
        lock(&self.pausing).insert(name.clone(), gate);
        let event = Event {
            kind: "prepare".into(),
            id: format!("pause:{name}"),
            room: name.clone(),
            file_id: room.file_id.clone(),
            epoch: room.epoch,
            checkpoint: 0,
            writers_only: false,
        };
        let raw = json!({
            "checkpoint": 0,
            "epoch": room.epoch,
            "fileId": room.file_id,
            "id": event.id,
            "room": name,
            "type": "prepare",
        });
        let saved = self.flush(&event, &raw).await.is_ok();
        if saved {
            self.rooms.broadcast(
                &name,
                json!({ "epoch": room.epoch, "fileId": room.file_id, "type": "source-editing-paused" }).to_string(),
            );
        }
        for channel in self.rooms.channels(&name) {
            if channel.write {
                self.rooms.close(
                    &name,
                    Some(channel.id),
                    Some(EDITING_PAUSED),
                    OFFICE_EDITING_PAUSED_REASON,
                );
            }
        }
        if lock(&self.local)
            .get(&name)
            .map(|waiting| waiting.id.as_str())
            == Some(event.id.as_str())
        {
            self.reset(&name);
        }
        lock(&self.pausing).remove(&name);
        drop(held);
        saved
    }

    /// Live instances by the server's heartbeat registry (30 s TTL, twice).
    async fn active_instances(&self) -> Result<HashSet<String>, SourceError> {
        let mut redis = self.redis.clone();
        let entries: HashMap<String, String> = redis
            .hgetall(INSTANCE_REGISTRY_KEY)
            .await
            .map_err(redis_error)?;
        let cutoff = now_ms().saturating_sub(INSTANCE_TTL.as_millis() * 2);
        let mut active: HashSet<String> = entries
            .into_iter()
            .filter(|(_, at)| at.parse::<u128>().is_ok_and(|at| at >= cutoff))
            .map(|(instance, _)| instance)
            .collect();
        active.insert(self.instance_id.clone());
        Ok(active)
    }

    async fn release(&self, lock_key: &str, id: &str) {
        let mut redis = self.redis.clone();
        let _: Result<i64, _> = redis::Script::new(RELEASE_LOCK)
            .key(lock_key)
            .arg(id)
            .invoke_async(&mut redis)
            .await;
        let _: Result<(), _> = redis.del(format!("capy:source-handoff:{id}")).await;
    }

    /// A rebuild attempt in the background; a failure waits for the sweep.
    pub fn schedule_rebuild(self: &Arc<Self>, file_id: &str) {
        let this = self.clone();
        let file_id = file_id.to_owned();
        tokio::spawn(async move {
            if let Err(error) = this.rebuild(&file_id).await {
                crate::observe::capture(
                    &error.to_string(),
                    &[("stage", "source_rebuild"), ("file_id", &file_id)],
                );
            }
        });
    }

    /// Moves editing onto the published file after a deferred publication,
    /// once nobody has the room open on any instance: rebase first, then a
    /// short lock to confirm the room is empty everywhere and the gateway's
    /// compare-and-swap. A refused rebase is recorded and never tried again.
    pub async fn rebuild(&self, file_id: &str) -> Result<bool, SourceError> {
        if !self.sources.rebuild_pending(file_id).await? {
            return Ok(false);
        }
        let client = self
            .sources
            .db()
            .get()
            .await
            .map_err(|error| SourceError::Other(error.to_string()))?;
        // The pause closed every writer; a viewer left open must not hold the
        // maintenance window.
        let writers_only: bool = client
            .query_one("SELECT EXISTS(SELECT 1 FROM office_editing_pause)", &[])
            .await
            .map_err(|error| SourceError::Other(error.to_string()))?
            .get(0);
        // `current` takes a connection of its own.
        drop(client);
        let session = self.sources.current(file_id).await?;
        if !session.rebuild_pending || session.format == SourceFormat::Text {
            return Ok(false);
        }
        if self.busy(&session.room) || self.rooms.busy(&session.room, writers_only) {
            return Ok(false);
        }
        let rebase = match self.rebuild_publication(&session).await {
            Ok(rebase) => rebase,
            Err(error) if rebase_refused(&error) => {
                let recorded: Result<Value, SourceError> = self
                    .sources
                    .gateway()
                    .file(
                        file_id,
                        "rebuild-refusal",
                        Some(&json!({
                            "epoch": session.epoch,
                            "error": error.to_string(),
                            "publishedSourceSHA256": session.published_source_sha256,
                        })),
                        None,
                        None,
                    )
                    .await;
                return match recorded {
                    // A publication or rebuild since: a later attempt rebuilds that.
                    Err(recording) if recording.status() == Some(409) => Ok(false),
                    Err(recording) => Err(recording),
                    // A documented outcome, not a failure: logged once and
                    // never sent to Sentry. Neither the sweep nor an unload
                    // retries it.
                    Ok(_) => {
                        crate::observe::log(
                            "warn",
                            "office_rebuild_refused",
                            json!({ "error": error.to_string(), "room": session.room }),
                        );
                        Ok(false)
                    }
                };
            }
            Err(error) => return Err(error),
        };
        let id = format!("rebuild:{}", uuid_like());
        let lock_key = format!("{EVICTION_KEY_PREFIX}{}", session.room);
        // Read before the lock is set, so the lock outlives it.
        let expiry = Instant::now() + REBUILD_LOCK;
        let mut redis = self.redis.clone();
        let set: Option<String> = redis::cmd("SET")
            .arg(&lock_key)
            .arg(&id)
            .arg("PX")
            .arg(REBUILD_LOCK.as_millis() as u64)
            .arg("NX")
            .query_async(&mut redis)
            .await
            .map_err(redis_error)?;
        if set.is_none() {
            return Ok(false);
        }
        let result = async {
            if !self.room_empty(&session, &id, writers_only).await? {
                return Ok(false);
            }
            if Instant::now() + REBUILD_REQUEST + REBUILD_MARGIN > expiry {
                return Ok(false);
            }
            let mut body = json!({
                "epoch": session.epoch,
                "expectedCheckpoint": session.checkpoint,
                "netTokens": rebase.net_tokens,
                "pendingEffects": rebase.pending_effects,
                "publishedSourceSHA256": session.published_source_sha256,
            });
            if let Some(state) = &rebase.rebased_state {
                body["state"] = json!(base64_encode(state));
                body["stateSeedSHA256"] = json!(rebase.rebased_state_seed_sha256);
            }
            let swapped: Result<Value, SourceError> = self
                .sources
                .gateway()
                .file(file_id, "rebuild", Some(&body), None, Some(REBUILD_REQUEST))
                .await;
            match swapped {
                Err(error) if error.status() == Some(409) => return Ok(false),
                Err(error) => return Err(error),
                Ok(_) => {}
            }
            // A connection that slipped in meanwhile learns of the new epoch.
            let _: () = redis
                .publish(
                    SOURCE_HANDOFF_CHANNEL,
                    json!({
                        "epoch": session.epoch,
                        "fileId": file_id,
                        "id": id,
                        "newEpoch": session.epoch + 1,
                        "room": session.room,
                        "type": "complete",
                    })
                    .to_string(),
                )
                .await
                .map_err(redis_error)?;
            Ok(true)
        }
        .await;
        self.release(&lock_key, &id).await;
        result
    }

    /// Every live instance answers the probe: idle, or busy with the room.
    async fn room_empty(
        &self,
        session: &SourceSession,
        id: &str,
        writers_only: bool,
    ) -> Result<bool, SourceError> {
        let deadline = Instant::now() + PROBE_WAIT;
        let instances = self.active_instances().await?;
        let mut redis = self.redis.clone();
        let _: () = redis
            .publish(
                SOURCE_HANDOFF_CHANNEL,
                json!({
                    "epoch": session.epoch,
                    "fileId": session.file_id,
                    "id": id,
                    "room": session.room,
                    "type": "probe",
                    "writersOnly": writers_only,
                })
                .to_string(),
            )
            .await
            .map_err(redis_error)?;
        loop {
            let answers: HashMap<String, String> = redis
                .hgetall(format!("capy:source-handoff:{id}"))
                .await
                .map_err(redis_error)?;
            // A reply read after the deadline counts for nothing.
            if Instant::now() >= deadline || answers.values().any(|answer| answer == "busy") {
                return Ok(false);
            }
            if instances
                .iter()
                .all(|instance| answers.get(instance).map(String::as_str) == Some("idle"))
            {
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn hold(&self, file_id: &str) -> Result<(), SourceError> {
        let deadline = Instant::now() + PUBLICATION_HOLD;
        loop {
            let client = self
                .sources
                .db()
                .get()
                .await
                .map_err(|error| SourceError::Other(error.to_string()))?;
            let name: Option<String> = client
                .query_opt("SELECT name FROM files WHERE id=$1", &[&file_id])
                .await
                .map_err(|error| SourceError::Other(error.to_string()))?
                .map(|row| row.get(0));
            drop(client);
            if !name.is_some_and(|name| name.contains(PUBLICATION_HOLD_MARKER)) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(SourceError::request(
                    503,
                    "Publication hold timed out",
                    None,
                ));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// A finalized candidate's publication (`POST /internal/source-refresh/publish`).
    pub async fn publish(self: &Arc<Self>, input: &SourcePublish) -> Result<Value, SourceError> {
        // Text and Office alike. Editors stay writable during the hold: their
        // saves land after the capture, and the session is read after it.
        if self.publication_hold {
            self.hold(&input.file_id).await?;
        }
        let session = self.sources.current(&input.file_id).await?;
        let publication = input.publication();
        let gateway = self.sources.gateway();
        let client = self
            .sources
            .db()
            .get()
            .await
            .map_err(|error| SourceError::Other(error.to_string()))?;
        let fenced: bool = client
            .query_one(
                "SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND payload->>'fileId'=$2 AND payload->>'sourceEpoch'=$3 AND payload->>'sourceCheckpoint'=$4 AND payload->>'sourceLeaseToken'=$5 AND payload->>'sourcePublishedCheckpoint'=$4 AND payload->>'sourcePublishedAttemptId'=$6) AS published",
                &[
                    &input.job_id,
                    &input.file_id,
                    &input.epoch.to_string(),
                    &input.checkpoint.to_string(),
                    &input.lease_token,
                    &input.attempt_id.to_string(),
                ],
            )
            .await
            .map_err(|error| SourceError::Other(error.to_string()))?
            .get(0);
        if fenced {
            let mut body = publication.clone();
            body.insert("expectedLatestCheckpoint".into(), json!(session.checkpoint));
            body.insert("netTokens".into(), json!(0));
            body.insert("pendingEffects".into(), json!([]));
            return gateway
                .file(&input.file_id, "publish", Some(&body), None, None)
                .await;
        }
        if session.epoch != input.epoch {
            return Err(SourceError::request(409, "Source epoch changed", None));
        }
        let captured = client
            .query_opt(
                "SELECT c.state,c.state_seed_sha256 FROM source_refresh_candidates c WHERE c.file_id=$1 AND c.job_id=$2 AND c.lease_token=$3 AND c.checkpoint=$4",
                &[&input.file_id, &input.job_id, &input.lease_token, &(input.checkpoint as i64)],
            )
            .await
            .map_err(|error| SourceError::Other(error.to_string()))?
            .map(|row| (row.get::<_, Option<Vec<u8>>>(0), row.get::<_, Option<String>>(1)));
        drop(client);
        if session.format == SourceFormat::Text {
            let Some((state, _)) = captured else {
                return Err(SourceError::request(409, "Source candidate changed", None));
            };
            // Text keeps its lineage: later edits stay a residual against the
            // exported text.
            let job = Job::default();
            let baseline = self
                .sources
                .captured_text(&session, state.as_deref(), &job)
                .await?;
            let mut latest = session;
            for attempt in 0..4 {
                if attempt > 0 {
                    latest = self.sources.current(&input.file_id).await?;
                }
                let (effects, tokens) = self
                    .sources
                    .effects_of_durable(&latest, Some(&baseline), &job)
                    .await?;
                let mut body = publication.clone();
                body.insert("expectedLatestCheckpoint".into(), json!(latest.checkpoint));
                body.insert("netTokens".into(), json!(tokens));
                body.insert("pendingEffects".into(), json!(effects));
                match gateway
                    .file(&input.file_id, "publish", Some(&body), None, None)
                    .await
                {
                    Err(error) if error.status() == Some(409) && attempt < 3 => {}
                    result => return result,
                }
            }
            return Err(SourceError::Other(
                "Source publication could not be committed".into(),
            ));
        }
        let client = self
            .sources
            .db()
            .get()
            .await
            .map_err(|error| SourceError::Other(error.to_string()))?;
        let system: bool = client
            .query_opt(
                "SELECT COALESCE(payload->>'paidBy','')='system' AND EXISTS(SELECT 1 FROM office_editing_pause) AS system FROM jobs WHERE id=$1 AND payload->>'fileId'=$2",
                &[&input.job_id, &input.file_id],
            )
            .await
            .map_err(|error| SourceError::Other(error.to_string()))?
            .is_some_and(|row| row.get::<_, Option<bool>>(0) == Some(true));
        drop(client);
        // The owner's, automatic and drain work publishes without touching
        // editing; only a system publication during the pause hands off.
        if !system {
            let Some(captured) = captured else {
                return Err(SourceError::request(409, "Source candidate changed", None));
            };
            return self
                .publish_deferred(input, publication, session, captured)
                .await;
        }
        self.publish_handoff(input, publication, session).await
    }

    /// A deferred publication: the file and its index change while every
    /// editor keeps its document; the count restarts from the latest save's
    /// effects against the capture on the same base; the rebuild waits for an
    /// empty room.
    async fn publish_deferred(
        self: &Arc<Self>,
        input: &SourcePublish,
        publication: serde_json::Map<String, Value>,
        session: SourceSession,
        captured: (Option<Vec<u8>>, Option<String>),
    ) -> Result<Value, SourceError> {
        let mut latest = session;
        let job = Job::default();
        for attempt in 0..4 {
            if attempt > 0 {
                latest = self.sources.current(&input.file_id).await?;
            }
            if latest.epoch != input.epoch {
                return Err(SourceError::request(409, "Source epoch changed", None));
            }
            let (_, tokens) = if latest.checkpoint == input.checkpoint {
                (Vec::new(), 0)
            } else {
                let published = SourceSession {
                    published_state: captured.0.clone(),
                    published_state_seed_sha256: captured.1.clone(),
                    rebuild_pending: true,
                    ..latest.clone()
                };
                self.sources
                    .effects_of_durable(&published, None, &job)
                    .await?
            };
            // The residual resets the count; Office effects are read on
            // demand, never stored (Q405).
            let mut body = publication.clone();
            body.insert("deferred".into(), json!(true));
            body.insert("expectedLatestCheckpoint".into(), json!(latest.checkpoint));
            body.insert("netTokens".into(), json!(tokens));
            body.insert("pendingEffects".into(), json!([]));
            match self
                .sources
                .gateway()
                .file::<Value>(&input.file_id, "publish", Some(&body), None, None)
                .await
            {
                Ok(result) => {
                    self.schedule_rebuild(&input.file_id);
                    return Ok(result);
                }
                Err(error) if error.status() == Some(409) && attempt < 3 => {}
                Err(error) => return Err(error),
            }
        }
        Err(SourceError::Other(
            "Source publication could not be committed".into(),
        ))
    }

    /// A system publication during the maintenance pause: every instance
    /// flushes the room under its lock, the latest saves rebase onto the
    /// export, and editing moves to the next epoch.
    async fn publish_handoff(
        self: &Arc<Self>,
        input: &SourcePublish,
        publication: serde_json::Map<String, Value>,
        session: SourceSession,
    ) -> Result<Value, SourceError> {
        let id = uuid_like();
        let room = session.room.clone();
        let lock_key = format!("{EVICTION_KEY_PREFIX}{room}");
        let mut redis = self.redis.clone();
        let set: Option<String> = redis::cmd("SET")
            .arg(&lock_key)
            .arg(&id)
            .arg("PX")
            .arg(LOCK.as_millis() as u64)
            .arg("NX")
            .query_async(&mut redis)
            .await
            .map_err(redis_error)?;
        if set.is_none() {
            return Err(SourceError::request(
                503,
                "Source handoff already running",
                None,
            ));
        }
        let mut completed = false;
        let result = async {
            let instances = self.active_instances().await?;
            let _: () = redis
                .publish(
                    SOURCE_HANDOFF_CHANNEL,
                    json!({
                        "checkpoint": input.checkpoint,
                        "epoch": input.epoch,
                        "fileId": input.file_id,
                        "id": id,
                        "room": room,
                        "type": "prepare",
                    })
                    .to_string(),
                )
                .await
                .map_err(redis_error)?;
            let deadline = Instant::now() + ACK_WAIT;
            loop {
                let acknowledgments: HashMap<String, String> = redis
                    .hgetall(format!("capy:source-handoff:{id}"))
                    .await
                    .map_err(redis_error)?;
                if acknowledgments.values().any(|answer| answer == "failed") {
                    return Err(SourceError::request(
                        503,
                        "An editor has uncommitted changes",
                        None,
                    ));
                }
                if instances.iter().all(|instance| {
                    acknowledgments.get(instance).map(String::as_str) == Some("ready")
                }) {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(SourceError::request(503, "Source handoff timed out", None));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            for _ in 0..4 {
                let latest = self.sources.current(&input.file_id).await?;
                if latest.epoch != input.epoch {
                    return Err(SourceError::request(409, "Source epoch changed", None));
                }
                let rebased = self.rebase_publication(&latest, input).await?;
                let holder: Option<String> = redis.get(&lock_key).await.map_err(redis_error)?;
                if holder.as_deref() != Some(id.as_str()) {
                    return Err(SourceError::request(
                        503,
                        "Source handoff lease expired",
                        None,
                    ));
                }
                let mut body = publication.clone();
                if let Value::Object(rebased) = serde_json::to_value(&rebased).unwrap_or_default() {
                    body.extend(rebased);
                }
                body.insert("expectedLatestCheckpoint".into(), json!(latest.checkpoint));
                match self
                    .sources
                    .gateway()
                    .file::<Value>(&input.file_id, "publish", Some(&body), None, None)
                    .await
                {
                    Ok(result) => {
                        completed = true;
                        let _: () = redis
                            .publish(
                                SOURCE_HANDOFF_CHANNEL,
                                json!({
                                    "epoch": input.epoch,
                                    "fileId": input.file_id,
                                    "id": id,
                                    "newEpoch": input.epoch + 1,
                                    "room": room,
                                    "type": "complete",
                                })
                                .to_string(),
                            )
                            .await
                            .map_err(redis_error)?;
                        return Ok(result);
                    }
                    Err(error) if error.status() == Some(409) => {
                        let current = self.sources.current(&input.file_id).await?;
                        if current.epoch != latest.epoch || current.checkpoint == latest.checkpoint
                        {
                            return Err(error);
                        }
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(SourceError::request(
                503,
                "Source saves advanced during publication",
                None,
            ))
        }
        .await;
        if !completed {
            // A timed-out request can have committed: read the epoch before
            // letting a client resume writing its old document.
            let current = self.sources.current(&input.file_id).await.ok();
            let moved = current
                .as_ref()
                .is_some_and(|current| current.epoch != input.epoch);
            let _: Result<(), _> = redis
                .publish(
                    SOURCE_HANDOFF_CHANNEL,
                    json!({
                        "epoch": input.epoch,
                        "fileId": input.file_id,
                        "id": id,
                        "newEpoch": current.map(|current| current.epoch),
                        "room": room,
                        "type": if moved { "complete" } else { "cancel" },
                    })
                    .to_string(),
                )
                .await;
        }
        self.release(&lock_key, &id).await;
        result
    }

    /// The publication's rebase: the edits saved after the capture landed on
    /// seed(export); nothing saved since leaves the state seed(export).
    async fn rebase_publication(
        &self,
        session: &SourceSession,
        input: &SourcePublish,
    ) -> Result<SourceRebase, SourceError> {
        let client = self
            .sources
            .db()
            .get()
            .await
            .map_err(|error| SourceError::Other(error.to_string()))?;
        let candidate = client
            .query_opt(
                "SELECT c.state,c.state_seed_sha256,c.source_sha256 FROM source_refresh_candidates c WHERE c.file_id=$1 AND c.job_id=$2 AND c.lease_token=$3 AND c.epoch=$4 AND c.checkpoint=$5",
                &[
                    &input.file_id,
                    &input.job_id,
                    &input.lease_token,
                    &(input.epoch as i64),
                    &(input.checkpoint as i64),
                ],
            )
            .await
            .map_err(|error| SourceError::Other(error.to_string()))?
            .ok_or_else(|| SourceError::request(409, "Source candidate changed", None))?;
        drop(client);
        if session.checkpoint == input.checkpoint {
            return Ok(SourceRebase::default());
        }
        #[derive(Deserialize)]
        struct Link {
            #[serde(rename = "sourceURL")]
            source_url: String,
        }
        let link: Link = self
            .sources
            .gateway()
            .file(
                &input.file_id,
                &format!(
                    "refresh-source?jobId={}&leaseToken={}",
                    encode(&input.job_id),
                    encode(&input.lease_token)
                ),
                None::<&()>,
                None,
                None,
            )
            .await?;
        let state: Option<Vec<u8>> = candidate.get(0);
        let seed: Option<String> = candidate.get(1);
        let sha: String = candidate.get::<_, Option<String>>(2).unwrap_or_default();
        self.sources
            .rebase_onto(
                session,
                (state.as_deref(), seed.as_deref()),
                (&link.source_url, &sha),
            )
            .await
    }

    /// The rebuild after a deferred publication: the edits saved after the
    /// published capture landed on seed(published).
    async fn rebuild_publication(
        &self,
        session: &SourceSession,
    ) -> Result<SourceRebase, SourceError> {
        let (Some(url), Some(sha)) = (
            &session.published_source_url,
            &session.published_source_sha256,
        ) else {
            return Err(SourceError::Other("Source has no pending rebuild".into()));
        };
        if !session.rebuild_pending {
            return Err(SourceError::Other("Source has no pending rebuild".into()));
        }
        if session.checkpoint == session.indexed_checkpoint {
            return Ok(SourceRebase::default());
        }
        self.sources
            .rebase_onto(
                session,
                (
                    session.published_state.as_deref(),
                    session.published_state_seed_sha256.as_deref(),
                ),
                (url, sha),
            )
            .await
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A random handoff id (no uuid crate: 128 random bits as hex).
fn uuid_like() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for _ in 0..2 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u128(now_ms());
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}
