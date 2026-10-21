//! Direct AI edits of a source and their Undo (sourceDocuments.ts
//! `applyEdit`, the Office half of editCommands.ts): commands run on an
//! isolated document of the durable state (base and rows) merged with this
//! instance's live room, text through the notes crate's text commands and
//! Office through the engine's commands, guarded as editCommands.ts guards
//! them. The change commits as one row through the checkpoint CAS with the
//! operation's receipt; a moved checkpoint applies the commands again on the
//! new state (3 attempts), an ended epoch never will.

use notes::edit::{DocumentCommand, GuardTarget};
use office_service::{Command, Target};
use serde_json::{Value, json};
use ydoc::guards::{GuardRun, full_guard, guards_equal, range_guard};
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, Map, Out, ReadTxn, StateVector, Transact};

use crate::effects::{effect_tokens, utf16};
use crate::engine::office::calls::On;
use crate::engine::{EngineError, FailureKind};
use crate::gateway::{CheckpointBody, CheckpointSaved};
use crate::store::{Job, Reader, office, replay, text_of};
use crate::text::{TEXT_ROOT, full_text_effects};
use crate::{BoxFuture, SourceError, SourceRoom, Sources};

const ATTEMPTS: usize = 3;

/// What the gateway asked: the commands, or an Undo of an earlier edit.
#[derive(Clone, Debug)]
pub struct EditInput {
    pub actor_user_id: String,
    pub commands: Vec<Value>,
    /// An Undo names the epoch its edit was made in.
    pub epoch: Option<u64>,
    pub file_id: String,
    /// The operation identity (`id`, `requestHash`, `toolVersion`, ...).
    pub operation: Value,
    pub undo: Option<EditUndo>,
}

#[derive(Clone, Debug)]
pub struct EditUndo {
    pub undo_of: String,
    pub inverse: Value,
    pub guards: Value,
}

/// A committed edit: the receipt, its room, what that room lacks of it, the
/// stored cover it makes and the checkpoint it reached. `notice` is the
/// Office engine's note on the characters the agent's text lost (Epo
/// 2026-10-15), for the tool result.
pub struct EditResult {
    pub receipt: Value,
    pub notice: Option<String>,
    pub room: String,
    pub update: Vec<u8>,
    pub durable: ydoc::Durable,
    pub checkpoint: u64,
    pub row_bytes: usize,
}

fn edit_error(code: &str, message: impl Into<String>) -> SourceError {
    SourceError::Edit {
        code: code.into(),
        message: message.into(),
        details: None,
    }
}

/// An agent edit whose update is over `ydoc::MAX_UPDATE_BYTES` (Epo
/// 2026-10-18): the gateway hears `quota_rejected` and tells the agent to
/// make smaller edits.
fn check_update_size(update: &[u8]) -> Result<(), SourceError> {
    if update.len() > ydoc::MAX_UPDATE_BYTES {
        return Err(edit_error("quota_rejected", "update_size_exceeded"));
    }
    Ok(())
}

pub(crate) fn parse<T: serde::de::DeserializeOwned>(
    value: Value,
    what: &str,
) -> Result<T, SourceError> {
    serde_json::from_value(value)
        .map_err(|error| edit_error("invalid_input", format!("invalid {what}: {error}")))
}

impl From<notes::edit::EditError> for SourceError {
    fn from(error: notes::edit::EditError) -> Self {
        match error {
            notes::edit::EditError::Edit {
                code,
                message,
                details,
            } => SourceError::Edit {
                code: serde_json::to_value(code)
                    .ok()
                    .and_then(|code| code.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "invalid_input".into()),
                message,
                details,
            },
            other => SourceError::Other(other.to_string()),
        }
    }
}

/// `officeError`: an engine refusal of an agent edit crosses the process
/// boundary as `<code>: message`, with its details.
pub(crate) fn office_error(error: EngineError) -> SourceError {
    if let EngineError::Refused(failure) = &error
        && failure.kind == FailureKind::Edit
        && let Some((code, message)) = failure.message.split_once(": ")
        && matches!(
            code,
            "invalid_input" | "stale_target" | "unavailable_target" | "unsupported_operation"
        )
    {
        return SourceError::Edit {
            code: code.into(),
            message: message.into(),
            details: failure.details.clone(),
        };
    }
    SourceError::Engine(error)
}

/// `officeRuns`: the item runs at one engine-reported location. Stories are
/// Y.Text values under a root map; an XLSX cell is an entry of a nested map,
/// where every value ever written for the key counts (the newest first in the
/// map, older ones to its left).
fn office_runs<T: ReadTxn>(
    txn: &T,
    path: &[String],
    range: Option<[u32; 2]>,
) -> Result<Vec<GuardRun>, SourceError> {
    let (first, rest) = path
        .split_first()
        .ok_or_else(|| edit_error("invalid_input", "empty path"))?;
    let Some(key) = rest.last() else {
        return Err(edit_error("invalid_input", "empty path"));
    };
    let mut map = txn
        .get_map(first.as_str())
        .ok_or_else(|| edit_error("stale_target", "the edited location is gone"))?;
    for step in &rest[..rest.len() - 1] {
        match map.get(txn, step) {
            Some(Out::YMap(next)) => map = next,
            _ => return Err(edit_error("stale_target", "the edited location is gone")),
        }
    }
    if let Some([start, end]) = range {
        let Some(Out::YText(text)) = map.get(txn, key) else {
            return Err(edit_error("stale_target", "the edited story is gone"));
        };
        // A paragraph with text guards its own runs; an empty one needs a neighbour.
        let pad = if end > start { 0 } else { 1 };
        return Ok(range_guard(txn, text.as_ref(), start, end, pad));
    }
    let branch: &yrs::branch::Branch = map.as_ref();
    let mut runs = Vec::new();
    let mut item = branch.entry_item(key);
    while let Some(current) = item {
        let id = current.id();
        let mut run = GuardRun {
            client: id.client.get(),
            clock: id.clock,
            deleted: current.is_deleted(),
            format: false,
            len: current.len(),
            nested: None,
        };
        if !run.deleted
            && let yrs::block::ItemContent::Type(nested) = current.content()
        {
            run.nested = Some(full_guard(txn, nested.as_ref()));
        }
        runs.push(run);
        item = current.left();
    }
    runs.reverse();
    Ok(runs)
}

/// `officeGuards`.
fn office_guards(doc: &Doc, targets: &[Target]) -> Result<Vec<GuardTarget>, SourceError> {
    let txn = doc.transact();
    targets
        .iter()
        .map(|target| {
            Ok(GuardTarget::Office {
                id: target.id.clone(),
                path: target.path.clone(),
                range: target.range,
                runs: office_runs(&txn, &target.path, target.range)?,
            })
        })
        .collect()
}

/// `verifyOfficeGuards`: each guard at the location the engine reports for
/// its stable id now (story offsets move when earlier paragraphs change).
fn verify_office_guards(
    doc: &Doc,
    guards: &[GuardTarget],
    located: &[Target],
) -> Result<(), SourceError> {
    let txn = doc.transact();
    for guard in guards {
        let GuardTarget::Office { id, runs, .. } = guard else {
            return Err(edit_error(
                "stale_target",
                "guard does not fit an Office source",
            ));
        };
        let target = located
            .iter()
            .find(|target| &target.id == id)
            .ok_or_else(|| edit_error("stale_target", "an edited target is gone"))?;
        if !guards_equal(&office_runs(&txn, &target.path, target.range)?, runs) {
            return Err(edit_error(
                "stale_target",
                "the edited content changed since this edit",
            ));
        }
    }
    Ok(())
}

impl Sources {
    /// `applyEdit`. `live` hands over this instance's copy of the room.
    pub async fn apply_edit<F>(&self, input: EditInput, live: F) -> Result<EditResult, SourceError>
    where
        F: Fn(&str) -> BoxFuture<Option<Vec<u8>>>,
    {
        let mut operation = input.operation.clone();
        operation["actorUserId"] = json!(input.actor_user_id);
        if operation.get("toolVersion").is_none_or(Value::is_null) {
            operation["toolVersion"] = json!(1);
        }
        let mut last = None;
        let job = Job::default();
        for _ in 0..ATTEMPTS {
            match self.edit_once(&input, &operation, &live, &job).await {
                Ok(result) => return Ok(result),
                // A moved checkpoint applies again on the new state; an ended
                // epoch never will.
                Err(error)
                    if error.status() == Some(409)
                        && !matches!(&error, SourceError::Request { code: Some(code), .. } if code == "epoch_changed") =>
                {
                    last = Some(error);
                }
                Err(error) => return Err(error),
            }
        }
        Err(last.unwrap_or_else(|| SourceError::Other("Source edit could not be committed".into())))
    }

    async fn edit_once<F>(
        &self,
        input: &EditInput,
        operation: &Value,
        live: &F,
        job: &Job,
    ) -> Result<EditResult, SourceError>
    where
        F: Fn(&str) -> BoxFuture<Option<Vec<u8>>>,
    {
        let session = self
            .gateway()
            .session(&input.file_id, &input.actor_user_id)
            .await?;
        if session.access != "write" {
            return Err(SourceError::request(
                403,
                "Source is not editable by this actor",
                None,
            ));
        }
        let room = SourceRoom {
            file_id: input.file_id.clone(),
            epoch: session.epoch,
        };
        let name = room.name();
        if input.epoch.is_some_and(|epoch| epoch != session.epoch) {
            return Err(edit_error(
                "stale_target",
                "the source was rebased since this edit",
            ));
        }
        let (base, sha) = self.bound_base(&session, Reader::Job(job)).await?;
        let stored = self.stored(&input.file_id, None).await?;
        if stored.epoch != session.epoch {
            return Err(SourceError::epoch_changed());
        }
        if stored.base_revision != session.base_revision {
            return Err(SourceError::request(
                409,
                "Source base moved during the edit",
                None,
            ));
        }
        let seeded = stored.state.is_none() && stored.rows.is_empty();
        let (seed, layers) = self
            .layers(
                session.format,
                &base,
                &sha,
                &stored,
                Some(&name),
                Reader::Job(job),
            )
            .await?;
        let live_state = live(&name).await;
        // The durable document, then the live room's (both off the runtime).
        let (doc, durable, live_vector) = tokio::task::spawn_blocking(
            move || -> Result<(Doc, ydoc::Durable, Option<StateVector>), SourceError> {
                let doc = ydoc::scratch_doc();
                replay(&doc, layers.iter().map(Vec::as_slice))?;
                let durable = ydoc::Durable::of(&doc.transact());
                let vector = match live_state {
                    Some(live) => {
                        let update = yrs::Update::decode_v1(&live)
                            .map_err(|error| SourceError::State(error.to_string()))?;
                        let vector = update.state_vector();
                        ydoc::apply(&doc, update)
                            .map_err(|error| SourceError::State(error.to_string()))?;
                        Some(vector)
                    }
                    None => None,
                };
                Ok((doc, durable, vector))
            },
        )
        .await
        .map_err(|error| SourceError::Other(format!("source edit: {error}")))??;
        let mut notice = None;
        let (inverse, guards) = match office(session.format) {
            None => {
                let root = doc.get_or_insert_text(TEXT_ROOT);
                let mut txn = doc.transact_mut();
                match &input.undo {
                    Some(undo) => {
                        let guards: Vec<GuardTarget> = parse(undo.guards.clone(), "guards")?;
                        notes::edit::verify_text_guards(&txn, &root, &guards)?;
                        let commands: Vec<DocumentCommand> =
                            parse(undo.inverse.clone(), "inverse")?;
                        let outcome = notes::edit::apply_text_commands(&mut txn, &root, &commands)?;
                        (
                            serde_json::to_value(outcome.inverse).unwrap_or_default(),
                            outcome.guards,
                        )
                    }
                    None => {
                        let commands: Vec<DocumentCommand> =
                            parse(Value::Array(input.commands.clone()), "commands")?;
                        let outcome = notes::edit::apply_text_commands(&mut txn, &root, &commands)?;
                        (
                            serde_json::to_value(outcome.inverse).unwrap_or_default(),
                            outcome.guards,
                        )
                    }
                }
            }
            Some(format) => {
                let state = doc
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default());
                let on = On {
                    format,
                    base: &base,
                    base_sha256: &sha,
                    room: Some(&name),
                };
                let commands: Vec<Command> = match &input.undo {
                    Some(undo) => {
                        let guards: Vec<GuardTarget> = parse(undo.guards.clone(), "guards")?;
                        let ids: Vec<String> = guards
                            .iter()
                            .map(|guard| match guard {
                                GuardTarget::Office { id, .. } => id.clone(),
                                _ => String::new(),
                            })
                            .collect();
                        let located = self
                            .engines()
                            .locate_targets(on, &state, &ids)
                            .await
                            .map_err(office_error)?;
                        verify_office_guards(&doc, &guards, &located)?;
                        parse(undo.inverse.clone(), "inverse")?
                    }
                    None => parse(Value::Array(input.commands.clone()), "commands")?,
                };
                let applied = self
                    .engines()
                    .apply_commands(on, &state, &commands)
                    .await
                    .map_err(office_error)?;
                notice = applied.notice;
                // The engine's state is the checkpoint plus its edits: merged
                // in, the document is the post-edit state the guards describe.
                ydoc::apply(
                    &doc,
                    yrs::Update::decode_v1(&applied.state)
                        .map_err(|error| SourceError::State(error.to_string()))?,
                )
                .map_err(|error| SourceError::State(error.to_string()))?;
                let inverse = serde_json::to_value(applied.inverse).unwrap_or_default();
                match office_guards(&doc, &applied.targets) {
                    Ok(guards) => (inverse, guards),
                    // An Undo whose targets cannot be guarded still lands,
                    // without a Redo (no commands, so Go stores no step).
                    Err(_) if input.undo.is_some() => (Value::Array(Vec::new()), Vec::new()),
                    Err(error) => return Err(error),
                }
            }
        };
        let whole = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        if whole.len() as u64
            > crate::admission_cap(crate::state_cap(
                seed.state.len() as u64,
                base.len() as u64,
                stored.export_cap,
            ))
        {
            return Err(SourceError::request(
                413,
                "Source checkpoint exceeds byte limit",
                None,
            ));
        }
        let (effects, preview) = match office(session.format) {
            Some(_) => (
                self.office_effects(&session, &base, &sha, &whole, &name, Reader::Job(job))
                    .await?,
                None,
            ),
            None => {
                let txn = doc.transact();
                let text = txn
                    .get_text(TEXT_ROOT)
                    .map(|text| text.get_string(&txn))
                    .unwrap_or_default();
                let save = full_text_effects(&text, &utf16(text_of(&base)?));
                (save.effects, Some(save.preview))
            }
        };
        let (row, after) = {
            let txn = doc.transact();
            let hidden = ydoc::live_markers(&txn);
            ydoc::delta_update(&txn, &durable, &hidden)
        };
        // The edit's own update, before a text source's first row takes its
        // seed: over the update cap it is refused before anything commits.
        check_update_size(&row)?;
        // A text source's first row carries its seed (see store).
        let row = if seeded && office(session.format).is_none() {
            whole
        } else {
            row
        };
        // An Undo carries its own inverse and guards too: its Undo is Redo.
        let mut operation = json!({
            "guards": guards,
            "inverse": { "commands": inverse },
            "receipt": operation,
        });
        if let Some(undo) = &input.undo {
            operation["undoOf"] = json!(undo.undo_of);
        }
        let body = CheckpointBody {
            actor_ids: vec![input.actor_user_id.clone()],
            epoch: session.epoch,
            expected_checkpoint: stored.checkpoint,
            base_revision: session.base_revision,
            update: Some(row.clone()),
            net_tokens: effect_tokens(&effects),
            pending_effects: effects,
            state_seed_sha256: office(session.format).map(|_| seed.sha256.clone()),
            base_source_sha256: seeded.then(|| sha.clone()),
            seed_bytes: (seeded && office(session.format).is_none())
                .then_some(seed.state.len() as u64),
            operation: Some(operation),
            preview,
        };
        let saved: CheckpointSaved = self
            .gateway()
            .file(&input.file_id, "checkpoint", Some(&body), None, None)
            .await?;
        self.not_seeded(&name);
        let receipt = saved
            .operation
            .ok_or_else(|| SourceError::Other("checkpoint did not return a receipt".into()))?;
        let update = match &live_vector {
            Some(vector) => doc.transact().encode_state_as_update_v1(vector),
            None => row.clone(),
        };
        Ok(EditResult {
            receipt,
            notice,
            room: name,
            update,
            durable: after,
            checkpoint: saved.checkpoint,
            row_bytes: row.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{MapPrelim, TextPrelim, WriteTxn};

    /// An agent edit's update over the cap is a `quota_rejected` refusal the
    /// agent can act on; one at the cap goes (Epo 2026-10-18).
    #[test]
    fn an_edit_over_the_update_cap_is_refused() {
        assert!(check_update_size(&vec![0; ydoc::MAX_UPDATE_BYTES]).is_ok());
        match check_update_size(&vec![0; ydoc::MAX_UPDATE_BYTES + 1]) {
            Err(SourceError::Edit { code, message, .. }) => {
                assert_eq!(
                    (code.as_str(), message.as_str()),
                    ("quota_rejected", "update_size_exceeded")
                );
            }
            other => panic!("{other:?}"),
        }
    }

    fn story_doc() -> Doc {
        let doc = Doc::new();
        let mut txn = doc.transact_mut();
        let stories = txn.get_or_insert_map("stories");
        let text = stories.insert(&mut txn, "p1", TextPrelim::new("hello world"));
        let _ = text;
        let cells = stories.insert(&mut txn, "cells", MapPrelim::default());
        cells.insert(&mut txn, "A1", "one");
        cells.insert(&mut txn, "A1", "two");
        drop(txn);
        doc
    }

    #[test]
    fn office_guards_cover_a_story_range_and_every_value_of_a_cell() {
        let doc = story_doc();
        let story = Target {
            id: "p1".into(),
            path: vec!["stories".into(), "p1".into()],
            range: Some([0, 5]),
        };
        let cell = Target {
            id: "A1".into(),
            path: vec!["stories".into(), "cells".into(), "A1".into()],
            range: None,
        };
        let guards = office_guards(&doc, &[story.clone(), cell.clone()]).unwrap();
        verify_office_guards(&doc, &guards, &[story.clone(), cell.clone()]).unwrap();
        // The cell keeps both values it was ever given.
        let GuardTarget::Office { runs, .. } = &guards[1] else {
            panic!()
        };
        assert_eq!(runs.len(), 2);
        assert!(runs[0].deleted && !runs[1].deleted);
        // Another write to the cell changes its guard.
        {
            let mut txn = doc.transact_mut();
            let stories = txn.get_or_insert_map("stories");
            let Some(Out::YMap(cells)) = stories.get(&txn, "cells") else {
                panic!()
            };
            cells.insert(&mut txn, "A1", "three");
        }
        let error = verify_office_guards(&doc, &guards, &[story, cell]).unwrap_err();
        assert!(matches!(error, SourceError::Edit { ref code, .. } if code == "stale_target"));
        // A target the engine no longer finds is stale.
        let error = verify_office_guards(&doc, &guards[..1], &[]).unwrap_err();
        assert!(matches!(error, SourceError::Edit { ref code, .. } if code == "stale_target"));
    }

    #[test]
    fn engine_edit_refusals_keep_their_code_and_details() {
        let block = json!({ "block": { "id": "p1", "type": "paragraph", "text": "now" } });
        let refused = EngineError::Refused(crate::engine::Failure {
            kind: FailureKind::Edit,
            message: "stale_target: the paragraph changed".into(),
            details: Some(block.clone()),
        });
        assert!(matches!(
            office_error(refused),
            SourceError::Edit { ref code, ref message, ref details }
                if code == "stale_target" && message == "the paragraph changed" && details.as_ref() == Some(&block)
        ));
        let other = EngineError::Transient("Office engine process exited".into());
        assert!(matches!(office_error(other), SourceError::Engine(_)));
    }
}
