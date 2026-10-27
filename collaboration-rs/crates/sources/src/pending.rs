//! Office pending effects, computed when the agent reads a file (Q405, Epo
//! 2026-10-26). A read compares the stored document against the published
//! baseline (`office_effects`) and keeps the result on the file's
//! source-document row (`effects_cache`, Q423, Epo 2026-10-27), for the
//! version it read: {"at": {epoch, checkpoint, baseRevision, engine},
//! "effects"}, `engine` the engine build's hash (Q435). Every save and
//! publication moves that version and clears the column, so a cold read
//! writes it once per saved version, and it survives restarts; an entry
//! that no longer decodes is a miss.
//! A loaded room's unsaved edits are read live, merged into the stored
//! document, and never written.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures::StreamExt;

use office_service::NetEffect;
use serde::Serialize;
use tokio_postgres::types::Json;
use yrs::{Doc, TransactionMut};

use crate::effects::{TextCount, edited_text, markers_only};
use crate::gateway::SourceSession;
use crate::store::{Job, Reader, db_error, whole};
use crate::{BoxFuture, SourceError, Sources};

const EDITS_OBSERVER: &str = "capy-source-edits";

/// What a loaded Office room's document took since its last save: a version
/// any change moves, the version its last save stored, and the text its
/// transactions inserted and deleted (the reindex count each save stores).
#[derive(Default)]
pub(crate) struct Edits {
    version: AtomicU64,
    saved: AtomicU64,
    units: AtomicU64,
    cjk: AtomicU64,
}

impl Edits {
    /// Counts every transaction on `doc` from now on, the room's writers',
    /// its service edits and Undo alike.
    pub(crate) fn observe(doc: &Doc) -> Result<Arc<Self>, SourceError> {
        let edits = Arc::new(Self::default());
        let seen = edits.clone();
        doc.observe_after_transaction_with(EDITS_OBSERVER, move |txn: &mut TransactionMut<'_>| {
            // Nothing, or only markers (a store's marker clear), is no edit:
            // the room stays saved (Q435).
            if markers_only(txn) {
                return;
            }
            seen.version.fetch_add(1, Ordering::SeqCst);
            let count = edited_text(txn);
            seen.units.fetch_add(count.units, Ordering::SeqCst);
            seen.cjk.fetch_add(count.cjk, Ordering::SeqCst);
        })
        .map_err(|error| SourceError::Other(format!("source edit count: {error}")))?;
        Ok(edits)
    }

    /// The count since the last save and the version the document is at,
    /// taken by the room task as it captures a save's row (Q435): edits it
    /// applies while that save runs stay unsaved.
    pub(crate) fn take(&self) -> (TextCount, u64) {
        let version = self.version.load(Ordering::SeqCst);
        let count = TextCount {
            units: self.units.swap(0, Ordering::SeqCst),
            cjk: self.cjk.swap(0, Ordering::SeqCst),
        };
        (count, version)
    }

    /// A save that stored `version`: the room holds no edit it lacks.
    pub(crate) fn saved(&self, version: u64) {
        self.saved.store(version, Ordering::SeqCst);
    }

    /// A count whose save failed: the next save stores it.
    pub(crate) fn put_back(&self, count: TextCount) {
        self.units.fetch_add(count.units, Ordering::SeqCst);
        self.cjk.fetch_add(count.cjk, Ordering::SeqCst);
    }

    /// The room holds edits its last save did not store.
    pub(crate) fn unsaved(&self) -> bool {
        self.version.load(Ordering::SeqCst) != self.saved.load(Ordering::SeqCst)
    }
}

/// One file's pending effects as the read found them.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChanges {
    pub file_id: String,
    pub epoch: u64,
    pub checkpoint: u64,
    pub changes: Vec<NetEffect>,
}

/// `POST /internal/source-changes`: the files read, and those whose read
/// failed or did not finish in time (the pipeline says their changes may be
/// missing).
#[derive(Clone, Debug, Default, Serialize)]
pub struct OfficeChanges {
    pub files: Vec<FileChanges>,
    pub failed: Vec<String>,
}

/// Office files one read computes at once; the engine pool bounds the work
/// itself (Q435).
const READS_AT_ONCE: usize = 4;

/// What one `/internal/source-changes` call may take (Q435): files not read
/// by then answer failed, the others still answer. Go waits a little longer
/// (`sourceChangesTimeout`).
pub const OFFICE_CHANGES_BUDGET: Duration = Duration::from_secs(20);

/// The cached effects of a row whose version they were read at, NULL
/// otherwise; `$1` is the engine's version.
const CACHED_EFFECTS_SQL: &str = "CASE WHEN d.effects_cache->'at'=jsonb_build_object('epoch',d.epoch,'checkpoint',d.checkpoint,'baseRevision',d.base_revision,'engine',$1::text) THEN d.effects_cache->'effects' END";

/// A row's cached effects (column `index`); an entry that no longer decodes
/// is a miss, read again and replaced (Q435).
fn decoded(row: &tokio_postgres::Row, index: usize, file_id: &str) -> Option<Vec<NetEffect>> {
    match row.try_get::<_, Option<Json<Vec<NetEffect>>>>(index) {
        Ok(cached) => cached.map(|Json(effects)| effects),
        Err(error) => {
            crate::observe::log(
                "warn",
                "office_effects_cache_unreadable",
                serde_json::json!({ "error": error.to_string(), "fileId": file_id }),
            );
            None
        }
    }
}

impl Sources {
    /// The pending effects of the workspace's Office files among `file_ids`
    /// (text files and files of other workspaces are left out). `live`
    /// answers a room's state when this instance has it loaded. Cached files
    /// cost one statement for all and no engine call; the rest are read
    /// [`READS_AT_ONCE`] at a time, and those not read within `budget`
    /// answer failed.
    pub async fn office_changes<F>(
        &self,
        workspace_id: &str,
        file_ids: &[String],
        live: F,
        budget: Duration,
    ) -> Result<OfficeChanges, SourceError>
    where
        F: Fn(String) -> BoxFuture<Option<Vec<u8>>>,
    {
        let deadline = tokio::time::Instant::now() + budget;
        let engine = self.engine_version().await?;
        let client = self.db().get().await.map_err(db_error)?;
        let rows = client
            .query(
                &format!(
                    "SELECT d.file_id,d.epoch,d.checkpoint,{CACHED_EFFECTS_SQL} FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=ANY($2) AND f.workspace_id=$3 AND f.trashed_at IS NULL AND d.format<>'text' ORDER BY d.file_id"
                ),
                &[&engine, &file_ids, &workspace_id],
            )
            .await
            .map_err(db_error)?;
        drop(client);
        let mut out = OfficeChanges::default();
        let mut misses = Vec::new();
        for row in rows {
            let file_id: String = row.get(0);
            let (epoch, checkpoint) = (row.get::<_, i64>(1) as u64, row.get::<_, i64>(2) as u64);
            match decoded(&row, 3, &file_id) {
                Some(changes) if !self.unsaved(&file_id, epoch) => out.files.push(FileChanges {
                    file_id,
                    epoch,
                    checkpoint,
                    changes,
                }),
                _ => misses.push(file_id),
            }
        }
        let live = &live;
        let reads: Vec<_> = futures::stream::iter(misses)
            .map(|file_id| async move {
                let read = tokio::time::timeout_at(deadline, async {
                    let session = self.current(&file_id).await?;
                    let changes = self.read_effects(&session, live, None).await?;
                    Ok::<_, SourceError>((session.epoch, session.checkpoint, changes))
                })
                .await;
                (file_id, read)
            })
            .buffer_unordered(READS_AT_ONCE)
            .collect()
            .await;
        for (file_id, read) in reads {
            let error = match read {
                Ok(Ok((epoch, checkpoint, changes))) => {
                    out.files.push(FileChanges {
                        file_id,
                        epoch,
                        checkpoint,
                        changes,
                    });
                    continue;
                }
                Ok(Err(error)) => error.to_string(),
                Err(_) => "not read within the budget".to_owned(),
            };
            crate::observe::log(
                "warn",
                "office_changes_failed",
                serde_json::json!({ "error": error, "fileId": file_id }),
            );
            out.failed.push(file_id);
        }
        out.files.sort_by(|a, b| a.file_id.cmp(&b.file_id));
        out.failed.sort();
        Ok(out)
    }

    /// The engine's build (Q435): the first 16 hex digits of the engine
    /// program's SHA-256, hashed once per process. Cached effects carry it,
    /// so a new engine (a pin bump, a reader change) reads every file anew.
    async fn engine_version(&self) -> Result<String, SourceError> {
        self.engine_version
            .get_or_try_init(|| async {
                let program = self.engine_program.clone();
                tokio::task::spawn_blocking(move || {
                    use sha2::Digest;
                    let mut hasher = sha2::Sha256::new();
                    std::io::copy(&mut std::fs::File::open(&program)?, &mut hasher)?;
                    let hex: String = hasher.finalize()[..8]
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect();
                    Ok::<_, std::io::Error>(hex)
                })
                .await
                .map_err(|error| SourceError::Other(format!("engine version: {error}")))?
                .map_err(|error| SourceError::Other(format!("engine version: {error}")))
            })
            .await
            .cloned()
    }

    /// One file's cached effects for its current version (a miss: none).
    pub(crate) async fn cached_effects(
        &self,
        session: &SourceSession,
    ) -> Result<Option<Vec<NetEffect>>, SourceError> {
        let engine = self.engine_version().await?;
        let client = self.db().get().await.map_err(db_error)?;
        let row = client
            .query_opt(
                &format!(
                    "SELECT {CACHED_EFFECTS_SQL} FROM source_documents d WHERE d.file_id=$2 AND d.epoch=$3 AND d.checkpoint=$4 AND d.base_revision=$5"
                ),
                &[
                    &engine,
                    &session.file_id,
                    &(session.epoch as i64),
                    &(session.checkpoint as i64),
                    &session.base_revision,
                ],
            )
            .await
            .map_err(db_error)?;
        Ok(row.and_then(|row| decoded(&row, 0, &session.file_id)))
    }

    /// One Office file's pending effects now. A room loaded here with
    /// unsaved edits: computed with them, never written. Otherwise `cached`
    /// (the row's entry), or computed from the stored document and written
    /// to the row unless a save or publication moved it meanwhile; a failed
    /// write is logged and the effects still answer.
    pub(crate) async fn read_effects<F>(
        &self,
        session: &SourceSession,
        live: &F,
        cached: Option<Vec<NetEffect>>,
    ) -> Result<Vec<NetEffect>, SourceError>
    where
        F: Fn(String) -> BoxFuture<Option<Vec<u8>>>,
    {
        let unsaved = self.unsaved(&session.file_id, session.epoch);
        if !unsaved && let Some(cached) = cached {
            return Ok(cached);
        }
        let job = Job::default();
        let (base, sha) = self.bound_base(session, Reader::Job(&job)).await?;
        let mut layers = self.durable_layers(session, &base, &sha, &job).await?;
        if unsaved {
            layers.extend(live(session.room.clone()).await);
        }
        let state = whole(session.format, layers).await?;
        let effects = self
            .office_effects(
                session,
                &base,
                &sha,
                &state,
                &session.room,
                Reader::Job(&job),
            )
            .await?;
        if !unsaved && let Err(error) = self.cache_effects(session, &effects).await {
            crate::observe::log(
                "warn",
                "office_effects_cache_write_failed",
                serde_json::json!({ "error": error.to_string(), "fileId": session.file_id }),
            );
        }
        Ok(effects)
    }

    /// Writes a read's effects to the row at the version they were read at.
    async fn cache_effects(
        &self,
        session: &SourceSession,
        effects: &[NetEffect],
    ) -> Result<(), SourceError> {
        let engine = self.engine_version().await?;
        let client = self.db().get().await.map_err(db_error)?;
        client
            .execute(
                "UPDATE source_documents SET effects_cache=jsonb_build_object('at',jsonb_build_object('epoch',epoch,'checkpoint',checkpoint,'baseRevision',base_revision,'engine',$1::text),'effects',$6::jsonb) WHERE file_id=$2 AND epoch=$3 AND checkpoint=$4 AND base_revision=$5",
                &[
                    &engine,
                    &session.file_id,
                    &(session.epoch as i64),
                    &(session.checkpoint as i64),
                    &session.base_revision,
                    &Json(effects),
                ],
            )
            .await
            .map_err(db_error)?;
        Ok(())
    }

    /// The stored document with this instance's live room merged in, whole,
    /// as the editors see it now.
    pub(crate) async fn current_state<F>(
        &self,
        session: &SourceSession,
        (base, sha): (&[u8], &str),
        job: &Job,
        live: &F,
    ) -> Result<Vec<u8>, SourceError>
    where
        F: Fn(String) -> BoxFuture<Option<Vec<u8>>>,
    {
        let mut layers = self.durable_layers(session, base, sha, job).await?;
        layers.extend(live(session.room.clone()).await);
        whole(session.format, layers).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Any, Map, MapPrelim, Text, Transact};

    fn counted(doc: &Doc, edit: impl FnOnce(&mut TransactionMut<'_>)) -> TextCount {
        let mut txn = doc.transact_mut();
        edit(&mut txn);
        edited_text(&txn)
    }

    // Q405: the reindex count is the text an edit inserts and deletes, gross;
    // formatting counts nothing, the markers a new format replaces included.
    #[test]
    fn edits_count_their_text_and_formatting_counts_nothing() {
        let doc = ydoc::scratch_doc();
        let story = doc.get_or_insert_text("story");
        let typed = counted(&doc, |txn| story.insert(txn, 0, "hello world 漢字"));
        assert_eq!(typed, TextCount { units: 12, cjk: 2 });
        assert_eq!(typed.tokens(), 5);
        let colour = |name: &str| -> yrs::types::Attrs {
            [("color".into(), Any::from(name))].into_iter().collect()
        };
        assert_eq!(
            counted(&doc, |txn| story.format(txn, 0, 8, colour("red"))),
            TextCount::default()
        );
        let mut replaced_markers = false;
        let recoloured = counted(&doc, |txn| {
            story.format(txn, 0, 8, colour("blue"));
            replaced_markers = !txn.delete_set().is_empty();
        });
        assert!(replaced_markers, "the new colour replaces the old markers");
        assert_eq!(recoloured, TextCount::default());
        // A replacement counts both sides; a deletion inside a run its part.
        let replaced = counted(&doc, |txn| {
            story.remove_range(txn, 6, 5);
            story.insert(txn, 6, "there");
        });
        assert_eq!(replaced, TextCount { units: 10, cjk: 0 });
        assert_eq!(
            counted(&doc, |txn| story.remove_range(txn, 12, 1)),
            TextCount { units: 0, cjk: 1 }
        );
    }

    // An XLSX cell's content counts its value and formula text; its style
    // and other maps count nothing.
    #[test]
    fn xlsx_cells_count_their_value_and_formula() {
        let doc = ydoc::scratch_doc();
        let sheets = doc.get_or_insert_map("xlsx:sheets");
        let (contents, styles) = {
            let mut txn = doc.transact_mut();
            let sheet = sheets.insert(&mut txn, "sheet:0", MapPrelim::default());
            (
                sheet.insert(&mut txn, "contents", MapPrelim::default()),
                sheet.insert(&mut txn, "styles", MapPrelim::default()),
            )
        };
        let text = r#"{"value":{"kind":"text","value":"Grade"},"formula":null}"#;
        assert_eq!(
            counted(&doc, |txn| {
                contents.insert(txn, "a", text);
            }),
            TextCount { units: 5, cjk: 0 }
        );
        let formula = r#"{"value":{"kind":"number","value":12.5},"formula":{"text":"=A1*2","bindings":[],"opaque_context":null}}"#;
        // Replacing the cell counts the old content's text and the new one's.
        assert_eq!(
            counted(&doc, |txn| {
                contents.insert(txn, "a", formula);
            }),
            TextCount {
                units: 5 + 4 + 5,
                cjk: 0
            }
        );
        assert_eq!(
            counted(&doc, |txn| {
                styles.insert(txn, "a", "bold-style-key");
            }),
            TextCount::default()
        );
    }
}
