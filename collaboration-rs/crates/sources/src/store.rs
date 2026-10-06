//! Source documents (sourceDocuments.ts) with delta saves (Epo 2026-10-06):
//! a room loads base + log and checks it, a store appends only the room's
//! update since its durable state (the row) through the gateway's checkpoint
//! CAS, and a fold merges the log into the base. Office effects come from the
//! engine pool on the room's whole state; text effects from the change.
//!
//! Stored layout (DESIGN 3.1): `source_documents.state` is the base (an
//! Office change over seed(base) with `state_seed_sha256`, or a whole text
//! state; NULL is seed(base)); `source_document_updates(file_id, epoch,
//! checkpoint, update)` holds the rows appended since, one per checkpoint.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use office_service::{BaselineEntry, Format, NetEffect, ObjectRef};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Transact, Update};

use crate::cache::ByteCache;
use crate::effects::{effect_tokens, trim_effect, utf16};
use crate::engine::office::calls::On;
use crate::engine::{EngineError, EnginePool, FailureKind, PoolConfig};
use crate::gateway::{CheckpointBody, CheckpointSaved, Gateway, RefreshCandidate, SourceSession};
use crate::text::{TEXT_ROOT, TextSave, TextWindow, full_text_effects, text_doc, text_seed};
use crate::{MAX_SOURCE_STATE_BYTES, SourceError, SourceFormat, SourceRoom};

const BASE_CACHE_BYTES: u64 = 128 << 20;
const SEED_CACHE_BYTES: u64 = 64 << 20;
const BASELINE_CACHE_BYTES: u64 = 64 << 20;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Checkpoint CAS attempts per save (a moved checkpoint reloads and retries).
const SAVE_ATTEMPTS: usize = 4;

pub struct SourcesConfig {
    pub api_url: String,
    pub secret: String,
    pub engine: PoolConfig,
}

/// seed(base) and what is derived from it once.
struct Seed {
    state: Vec<u8>,
    sha256: String,
    vector: StateVector,
}

/// What this instance knows of a loaded room between its saves.
struct RoomRecord {
    session: SourceSession,
    /// The checkpoint the room's durable state is at.
    checkpoint: u64,
    /// A NULL state with no rows: the first save reports the seed.
    seeded: bool,
    /// Text: the indexed baseline and the last saved effect's window.
    baseline: Option<Arc<Vec<u16>>>,
    window: Option<TextWindow>,
}

/// A source room just loaded.
#[derive(Debug)]
pub struct Loaded {
    pub format: SourceFormat,
    pub checkpoint: u64,
    /// The bytes applied (seed, base and rows), the room's first size estimate.
    pub bytes: u64,
    pub session: SourceSession,
}

/// One store of a room: its update since the durable state and what the
/// effects are read from.
pub struct Save {
    pub row: Vec<u8>,
    /// Office: the room's whole state, which the engine reads effects from.
    pub state: Option<Vec<u8>>,
    /// Text: effects from the change ([`Sources::text_effects`]).
    pub text: Option<TextSave>,
    /// The writers whose markers the row holds; the first authorizes reads.
    pub actors: Vec<String>,
    /// The first failure's Sentry event while this store retries it.
    pub retry_event: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Saved {
    pub checkpoint: u64,
}

/// The rows and base a room's durable state is made of, read in one snapshot.
struct Stored {
    state: Option<Vec<u8>>,
    state_seed_sha256: Option<String>,
    checkpoint: u64,
    epoch: u64,
    base_revision: i64,
    rows: Vec<(u64, Vec<u8>)>,
}

/// A rebase onto new bytes; none (no save after the capture) leaves the
/// state seed(new bytes), with no effects.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRebase {
    pub net_tokens: u64,
    pub pending_effects: Vec<NetEffect>,
    #[serde(skip_serializing_if = "Option::is_none", with = "opt_base64")]
    pub rebased_state: Option<Vec<u8>>,
    #[serde(
        rename = "rebasedStateSeedSHA256",
        skip_serializing_if = "Option::is_none"
    )]
    pub rebased_state_seed_sha256: Option<String>,
}

mod opt_base64 {
    pub fn serialize<S: serde::Serializer>(
        bytes: &Option<Vec<u8>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        crate::gateway::base64_bytes::serialize(bytes, serializer)
    }
}

/// An editable view of a durable source (agent reads).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInspection {
    pub access: String,
    pub checkpoint: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<office_service::Entry>>,
    pub epoch: u64,
    pub format: SourceFormat,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveInput {
    pub file_id: String,
    pub workspace_id: String,
    pub user_id: String,
    pub epoch: u64,
    pub checkpoint: u64,
    pub change_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAsset {
    pub bytes: String,
    pub mime_type: String,
    pub sha256: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn db_error(error: impl std::fmt::Display) -> SourceError {
    SourceError::Other(format!("source database: {error}"))
}

pub(crate) fn office(format: SourceFormat) -> Option<Format> {
    match format {
        SourceFormat::Docx => Some(Format::Docx),
        SourceFormat::Xlsx => Some(Format::Xlsx),
        SourceFormat::Pptx => Some(Format::Pptx),
        SourceFormat::Text => None,
    }
}

fn decode(bytes: &[u8]) -> Result<Update, SourceError> {
    Update::decode_v1(bytes)
        .map_err(|error| SourceError::State(format!("malformed stored update: {error}")))
}

/// Applies `updates` in one transaction (seed plus change, as a fresh
/// document applies a whole state) and refuses a result with pending
/// content: every item a change refers to must be in what precedes it.
fn replay<'a>(doc: &Doc, updates: impl IntoIterator<Item = &'a [u8]>) -> Result<(), SourceError> {
    let mut txn = doc.transact_mut();
    for bytes in updates {
        txn.apply_update(decode(bytes)?).map_err(|error| {
            SourceError::State(format!("stored update does not apply: {error}"))
        })?;
    }
    if txn.store().pending_update().is_some() || txn.store().pending_ds().is_some() {
        return Err(SourceError::State(
            "The saved changes refer to content missing from the seed".into(),
        ));
    }
    Ok(())
}

fn encode(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

pub struct Sources {
    gateway: Gateway,
    db: deadpool_postgres::Pool,
    engines: EnginePool,
    bases: Mutex<ByteCache<Arc<Vec<u8>>>>,
    seeds: Mutex<ByteCache<Arc<Seed>>>,
    baselines: Mutex<ByteCache<Arc<Vec<BaselineEntry>>>>,
    rooms: Mutex<HashMap<String, RoomRecord>>,
}

impl Sources {
    /// Needs a tokio runtime (the engine pool's supervisors).
    pub fn new(config: SourcesConfig, db: deadpool_postgres::Pool, http: reqwest::Client) -> Self {
        Self {
            gateway: Gateway::new(http, config.api_url, config.secret),
            db,
            engines: EnginePool::new(config.engine),
            bases: Mutex::new(ByteCache::new(BASE_CACHE_BYTES)),
            seeds: Mutex::new(ByteCache::new(SEED_CACHE_BYTES)),
            baselines: Mutex::new(ByteCache::new(BASELINE_CACHE_BYTES)),
            rooms: Mutex::new(HashMap::new()),
        }
    }

    pub fn gateway(&self) -> &Gateway {
        &self.gateway
    }

    pub fn engines(&self) -> &EnginePool {
        &self.engines
    }

    pub fn db(&self) -> &deadpool_postgres::Pool {
        &self.db
    }

    /// A base by its SHA (verified, cached); an unbound one is hashed.
    pub(crate) async fn base(&self, url: &str, sha: &str) -> Result<Arc<Vec<u8>>, SourceError> {
        if !sha.is_empty()
            && let Some(bytes) = lock(&self.bases).get(sha)
        {
            return Ok(bytes);
        }
        let bytes = read_source_bytes(self.gateway.http(), url).await?;
        let actual = office_service::sha256_hex(&bytes);
        if !sha.is_empty() && actual != sha {
            return Err(SourceError::Other("Source SHA mismatch".into()));
        }
        let bytes = Arc::new(bytes);
        lock(&self.bases).set(&actual, bytes.clone(), bytes.len() as u64);
        Ok(bytes)
    }

    /// seed(base) (what a NULL state stands for), cached per format and base.
    async fn seed(
        &self,
        format: SourceFormat,
        base: &[u8],
        sha: &str,
        room: Option<&str>,
    ) -> Result<Arc<Seed>, SourceError> {
        let key = format!("{format:?}:{sha}");
        if let Some(seed) = lock(&self.seeds).get(&key) {
            return Ok(seed);
        }
        let state = match office(format) {
            None => text_seed(base).map_err(|error| {
                SourceError::State(format!("text source is not UTF-8: {error}"))
            })?,
            Some(format) => {
                self.engines
                    .seed(On {
                        format,
                        base,
                        base_sha256: sha,
                        room,
                    })
                    .await?
            }
        };
        let vector = decode(&state)?.state_vector();
        let seed = Arc::new(Seed {
            sha256: office_service::sha256_hex(&state),
            vector,
            state,
        });
        lock(&self.seeds).set(&key, seed.clone(), seed.state.len() as u64);
        Ok(seed)
    }

    /// The base of `session` with its SHA bound (hashed when the file has none yet).
    async fn bound_base(
        &self,
        session: &SourceSession,
    ) -> Result<(Arc<Vec<u8>>, String), SourceError> {
        let bytes = self
            .base(&session.source_url, &session.base_source_sha256)
            .await?;
        let sha = if session.base_source_sha256.is_empty() {
            office_service::sha256_hex(bytes.as_slice())
        } else {
            session.base_source_sha256.clone()
        };
        Ok((bytes, sha))
    }

    /// The session for a room's writer or reader, refused when its epoch ended
    /// (as `epoch_changed`) or a writer lost write access.
    async fn session_for_room(
        &self,
        room: &SourceRoom,
        actor: &str,
        write: bool,
    ) -> Result<SourceSession, SourceError> {
        let session = self.gateway.session(&room.file_id, actor).await?;
        if session.epoch != room.epoch {
            return Err(SourceError::epoch_changed());
        }
        if write && session.access != "write" {
            return Err(SourceError::request(403, "Source access changed", None));
        }
        Ok(session)
    }

    /// The base and rows of `file_id`'s editing epoch in one snapshot (rows
    /// after `after` only, when given).
    async fn stored(&self, file_id: &str, after: Option<u64>) -> Result<Stored, SourceError> {
        let mut client = self.db.get().await.map_err(db_error)?;
        let txn = client
            .build_transaction()
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await
            .map_err(db_error)?;
        let row = txn
            .query_opt(
                "SELECT d.state,d.state_seed_sha256,d.checkpoint,d.epoch,d.base_revision FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1 AND f.trashed_at IS NULL",
                &[&file_id],
            )
            .await
            .map_err(db_error)?
            .ok_or_else(|| SourceError::request(404, "Source no longer exists", None))?;
        let epoch: i64 = row.get(3);
        let rows = txn
            .query(
                "SELECT checkpoint,update FROM source_document_updates WHERE file_id=$1 AND epoch=$2 AND checkpoint>$3 ORDER BY checkpoint",
                &[&file_id, &epoch, &(after.unwrap_or(0) as i64)],
            )
            .await
            .map_err(db_error)?;
        txn.commit().await.map_err(db_error)?;
        Ok(Stored {
            state: row.get(0),
            state_seed_sha256: row.get(1),
            checkpoint: row.get::<_, i64>(2) as u64,
            epoch: epoch as u64,
            base_revision: row.get(4),
            rows: rows
                .into_iter()
                .map(|row| (row.get::<_, i64>(0) as u64, row.get(1)))
                .collect(),
        })
    }

    /// The updates that make the durable state, in order: seed(base) and the
    /// stored change for Office (refused when the change names no seed or
    /// another one: the load check), the text state (or its seed), then rows.
    async fn layers(
        &self,
        format: SourceFormat,
        base: &[u8],
        sha: &str,
        stored: &Stored,
        room: Option<&str>,
    ) -> Result<(Arc<Seed>, Vec<Vec<u8>>), SourceError> {
        let seed = self.seed(format, base, sha, room).await?;
        let mut layers = Vec::new();
        if office(format).is_some() {
            if stored.state.is_some() || !stored.rows.is_empty() {
                match &stored.state_seed_sha256 {
                    None => {
                        return Err(SourceError::State(
                            "An Office state is stored without the seed it is a change over".into(),
                        ));
                    }
                    Some(stored_seed) if *stored_seed != seed.sha256 => {
                        return Err(SourceError::SeedChanged);
                    }
                    Some(_) => {}
                }
            }
            layers.push(seed.state.clone());
            layers.extend(stored.state.clone());
        } else {
            layers.push(stored.state.clone().unwrap_or_else(|| seed.state.clone()));
        }
        layers.extend(stored.rows.iter().map(|(_, row)| row.clone()));
        Ok((seed, layers))
    }

    /// Loads `room`'s durable state into `doc` (base + rows, checked) and
    /// remembers the room for its saves.
    pub async fn load(
        &self,
        room: &SourceRoom,
        actor: &str,
        doc: &Doc,
    ) -> Result<Loaded, SourceError> {
        let mut session = self.session_for_room(room, actor, false).await?;
        let (base, sha) = self.bound_base(&session).await?;
        let stored = self.stored(&room.file_id, None).await?;
        if stored.epoch != room.epoch {
            return Err(SourceError::epoch_changed());
        }
        if stored.base_revision != session.base_revision {
            return Err(SourceError::Other(
                "Source base moved during the room load".into(),
            ));
        }
        let name = room.name();
        let (_, layers) = self
            .layers(session.format, &base, &sha, &stored, Some(&name))
            .await?;
        let target = doc.clone();
        let layers = Arc::new(layers);
        let applied = layers.clone();
        tokio::task::spawn_blocking(move || replay(&target, applied.iter().map(Vec::as_slice)))
            .await
            .map_err(|error| SourceError::Other(format!("room load: {error}")))??;
        let mut record = RoomRecord {
            checkpoint: stored.checkpoint,
            seeded: stored.state.is_none() && stored.rows.is_empty(),
            baseline: None,
            window: None,
            session: SourceSession {
                state: None,
                published_state: None,
                base_source_sha256: sha,
                checkpoint: stored.checkpoint,
                ..session.clone()
            },
        };
        if session.format == SourceFormat::Text {
            let baseline = Arc::new(utf16(text_of(&base)?));
            let txn = doc.transact();
            let text = txn.get_text(TEXT_ROOT).map(|text| text.get_string(&txn));
            record.window =
                full_text_effects(text.as_deref().unwrap_or_default(), &baseline).window;
            record.baseline = Some(baseline);
        }
        session.checkpoint = stored.checkpoint;
        lock(&self.rooms).insert(name, record);
        Ok(Loaded {
            format: session.format,
            checkpoint: stored.checkpoint,
            bytes: layers.iter().map(|layer| layer.len() as u64).sum(),
            session,
        })
    }

    /// A loaded text room's save effects from its row (#12), on the room
    /// task with the room's read transaction: O(change), not O(text).
    pub fn text_effects<T: ReadTxn>(
        &self,
        room: &SourceRoom,
        txn: &T,
        row: &[u8],
    ) -> Result<TextSave, SourceError> {
        let rooms = lock(&self.rooms);
        let record = rooms
            .get(&room.name())
            .ok_or_else(|| SourceError::Other("source room is not loaded here".into()))?;
        let baseline = record
            .baseline
            .clone()
            .ok_or_else(|| SourceError::Other("not a text room".into()))?;
        let row = decode(row)?;
        Ok(crate::text::text_effects_from_change(
            txn,
            &row,
            &baseline,
            record.window,
        ))
    }

    /// The durable checkpoint this instance knows for a loaded room.
    pub fn known_checkpoint(&self, room: &SourceRoom) -> Option<u64> {
        lock(&self.rooms)
            .get(&room.name())
            .map(|record| record.checkpoint)
    }

    /// Drops a room's record and its XLSX replica (its room unloaded).
    pub async fn forget(&self, room: &SourceRoom) {
        let name = room.name();
        lock(&self.rooms).remove(&name);
        self.engines.drop_room(&name).await;
    }

    /// The whole durable state of a file from its base and rows (`stateOf`
    /// for the delta layout).
    async fn durable_state(
        &self,
        session: &SourceSession,
        base: &[u8],
        sha: &str,
    ) -> Result<Vec<u8>, SourceError> {
        let stored = self.stored(&session.file_id, None).await?;
        if stored.epoch != session.epoch {
            return Err(SourceError::epoch_changed());
        }
        let (_, layers) = self
            .layers(session.format, base, sha, &stored, None)
            .await?;
        whole(session.format, layers).await
    }

    /// An Office capture stored as its change over seed(base) (`state` NULL:
    /// the seed), whole.
    async fn captured_state(
        &self,
        format: SourceFormat,
        base: &[u8],
        sha: &str,
        state: Option<&[u8]>,
        state_seed_sha256: Option<&str>,
    ) -> Result<Vec<u8>, SourceError> {
        let seed = self.seed(format, base, sha, None).await?;
        let Some(state) = state else {
            return Ok(seed.state.clone());
        };
        if office(format).is_none() {
            return Ok(state.to_vec());
        }
        match state_seed_sha256 {
            None => Err(SourceError::State(
                "An Office state is stored without the seed it is a change over".into(),
            )),
            Some(stored) if stored != seed.sha256 => Err(SourceError::SeedChanged),
            Some(_) => whole(format, vec![seed.state.clone(), state.to_vec()]).await,
        }
    }

    /// The indexed baseline Office effects compare against: the baseline of
    /// seed(base), or while a rebuild is pending, of the published capture.
    async fn indexed_baseline(
        &self,
        session: &SourceSession,
        base: &[u8],
        sha: &str,
        room: &str,
    ) -> Result<Arc<Vec<BaselineEntry>>, SourceError> {
        let format = office(session.format)
            .ok_or_else(|| SourceError::Other("not an Office source".into()))?;
        let on = On {
            format,
            base,
            base_sha256: sha,
            room: Some(room),
        };
        let (key, state) = if session.rebuild_pending {
            let published = self
                .captured_state(
                    session.format,
                    base,
                    sha,
                    session.published_state.as_deref(),
                    session.published_state_seed_sha256.as_deref(),
                )
                .await?;
            let key = format!(
                "published:{format:?}:{sha}:{}",
                office_service::sha256_hex(&published)
            );
            (key, Some(published))
        } else {
            (format!("{format:?}:{sha}"), None)
        };
        if let Some(entries) = lock(&self.baselines).get(&key) {
            return Ok(entries);
        }
        let state = match state {
            Some(state) => state,
            None => self
                .seed(session.format, base, sha, Some(room))
                .await?
                .state
                .clone(),
        };
        let entries = Arc::new(self.engines.baseline(on, &state).await?);
        let bytes = serde_json::to_vec(entries.as_ref()).map_or(0, |json| json.len() as u64);
        lock(&self.baselines).set(&key, entries.clone(), bytes);
        Ok(entries)
    }

    /// Net effects of a whole Office `state` against the indexed baseline (or
    /// `from`): XLSX reads them off its overrides with the room's replica.
    pub(crate) async fn office_effects(
        &self,
        session: &SourceSession,
        base: &[u8],
        sha: &str,
        state: &[u8],
        room: &str,
        from: Option<&[BaselineEntry]>,
    ) -> Result<Vec<NetEffect>, SourceError> {
        let format = office(session.format)
            .ok_or_else(|| SourceError::Other("not an Office source".into()))?;
        let on = On {
            format,
            base,
            base_sha256: sha,
            room: Some(room),
        };
        let effects = if format == Format::Xlsx && !session.rebuild_pending && from.is_none() {
            self.engines.xlsx_pending_effects(on, state).await?
        } else {
            let indexed = match from {
                Some(from) => Arc::new(from.to_vec()),
                None => self.indexed_baseline(session, base, sha, room).await?,
            };
            let current = self.engines.baseline(on, state).await?;
            office_service::compare_baselines(&indexed, &current)
        };
        Ok(effects.into_iter().map(trim_effect).collect())
    }

    /// Stores a room's update since its durable state (a delta save): its
    /// effects measured, then appended through the checkpoint CAS. A moved
    /// checkpoint re-reads the session and the rows saved meanwhile, measures
    /// again over them and appends again (4 attempts); an ended epoch never
    /// will.
    pub async fn store(&self, room: &SourceRoom, save: Save) -> Result<Saved, SourceError> {
        let name = room.name();
        if save.actors.is_empty() {
            // A receipt for an unchanged document is still a durability receipt.
            return self
                .current_checkpoint(room)
                .await
                .map(|checkpoint| Saved { checkpoint });
        }
        if let Some(state) = &save.state
            && state.len() > MAX_SOURCE_STATE_BYTES
        {
            return Err(SourceError::request(
                413,
                "Source checkpoint exceeds byte limit",
                None,
            ));
        }
        let known = lock(&self.rooms)
            .get(&name)
            .map(|record| (record.session.clone(), record.checkpoint, record.seeded));
        let mut text = save.text.clone();
        for attempt in 0..SAVE_ATTEMPTS {
            let (session, expected, seeded, merged_rows) = match (&known, attempt) {
                (Some((session, checkpoint, seeded)), 0) => {
                    (session.clone(), *checkpoint, *seeded, Vec::new())
                }
                _ => {
                    // Authorizes the writer again and reads what landed since.
                    let session = self.session_for_room(room, &save.actors[0], true).await?;
                    let after = known.as_ref().map(|(_, checkpoint, _)| *checkpoint);
                    let stored = self.stored(&room.file_id, after).await?;
                    if stored.epoch != room.epoch {
                        return Err(SourceError::epoch_changed());
                    }
                    let seeded =
                        stored.state.is_none() && stored.rows.is_empty() && after.is_none();
                    text = None;
                    (session, stored.checkpoint, seeded, stored.rows)
                }
            };
            let (base, sha) = self.bound_base(&session).await?;
            let (effects, state_seed_sha256) = match office(session.format) {
                Some(_) => {
                    let state = save.state.as_deref().ok_or_else(|| {
                        SourceError::Other("an Office save needs the room's state".into())
                    })?;
                    let seed = self.seed(session.format, &base, &sha, Some(&name)).await?;
                    let effects = if merged_rows.is_empty() {
                        self.office_effects(&session, &base, &sha, state, &name, None)
                            .await?
                    } else {
                        let mut layers = vec![state.to_vec()];
                        layers.extend(merged_rows.iter().map(|(_, row)| row.clone()));
                        let merged = whole(session.format, layers).await?;
                        self.office_effects(&session, &base, &sha, &merged, &name, None)
                            .await?
                    };
                    (effects, Some(seed.sha256.clone()))
                }
                None => {
                    let effects = match &text {
                        Some(text) => text.effects.clone(),
                        None => {
                            let computed = self
                                .text_effects_whole(&session, &base, &sha, &save.row)
                                .await?;
                            let effects = computed.effects.clone();
                            text = Some(computed);
                            effects
                        }
                    };
                    (effects, None)
                }
            };
            let seed_report = if seeded {
                let seed_bytes = match office(session.format) {
                    None => Some(
                        self.seed(session.format, &base, &sha, None)
                            .await?
                            .state
                            .len() as u64,
                    ),
                    Some(_) => None,
                };
                (Some(sha.clone()), seed_bytes)
            } else {
                (None, None)
            };
            let body = CheckpointBody {
                actor_ids: save.actors.clone(),
                epoch: room.epoch,
                expected_checkpoint: expected,
                base_revision: session.base_revision,
                update: Some(save.row.clone()),
                net_tokens: effect_tokens(&effects),
                pending_effects: effects.clone(),
                state_seed_sha256,
                base_source_sha256: seed_report.0,
                seed_bytes: seed_report.1,
                operation: None,
            };
            let result: Result<CheckpointSaved, SourceError> = self
                .gateway
                .file(
                    &room.file_id,
                    "checkpoint",
                    Some(&body),
                    save.retry_event.as_deref(),
                    None,
                )
                .await;
            match result {
                Ok(saved) => {
                    let mut rooms = lock(&self.rooms);
                    if let Some(record) = rooms.get_mut(&name) {
                        record.checkpoint = saved.checkpoint;
                        record.seeded = false;
                        record.session = SourceSession {
                            state: None,
                            published_state: record.session.published_state.take(),
                            base_source_sha256: sha.clone(),
                            checkpoint: saved.checkpoint,
                            net_tokens: body.net_tokens as i64,
                            pending_effects: effects,
                            ..session
                        };
                        if let Some(text) = &text {
                            record.window = text.window;
                        }
                        if record.session.format == SourceFormat::Text && attempt > 0 {
                            record.baseline = Some(Arc::new(utf16(text_of(&base)?)));
                        }
                    }
                    return Ok(Saved {
                        checkpoint: saved.checkpoint,
                    });
                }
                Err(error) => {
                    let retry = error.status() == Some(409)
                        && !matches!(&error, SourceError::Request { code: Some(code), .. } if code == "epoch_changed")
                        && attempt + 1 < SAVE_ATTEMPTS;
                    if !retry {
                        return Err(error);
                    }
                }
            }
        }
        Err(SourceError::Other(
            "Source checkpoint could not be committed".into(),
        ))
    }

    /// Text effects of the durable state plus `row`, read whole (the slow
    /// paths: a moved checkpoint, an unloaded room's retry).
    async fn text_effects_whole(
        &self,
        session: &SourceSession,
        base: &[u8],
        sha: &str,
        row: &[u8],
    ) -> Result<TextSave, SourceError> {
        let stored = self.stored(&session.file_id, None).await?;
        let (_, mut layers) = self
            .layers(session.format, base, sha, &stored, None)
            .await?;
        layers.push(row.to_vec());
        let baseline = utf16(text_of(base)?);
        tokio::task::spawn_blocking(move || {
            let doc = text_doc(1);
            replay(&doc, layers.iter().map(Vec::as_slice))?;
            let txn = doc.transact();
            let text = txn.get_text(TEXT_ROOT).map(|text| text.get_string(&txn));
            Ok(full_text_effects(
                text.as_deref().unwrap_or_default(),
                &baseline,
            ))
        })
        .await
        .map_err(|error| SourceError::Other(format!("text effects: {error}")))?
    }

    /// The room's checkpoint as stored, refused when its epoch ended.
    async fn current_checkpoint(&self, room: &SourceRoom) -> Result<u64, SourceError> {
        let client = self.db.get().await.map_err(db_error)?;
        let row = client
            .query_opt(
                "SELECT d.checkpoint FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1 AND d.epoch=$2 AND f.trashed_at IS NULL",
                &[&room.file_id, &(room.epoch as i64)],
            )
            .await
            .map_err(db_error)?
            .ok_or_else(SourceError::epoch_changed)?;
        Ok(row.get::<_, i64>(0) as u64)
    }

    /// Per-connection access (204 or a refusal).
    pub async fn assert_access(
        &self,
        room: &SourceRoom,
        actor: &str,
        write: bool,
    ) -> Result<(), SourceError> {
        self.gateway.access(room, actor, write).await
    }

    pub async fn reset_epoch(&self, room: &SourceRoom) -> Result<bool, SourceError> {
        self.gateway.reset_epoch(room).await
    }

    /// Whether the maintenance pause covers this room: an Office file while
    /// a pause row exists. Text rooms keep editing.
    pub async fn editing_paused(&self, room: &SourceRoom) -> Result<bool, SourceError> {
        let client = self.db.get().await.map_err(db_error)?;
        let row = client
            .query_one(
                "SELECT EXISTS(SELECT 1 FROM office_editing_pause) AND EXISTS(SELECT 1 FROM source_documents WHERE file_id=$1 AND format<>'text') AS paused",
                &[&room.file_id],
            )
            .await
            .map_err(db_error)?;
        Ok(row.get(0))
    }

    /// Merges the log of `room`'s epoch into its base (DESIGN 3.5): replays
    /// base + rows, runs the load check, writes the base and deletes the rows
    /// it covers, in one transaction holding the document row. Rows a refresh
    /// candidate that is not exported yet still needs stay. The rows folded.
    pub async fn fold(&self, room: &SourceRoom) -> Result<u64, SourceError> {
        let mut client = self.db.get().await.map_err(db_error)?;
        let txn = client.transaction().await.map_err(db_error)?;
        let Some(row) = txn
            .query_opt(
                "SELECT d.format,d.state,d.state_seed_sha256,d.checkpoint,d.epoch,COALESCE(d.base_source_sha256,''),(SELECT MIN(c.checkpoint) FROM source_refresh_candidates c WHERE c.file_id=d.file_id AND c.epoch=d.epoch AND c.source_sha256 IS NULL) FROM source_documents d WHERE d.file_id=$1 FOR UPDATE",
                &[&room.file_id],
            )
            .await
            .map_err(db_error)?
        else {
            return Ok(0);
        };
        let format: SourceFormat = serde_json::from_value(Value::String(row.get(0)))
            .map_err(|error| SourceError::Other(format!("source format: {error}")))?;
        let epoch: i64 = row.get(4);
        if epoch as u64 != room.epoch {
            return Ok(0);
        }
        let checkpoint: i64 = row.get(3);
        let captured: Option<i64> = row.get(6);
        let upto = captured.map_or(checkpoint, |captured| captured.min(checkpoint));
        let rows = txn
            .query(
                "SELECT checkpoint,update FROM source_document_updates WHERE file_id=$1 AND epoch=$2 AND checkpoint<=$3 ORDER BY checkpoint",
                &[&room.file_id, &epoch, &upto],
            )
            .await
            .map_err(db_error)?;
        if rows.is_empty() {
            return Ok(0);
        }
        let stored = Stored {
            state: row.get(1),
            state_seed_sha256: row.get(2),
            checkpoint: checkpoint as u64,
            epoch: epoch as u64,
            base_revision: 0,
            rows: rows
                .into_iter()
                .map(|row| (row.get::<_, i64>(0) as u64, row.get(1)))
                .collect(),
        };
        let sha: String = row.get(5);
        let base = self.base_by_sha(&room.file_id, &sha).await?;
        let (seed, layers) = self.layers(format, &base, &sha, &stored, None).await?;
        let folded_bytes: i64 = stored.rows.iter().map(|(_, row)| row.len() as i64).sum();
        let folded_rows = stored.rows.len() as i64;
        let last = stored
            .rows
            .last()
            .map_or(0, |(checkpoint, _)| *checkpoint as i64);
        let is_office = office(format).is_some();
        let state = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, SourceError> {
            let doc = if is_office { Doc::new() } else { text_doc(1) };
            replay(&doc, layers.iter().map(Vec::as_slice))?;
            let txn = doc.transact();
            Ok(if is_office {
                txn.encode_state_as_update_v1(&seed.vector)
            } else {
                txn.encode_state_as_update_v1(&StateVector::default())
            })
        })
        .await
        .map_err(|error| SourceError::Other(format!("fold: {error}")))??;
        txn.execute(
            "UPDATE source_documents SET state=$2,log_bytes=log_bytes-$3,log_rows=log_rows-$4 WHERE file_id=$1",
            &[&room.file_id, &state, &folded_bytes, &(folded_rows as i32)],
        )
        .await
        .map_err(db_error)?;
        txn.execute(
            "DELETE FROM source_document_updates WHERE file_id=$1 AND epoch=$2 AND checkpoint<=$3",
            &[&room.file_id, &epoch, &last],
        )
        .await
        .map_err(db_error)?;
        txn.commit().await.map_err(db_error)?;
        Ok(folded_rows as u64)
    }

    /// The base of a file by its bound SHA (the cache, else the file's
    /// current blob URL through the bootstrap of its owner).
    async fn base_by_sha(&self, file_id: &str, sha: &str) -> Result<Arc<Vec<u8>>, SourceError> {
        if let Some(bytes) = lock(&self.bases).get(sha) {
            return Ok(bytes);
        }
        let owner = self.owner(file_id).await?;
        let session = self.gateway.session(file_id, &owner).await?;
        self.base(&session.source_url, sha).await
    }

    async fn owner(&self, file_id: &str) -> Result<String, SourceError> {
        let client = self.db.get().await.map_err(db_error)?;
        let row = client
            .query_opt(
                "SELECT w.user_id FROM files f JOIN workspaces w ON w.id=f.workspace_id WHERE f.id=$1 AND f.trashed_at IS NULL",
                &[&file_id],
            )
            .await
            .map_err(db_error)?
            .ok_or_else(|| SourceError::request(404, "Source no longer exists", None))?;
        Ok(row.get(0))
    }

    /// The owner's current session (sourceHandoff.ts `current`).
    pub async fn current(&self, file_id: &str) -> Result<SourceSession, SourceError> {
        let owner = self.owner(file_id).await?;
        self.gateway.session(file_id, &owner).await
    }

    /// Editable view of the durable source: the text, or the Office entries.
    pub async fn inspect(
        &self,
        file_id: &str,
        actor: &str,
    ) -> Result<SourceInspection, SourceError> {
        let session = self.gateway.session(file_id, actor).await?;
        let (base, sha) = self.bound_base(&session).await?;
        let state = self.durable_state(&session, &base, &sha).await?;
        let mut inspection = SourceInspection {
            access: session.access.clone(),
            checkpoint: session.checkpoint,
            entries: None,
            epoch: session.epoch,
            format: session.format,
            text: None,
        };
        match office(session.format) {
            None => {
                inspection.text = Some(
                    crate::text::text_state(&state)
                        .map_err(|error| SourceError::State(error.to_string()))?,
                )
            }
            Some(format) => {
                let on = On {
                    format,
                    base: &base,
                    base_sha256: &sha,
                    room: Some(&session.room),
                };
                inspection.entries = Some(self.engines.inspect(on, &state).await?);
            }
        }
        Ok(inspection)
    }

    /// The image of a pending effect, for the API's change review.
    pub async fn resolve(&self, input: &ResolveInput) -> Result<ResolvedAsset, SourceError> {
        let session = self.gateway.session(&input.file_id, &input.user_id).await?;
        if session.workspace_id != input.workspace_id
            || session.epoch != input.epoch
            || session.checkpoint != input.checkpoint
            || session.format == SourceFormat::Text
        {
            return Err(SourceError::request(409, "Source checkpoint changed", None));
        }
        let object_ref: ObjectRef = session
            .pending_effects
            .iter()
            .find(|effect| effect.id == input.change_id)
            .and_then(|effect| effect.asset_ref.clone())
            .ok_or_else(|| SourceError::request(404, "Source image unavailable", None))?;
        let (base, sha) = self.bound_base(&session).await?;
        let state = self.durable_state(&session, &base, &sha).await?;
        let format = office(session.format)
            .ok_or_else(|| SourceError::Other("not an Office source".into()))?;
        let (bytes, mime_type, sha256) = self
            .engines
            .resolve_asset(
                On {
                    format,
                    base: &base,
                    base_sha256: &sha,
                    room: Some(&session.room),
                },
                &state,
                &object_ref,
            )
            .await?;
        Ok(ResolvedAsset {
            bytes: STANDARD.encode(bytes),
            mime_type,
            sha256,
        })
    }

    /// Exports a candidate's captured state and uploads it. The capture is
    /// materialized here from the base and the rows up to its checkpoint
    /// (Go no longer copies states at save time) and sent along with the
    /// candidate. An export-only job (`publish` given) then publishes it.
    pub async fn export_candidate(
        &self,
        file_id: &str,
        job_id: &str,
        publish: Option<
            &(dyn Fn(Value) -> crate::BoxFuture<Result<Value, SourceError>> + Send + Sync),
        >,
    ) -> Result<(), SourceError> {
        let candidate: RefreshCandidate = self
            .gateway
            .file(
                file_id,
                &format!("refresh-candidate?jobId={}", crate::gateway::encode(job_id)),
                None::<&()>,
                None,
                None,
            )
            .await?;
        let mut publishing = false;
        let result: Result<(), SourceError> = async {
            let base = self
                .base(&candidate.base_source_url, &candidate.base_source_sha256)
                .await?;
            let sha = if candidate.base_source_sha256.is_empty() {
                office_service::sha256_hex(base.as_slice())
            } else {
                candidate.base_source_sha256.clone()
            };
            let (captured, captured_seed) = self.capture(&candidate, &base, &sha).await?;
            let state = match &captured {
                Some(change) if office(candidate.format).is_some() => {
                    let seed = self.seed(candidate.format, &base, &sha, None).await?;
                    whole(candidate.format, vec![seed.state.clone(), change.clone()]).await?
                }
                Some(text) => text.clone(),
                None => self
                    .seed(candidate.format, &base, &sha, None)
                    .await?
                    .state
                    .clone(),
            };
            let bytes = match office(candidate.format) {
                None => crate::text::text_state(&state)
                    .map_err(|error| SourceError::State(error.to_string()))?
                    .into_bytes(),
                Some(format) => {
                    let seed = office_service::sha256_hex(format!(
                        "{file_id}:{}:{}",
                        candidate.epoch, candidate.checkpoint
                    ));
                    self.engines
                        .export(
                            On {
                                format,
                                base: &base,
                                base_sha256: &sha,
                                room: None,
                            },
                            &state,
                            &seed,
                            "2000-01-01T00:00:00.000Z",
                        )
                        .await?
                }
            };
            if bytes.len() > MAX_SOURCE_STATE_BYTES {
                return Err(SourceError::Other(
                    "Export exceeds the supported byte limit".into(),
                ));
            }
            let sha256 = office_service::sha256_hex(&bytes);
            let size = bytes.len();
            let mut upload = self
                .gateway
                .http()
                .put(&candidate.upload_url)
                .body(bytes)
                .timeout(UPLOAD_TIMEOUT);
            for (name, value) in &candidate.upload_headers {
                upload = upload.header(name, value);
            }
            let uploaded = upload.send().await.map_err(|error| {
                SourceError::Other(format!("Source candidate upload failed: {error}"))
            })?;
            if !uploaded.status().is_success() {
                return Err(SourceError::Other(format!(
                    "Source candidate upload failed ({})",
                    uploaded.status().as_u16()
                )));
            }
            let etag = uploaded
                .headers()
                .get("etag")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .trim_matches('"')
                .to_owned();
            let _: Value = self
                .gateway
                .file(
                    file_id,
                    "refresh-candidate",
                    Some(&json!({
                        "checkpoint": candidate.checkpoint,
                        "epoch": candidate.epoch,
                        "jobId": job_id,
                        "leaseToken": candidate.lease_token,
                        "sizeBytes": size,
                        "sourceETag": etag,
                        "sourceSHA256": sha256,
                        "state": captured.as_ref().map(|state| STANDARD.encode(state)),
                        "stateSeedSHA256": captured_seed,
                    })),
                    None,
                    None,
                )
                .await?;
            if let Some(publish) = publish {
                publishing = true;
                publish(json!({
                    "attemptId": 1,
                    "checkpoint": candidate.checkpoint,
                    "contentHash": "",
                    "contentId": "",
                    "epoch": candidate.epoch,
                    "fileId": file_id,
                    "jobId": job_id,
                    "leaseToken": candidate.lease_token,
                    "sourceETag": etag,
                }))
                .await?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = &result {
            // A superseded publication (409) or a refused rebase goes back to
            // the scheduler at once; any other refusal parks the file.
            let stale = publishing && (error.status() == Some(409) || rebase_refused(error));
            let _: Value = self
                .gateway
                .file(
                    file_id,
                    "refresh-failure",
                    Some(&json!({
                        "error": error.to_string(),
                        "jobId": job_id,
                        "leaseToken": candidate.lease_token,
                        "stale": stale,
                    })),
                    None,
                    None,
                )
                .await?;
        }
        result
    }

    /// The candidate's capture: the stored change (Office, over seed(base))
    /// or text state as of its checkpoint, from the base and the rows up to
    /// it; `None` is seed(base).
    async fn capture(
        &self,
        candidate: &RefreshCandidate,
        base: &[u8],
        sha: &str,
    ) -> Result<(Option<Vec<u8>>, Option<String>), SourceError> {
        let stored = self.stored(&candidate.file_id, None).await?;
        if stored.epoch != candidate.epoch || stored.checkpoint < candidate.checkpoint {
            return Err(SourceError::request(409, "Source candidate changed", None));
        }
        let rows: Vec<(u64, Vec<u8>)> = stored
            .rows
            .iter()
            .filter(|(checkpoint, _)| *checkpoint <= candidate.checkpoint)
            .cloned()
            .collect();
        if stored.state.is_none() && rows.is_empty() {
            return Ok((None, None));
        }
        let stored = Stored { rows, ..stored };
        let (seed, layers) = self
            .layers(candidate.format, base, sha, &stored, None)
            .await?;
        let is_office = office(candidate.format).is_some();
        let seed_sha = is_office.then(|| seed.sha256.clone());
        let state = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, SourceError> {
            let doc = if is_office { Doc::new() } else { text_doc(1) };
            replay(&doc, layers.iter().map(Vec::as_slice))?;
            let txn = doc.transact();
            let none = StateVector::default();
            Ok(txn.encode_state_as_update_v1(if is_office { &seed.vector } else { &none }))
        })
        .await
        .map_err(|error| SourceError::Other(format!("capture: {error}")))??;
        Ok((Some(state), seed_sha))
    }

    /// Files published while editing stayed on the old base, with no refresh
    /// in flight and no refused rebuild, oldest first, except `skip`.
    pub async fn pending_rebuilds(&self, skip: &[String]) -> Result<Vec<String>, SourceError> {
        let client = self.db.get().await.map_err(db_error)?;
        let rows = client
            .query(
                "SELECT d.file_id FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.rebuild_pending AND d.rebuild_refusal IS NULL AND d.running_job_id IS NULL AND f.trashed_at IS NULL AND NOT d.file_id=ANY($1::text[]) ORDER BY d.updated_at LIMIT 32",
                &[&skip],
            )
            .await
            .map_err(db_error)?;
        Ok(rows.into_iter().map(|row| row.get(0)).collect())
    }

    /// Requests due refreshes, exports claimed candidates (`publish` for
    /// export-only jobs) and indexes idle notes (the 5 s source scheduler).
    pub async fn schedule_refreshes(
        &self,
        publish: Option<
            &(dyn Fn(Value) -> crate::BoxFuture<Result<Value, SourceError>> + Send + Sync),
        >,
    ) -> Result<(), SourceError> {
        let client = self.db.get().await.map_err(db_error)?;
        let eligible = client
            .query(
                crate::refresh::REFRESH_CANDIDATES_SQL,
                &[
                    &crate::refresh::OFFICE_REFRESH_TOKENS,
                    &crate::refresh::OFFICE_REFRESH_IDLE,
                    &crate::refresh::OFFICE_REFRESH_STALE,
                ],
            )
            .await
            .map_err(db_error)?;
        for row in eligible {
            let (file_id, user_id, checkpoint, reprocess): (String, String, i64, bool) =
                (row.get(0), row.get(1), row.get(2), row.get(3));
            let requested: Result<Value, SourceError> = self
                .gateway
                .file(
                    &file_id,
                    "refresh",
                    Some(&json!({ "actorId": user_id, "automatic": true })),
                    None,
                    None,
                )
                .await;
            let Err(error) = requested else { continue };
            // An owner over quota, or a race: try the reprocess again later.
            if reprocess {
                client
                    .execute(crate::refresh::REPROCESS_DEFER_SQL, &[&file_id])
                    .await
                    .map_err(db_error)?;
                continue;
            }
            match error.status() {
                Some(409) => {}
                // The owner is at the concurrent ingest-job limit: a later run
                // retries the file after the other due files.
                Some(429) => {
                    client
                        .execute(crate::refresh::REFRESH_DEFER_SQL, &[&file_id])
                        .await
                        .map_err(db_error)?;
                }
                _ => {
                    client
                        .execute(
                            "UPDATE source_documents SET refresh_error=$3 WHERE file_id=$1 AND checkpoint=$2 AND running_job_id IS NULL",
                            &[&file_id, &checkpoint, &error.to_string()],
                        )
                        .await
                        .map_err(db_error)?;
                }
            }
        }
        let jobs = client
            .query(
                "SELECT j.id,c.file_id,COALESCE((j.payload->>'exportOnly')::boolean,false) AND COALESCE(j.payload->>'paidBy','')<>'system' AS handoff FROM jobs j JOIN source_refresh_candidates c ON c.job_id=j.id WHERE j.type='source_refresh' AND (j.status='pending' OR (j.status='running' AND j.lease_expires_at<now())) ORDER BY j.created_at LIMIT 2",
                &[],
            )
            .await
            .map_err(db_error)?;
        for job in jobs {
            let (job_id, file_id, handoff): (String, String, bool) =
                (job.get(0), job.get(1), job.get(2));
            // A maintenance export-only job publishes in finalize (editing paused).
            if let Err(error) = self
                .export_candidate(&file_id, &job_id, if handoff { publish } else { None })
                .await
                && error.status() != Some(409)
            {
                crate::observe::log(
                    "warn",
                    "source refresh failed",
                    json!({ "error": error.to_string(), "file_id": file_id }),
                );
            }
        }
        if let Err(error) = self.schedule_note_indexes().await {
            crate::observe::log(
                "warn",
                "note index scheduling failed",
                json!({ "error": error.to_string() }),
            );
        }
        Ok(())
    }

    /// Dirty workspace notes that sat idle become one ingest job each; a real
    /// refusal is parked on the note until its content changes again.
    pub async fn schedule_note_indexes(&self) -> Result<(), SourceError> {
        let client = self.db.get().await.map_err(db_error)?;
        let eligible = client
            .query(crate::refresh::NOTE_INDEX_SQL, &[])
            .await
            .map_err(db_error)?;
        for row in eligible {
            let id: String = row.get(0);
            let path = format!(
                "/internal/collaboration/materials/{}/index",
                crate::gateway::encode(&id)
            );
            let result: Result<Value, SourceError> = self
                .gateway
                .request(&path, Some(&json!({})), None, None)
                .await;
            let Err(error) = result else { continue };
            // 409: not due. Anything transient (network, 5xx, 429) retries next
            // tick; only a refusal a retry cannot fix parks the note.
            match error.status() {
                None | Some(409) | Some(429) => continue,
                Some(status) if !(400..500).contains(&status) => continue,
                Some(_) => {}
            }
            client
                .execute(
                    "UPDATE materials SET index_error=$2 WHERE id=$1 AND index_job_id IS NULL",
                    &[&id, &error.to_string()],
                )
                .await
                .map_err(db_error)?;
        }
        Ok(())
    }

    /// The rebase after a publication: the edits saved after the capture
    /// landed on seed(export) and stored as their change over that seed.
    pub(crate) async fn rebase_onto(
        &self,
        session: &SourceSession,
        captured: (Option<&[u8]>, Option<&str>),
        exported: (&str, &str),
    ) -> Result<SourceRebase, SourceError> {
        let format = office(session.format)
            .ok_or_else(|| SourceError::Other("Office rebase requires an Office source".into()))?;
        let (old, sha) = self.bound_base(session).await?;
        let new_base = self.base(exported.0, exported.1).await?;
        let captured = self
            .captured_state(session.format, &old, &sha, captured.0, captured.1)
            .await?;
        let latest = self.durable_state(session, &old, &sha).await?;
        let (state, effects) = self
            .engines
            .rebase(
                On {
                    format,
                    base: &old,
                    base_sha256: &sha,
                    room: Some(&session.room),
                },
                &captured,
                &latest,
                &new_base,
            )
            .await
            .map_err(|error| match error {
                // The engine refused, as it would every retry: the refresh ends.
                EngineError::Refused(failure) if failure.kind == FailureKind::Rebase => {
                    SourceError::request(422, failure.message, None)
                }
                other => SourceError::Engine(other),
            })?;
        let effects: Vec<NetEffect> = effects.into_iter().map(trim_effect).collect();
        let seed = self
            .seed(session.format, &new_base, exported.1, None)
            .await?;
        let seed_sha = seed.sha256.clone();
        let change = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, SourceError> {
            let doc = Doc::new();
            replay(&doc, [state.as_slice()])?;
            let change = doc.transact().encode_state_as_update_v1(&seed.vector);
            // Seed plus the change must load (the load check), never pending.
            replay(&Doc::new(), [seed.state.as_slice(), change.as_slice()])?;
            Ok(change)
        })
        .await
        .map_err(|error| SourceError::Other(format!("rebase: {error}")))??;
        Ok(SourceRebase {
            net_tokens: effect_tokens(&effects),
            pending_effects: effects,
            rebased_state: Some(change),
            rebased_state_seed_sha256: Some(seed_sha),
        })
    }

    /// Effects of the durable state, against `from` (a text publication's
    /// exported text) or the indexed baseline, for the handoff.
    pub(crate) async fn effects_of_durable(
        &self,
        session: &SourceSession,
        from: Option<&[u16]>,
    ) -> Result<Vec<NetEffect>, SourceError> {
        let (base, sha) = self.bound_base(session).await?;
        let state = self.durable_state(session, &base, &sha).await?;
        if office(session.format).is_some() {
            return self
                .office_effects(session, &base, &sha, &state, &session.room, None)
                .await;
        }
        let text = crate::text::text_state(&state)
            .map_err(|error| SourceError::State(error.to_string()))?;
        let baseline = match from {
            Some(from) => from.to_vec(),
            None => utf16(text_of(&base)?),
        };
        Ok(crate::effects::text_effects(&baseline, &utf16(&text)))
    }

    /// The text of a capture (text publications measure later edits against it).
    pub(crate) async fn captured_text(
        &self,
        session: &SourceSession,
        state: Option<&[u8]>,
    ) -> Result<Vec<u16>, SourceError> {
        let (base, sha) = self.bound_base(session).await?;
        let state = self
            .captured_state(session.format, &base, &sha, state, None)
            .await?;
        Ok(utf16(
            &crate::text::text_state(&state)
                .map_err(|error| SourceError::State(error.to_string()))?,
        ))
    }
}

/// The engine refused a rebase (RebaseError), as it would on every retry.
pub fn rebase_refused(error: &SourceError) -> bool {
    matches!(error, SourceError::Request { status: 422, message, .. } if message.starts_with("Office rebase:"))
}

fn text_of(bytes: &[u8]) -> Result<&str, SourceError> {
    crate::text::decode_text(bytes)
        .map_err(|error| SourceError::State(format!("text source is not UTF-8: {error}")))
}

/// The whole state of `layers` applied in order (checked like a load).
async fn whole(format: SourceFormat, layers: Vec<Vec<u8>>) -> Result<Vec<u8>, SourceError> {
    tokio::task::spawn_blocking(move || {
        let doc = if office(format).is_some() {
            Doc::new()
        } else {
            text_doc(1)
        };
        replay(&doc, layers.iter().map(Vec::as_slice))?;
        Ok(encode(&doc))
    })
    .await
    .map_err(|error| SourceError::Other(format!("state rebuild: {error}")))?
}

/// A source's bytes, at most [`MAX_SOURCE_STATE_BYTES`] (readSourceBytes).
pub async fn read_source_bytes(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, SourceError> {
    let failed = || SourceError::Other("Source download failed".into());
    let mut response = http
        .get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|_| failed())?;
    if !response.status().is_success() {
        return Err(failed());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failed())? {
        if bytes.len() + chunk.len() > MAX_SOURCE_STATE_BYTES {
            return Err(SourceError::Other(
                "Source exceeds the supported byte limit".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
