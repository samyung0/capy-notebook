//! Direct AI edits of a source (sourceDocuments.ts `applyEdit`, the Office
//! half of editCommands.ts): commands run on an isolated document of the
//! durable state (base and rows) merged with this instance's live room, text
//! through the notes crate's text commands and Office through the engine's
//! commands. The change commits as one row through the checkpoint CAS with
//! the operation's receipt; a moved checkpoint applies the commands again on
//! the new state (3 attempts), an ended epoch never will. The edit's own Yjs
//! items go to the live room, which keeps them for its Undo (`ydoc::undo`);
//! with no room loaded the edit has no Undo.

use notes::edit::DocumentCommand;
use office_service::Command;
use serde_json::{Value, json};
use ydoc::undo::Captured;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Transact};

use crate::effects::{TextCount, edited_text, effect_tokens, utf16};
use crate::engine::office::calls::On;
use crate::engine::{EngineError, FailureKind};
use crate::gateway::{CheckpointBody, CheckpointSaved};
use crate::store::{Job, Reader, office, replay, text_of};
use crate::text::{TEXT_ROOT, full_text_effects};
use crate::{BoxFuture, SourceError, SourceRoom, Sources};

const ATTEMPTS: usize = 3;

/// What the gateway asked.
#[derive(Clone, Debug)]
pub struct EditInput {
    pub actor_user_id: String,
    pub commands: Vec<Value>,
    pub file_id: String,
    /// The operation identity (`id`, `requestHash`, `toolVersion`, ...).
    pub operation: Value,
}

/// A committed edit: the receipt, its room, what that room lacks of it, the
/// stored cover it makes and the checkpoint it reached. `notice` is the
/// Office engine's note on the characters the agent's text lost (Epo
/// 2026-10-15), for the tool result. `captured` is the edit's own items,
/// when a live room took part (its Undo).
pub struct EditResult {
    pub receipt: Value,
    pub notice: Option<String>,
    pub room: String,
    pub update: Vec<u8>,
    pub durable: ydoc::Durable,
    pub checkpoint: u64,
    pub row_bytes: usize,
    pub captured: Option<Captured>,
    /// What its Undo may send ([crate::undo_cost]).
    pub undo_cost: usize,
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
        // The edit's Undo lives in the room: none without one (Epo 2026-10-20);
        // the server puts its ref on the receipt once the room took it.
        let undoable = live_state.is_some();
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
        let undo_cost: usize;
        // An Office edit's text, counted here when no room took part; an open
        // room counts what it applies (Q405).
        let mut edited = TextCount::default();
        let captured = match office(session.format) {
            None => {
                let root = doc.get_or_insert_text(TEXT_ROOT);
                let commands: Vec<DocumentCommand> =
                    parse(Value::Array(input.commands.clone()), "commands")?;
                undo_cost = commands
                    .iter()
                    .map(|command| crate::undo_cost::document(command, |_| 0))
                    .fold(0, usize::saturating_add);
                let mut txn = doc.transact_mut();
                notes::edit::apply_text_commands(&mut txn, &root, &commands)?;
                Captured::of(&mut txn)
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
                let commands: Vec<Command> =
                    parse(Value::Array(input.commands.clone()), "commands")?;
                let applied = self
                    .engines()
                    .apply_commands(on, &state, &commands)
                    .await
                    .map_err(office_error)?;
                // One `touched` a command the engine applied: the commands
                // its limits left out cost nothing.
                undo_cost = commands
                    .iter()
                    .zip(&applied.touched)
                    .map(|(command, touched)| crate::undo_cost::office(command, *touched))
                    .fold(0, usize::saturating_add);
                notice = applied.notice;
                // The engine's state is the checkpoint plus its edits: merged
                // in, what it adds is the edit.
                let update = yrs::Update::decode_v1(&applied.state)
                    .map_err(|error| SourceError::State(error.to_string()))?;
                let mut txn = doc.transact_mut();
                txn.apply_update(update)
                    .map_err(|error| SourceError::State(error.to_string()))?;
                if !undoable {
                    edited = edited_text(&txn);
                }
                Captured::of(&mut txn)
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
        // Office effects are read on demand (Q405): the edit adds its count.
        let (effects, net_tokens, preview) = match office(session.format) {
            Some(_) => (
                Vec::new(),
                session.net_tokens.max(0) as u64 + edited.tokens(),
                None,
            ),
            None => {
                let txn = doc.transact();
                let text = txn
                    .get_text(TEXT_ROOT)
                    .map(|text| text.get_string(&txn))
                    .unwrap_or_default();
                let save = full_text_effects(&text, &utf16(text_of(&base)?));
                let tokens = effect_tokens(&save.effects);
                (save.effects, tokens, Some(save.preview))
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
        let operation = json!({ "receipt": operation });
        let body = CheckpointBody {
            actor_ids: vec![input.actor_user_id.clone()],
            epoch: session.epoch,
            expected_checkpoint: stored.checkpoint,
            base_revision: session.base_revision,
            update: Some(row.clone()),
            net_tokens,
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
            captured: undoable.then_some(captured),
            undo_cost,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // A busy by-id read is a refusal the agent reads (409), not an outage.
        assert!(matches!(
            office_error(crate::engine::busy()),
            SourceError::Edit { ref code, ref message, .. }
                if code == "unavailable_target" && message.contains("busy")
        ));
    }
}
