//! Office pending effects, computed when the agent reads a file and cached
//! until any edit to it (Q405, Epo 2026-10-26). A read compares the stored
//! document, with this instance's live room merged in, against the
//! published baseline (`office_effects`). The cache keeps one entry per
//! file, valid while its stamp holds: a durable write (a save, an agent
//! edit, an Undo) moves the checkpoint, a publication the base revision or
//! the epoch, a live edit the room's edit version, and a room load or
//! unload its generation.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use office_service::NetEffect;
use serde::Serialize;
use yrs::{Doc, TransactionMut};

use crate::effects::{TextCount, edited_text};
use crate::gateway::SourceSession;
use crate::store::{Job, Reader, whole};
use crate::{BoxFuture, SourceError, SourceRoom, Sources};

/// Files whose effects one instance keeps; past it the least recently read
/// goes.
const CACHED_FILES: usize = 256;

const EDITS_OBSERVER: &str = "capy-source-edits";

/// What a loaded Office room's document took since its last save: a version
/// any change moves (the cache's key) and the text its transactions
/// inserted and deleted (the reindex count each save stores).
#[derive(Default)]
pub(crate) struct Edits {
    version: AtomicU64,
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

    pub(crate) fn version(&self) -> u64 {
        self.version.load(Ordering::SeqCst)
    }

    /// The count since the last save, for the save about to store it.
    pub(crate) fn take(&self) -> TextCount {
        TextCount {
            units: self.units.swap(0, Ordering::SeqCst),
            cjk: self.cjk.swap(0, Ordering::SeqCst),
        }
    }

    /// A count whose save failed: the next save stores it.
    pub(crate) fn put_back(&self, count: TextCount) {
        self.units.fetch_add(count.units, Ordering::SeqCst);
        self.cjk.fetch_add(count.cjk, Ordering::SeqCst);
    }
}

/// What a cached file's effects were read at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    epoch: u64,
    checkpoint: u64,
    base_revision: i64,
    /// The loaded room's (generation, edit version), when one was.
    room: Option<(u64, u64)>,
}

struct Cached {
    stamp: Stamp,
    effects: Arc<Vec<NetEffect>>,
    used: u64,
}

#[derive(Default)]
pub(crate) struct EffectsCache {
    files: HashMap<String, Cached>,
    tick: u64,
}

impl EffectsCache {
    fn get(&mut self, file_id: &str, stamp: &Stamp) -> Option<Arc<Vec<NetEffect>>> {
        self.tick += 1;
        let cached = self.files.get_mut(file_id)?;
        if cached.stamp != *stamp {
            return None;
        }
        cached.used = self.tick;
        Some(cached.effects.clone())
    }

    fn put(&mut self, file_id: &str, stamp: Stamp, effects: Arc<Vec<NetEffect>>) {
        self.tick += 1;
        let used = self.tick;
        self.files.insert(
            file_id.to_owned(),
            Cached {
                stamp,
                effects,
                used,
            },
        );
        // ponytail: O(n) scan for the oldest; a real LRU if the cap grows.
        if self.files.len() > CACHED_FILES
            && let Some(oldest) = self
                .files
                .iter()
                .min_by_key(|(_, cached)| cached.used)
                .map(|(file, _)| file.clone())
        {
            self.files.remove(&oldest);
        }
    }

    pub(crate) fn forget(&mut self, file_id: &str) {
        self.files.remove(file_id);
    }
}

/// One file's pending effects as the read found them.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChanges {
    pub file_id: String,
    pub epoch: u64,
    pub checkpoint: u64,
    pub changes: Arc<Vec<NetEffect>>,
}

/// `POST /internal/source-changes`: the files read, and those whose read
/// failed (the pipeline says their changes may be missing).
#[derive(Clone, Debug, Default, Serialize)]
pub struct OfficeChanges {
    pub files: Vec<FileChanges>,
    pub failed: Vec<String>,
}

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
        let client = self.db().get().await.map_err(crate::store::db_error)?;
        let rows = client
            .query(
                "SELECT d.file_id,d.epoch,d.checkpoint,d.base_revision FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=ANY($1) AND f.workspace_id=$2 AND f.trashed_at IS NULL AND d.format<>'text' ORDER BY d.file_id",
                &[&file_ids, &workspace_id],
            )
            .await
            .map_err(crate::store::db_error)?;
        drop(client);
        let mut out = OfficeChanges::default();
        for row in rows {
            let file_id: String = row.get(0);
            let (epoch, checkpoint) = (row.get::<_, i64>(1) as u64, row.get::<_, i64>(2) as u64);
            let stamp = self.stamp(&file_id, epoch, checkpoint, row.get(3));
            let hit = crate::store::lock(&self.effects).get(&file_id, &stamp);
            let read = match hit {
                Some(changes) => Ok((epoch, checkpoint, changes)),
                None => match self.current(&file_id).await {
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

    /// The stamp a read of the file now would have.
    fn stamp(&self, file_id: &str, epoch: u64, checkpoint: u64, base_revision: i64) -> Stamp {
        let room = SourceRoom {
            file_id: file_id.to_owned(),
            epoch,
        };
        Stamp {
            epoch,
            checkpoint,
            base_revision,
            room: self.room_edits(&room.name()),
        }
    }

    /// One Office file's pending effects now: cached, or read from the
    /// stored document with the live room merged in. The stamp is taken
    /// before the state, so an edit landing meanwhile only makes the next
    /// read compute again.
    pub(crate) async fn read_effects<F>(
        &self,
        session: &SourceSession,
        live: &F,
    ) -> Result<Arc<Vec<NetEffect>>, SourceError>
    where
        F: Fn(String) -> BoxFuture<Option<Vec<u8>>>,
    {
        let stamp = self.stamp(
            &session.file_id,
            session.epoch,
            session.checkpoint,
            session.base_revision,
        );
        if let Some(hit) = crate::store::lock(&self.effects).get(&session.file_id, &stamp) {
            return Ok(hit);
        }
        let job = Job::default();
        let (base, sha) = self.bound_base(session, Reader::Job(&job)).await?;
        let state = self
            .current_state(session, (&base, &sha), &job, live)
            .await?;
        let effects = Arc::new(
            self.office_effects(
                session,
                &base,
                &sha,
                &state,
                &session.room,
                Reader::Job(&job),
            )
            .await?,
        );
        crate::store::lock(&self.effects).put(&session.file_id, stamp, effects.clone());
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
