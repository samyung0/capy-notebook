//! Office pending effects, computed when the agent reads a file (Q405, Epo
//! 2026-10-26). A read compares the stored document against the published
//! baseline (`office_effects`) and keeps the result on the file's
//! source-document row (`effects_cache`, Q423, Epo 2026-10-27), for the
//! version it read: {"at": {epoch, checkpoint, baseRevision}, "effects"}.
//! Every save and publication moves that version and clears the column, so
//! a cold read writes it once per saved version, and it survives restarts.
//! A loaded room's unsaved edits are read live, merged into the stored
//! document, and never written.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use office_service::NetEffect;
use serde::Serialize;
use tokio_postgres::types::Json;
use yrs::{Doc, TransactionMut};

use crate::effects::{TextCount, edited_text};
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
            if txn.insert_set().is_empty() && txn.delete_set().is_empty() {
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

    /// The count since the last save, for the save about to store it, and
    /// the version that save holds (the room waits while it saves).
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
/// failed (the pipeline says their changes may be missing).
#[derive(Clone, Debug, Default, Serialize)]
pub struct OfficeChanges {
    pub files: Vec<FileChanges>,
    pub failed: Vec<String>,
}

/// The cached effects of a row whose version they were read at; NULL
/// otherwise.
const CACHED_EFFECTS_SQL: &str = "CASE WHEN d.effects_cache->'at'=jsonb_build_object('epoch',d.epoch,'checkpoint',d.checkpoint,'baseRevision',d.base_revision) THEN d.effects_cache->'effects' END";

impl Sources {
    /// The pending effects of the workspace's Office files among `file_ids`
    /// (text files and files of other workspaces are left out). `live`
    /// answers a room's state when this instance has it loaded. A cached
    /// file costs one statement for all and no engine call.
    pub async fn office_changes<F>(
        &self,
        workspace_id: &str,
        file_ids: &[String],
        live: F,
    ) -> Result<OfficeChanges, SourceError>
    where
        F: Fn(String) -> BoxFuture<Option<Vec<u8>>>,
    {
        let client = self.db().get().await.map_err(db_error)?;
        let rows = client
            .query(
                &format!(
                    "SELECT d.file_id,d.epoch,d.checkpoint,{CACHED_EFFECTS_SQL} FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=ANY($1) AND f.workspace_id=$2 AND f.trashed_at IS NULL AND d.format<>'text' ORDER BY d.file_id"
                ),
                &[&file_ids, &workspace_id],
            )
            .await
            .map_err(db_error)?;
        drop(client);
        let mut out = OfficeChanges::default();
        for row in rows {
            let file_id: String = row.get(0);
            let (epoch, checkpoint) = (row.get::<_, i64>(1) as u64, row.get::<_, i64>(2) as u64);
            let cached: Option<Json<Vec<NetEffect>>> = row.get(3);
            let read = match cached {
                Some(Json(changes)) if !self.unsaved(&file_id, epoch) => {
                    Ok((epoch, checkpoint, changes))
                }
                _ => match self.current(&file_id).await {
                    Ok(session) => self
                        .read_effects(&session, &live)
                        .await
                        .map(|changes| (session.epoch, session.checkpoint, changes)),
                    Err(error) => Err(error),
                },
            };
            match read {
                Ok((epoch, checkpoint, changes)) => out.files.push(FileChanges {
                    file_id,
                    epoch,
                    checkpoint,
                    changes,
                }),
                Err(error) => {
                    crate::observe::log(
                        "warn",
                        "office_changes_failed",
                        serde_json::json!({ "error": error.to_string(), "fileId": file_id }),
                    );
                    out.failed.push(file_id);
                }
            }
        }
        Ok(out)
    }

    /// One Office file's pending effects now. A room loaded here with
    /// unsaved edits: computed with them, never written. Otherwise the
    /// stored document's, from the row's cache, or computed and written
    /// there unless a save or publication moved the row meanwhile.
    pub(crate) async fn read_effects<F>(
        &self,
        session: &SourceSession,
        live: &F,
    ) -> Result<Vec<NetEffect>, SourceError>
    where
        F: Fn(String) -> BoxFuture<Option<Vec<u8>>>,
    {
        let unsaved = self.unsaved(&session.file_id, session.epoch);
        let at = (
            session.epoch as i64,
            session.checkpoint as i64,
            session.base_revision,
        );
        if !unsaved {
            let client = self.db().get().await.map_err(db_error)?;
            let row = client
                .query_opt(
                    &format!(
                        "SELECT {CACHED_EFFECTS_SQL} FROM source_documents d WHERE d.file_id=$1 AND d.epoch=$2 AND d.checkpoint=$3 AND d.base_revision=$4"
                    ),
                    &[&session.file_id, &at.0, &at.1, &at.2],
                )
                .await
                .map_err(db_error)?;
            if let Some(Json(cached)) =
                row.and_then(|row| row.get::<_, Option<Json<Vec<NetEffect>>>>(0))
            {
                return Ok(cached);
            }
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
        if !unsaved {
            let client = self.db().get().await.map_err(db_error)?;
            client
                .execute(
                    "UPDATE source_documents SET effects_cache=jsonb_build_object('at',jsonb_build_object('epoch',epoch,'checkpoint',checkpoint,'baseRevision',base_revision),'effects',$5::jsonb) WHERE file_id=$1 AND epoch=$2 AND checkpoint=$3 AND base_revision=$4",
                    &[&session.file_id, &at.0, &at.1, &at.2, &Json(&effects)],
                )
                .await
                .map_err(db_error)?;
        }
        Ok(effects)
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
