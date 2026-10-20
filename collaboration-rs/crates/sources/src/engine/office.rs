//! The Office calls an engine process answers, named as officeRuntime.ts
//! named them, over office-service's typed API. Byte inputs travel as frame
//! blobs in a fixed order per method: the base first, then the states.

use std::sync::OnceLock;

use office_service::{Checkpoint, Command, Determinism, Error, Format, ObjectRef, XlsxReplicas};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::child::{Answer, ENV_REPLICA_BUDGET, Failure, FailureKind};
use super::frame::Frame;

/// The JSON half of a request (every field a method does not read stays out).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Args {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<Format>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_sha256: Option<String>,
    /// The room whose XLSX replica serves the call (`xlsxPendingEffects`,
    /// `dropOfficeReplica`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub now: Option<String>,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub object_ref: Option<ObjectRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<Vec<Command>>,
}

/// The process's XLSX replica cache, sized by the pool (its share of the
/// replica budget).
fn replicas() -> &'static XlsxReplicas {
    static REPLICAS: OnceLock<XlsxReplicas> = OnceLock::new();
    REPLICAS.get_or_init(|| {
        XlsxReplicas::new(
            std::env::var(ENV_REPLICA_BUDGET)
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        )
    })
}

pub(super) fn replica_stats_json() -> Value {
    let stats = replicas().stats();
    json!({
        "replicas": stats.replicas,
        "replicaBytes": stats.replica_bytes,
        "hits": stats.hits,
        "misses": stats.misses,
        "evictions": stats.evictions,
    })
}

fn failure(error: Error) -> Failure {
    let (kind, details) = match &error {
        Error::Edit { details, .. } => (FailureKind::Edit, details.clone()),
        Error::Rebase(_) => (FailureKind::Rebase, None),
        Error::Invalid(_) => (FailureKind::Invalid, None),
        Error::Engine(_) => (FailureKind::Engine, None),
        Error::Panic(_) => (FailureKind::Panic, None),
    };
    Failure {
        kind,
        message: error.to_string(),
        details,
    }
}

fn to_json(value: impl Serialize) -> Result<Value, Failure> {
    serde_json::to_value(value).map_err(|error| Failure::invalid(error.to_string()))
}

/// Answers one Office request.
pub fn dispatch(request: &Frame) -> Answer {
    let args: Args = serde_json::from_slice(&request.json)
        .map_err(|error| Failure::invalid(format!("engine request: {error}")))?;
    let blob = |index: usize| -> Result<&[u8], Failure> {
        request.blobs.get(index).map(Vec::as_slice).ok_or_else(|| {
            Failure::invalid(format!("{} needs byte argument {index}", request.head))
        })
    };
    let format = || {
        args.format
            .ok_or_else(|| Failure::invalid("format is required"))
    };
    let sha = args.base_sha256.as_deref().unwrap_or_default();
    let checkpoint = |index: usize| -> Result<Checkpoint<'_>, Failure> {
        Ok(Checkpoint {
            format: format()?,
            schema_version: 1,
            base_sha256: sha,
            state: blob(index)?,
        })
    };
    match request.head.as_str() {
        "seedOffice" => {
            let state = office_service::seed(format()?, blob(0)?).map_err(failure)?;
            Ok((Value::Null, vec![state]))
        }
        "officeBaseline" => Ok((
            to_json(office_service::baseline(blob(0)?, checkpoint(1)?).map_err(failure)?)?,
            Vec::new(),
        )),
        "xlsxPendingEffects" => {
            let effects = match &args.room {
                Some(room) => replicas().effects(blob(0)?, checkpoint(1)?, room),
                None => office_service::xlsx_pending_effects(blob(0)?, checkpoint(1)?),
            }
            .map_err(failure)?;
            Ok((to_json(effects)?, Vec::new()))
        }
        "dropOfficeReplica" => {
            replicas().drop_room(args.room.as_deref().unwrap_or_default());
            Ok((Value::Null, Vec::new()))
        }
        "rebaseOffice" => {
            let rebased =
                office_service::rebase(blob(0)?, checkpoint(1)?, checkpoint(2)?, blob(3)?)
                    .map_err(failure)?;
            Ok((to_json(rebased.effects)?, vec![rebased.state]))
        }
        "resolveAsset" => {
            let object_ref = args
                .object_ref
                .as_ref()
                .ok_or_else(|| Failure::invalid("ref is required"))?;
            let asset = office_service::resolve_asset(blob(0)?, checkpoint(1)?, object_ref)
                .map_err(failure)?;
            Ok((
                json!({ "mimeType": asset.mime_type, "sha256": asset.sha256 }),
                vec![asset.bytes],
            ))
        }
        "exportOffice" => {
            let determinism = Determinism {
                seed: args.seed.as_deref().unwrap_or_default(),
                now: args.now.as_deref().unwrap_or_default(),
            };
            let bytes =
                office_service::export(blob(0)?, checkpoint(1)?, determinism).map_err(failure)?;
            Ok((Value::Null, vec![bytes]))
        }
        "inspectOffice" => Ok((
            to_json(office_service::inspect(blob(0)?, checkpoint(1)?).map_err(failure)?)?,
            Vec::new(),
        )),
        "applyOfficeCommands" => {
            let commands = args.commands.as_deref().unwrap_or_default();
            let result = office_service::apply_commands(blob(0)?, checkpoint(1)?, commands)
                .map_err(failure)?;
            Ok((
                json!({
                    "inverse": to_json(result.inverse)?,
                    "targets": to_json(result.targets)?,
                    "notice": result.notice,
                }),
                vec![result.state],
            ))
        }
        other => Err(Failure::invalid(format!("unknown engine method {other}"))),
    }
}

/// The typed calls the server makes, on the lane each belongs to: saves
/// (effects, seeds for a load, replica drops) never wait behind background
/// work (exports, rebases, inspect, agent commands, assets).
pub mod calls {
    use office_service::{
        BaselineEntry, Command, CommandResult, Entry, Format, NetEffect, ObjectRef,
    };
    use serde::de::DeserializeOwned;
    use serde_json::Value;

    use super::Args;
    use crate::engine::{EngineError, EnginePool, Failure, Frame, Lane, Reply};

    /// What a save-lane call needs to name its base and state.
    #[derive(Clone, Copy, Debug)]
    pub struct On<'a> {
        pub format: Format,
        pub base: &'a [u8],
        pub base_sha256: &'a str,
        pub room: Option<&'a str>,
    }

    fn frame(method: &str, args: &Args, blobs: Vec<Vec<u8>>) -> Frame {
        Frame::new(method, serde_json::to_vec(args).unwrap_or_default(), blobs)
    }

    fn args(on: On<'_>) -> Args {
        Args {
            format: Some(on.format),
            base_sha256: Some(on.base_sha256.to_owned()),
            ..Args::default()
        }
    }

    fn parse<T: DeserializeOwned>(value: Value) -> Result<T, EngineError> {
        serde_json::from_value(value).map_err(|error| {
            EngineError::Refused(Failure::invalid(format!("engine answer: {error}")))
        })
    }

    fn blob(reply: &mut Reply) -> Result<Vec<u8>, EngineError> {
        if reply.blobs.is_empty() {
            return Err(EngineError::Transient(
                "Office engine answered without its bytes".into(),
            ));
        }
        Ok(reply.blobs.swap_remove(0))
    }

    impl EnginePool {
        /// seed(base): the state a NULL row stands for (seedOffice).
        pub async fn seed(&self, on: On<'_>) -> Result<Vec<u8>, EngineError> {
            let request = frame("seedOffice", &args(on), vec![on.base.to_vec()]);
            blob(&mut self.call(Lane::Save, on.room, request).await?)
        }

        /// officeBaseline of `state`.
        pub async fn baseline(
            &self,
            on: On<'_>,
            state: &[u8],
        ) -> Result<Vec<BaselineEntry>, EngineError> {
            let request = frame(
                "officeBaseline",
                &args(on),
                vec![on.base.to_vec(), state.to_vec()],
            );
            parse(self.call(Lane::Save, on.room, request).await?.value)
        }

        /// XLSX effects read off `state`'s overrides, with the room's replica.
        pub async fn xlsx_pending_effects(
            &self,
            on: On<'_>,
            state: &[u8],
        ) -> Result<Vec<NetEffect>, EngineError> {
            let mut request = args(on);
            request.room = on.room.map(str::to_owned);
            let request = frame(
                "xlsxPendingEffects",
                &request,
                vec![on.base.to_vec(), state.to_vec()],
            );
            parse(self.call(Lane::Save, on.room, request).await?.value)
        }

        /// Frees a room's replica once the room unloaded. A process that is
        /// not running holds none.
        pub async fn drop_room(&self, room: &str) {
            if !self.holds_room(room) {
                return;
            }
            let request = frame(
                "dropOfficeReplica",
                &Args {
                    room: Some(room.to_owned()),
                    ..Args::default()
                },
                Vec::new(),
            );
            let _ = self.call(Lane::Save, Some(room), request).await;
        }

        /// Edits saved after `captured`, landed on seed(exported), and their
        /// effects against the export (rebaseOffice).
        pub async fn rebase(
            &self,
            on: On<'_>,
            captured: &[u8],
            latest: &[u8],
            exported: &[u8],
        ) -> Result<(Vec<u8>, Vec<NetEffect>), EngineError> {
            let request = frame(
                "rebaseOffice",
                &args(on),
                vec![
                    on.base.to_vec(),
                    captured.to_vec(),
                    latest.to_vec(),
                    exported.to_vec(),
                ],
            );
            let mut reply = self.call(Lane::Background, on.room, request).await?;
            let state = blob(&mut reply)?;
            Ok((state, parse(reply.value)?))
        }

        /// The package bytes of `state` (exportOffice).
        pub async fn export(
            &self,
            on: On<'_>,
            state: &[u8],
            seed: &str,
            now: &str,
        ) -> Result<Vec<u8>, EngineError> {
            let mut request = args(on);
            request.seed = Some(seed.to_owned());
            request.now = Some(now.to_owned());
            let request = frame(
                "exportOffice",
                &request,
                vec![on.base.to_vec(), state.to_vec()],
            );
            blob(&mut self.call(Lane::Background, on.room, request).await?)
        }

        pub async fn inspect(&self, on: On<'_>, state: &[u8]) -> Result<Vec<Entry>, EngineError> {
            let request = frame(
                "inspectOffice",
                &args(on),
                vec![on.base.to_vec(), state.to_vec()],
            );
            parse(self.call(Lane::Background, on.room, request).await?.value)
        }

        /// Applies agent commands: the new state, the inverse in undo order and
        /// the post-edit target locations.
        pub async fn apply_commands(
            &self,
            on: On<'_>,
            state: &[u8],
            commands: &[Command],
        ) -> Result<CommandResult, EngineError> {
            let mut request = args(on);
            request.commands = Some(commands.to_vec());
            let request = frame(
                "applyOfficeCommands",
                &request,
                vec![on.base.to_vec(), state.to_vec()],
            );
            let mut reply = self.call(Lane::Background, on.room, request).await?;
            Ok(CommandResult {
                state: blob(&mut reply)?,
                inverse: parse(reply.value["inverse"].take())?,
                targets: parse(reply.value["targets"].take())?,
                notice: parse(reply.value["notice"].take())?,
            })
        }

        /// The image bytes of an effect's asset: (bytes, mime type, sha256).
        pub async fn resolve_asset(
            &self,
            on: On<'_>,
            state: &[u8],
            object_ref: &ObjectRef,
        ) -> Result<(Vec<u8>, String, String), EngineError> {
            let mut request = args(on);
            request.object_ref = Some(object_ref.clone());
            let request = frame(
                "resolveAsset",
                &request,
                vec![on.base.to_vec(), state.to_vec()],
            );
            let mut reply = self.call(Lane::Background, on.room, request).await?;
            let bytes = blob(&mut reply)?;
            let text = |key: &str| reply.value[key].as_str().unwrap_or_default().to_owned();
            Ok((bytes, text("mimeType"), text("sha256")))
        }
    }
}
