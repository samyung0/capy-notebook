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
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use office_service::{BaselineEntry, Format, NetEffect, ObjectRef};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Transact, Update};

use crate::disk::{DiskStore, Hold, Key, PutError};
use crate::effects::{effect_tokens, trim_effect, utf16};
use crate::engine::office::calls::On;
use crate::engine::{EngineError, EnginePool, FailureKind, PoolConfig};
use crate::gateway::{CheckpointBody, CheckpointSaved, Gateway, RefreshCandidate, SourceSession};
use crate::text::{TEXT_ROOT, TextSave, TextWindow, full_text_effects, text_doc, text_seed};
use crate::{BoxFuture, MAX_SOURCE_STATE_BYTES, SourceError, SourceFormat, SourceRoom};

/// How often the disk store deletes files past their grace.
const SWEEP_EVERY: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Checkpoint CAS attempts per save (a moved checkpoint reloads and retries).
const SAVE_ATTEMPTS: usize = 3;

pub struct SourcesConfig {
    pub api_url: String,
    pub secret: String,
    pub engine: PoolConfig,
    /// The disk store's folder (wiped at start) and its cap in bytes
    /// (`COLLABORATION_SOURCE_DISK_DIR`, `COLLABORATION_SOURCE_DISK_BYTES`).
    pub disk_dir: PathBuf,
    pub disk_bytes: u64,
}

/// seed(base) for one call, and its SHA-256.
pub(crate) struct Seed {
    pub(crate) state: Vec<u8>,
    pub(crate) sha256: String,
}

impl Seed {
    /// The seed's state vector, derived per use (a decode of the seed).
    fn vector(&self) -> Result<StateVector, SourceError> {
        Ok(decode(&self.state)?.state_vector())
    }
}

/// Whom a base, seed or baseline is read for: the disk store's rules.
#[derive(Clone, Copy)]
pub(crate) enum Reader<'a> {
    /// A room load (its generation): it takes the files, a miss is written
    /// and counts against the cap, and a full store refuses the load.
    Load(u64),
    /// A loaded room's save: it holds the files; a miss is written when the
    /// store has room, else kept for this call only.
    Room(u64),
    /// A roomless job (a fold, export, inspection, rebuild, rebase, refresh,
    /// agent edit): it reads what is on disk, else keeps its own copy for
    /// the job, and writes nothing.
    Job(&'a Job),
}

impl Reader<'_> {
    fn holder(self) -> Option<u64> {
        match self {
            Reader::Load(generation) | Reader::Room(generation) => Some(generation),
            Reader::Job(_) => None,
        }
    }
}

/// A roomless job's copies of the bases and seeds it read (Epo 2026-10-17:
/// roomless jobs read into memory per job): each is downloaded, read or
/// seeded once per job and dropped with it, never shared between jobs.
#[derive(Default)]
pub(crate) struct Job(Mutex<HashMap<Key, (Vec<u8>, String)>>);

/// What this instance knows of a loaded room between its saves.
struct RoomRecord {
    /// Which load made it (see [`Loaded::hold`]).
    generation: u64,
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
    /// The stored base's size and the rows over it (the room's fold sizes).
    pub base_bytes: u64,
    pub rows: u64,
    pub row_bytes: u64,
    pub session: SourceSession,
    /// This load's hold on its disk store files (dropping it lets them go:
    /// the room keeps it until it unloads) and, by its generation, its
    /// record: [`Sources::forget`] removes only that one, never a later
    /// load's under the same room name.
    pub hold: Hold,
    pub times: LoadTimes,
}

/// Where a room load's time went, in ms (the `room_load` log line).
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct LoadTimes {
    /// The gateway's source session.
    pub session: u64,
    /// The base bytes: a bucket read unless the disk store holds them.
    pub base: u64,
    /// The stored state and rows.
    pub stored: u64,
    /// seed(base), an engine call unless the disk store holds it, and the
    /// layers over it.
    pub seed: u64,
    /// The layers applied to the room's document.
    pub replay: u64,
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
    /// The row appended (0: nothing to save, no writer in it).
    pub row_bytes: u64,
}

/// What a fold merged: the rows and their bytes, and the new base's size.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Folded {
    pub rows: u64,
    pub row_bytes: u64,
    pub base_bytes: u64,
}

/// The rows and base a room's durable state is made of, read in one snapshot.
pub(crate) struct Stored {
    pub(crate) state: Option<Vec<u8>>,
    pub(crate) state_seed_sha256: Option<String>,
    pub(crate) checkpoint: u64,
    pub(crate) epoch: u64,
    pub(crate) base_revision: i64,
    pub(crate) rows: Vec<(u64, Vec<u8>)>,
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

/// An editable view of a source as its editors see it (agent reads).
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

/// A room load's refusal (a full store) or failure (its I/O).
impl From<PutError> for SourceError {
    fn from(error: PutError) -> Self {
        match error {
            PutError::Full { held, cap } => SourceError::StoreFull { held, cap },
            PutError::Io(_) => SourceError::Other(error.to_string()),
        }
    }
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
pub(crate) fn replay<'a>(
    doc: &Doc,
    updates: impl IntoIterator<Item = &'a [u8]>,
) -> Result<(), SourceError> {
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

/// A document to replay stored state into (a fold, a capture, a save's
/// change and its load check, a rebuild): every room's options
/// (`ydoc::doc_options`), so no formatting cleanup deletes a marker the
/// peers sent (Epo D3, 2026-10-09, for Office sources).
fn working_doc(office: bool) -> Doc {
    if office {
        ydoc::scratch_doc()
    } else {
        text_doc(1)
    }
}

fn encode(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

pub struct Sources {
    gateway: Gateway,
    db: deadpool_postgres::Pool,
    engines: EnginePool,
    disk: Arc<DiskStore>,
    rooms: Mutex<HashMap<String, RoomRecord>>,
    generations: std::sync::atomic::AtomicU64,
}

impl Sources {
    /// Needs a tokio runtime (the engine pool's supervisors, the disk
    /// store's sweep). Wipes the disk store's folder.
    pub fn new(
        config: SourcesConfig,
        db: deadpool_postgres::Pool,
        http: reqwest::Client,
    ) -> std::io::Result<Self> {
        let disk = Arc::new(DiskStore::open(config.disk_dir, config.disk_bytes)?);
        let sweeping = Arc::downgrade(&disk);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(SWEEP_EVERY);
            loop {
                tick.tick().await;
                let Some(disk) = sweeping.upgrade() else {
                    return;
                };
                disk.sweep(Instant::now()).await;
            }
        });
        Ok(Self {
            gateway: Gateway::new(http, config.api_url, config.secret),
            db,
            engines: EnginePool::new(config.engine),
            disk,
            rooms: Mutex::new(HashMap::new()),
            generations: std::sync::atomic::AtomicU64::new(0),
        })
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

    /// The bytes of the disk store files loaded rooms hold (`/metrics`).
    pub async fn disk_held_bytes(&self) -> u64 {
        self.disk.held().await
    }

    /// A file from the job's copies, else the disk store (see [`Reader`]).
    async fn kept(&self, key: &Key, reader: Reader<'_>) -> Option<(Vec<u8>, String)> {
        let Reader::Job(job) = reader else {
            return self.disk.get(key, reader.holder()).await;
        };
        if let Some(found) = lock(&job.0).get(key).cloned() {
            return Some(found);
        }
        let found = self.disk.get(key, None).await?;
        lock(&job.0).insert(key.clone(), found.clone());
        Some(found)
    }

    /// Writes a file a loaded room read or built (see [`Reader`]); a
    /// roomless job keeps its own copy and writes nothing.
    async fn keep(
        &self,
        key: &Key,
        bytes: &[u8],
        sha256: &str,
        reader: Reader<'_>,
    ) -> Result<(), SourceError> {
        let (holder, load) = match reader {
            Reader::Load(generation) => (generation, true),
            Reader::Room(generation) => (generation, false),
            Reader::Job(job) => {
                lock(&job.0).insert(key.clone(), (bytes.to_vec(), sha256.to_owned()));
                return Ok(());
            }
        };
        match self.disk.put(key, bytes, sha256, holder).await {
            Ok(()) => Ok(()),
            Err(error) if load => Err(error.into()),
            Err(error) => {
                crate::observe::log(
                    "warn",
                    "source file kept for this call only",
                    json!({ "error": error.to_string(), "file": key.file_name() }),
                );
                Ok(())
            }
        }
    }

    /// A base and its SHA-256 (verified against `sha`; an unbound one is
    /// hashed): from the disk store, else downloaded.
    pub(crate) async fn base(
        &self,
        url: &str,
        sha: &str,
        reader: Reader<'_>,
    ) -> Result<(Vec<u8>, String), SourceError> {
        if let Some(key) = Key::base(sha)
            && let Some(found) = self.kept(&key, reader).await
        {
            return Ok(found);
        }
        let response = open_source(self.gateway.http(), &self.gateway.object_url(url)).await?;
        // A room load the store has no room for is refused before the
        // download: the store's own check, on the length the bucket sent.
        if let (Reader::Load(_), Some(length)) = (reader, response.content_length()) {
            self.disk.room_for(length).await?;
        }
        let bytes = read_body(response).await?;
        let actual = office_service::sha256_hex(&bytes);
        if !sha.is_empty() && actual != sha {
            return Err(SourceError::Other("Source SHA mismatch".into()));
        }
        if let Some(key) = Key::base(&actual) {
            self.keep(&key, &bytes, &actual, reader).await?;
        }
        Ok((bytes, actual))
    }

    /// seed(base) (what a NULL state stands for): from the disk store, else
    /// seeded.
    pub(crate) async fn seed(
        &self,
        format: SourceFormat,
        base: &[u8],
        sha: &str,
        room: Option<&str>,
        reader: Reader<'_>,
    ) -> Result<Seed, SourceError> {
        let key = Key::seed(format, sha);
        if let Some(key) = &key
            && let Some((state, sha256)) = self.kept(key, reader).await
        {
            return Ok(Seed { state, sha256 });
        }
        // A room load is refused before the seed call when loaded rooms fill
        // the store: a seed is never empty, so the store could not keep it.
        if let (Some(_), Reader::Load(_)) = (&key, reader) {
            self.disk.room_for(1).await?;
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
        let sha256 = office_service::sha256_hex(&state);
        if let Some(key) = &key {
            self.keep(key, &state, &sha256, reader).await?;
        }
        Ok(Seed { state, sha256 })
    }

    /// The base of `session` with its SHA bound (hashed when the file has none yet).
    pub(crate) async fn bound_base(
        &self,
        session: &SourceSession,
        reader: Reader<'_>,
    ) -> Result<(Vec<u8>, String), SourceError> {
        self.base(&session.source_url, &session.base_source_sha256, reader)
            .await
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
    pub(crate) async fn stored(
        &self,
        file_id: &str,
        after: Option<u64>,
    ) -> Result<Stored, SourceError> {
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
    /// another one: the load check), the text state (its seed only while
    /// nothing is saved: a text room's first row holds the seed), then rows.
    pub(crate) async fn layers(
        &self,
        format: SourceFormat,
        base: &[u8],
        sha: &str,
        stored: &Stored,
        room: Option<&str>,
        reader: Reader<'_>,
    ) -> Result<(Seed, Vec<Vec<u8>>), SourceError> {
        let seed = self.seed(format, base, sha, room, reader).await?;
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
            match &stored.state {
                Some(state) => layers.push(state.clone()),
                None if stored.rows.is_empty() => layers.push(seed.state.clone()),
                None => {}
            }
        }
        layers.extend(stored.rows.iter().map(|(_, row)| row.clone()));
        Ok((seed, layers))
    }

    /// Loads `room`'s durable state into `doc` (base + rows, checked) and
    /// remembers the room for its saves. The room holds its base and seed in
    /// the disk store while it keeps [`Loaded::hold`]; a failed load drops
    /// it at once. A store its loaded rooms' files fill refuses the load
    /// ([`SourceError::StoreFull`]).
    pub async fn load(
        &self,
        room: &SourceRoom,
        actor: &str,
        doc: &Doc,
    ) -> Result<Loaded, SourceError> {
        let generation = self
            .generations
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let hold = self.disk.hold(generation);
        let reader = Reader::Load(generation);
        let mut times = LoadTimes::default();
        let mut lap = std::time::Instant::now();
        let mut stage = |slot: &mut u64| {
            *slot = lap.elapsed().as_millis() as u64;
            lap = std::time::Instant::now();
        };
        let mut session = self.session_for_room(room, actor, false).await?;
        stage(&mut times.session);
        let (base, sha) = self.bound_base(&session, reader).await?;
        stage(&mut times.base);
        let stored = self.stored(&room.file_id, None).await?;
        stage(&mut times.stored);
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
            .layers(session.format, &base, &sha, &stored, Some(&name), reader)
            .await?;
        stage(&mut times.seed);
        let target = doc.clone();
        let layers = Arc::new(layers);
        let applied = layers.clone();
        tokio::task::spawn_blocking(move || replay(&target, applied.iter().map(Vec::as_slice)))
            .await
            .map_err(|error| SourceError::Other(format!("room load: {error}")))??;
        stage(&mut times.replay);
        let mut record = RoomRecord {
            generation,
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
            base_bytes: stored.state.as_ref().map_or(0, |state| state.len() as u64),
            rows: stored.rows.len() as u64,
            row_bytes: stored.rows.iter().map(|(_, row)| row.len() as u64).sum(),
            hold,
            session,
            times,
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

    /// Drops the room's record and its XLSX replica (its room unloaded)
    /// unless a later load of the same room replaced the record meanwhile.
    /// Its disk store files go with the load's [`Loaded::hold`].
    pub async fn forget(&self, room: &SourceRoom, generation: u64) {
        let name = room.name();
        {
            let mut rooms = lock(&self.rooms);
            if rooms
                .get(&name)
                .is_none_or(|record| record.generation != generation)
            {
                return;
            }
            rooms.remove(&name);
        }
        self.engines.drop_room(&name).await;
    }

    /// The whole durable state of a file from its base and rows (`stateOf`
    /// for the delta layout).
    async fn durable_state(
        &self,
        session: &SourceSession,
        base: &[u8],
        sha: &str,
        job: &Job,
    ) -> Result<Vec<u8>, SourceError> {
        let layers = self.durable_layers(session, base, sha, job).await?;
        whole(session.format, layers).await
    }

    /// The stored document as the updates that make it, seed first.
    async fn durable_layers(
        &self,
        session: &SourceSession,
        base: &[u8],
        sha: &str,
        job: &Job,
    ) -> Result<Vec<Vec<u8>>, SourceError> {
        let stored = self.stored(&session.file_id, None).await?;
        if stored.epoch != session.epoch {
            return Err(SourceError::epoch_changed());
        }
        let (_, layers) = self
            .layers(session.format, base, sha, &stored, None, Reader::Job(job))
            .await?;
        Ok(layers)
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
        reader: Reader<'_>,
    ) -> Result<Vec<u8>, SourceError> {
        let seed = self.seed(format, base, sha, None, reader).await?;
        let Some(state) = state else {
            return Ok(seed.state);
        };
        if office(format).is_none() {
            return Ok(state.to_vec());
        }
        match state_seed_sha256 {
            None => Err(SourceError::State(
                "An Office state is stored without the seed it is a change over".into(),
            )),
            Some(stored) if stored != seed.sha256 => Err(SourceError::SeedChanged),
            Some(_) => whole(format, vec![seed.state, state.to_vec()]).await,
        }
    }

    /// The indexed baseline Office effects compare against: the baseline of
    /// seed(base), or while a rebuild is pending, of the published capture.
    /// From the disk store (as JSON), else built by the engine.
    async fn indexed_baseline(
        &self,
        session: &SourceSession,
        base: &[u8],
        sha: &str,
        room: &str,
        reader: Reader<'_>,
    ) -> Result<Vec<BaselineEntry>, SourceError> {
        let format = office(session.format)
            .ok_or_else(|| SourceError::Other("not an Office source".into()))?;
        let on = On {
            format,
            base,
            base_sha256: sha,
            room: Some(room),
        };
        let published = if session.rebuild_pending {
            Some(
                self.captured_state(
                    session.format,
                    base,
                    sha,
                    session.published_state.as_deref(),
                    session.published_state_seed_sha256.as_deref(),
                    reader,
                )
                .await?,
            )
        } else {
            None
        };
        let key = Key::baseline(
            session.format,
            sha,
            published
                .as_ref()
                .map(office_service::sha256_hex)
                .as_deref(),
        );
        if let Some(key) = &key
            && let Some((json, _)) = self.disk.get(key, reader.holder()).await
        {
            return serde_json::from_slice(&json)
                .map_err(|error| SourceError::Other(format!("stored baseline: {error}")));
        }
        let state = match published {
            Some(state) => state,
            None => {
                self.seed(session.format, base, sha, Some(room), reader)
                    .await?
                    .state
            }
        };
        let entries = self.engines.baseline(on, &state).await?;
        if let Some(key) = &key
            && reader.holder().is_some()
        {
            let json = serde_json::to_vec(&entries)
                .map_err(|error| SourceError::Other(format!("baseline: {error}")))?;
            self.keep(key, &json, &office_service::sha256_hex(&json), reader)
                .await?;
        }
        Ok(entries)
    }

    /// Net effects of a whole Office `state` against the indexed baseline:
    /// XLSX reads them off its overrides with the room's replica; DOCX and
    /// PPTX leave out the moves an edit merely shifted (office-service
    /// `save_effects`, API v3).
    pub(crate) async fn office_effects(
        &self,
        session: &SourceSession,
        base: &[u8],
        sha: &str,
        state: &[u8],
        room: &str,
        reader: Reader<'_>,
    ) -> Result<Vec<NetEffect>, SourceError> {
        let format = office(session.format)
            .ok_or_else(|| SourceError::Other("not an Office source".into()))?;
        let on = On {
            format,
            base,
            base_sha256: sha,
            room: Some(room),
        };
        let effects = if format == Format::Xlsx && !session.rebuild_pending {
            self.engines.xlsx_pending_effects(on, state).await?
        } else {
            let indexed = self
                .indexed_baseline(session, base, sha, room, reader)
                .await?;
            let current = self.engines.baseline(on, state).await?;
            if format == Format::Xlsx {
                office_service::compare_baselines(&indexed, &current)
            } else {
                office_service::unshifted_effects(&indexed, &current)
            }
        };
        Ok(effects.into_iter().map(trim_effect).collect())
    }

    /// Stores a room's update since its durable state (a delta save): its
    /// effects measured, then appended through the checkpoint CAS. A moved
    /// checkpoint re-reads the session and the rows saved meanwhile, measures
    /// again over them and appends again (3 attempts); an ended epoch never
    /// will.
    pub async fn store(&self, room: &SourceRoom, save: Save) -> Result<Saved, SourceError> {
        let name = room.name();
        if save.actors.is_empty() {
            // A receipt for an unchanged document is still a durability receipt.
            return self.current_checkpoint(room).await.map(|checkpoint| Saved {
                checkpoint,
                row_bytes: 0,
            });
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
        let known = lock(&self.rooms).get(&name).map(|record| {
            (
                record.session.clone(),
                record.checkpoint,
                record.seeded,
                record.generation,
            )
        });
        // The loaded room's files; a save for a room not loaded here reads
        // as a roomless job.
        let job = Job::default();
        let reader = known
            .as_ref()
            .map_or(Reader::Job(&job), |(_, _, _, generation)| {
                Reader::Room(*generation)
            });
        let mut text = save.text.clone();
        for attempt in 0..SAVE_ATTEMPTS {
            let (session, expected, seeded, merged_rows) = match (&known, attempt) {
                (Some((session, checkpoint, seeded, _)), 0) => {
                    (session.clone(), *checkpoint, *seeded, Vec::new())
                }
                _ => {
                    // Authorizes the writer again and reads what landed since.
                    let session = self.session_for_room(room, &save.actors[0], true).await?;
                    let after = known.as_ref().map(|(_, checkpoint, _, _)| *checkpoint);
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
            let (base, sha) = self.bound_base(&session, reader).await?;
            let (effects, state_seed_sha256) = match office(session.format) {
                Some(_) => {
                    let state = save.state.as_deref().ok_or_else(|| {
                        SourceError::Other("an Office save needs the room's state".into())
                    })?;
                    let seed = self
                        .seed(session.format, &base, &sha, Some(&name), reader)
                        .await?;
                    let effects = if merged_rows.is_empty() {
                        self.office_effects(&session, &base, &sha, state, &name, reader)
                            .await?
                    } else {
                        let mut layers = vec![state.to_vec()];
                        layers.extend(merged_rows.iter().map(|(_, row)| row.clone()));
                        let merged = whole(session.format, layers).await?;
                        self.office_effects(&session, &base, &sha, &merged, &name, reader)
                            .await?
                    };
                    (effects, Some(seed.sha256))
                }
                None => {
                    let effects = match &text {
                        Some(text) => text.effects.clone(),
                        None => {
                            let computed = self
                                .text_effects_whole(&session, &base, &sha, &save.row, reader)
                                .await?;
                            let effects = computed.effects.clone();
                            text = Some(computed);
                            effects
                        }
                    };
                    (effects, None)
                }
            };
            // A text room's first row is whole, seed included: a text
            // publication moves the base while the rows stay, and seed(base)
            // would then name the new bytes.
            let text_seed = if seeded && office(session.format).is_none() {
                Some(
                    self.seed(session.format, &base, &sha, None, reader)
                        .await?
                        .state,
                )
            } else {
                None
            };
            let seed_report = if seeded {
                (
                    Some(sha.clone()),
                    text_seed.as_ref().map(|seed| seed.len() as u64),
                )
            } else {
                (None, None)
            };
            let row = match text_seed {
                Some(seed) => whole(session.format, vec![seed, save.row.clone()]).await?,
                None => save.row.clone(),
            };
            let row_bytes = row.len();
            // O(effect text): a text room's pending effect spans every edit
            // since its baseline, up to the whole file twice.
            let net_tokens = {
                let effects = effects.clone();
                tokio::task::spawn_blocking(move || effect_tokens(&effects))
                    .await
                    .map_err(|error| SourceError::Other(format!("effect tokens: {error}")))?
            };
            let body = CheckpointBody {
                actor_ids: save.actors.clone(),
                epoch: room.epoch,
                expected_checkpoint: expected,
                base_revision: session.base_revision,
                update: Some(row),
                net_tokens,
                pending_effects: effects.clone(),
                state_seed_sha256,
                base_source_sha256: seed_report.0,
                seed_bytes: seed_report.1,
                operation: None,
                preview: text.as_ref().map(|text| text.preview.clone()),
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
                        row_bytes: row_bytes as u64,
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
        reader: Reader<'_>,
    ) -> Result<TextSave, SourceError> {
        let stored = self.stored(&session.file_id, None).await?;
        let (_, mut layers) = self
            .layers(session.format, base, sha, &stored, None, reader)
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
    /// it covers. Rows a refresh candidate that is not exported yet still
    /// needs stay. The slow part (the base, an engine seed, the replay) runs
    /// holding neither a connection nor the row: the write then locks the
    /// row and checks that nothing it folded changed meanwhile.
    pub async fn fold(&self, room: &SourceRoom) -> Result<Folded, SourceError> {
        const DOCUMENT: &str = "SELECT d.format,d.state,d.state_seed_sha256,d.checkpoint,d.epoch,COALESCE(d.base_source_sha256,''),(SELECT MIN(c.checkpoint) FROM source_refresh_candidates c WHERE c.file_id=d.file_id AND c.epoch=d.epoch AND c.source_sha256 IS NULL),sha256(d.state) FROM source_documents d WHERE d.file_id=$1";
        // One snapshot of the document and its rows.
        let (row, rows) = {
            let mut client = self.db.get().await.map_err(db_error)?;
            let txn = client
                .build_transaction()
                .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
                .read_only(true)
                .start()
                .await
                .map_err(db_error)?;
            let Some(row) = txn
                .query_opt(DOCUMENT, &[&room.file_id])
                .await
                .map_err(db_error)?
            else {
                return Ok(Folded::default());
            };
            let (epoch, checkpoint, captured): (i64, i64, Option<i64>) =
                (row.get(4), row.get(3), row.get(6));
            if epoch as u64 != room.epoch {
                return Ok(Folded::default());
            }
            let upto = captured.map_or(checkpoint, |captured| captured.min(checkpoint));
            let rows = txn
                .query(
                    "SELECT checkpoint,update FROM source_document_updates WHERE file_id=$1 AND epoch=$2 AND checkpoint<=$3 ORDER BY checkpoint",
                    &[&room.file_id, &epoch, &upto],
                )
                .await
                .map_err(db_error)?;
            txn.commit().await.map_err(db_error)?;
            (row, rows)
        };
        if rows.is_empty() {
            return Ok(Folded::default());
        }
        let format: SourceFormat = serde_json::from_value(Value::String(row.get(0)))
            .map_err(|error| SourceError::Other(format!("source format: {error}")))?;
        let (epoch, sha, state_hash): (i64, String, Option<Vec<u8>>) =
            (row.get(4), row.get(5), row.get(7));
        let stored = Stored {
            state: row.get(1),
            state_seed_sha256: row.get(2),
            checkpoint: row.get::<_, i64>(3) as u64,
            epoch: epoch as u64,
            base_revision: 0,
            rows: rows
                .into_iter()
                .map(|row| (row.get::<_, i64>(0) as u64, row.get(1)))
                .collect(),
        };
        let job = Job::default();
        let base = self.base_by_sha(&room.file_id, &sha, &job).await?;
        let (seed, layers) = self
            .layers(format, &base, &sha, &stored, None, Reader::Job(&job))
            .await?;
        let folded_bytes: i64 = stored.rows.iter().map(|(_, row)| row.len() as i64).sum();
        let folded_rows = stored.rows.len() as i64;
        let last = stored
            .rows
            .last()
            .map_or(0, |(checkpoint, _)| *checkpoint as i64);
        let is_office = office(format).is_some();
        let state = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, SourceError> {
            let doc = working_doc(is_office);
            replay(&doc, layers.iter().map(Vec::as_slice))?;
            let txn = doc.transact();
            Ok(if is_office {
                txn.encode_state_as_update_v1(&seed.vector()?)
            } else {
                txn.encode_state_as_update_v1(&StateVector::default())
            })
        })
        .await
        .map_err(|error| SourceError::Other(format!("fold: {error}")))??;
        // The write: only if the epoch, base, state and folded rows are as read
        // and no candidate captured since needs a folded row.
        let mut client = self.db.get().await.map_err(db_error)?;
        let txn = client.transaction().await.map_err(db_error)?;
        let Some(now) = txn
            .query_opt(&format!("{DOCUMENT} FOR UPDATE OF d"), &[&room.file_id])
            .await
            .map_err(db_error)?
        else {
            return Ok(Folded::default());
        };
        let (now_rows, now_bytes): (i64, i64) = {
            let counted = txn
                .query_one(
                    "SELECT count(*),COALESCE(sum(octet_length(update)),0)::bigint FROM source_document_updates WHERE file_id=$1 AND epoch=$2 AND checkpoint<=$3",
                    &[&room.file_id, &epoch, &last],
                )
                .await
                .map_err(db_error)?;
            (counted.get(0), counted.get(1))
        };
        let captured: Option<i64> = now.get(6);
        let unchanged = now.get::<_, i64>(4) == epoch
            && now.get::<_, String>(5) == sha
            && now.get::<_, Option<Vec<u8>>>(7) == state_hash
            && now_rows == folded_rows
            && now_bytes == folded_bytes
            && captured.is_none_or(|captured| captured >= last);
        if !unchanged {
            return Ok(Folded::default());
        }
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
        Ok(Folded {
            rows: folded_rows as u64,
            row_bytes: folded_bytes as u64,
            base_bytes: state.len() as u64,
        })
    }

    /// The base of a file by its bound SHA for a fold (the disk store, else
    /// the file's current blob URL through the bootstrap of its owner).
    async fn base_by_sha(
        &self,
        file_id: &str,
        sha: &str,
        job: &Job,
    ) -> Result<Vec<u8>, SourceError> {
        if let Some(key) = Key::base(sha)
            && let Some((bytes, _)) = self.kept(&key, Reader::Job(job)).await
        {
            return Ok(bytes);
        }
        let owner = self.owner(file_id).await?;
        let session = self.gateway.session(file_id, &owner).await?;
        Ok(self
            .base(&session.source_url, sha, Reader::Job(job))
            .await?
            .0)
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

    /// Editable view of the source as its editors see it now: the text, or
    /// the Office entries, of the stored document with this replica's live
    /// room merged in (unsaved typing), as an edit reads it. `live` answers
    /// the room's state, or None when no room is loaded (then the read is
    /// the stored document and loads nothing more).
    pub async fn inspect<F>(
        &self,
        file_id: &str,
        actor: &str,
        live: F,
    ) -> Result<SourceInspection, SourceError>
    where
        F: FnOnce(String) -> BoxFuture<Option<Vec<u8>>>,
    {
        let session = self.gateway.session(file_id, actor).await?;
        let job = Job::default();
        let (base, sha) = self.bound_base(&session, Reader::Job(&job)).await?;
        let mut layers = self.durable_layers(&session, &base, &sha, &job).await?;
        let room = SourceRoom {
            file_id: file_id.to_owned(),
            epoch: session.epoch,
        };
        layers.extend(live(room.name()).await);
        let state = whole(session.format, layers).await?;
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
        let job = Job::default();
        let (base, sha) = self.bound_base(&session, Reader::Job(&job)).await?;
        let state = self.durable_state(&session, &base, &sha, &job).await?;
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
            .await
            .inspect_err(|error| {
                // A refused claim records nothing (a refresh-failure needs the
                // lease), and its job may hold an export slot: report it.
                if error.status() == Some(409) {
                    crate::observe::capture(
                        &format!("source refresh claim refused: {error}"),
                        &[
                            ("stage", "source_refresh_claim"),
                            ("file_id", file_id),
                            ("job_id", job_id),
                        ],
                    );
                }
            })?;
        let mut publishing = false;
        let job = Job::default();
        let result: Result<(), SourceError> = async {
            let (base, sha) = self
                .base(
                    &candidate.base_source_url,
                    &candidate.base_source_sha256,
                    Reader::Job(&job),
                )
                .await?;
            let (captured, captured_seed) = self.capture(&candidate, &base, &sha, &job).await?;
            let state = match &captured {
                Some(change) if office(candidate.format).is_some() => {
                    let seed = self
                        .seed(candidate.format, &base, &sha, None, Reader::Job(&job))
                        .await?;
                    whole(candidate.format, vec![seed.state, change.clone()]).await?
                }
                Some(text) => text.clone(),
                None => {
                    self.seed(candidate.format, &base, &sha, None, Reader::Job(&job))
                        .await?
                        .state
                }
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
        job: &Job,
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
            .layers(candidate.format, base, sha, &stored, None, Reader::Job(job))
            .await?;
        let is_office = office(candidate.format).is_some();
        let seed_sha = is_office.then(|| seed.sha256.clone());
        let state = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, SourceError> {
            let doc = working_doc(is_office);
            replay(&doc, layers.iter().map(Vec::as_slice))?;
            let txn = doc.transact();
            let none = StateVector::default();
            let vector = if is_office { seed.vector()? } else { none };
            Ok(txn.encode_state_as_update_v1(&vector))
        })
        .await
        .map_err(|error| SourceError::Other(format!("capture: {error}")))??;
        Ok((Some(state), seed_sha))
    }

    /// Files published while editing stayed on the old base, with no refresh
    /// in flight and no refused rebuild, oldest first, except `skip`.
    /// Whether a file waits for its rebuild: pending, never refused, and not
    /// trashed (a trashed file's room still unloads and schedules one).
    pub async fn rebuild_pending(&self, file_id: &str) -> Result<bool, SourceError> {
        let client = self.db.get().await.map_err(db_error)?;
        let row = client
            .query_opt(
                "SELECT d.rebuild_pending AND d.rebuild_refusal IS NULL FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1 AND f.trashed_at IS NULL",
                &[&file_id],
            )
            .await
            .map_err(db_error)?;
        Ok(row.is_some_and(|row| row.get::<_, Option<bool>>(0) == Some(true)))
    }

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
            .query(crate::refresh::EXPORT_JOBS_SQL, &[])
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
        let job = Job::default();
        let (old, sha) = self.bound_base(session, Reader::Job(&job)).await?;
        let (new_base, _) = self.base(exported.0, exported.1, Reader::Job(&job)).await?;
        let captured = self
            .captured_state(
                session.format,
                &old,
                &sha,
                captured.0,
                captured.1,
                Reader::Job(&job),
            )
            .await?;
        let latest = self.durable_state(session, &old, &sha, &job).await?;
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
            .seed(
                session.format,
                &new_base,
                exported.1,
                None,
                Reader::Job(&job),
            )
            .await?;
        let seed_sha = seed.sha256.clone();
        let change = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, SourceError> {
            let doc = working_doc(true);
            replay(&doc, [state.as_slice()])?;
            let change = doc.transact().encode_state_as_update_v1(&seed.vector()?);
            // Seed plus the change must load (the load check), never pending.
            replay(
                &working_doc(true),
                [seed.state.as_slice(), change.as_slice()],
            )?;
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
        job: &Job,
    ) -> Result<Vec<NetEffect>, SourceError> {
        let (base, sha) = self.bound_base(session, Reader::Job(job)).await?;
        let state = self.durable_state(session, &base, &sha, job).await?;
        if office(session.format).is_some() {
            return self
                .office_effects(
                    session,
                    &base,
                    &sha,
                    &state,
                    &session.room,
                    Reader::Job(job),
                )
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
        job: &Job,
    ) -> Result<Vec<u16>, SourceError> {
        let (base, sha) = self.bound_base(session, Reader::Job(job)).await?;
        let state = self
            .captured_state(session.format, &base, &sha, state, None, Reader::Job(job))
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

pub(crate) fn text_of(bytes: &[u8]) -> Result<&str, SourceError> {
    crate::text::decode_text(bytes)
        .map_err(|error| SourceError::State(format!("text source is not UTF-8: {error}")))
}

/// The whole state of `layers` applied in order (checked like a load).
async fn whole(format: SourceFormat, layers: Vec<Vec<u8>>) -> Result<Vec<u8>, SourceError> {
    tokio::task::spawn_blocking(move || {
        let doc = working_doc(office(format).is_some());
        replay(&doc, layers.iter().map(Vec::as_slice))?;
        Ok(encode(&doc))
    })
    .await
    .map_err(|error| SourceError::Other(format!("state rebuild: {error}")))?
}

fn download_failed() -> SourceError {
    SourceError::Other("Source download failed".into())
}

/// A source download with its headers read and its body not yet.
async fn open_source(http: &reqwest::Client, url: &str) -> Result<reqwest::Response, SourceError> {
    let response = http
        .get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|_| download_failed())?;
    if !response.status().is_success() {
        return Err(download_failed());
    }
    Ok(response)
}

/// A source's bytes, at most [`MAX_SOURCE_STATE_BYTES`] (readSourceBytes).
pub async fn read_source_bytes(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, SourceError> {
    read_body(open_source(http, url).await?).await
}

async fn read_body(mut response: reqwest::Response) -> Result<Vec<u8>, SourceError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| download_failed())? {
        if bytes.len() + chunk.len() > MAX_SOURCE_STATE_BYTES {
            return Err(SourceError::Other(
                "Source exceeds the supported byte limit".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use yrs::{Any, Text, WriteTxn};

    use super::*;

    /// The live format markers of the root text `source`.
    fn live_format_markers(doc: &Doc) -> usize {
        let txn = doc.transact();
        let text = txn.get_text(TEXT_ROOT).unwrap();
        let branch: &yrs::branch::Branch = text.as_ref();
        let mut count = 0;
        let mut next = branch.start();
        while let Some(item) = next {
            if !item.is_deleted() && matches!(item.content(), yrs::block::ItemContent::Format(..)) {
                count += 1;
            }
            next = item.right();
        }
        count
    }

    // Epo D3 (2026-10-09): replaying stored state for a fold, a capture, a
    // save or a rebuild keeps the format markers peers sent. Two peers bold
    // the same opening letters at once; with yrs's formatting cleanup on, the
    // replay deletes one of the two start markers as overwritten.
    #[test]
    fn working_docs_keep_the_format_markers_peers_sent() {
        let writer = Doc::with_options(ydoc::doc_options(1));
        let text = writer.get_or_insert_text(TEXT_ROOT);
        text.insert(&mut writer.transact_mut(), 0, "abcd");
        let seed = encode(&writer);
        let other = Doc::with_options(ydoc::doc_options(2));
        replay(&other, [seed.as_slice()]).unwrap();
        let theirs = other.transact_mut().get_or_insert_text(TEXT_ROOT);
        let bold = |doc: &Doc, text: &yrs::TextRef| {
            let before = doc.transact().state_vector();
            let attrs = yrs::types::Attrs::from([(Arc::from("bold"), Any::Bool(true))]);
            text.format(&mut doc.transact_mut(), 0, 2, attrs);
            doc.transact().encode_state_as_update_v1(&before)
        };
        let first = bold(&writer, &text);
        let second = bold(&other, &theirs);
        for office in [true, false] {
            let doc = working_doc(office);
            replay(&doc, [seed.as_slice(), first.as_slice(), second.as_slice()]).unwrap();
            assert_eq!(live_format_markers(&doc), 4, "office {office}");
        }
    }

    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::disk::GRACE;
    use crate::disk::tests::Folder;

    const TEXT: &[u8] = b"a text source";

    /// Serves `TEXT` at the returned URL and counts its downloads. As a
    /// gateway, the same server answers the session of the text file `file`
    /// whose base it is.
    async fn blob() -> (String, Arc<AtomicUsize>) {
        let downloads = Arc::new(AtomicUsize::new(0));
        let counted = downloads.clone();
        let session = json!({
            "access": "write",
            "baseRevision": 1,
            "baseSourceSHA256": office_service::sha256_hex(TEXT),
            "checkpoint": 0,
            "epoch": 1,
            "fileId": "file",
            "format": "text",
            "indexedCheckpoint": 0,
            "netTokens": 0,
            "room": "source:file:epoch:1",
            "sourceURL": "/blob",
            "workspaceId": "workspace",
        });
        let app = axum::Router::new()
            .route(
                "/blob",
                axum::routing::get(move || {
                    counted.fetch_add(1, Ordering::Relaxed);
                    async { TEXT }
                }),
            )
            .route(
                "/internal/collaboration/files/file/bootstrap",
                axum::routing::get(move || std::future::ready(axum::Json(session.clone()))),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/blob", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, downloads)
    }

    /// Sources whose database and engines are never reached.
    fn sources(folder: &Folder, disk_bytes: u64) -> Sources {
        sources_on(folder, disk_bytes, "http://127.0.0.1:1")
    }

    /// Sources with `api` as the gateway (its database and engines never
    /// reached).
    fn sources_on(folder: &Folder, disk_bytes: u64, api: &str) -> Sources {
        let mut db = deadpool_postgres::Config::new();
        db.url = Some("postgres://unused@127.0.0.1:1/unused".into());
        let db = db
            .create_pool(
                Some(deadpool_postgres::Runtime::Tokio1),
                tokio_postgres::NoTls,
            )
            .unwrap();
        let engine = PoolConfig {
            program: "unused".into(),
            args: Vec::new(),
            save_processes: 1,
            background_processes: 1,
            call_timeout: crate::engine::CALL_TIMEOUT,
            replica_budget_bytes: 0,
            memory_limit_bytes: None,
        };
        let config = SourcesConfig {
            api_url: api.into(),
            secret: "secret".into(),
            engine,
            disk_dir: folder.0.clone(),
            disk_bytes,
        };
        Sources::new(config, db, reqwest::Client::new()).unwrap()
    }

    // Epo 2026-10-17: roomless jobs read into memory per job; only a loaded
    // room writes files, and a job reads the files rooms wrote.
    #[tokio::test]
    async fn roomless_jobs_write_no_files_and_read_what_rooms_wrote() {
        let folder = Folder::new("jobs");
        let sources = sources(&folder, 1 << 20);
        let (url, downloads) = blob().await;
        let sha = office_service::sha256_hex(TEXT);
        let job = Job::default();
        let (bytes, hash) = sources.base(&url, &sha, Reader::Job(&job)).await.unwrap();
        assert_eq!((bytes.as_slice(), hash.as_str()), (TEXT, sha.as_str()));
        let seed = sources
            .seed(SourceFormat::Text, TEXT, &sha, None, Reader::Job(&job))
            .await
            .unwrap();
        assert_eq!(seed.state, text_seed(TEXT).unwrap());
        assert!(folder.files().is_empty());
        // An unbound base a room loads is filed under its hash.
        sources.base(&url, "", Reader::Load(1)).await.unwrap();
        assert_eq!(folder.files(), [format!("base-{sha}")]);
        assert_eq!(downloads.load(Ordering::Relaxed), 2);
        let next = Job::default();
        let (bytes, _) = sources.base(&url, &sha, Reader::Job(&next)).await.unwrap();
        assert_eq!(bytes, TEXT);
        assert_eq!(downloads.load(Ordering::Relaxed), 2);
    }

    // Epo 2026-10-17: a roomless job downloads and seeds each file once, for
    // itself only; the next job reads and seeds again.
    #[tokio::test]
    async fn a_job_reads_and_seeds_each_file_once_for_itself_only() {
        let folder = Folder::new("once");
        let sources = sources(&folder, 1 << 20);
        let (url, downloads) = blob().await;
        let sha = office_service::sha256_hex(TEXT);
        let job = Job::default();
        for _ in 0..3 {
            let (bytes, _) = sources.base(&url, &sha, Reader::Job(&job)).await.unwrap();
            assert_eq!(bytes, TEXT);
        }
        assert_eq!(downloads.load(Ordering::Relaxed), 1);
        // Other bytes under the same SHA show which call seeded.
        let other = b"other bytes";
        let seed = |bytes: &'static [u8], job| {
            sources.seed(SourceFormat::Text, bytes, &sha, None, Reader::Job(job))
        };
        let first = seed(TEXT, &job).await.unwrap();
        assert_eq!(seed(other, &job).await.unwrap().state, first.state);
        let next = Job::default();
        sources.base(&url, &sha, Reader::Job(&next)).await.unwrap();
        assert_eq!(downloads.load(Ordering::Relaxed), 2);
        assert_eq!(
            seed(other, &next).await.unwrap().state,
            text_seed(other).unwrap()
        );
        assert!(folder.files().is_empty());
    }

    // Epo 2026-10-17: a room load is refused only when loaded rooms' files
    // fill the cap; a loaded room's save and a job still get their bytes.
    #[tokio::test]
    async fn a_full_store_refuses_a_room_load_but_not_a_save_or_a_job() {
        let folder = Folder::new("full");
        let sources = sources(&folder, TEXT.len() as u64 - 1);
        let (url, _) = blob().await;
        let sha = office_service::sha256_hex(TEXT);
        let refused = sources.base(&url, &sha, Reader::Load(1)).await;
        assert_eq!(
            refused.unwrap_err(),
            SourceError::StoreFull {
                held: 0,
                cap: TEXT.len() as u64 - 1
            }
        );
        let job = Job::default();
        for reader in [Reader::Room(1), Reader::Job(&job)] {
            let (bytes, _) = sources.base(&url, &sha, reader).await.unwrap();
            assert_eq!(bytes, TEXT);
        }
        assert!(folder.files().is_empty());
    }

    // A room load that fails after it took a file (here the database is out
    // of reach once the base is down) lets go of it: it goes after the grace.
    #[tokio::test]
    async fn a_load_that_fails_midway_lets_go_of_its_files() {
        let folder = Folder::new("failed-load");
        let (url, downloads) = blob().await;
        let sources = sources_on(&folder, 1 << 20, url.trim_end_matches("/blob"));
        let room = SourceRoom {
            file_id: "file".into(),
            epoch: 1,
        };
        let loaded = sources.load(&room, "actor", &Doc::new()).await;
        assert!(
            matches!(&loaded, Err(SourceError::Other(message)) if message.starts_with("source database")),
            "{loaded:?}"
        );
        assert_eq!(downloads.load(Ordering::Relaxed), 1);
        let sha = office_service::sha256_hex(TEXT);
        assert_eq!(folder.files(), [format!("base-{sha}")]);
        sources.disk.sweep(Instant::now() + GRACE).await;
        assert!(folder.files().is_empty());
    }

    /// Answers the length of a body that never comes.
    async fn endless_blob() -> String {
        let app = axum::Router::new().route(
            "/endless",
            axum::routing::get(|| async {
                let body = futures::stream::pending::<Result<Vec<u8>, std::io::Error>>();
                (
                    [(axum::http::header::CONTENT_LENGTH, "1")],
                    axum::body::Body::from_stream(body),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/endless", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        url
    }

    // Epo 2026-10-17, the refusal unchanged: a room load the store has no
    // room for is refused before it downloads the original (only the length
    // is read) and before the engine seed call (no engine runs here).
    #[tokio::test]
    async fn a_full_store_refuses_a_room_load_before_the_download_and_the_seed() {
        let folder = Folder::new("early");
        let cap = TEXT.len() as u64;
        let sources = sources(&folder, cap);
        let (url, _) = blob().await;
        let sha = office_service::sha256_hex(TEXT);
        sources.base(&url, &sha, Reader::Load(1)).await.unwrap();
        let full = SourceError::StoreFull { held: cap, cap };
        let endless = endless_blob().await;
        let refused = tokio::time::timeout(
            Duration::from_secs(10),
            sources.base(&endless, "", Reader::Load(2)),
        )
        .await
        .expect("refused before the body");
        assert_eq!(refused.unwrap_err(), full);
        let other = office_service::sha256_hex(b"an office file");
        let refused = tokio::time::timeout(
            Duration::from_secs(10),
            sources.seed(
                SourceFormat::Docx,
                b"an office file",
                &other,
                None,
                Reader::Load(2),
            ),
        )
        .await
        .expect("refused before the seed call");
        assert_eq!(refused.err(), Some(full));
        assert_eq!(folder.files(), [format!("base-{sha}")]);
    }

    #[tokio::test]
    async fn a_corrupted_original_is_downloaded_again_and_a_corrupted_seed_rebuilt() {
        let folder = Folder::new("corrupt");
        let sources = sources(&folder, 1 << 20);
        let (url, downloads) = blob().await;
        let sha = office_service::sha256_hex(TEXT);
        sources.base(&url, &sha, Reader::Load(1)).await.unwrap();
        let base_file = folder.0.join(format!("base-{sha}"));
        std::fs::write(&base_file, &TEXT[..4]).unwrap();
        let (bytes, _) = sources.base(&url, &sha, Reader::Room(1)).await.unwrap();
        assert_eq!(bytes, TEXT);
        assert_eq!(downloads.load(Ordering::Relaxed), 2);
        assert_eq!(std::fs::read(&base_file).unwrap(), TEXT);
        let seed = sources
            .seed(SourceFormat::Text, TEXT, &sha, None, Reader::Load(1))
            .await
            .unwrap();
        let seed_file = folder.0.join(format!("seed-text-{sha}"));
        std::fs::write(&seed_file, vec![0; seed.state.len()]).unwrap();
        let rebuilt = sources
            .seed(SourceFormat::Text, TEXT, &sha, None, Reader::Room(1))
            .await
            .unwrap();
        assert_eq!(
            (rebuilt.state.as_slice(), rebuilt.sha256.as_str()),
            (seed.state.as_slice(), seed.sha256.as_str())
        );
        assert_eq!(std::fs::read(&seed_file).unwrap(), seed.state);
    }

    #[tokio::test]
    async fn keys_that_are_not_sha_hex_never_reach_the_folder() {
        let folder = Folder::new("keys");
        let sources = sources(&folder, 1 << 20);
        let (url, _) = blob().await;
        let sha = office_service::sha256_hex(TEXT);
        for bad in ["../../escape", "..", &sha.to_uppercase(), &sha[1..]] {
            let refused = sources.base(&url, bad, Reader::Load(1)).await;
            assert_eq!(
                refused.unwrap_err(),
                SourceError::Other("Source SHA mismatch".into())
            );
            let seed = sources
                .seed(SourceFormat::Text, TEXT, bad, None, Reader::Load(1))
                .await
                .unwrap();
            assert_eq!(seed.state, text_seed(TEXT).unwrap());
        }
        assert!(folder.files().is_empty());
        assert!(!folder.0.join("../../escape").exists());
    }
}
