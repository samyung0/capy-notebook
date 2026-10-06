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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<String>>,
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
    let kind = match error {
        Error::Edit { .. } => FailureKind::Edit,
        Error::Rebase(_) => FailureKind::Rebase,
        Error::Invalid(_) => FailureKind::Invalid,
        Error::Engine(_) => FailureKind::Engine,
        Error::Panic(_) => FailureKind::Panic,
    };
    Failure {
        kind,
        message: error.to_string(),
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
                json!({ "inverse": to_json(result.inverse)?, "targets": to_json(result.targets)? }),
                vec![result.state],
            ))
        }
        "locateOfficeTargets" => {
            let ids = args.ids.as_deref().unwrap_or_default();
            Ok((
                to_json(
                    office_service::locate_targets(blob(0)?, checkpoint(1)?, ids)
                        .map_err(failure)?,
                )?,
                Vec::new(),
            ))
        }
        other => Err(Failure::invalid(format!("unknown engine method {other}"))),
    }
}
