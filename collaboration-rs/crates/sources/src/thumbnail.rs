//! List-card thumbnails after agent edits (openwiki/thumbnails.md, "Agent
//! captures"). Once per finished agent response Go names each Office file the
//! turn edited with the edits' targets; this checks them against the durable
//! document and, when page 1 may have changed, draws page 1 as the browser's
//! capture does (`render`, in an engine process). Nothing here runs on an
//! edit or a save.

use std::collections::HashSet;

use office_service::Format;
use serde::Deserialize;
use yrs::{Any, Array, Map, Out, ReadTxn, StateVector, Transact};

use crate::engine::office::calls::On;
use crate::store::{EXPORT_NOW, office, replay};
use crate::{SourceError, Sources};

/// Where the fork's engines keep an XLSX workbook's sheet order and a PPTX
/// deck's slides, their shapes and the shapes' text stories
/// (`office_service::document_roots`, pptx-edit `deck.rs`).
const SHEET_ORDER: &str = "xlsx:sheet-order";
const SLIDE_ORDER: &str = "pptx:slide-order";
const SLIDES: &str = "pptx:slides";
const SHAPES: &str = "pptx:shapes";

/// One file of a finished turn, as Go read its edits' stored inverses and
/// guards: the XLSX sheets with a `set_cell` inside the captured top-left
/// area (Go applies the area), the PPTX stories the edits changed.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTargets {
    pub file_id: String,
    #[serde(default)]
    pub sheets: Vec<String>,
    #[serde(default)]
    pub stories: Vec<String>,
}

/// Whether the turn's edits may have changed page 1: any DOCX edit, an XLSX
/// one on the first sheet, a PPTX one in a story of slide 1.
pub fn page_one_changed<T: ReadTxn>(
    format: Format,
    txn: &T,
    sheets: &[String],
    stories: &[String],
) -> bool {
    match format {
        Format::Docx => true,
        Format::Xlsx => {
            first_in_order(txn, SHEET_ORDER).is_some_and(|first| sheets.contains(&first))
        }
        Format::Pptx => {
            let on_slide = slide_one_stories(txn);
            stories.iter().any(|story| on_slide.contains(story))
        }
    }
}

fn first_in_order<T: ReadTxn>(txn: &T, root: &str) -> Option<String> {
    match txn.get_array(root)?.get(txn, 0)? {
        Out::Any(Any::String(id)) => Some(id.to_string()),
        _ => None,
    }
}

/// A JSON string list a shape holds (`textStories`, `children`).
fn strings(value: Option<Out>) -> Vec<String> {
    match value {
        Some(Out::Any(Any::Array(values))) => values
            .iter()
            .filter_map(|value| match value {
                Any::String(value) => Some(value.to_string()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The text stories of slide 1's shapes, a group's children included.
fn slide_one_stories<T: ReadTxn>(txn: &T) -> HashSet<String> {
    let mut stories = HashSet::new();
    let (Some(first), Some(slides), Some(shapes)) = (
        first_in_order(txn, SLIDE_ORDER),
        txn.get_map(SLIDES),
        txn.get_map(SHAPES),
    ) else {
        return stories;
    };
    let mut pending: Vec<String> = match slides.get(txn, &first) {
        Some(Out::YMap(slide)) => match slide.get(txn, "shapes") {
            Some(Out::YArray(order)) => order
                .iter(txn)
                .filter_map(|id| match id {
                    Out::Any(Any::String(id)) => Some(id.to_string()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    while let Some(id) = pending.pop() {
        if let Some(Out::YMap(shape)) = shapes.get(txn, &id) {
            stories.extend(strings(shape.get(txn, "textStories")));
            pending.extend(strings(shape.get(txn, "children")));
        }
    }
    stories
}

impl Sources {
    /// Page 1 of the file's durable state (every committed agent edit is in
    /// it) as a list-card WebP when the turn's edits may have changed it, or
    /// `None`. A DOCX is exported first as a refresh candidate is.
    pub async fn thumbnail_capture(
        &self,
        targets: &TurnTargets,
    ) -> Result<Option<Vec<u8>>, SourceError> {
        let session = self.current(&targets.file_id).await?;
        let format = office(session.format).ok_or_else(|| {
            SourceError::request(422, "Only Office sources take thumbnails", None)
        })?;
        let (base, sha) = self.bound_base(&session).await?;
        let stored = self.stored(&targets.file_id, None).await?;
        if stored.epoch != session.epoch {
            return Err(SourceError::epoch_changed());
        }
        let (_, layers) = self
            .layers(session.format, &base, &sha, &stored, None)
            .await?;
        let (sheets, stories) = (targets.sheets.clone(), targets.stories.clone());
        let state = tokio::task::spawn_blocking(move || -> Result<_, SourceError> {
            let doc = ydoc::scratch_doc();
            replay(&doc, layers.iter().map(Vec::as_slice))?;
            let txn = doc.transact();
            Ok(page_one_changed(format, &txn, &sheets, &stories)
                .then(|| txn.encode_state_as_update_v1(&StateVector::default())))
        })
        .await
        .map_err(|error| SourceError::Other(format!("thumbnail state: {error}")))??;
        let Some(state) = state else {
            return Ok(None);
        };
        let seed = office_service::sha256_hex(format!(
            "{}:{}:{}",
            targets.file_id, stored.epoch, stored.checkpoint
        ));
        let on = On {
            format,
            base: &base,
            base_sha256: &sha,
            room: None,
        };
        Ok(Some(
            self.engines()
                .render_thumbnail(on, &state, &seed, EXPORT_NOW)
                .await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use office_service::{Checkpoint, Command, Entry};
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, Update};

    use super::*;

    fn fixture(path: &str) -> Vec<u8> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        std::fs::read(root.join(path)).unwrap()
    }

    fn doc(state: &[u8]) -> Doc {
        let doc = ydoc::scratch_doc();
        replay(&doc, [state]).unwrap();
        doc
    }

    fn encode(doc: &Doc) -> Vec<u8> {
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// Moves `id` to the front of an order array, as a peer reordering
    /// sheets or slides does.
    fn move_first(state: &[u8], root: &str, id: &str) -> Vec<u8> {
        let doc = doc(state);
        {
            let mut txn = doc.transact_mut();
            let order = txn.get_array(root).unwrap();
            let at = order
                .iter(&txn)
                .position(|entry| matches!(entry, Out::Any(Any::String(entry)) if &*entry == id))
                .unwrap();
            order.remove(&mut txn, at as u32);
            order.insert(&mut txn, 0, id.to_owned());
        }
        encode(&doc)
    }

    fn first(state: &[u8], root: &str) -> String {
        first_in_order(&doc(state).transact(), root).unwrap()
    }

    struct Edited {
        state: Vec<u8>,
        inverse: Vec<Command>,
        paths: Vec<Vec<String>>,
    }

    fn apply(format: Format, base: &[u8], state: &[u8], command: Command) -> Edited {
        let sha = office_service::sha256_hex(base);
        let checkpoint = Checkpoint {
            format,
            schema_version: 1,
            base_sha256: &sha,
            state,
        };
        let result = office_service::apply_commands(base, checkpoint, &[command]).unwrap();
        // The engine's state is the checkpoint plus its edits.
        let doc = doc(state);
        doc.transact_mut()
            .apply_update(Update::decode_v1(&result.state).unwrap())
            .unwrap();
        Edited {
            state: encode(&doc),
            inverse: result.inverse,
            paths: result
                .targets
                .into_iter()
                .map(|target| target.path)
                .collect(),
        }
    }

    fn entries(format: Format, base: &[u8], state: &[u8]) -> Vec<Entry> {
        let sha = office_service::sha256_hex(base);
        office_service::inspect(
            base,
            Checkpoint {
                format,
                schema_version: 1,
                base_sha256: &sha,
                state,
            },
        )
        .unwrap()
    }

    fn changed(format: Format, state: &[u8], sheets: &[String], stories: &[String]) -> bool {
        page_one_changed(format, &doc(state).transact(), sheets, stories)
    }

    #[test]
    fn a_docx_edit_always_counts() {
        let base = fixture("e2e/fixtures/files/basic/lesson.docx");
        let seed = office_service::seed(Format::Docx, &base).unwrap();
        assert!(changed(Format::Docx, &seed, &[], &[]));
    }

    // The sheet a set_cell's stored inverse names is the sheet order's entry,
    // so the first sheet counts wherever it moved; another sheet never does.
    #[test]
    fn an_xlsx_edit_counts_on_the_first_sheet_only() {
        let base = fixture("e2e/fixtures/files/rich-content/course-guide.xlsx");
        let seed = office_service::seed(Format::Xlsx, &base).unwrap();
        let cells = entries(Format::Xlsx, &base, &seed);
        let sheet_of = |entry: &Entry| entry.position.rsplit_once(':').unwrap().0.to_owned();
        let first_sheet = first(&seed, SHEET_ORDER);
        let on_sheet = |wanted: bool| {
            cells
                .iter()
                .find(|entry| (sheet_of(entry) == first_sheet) == wanted && !entry.value.is_empty())
                .expect("a cell with a value")
                .clone()
        };
        let edit = |entry: &Entry| {
            let (sheet, cell) = entry.position.rsplit_once(':').unwrap();
            apply(
                Format::Xlsx,
                &base,
                &seed,
                Command::SetCell {
                    sheet: sheet.to_owned(),
                    cell: cell.to_owned(),
                    expected_value: entry.value.clone(),
                    value: format!("{} edited", entry.value),
                },
            )
        };
        let sheets = |edited: &Edited| -> Vec<String> {
            edited
                .inverse
                .iter()
                .map(|command| match command {
                    Command::SetCell { sheet, .. } => sheet.clone(),
                    other => panic!("an XLSX inverse is a set_cell, got {other:?}"),
                })
                .collect()
        };
        let on_first = edit(&on_sheet(true));
        assert_eq!(sheets(&on_first), std::slice::from_ref(&first_sheet));
        assert!(changed(
            Format::Xlsx,
            &on_first.state,
            &sheets(&on_first),
            &[]
        ));
        let on_other = edit(&on_sheet(false));
        assert!(!changed(
            Format::Xlsx,
            &on_other.state,
            &sheets(&on_other),
            &[]
        ));
        assert!(!changed(Format::Xlsx, &on_first.state, &[], &[]));
        // Its sheet moved first: the same edit now counts, the other no longer.
        let moved = move_first(&on_other.state, SHEET_ORDER, &sheets(&on_other)[0]);
        assert!(changed(Format::Xlsx, &moved, &sheets(&on_other), &[]));
        assert!(!changed(Format::Xlsx, &moved, &sheets(&on_first), &[]));
    }

    // A replace_text guard's story is on slide 1 or it is not; a slide moved
    // first brings its stories along.
    #[test]
    fn a_pptx_edit_counts_on_slide_one_only() {
        let base = fixture("e2e/fixtures/files/basic/lesson.pptx");
        let seed = office_service::seed(Format::Pptx, &base).unwrap();
        let paragraphs = entries(Format::Pptx, &base, &seed);
        let on = |slide: &str| {
            paragraphs
                .iter()
                .find(|entry| entry.label.starts_with(slide) && entry.value.len() > 3)
                .unwrap_or_else(|| panic!("a paragraph on {slide}"))
                .clone()
        };
        let edit = |entry: &Entry| {
            apply(
                Format::Pptx,
                &base,
                &seed,
                Command::ReplaceText {
                    target_id: entry.id.clone(),
                    expected_text: entry.value.clone(),
                    text: format!("{} edited", entry.value),
                },
            )
        };
        let stories = |edited: &Edited| -> Vec<String> {
            edited
                .paths
                .iter()
                .map(|path| {
                    assert_eq!(path[0], "pptx:stories");
                    path[1].clone()
                })
                .collect()
        };
        let first = edit(&on("Slide 1,"));
        assert!(changed(Format::Pptx, &first.state, &[], &stories(&first)));
        let last = edit(&on("Slide 2,"));
        assert!(!changed(Format::Pptx, &last.state, &[], &stories(&last)));
        assert!(!changed(Format::Pptx, &first.state, &[], &[]));
        // Slide 2 moved first: its edit now counts, slide 1's no longer.
        let order = doc(&last.state);
        let second = {
            let txn = order.transact();
            match txn.get_array(SLIDE_ORDER).unwrap().get(&txn, 1).unwrap() {
                Out::Any(Any::String(id)) => id.to_string(),
                _ => panic!("the slide order holds strings"),
            }
        };
        let moved = move_first(&last.state, SLIDE_ORDER, &second);
        assert!(changed(Format::Pptx, &moved, &[], &stories(&last)));
        assert!(!changed(Format::Pptx, &moved, &[], &stories(&first)));
    }
}
