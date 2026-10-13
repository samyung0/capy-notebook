//! Note projection to `materials.content` (decision 3, DESIGN.md 5): on idle,
//! on unload, on demand, and a pending scan for rooms no instance projected.
//! The Go API writes the content; a failure is recorded on the row and
//! reported once per run of failures (2026-09-13).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Value, json};
use yrs::Doc;

use crate::app::Shared;
use crate::model::Model;
use crate::note_store;
use crate::observe::{self, ERROR_EVENT_HEADER, RETRY_EVENT_HEADER};

/// The first failure's event per material, until a projection succeeds.
#[derive(Default)]
pub struct Failures(Mutex<HashMap<String, String>>);

impl Failures {
    #[allow(clippy::unwrap_used)]
    fn get(&self, material: &str) -> Option<String> {
        self.0.lock().unwrap().get(material).cloned()
    }

    #[allow(clippy::unwrap_used)]
    fn set(&self, material: &str, event: String) {
        self.0.lock().unwrap().insert(material.to_owned(), event);
    }

    #[allow(clippy::unwrap_used)]
    fn clear(&self, material: &str) {
        self.0.lock().unwrap().remove(material);
    }
}

/// The stored version at which each material's projection is refused for
/// good (a quiz holding a block this version cannot read, which a projection
/// would drop): the pending scan skips it until the version moves, and the
/// refusal is logged once (R2-L2).
#[derive(Default)]
pub struct Refused(Mutex<HashMap<String, i64>>);

impl Refused {
    /// Records the refusal at `version`; whether it is new.
    #[allow(clippy::unwrap_used)]
    fn refuse(&self, material: &str, version: i64) -> bool {
        self.0.lock().unwrap().insert(material.to_owned(), version) != Some(version)
    }

    /// Whether the projection at `version` was refused.
    #[allow(clippy::unwrap_used)]
    fn held(&self, material: &str, version: i64) -> bool {
        self.0.lock().unwrap().get(material) == Some(&version)
    }
}

/// Why a quiz's projection is refused.
const UNREADABLE_QUIZ: &str = "the quiz holds a block this version cannot read";

/// The Plate envelope of a document, off the room's thread.
pub async fn content_of(doc: Doc, model: Model) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        use yrs::Transact;
        let txn = doc.transact();
        let value = model.value(&txn)?;
        Ok(json!({ "schemaVersion": 1, "value": value }))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Projects a document holding exactly the durable state at `version`.
pub async fn project_doc(
    app: &Shared,
    material_id: &str,
    version: i64,
    doc: Doc,
    model: Model,
) -> Result<(), String> {
    let content = content_of(doc, model).await?;
    project(app, material_id, version, &content, None).await
}

/// `POST /internal/collaboration/materials/{id}/projection`. A quiz also
/// names every editor asset its documents reference (`asset_ids`), complete
/// questions or not, so an image in an incomplete one stays in use (REVIEW1
/// S4).
pub async fn project(
    app: &Shared,
    material_id: &str,
    version: i64,
    content: &Value,
    asset_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let url = format!(
        "{}/internal/collaboration/materials/{}/projection",
        app.config.api_url,
        urlencode(material_id)
    );
    let previous = app.projection_failures.get(material_id);
    let mut request = app
        .http
        .post(url)
        .header("x-collaboration-secret", &app.config.secret)
        .timeout(Duration::from_secs(15))
        .json(&match asset_ids {
            Some(ids) => json!({ "assetIds": ids, "content": content, "yjsVersion": version }),
            None => json!({ "content": content, "yjsVersion": version }),
        });
    if let Some(event) = &previous {
        request = request.header(RETRY_EVENT_HEADER, event);
    }
    let outcome = match request.send().await {
        Ok(response) if response.status().is_success() => Ok(()),
        Ok(response) => {
            let status = response.status().as_u16();
            let event = observe::event_id(
                response
                    .headers()
                    .get(ERROR_EVENT_HEADER)
                    .and_then(|value| value.to_str().ok()),
            );
            let body = response.text().await.unwrap_or_default();
            let body: String = body.chars().take(500).collect();
            Err((format!("projection failed ({status}): {body}"), event))
        }
        Err(error) => Err((format!("projection failed: {error}"), None)),
    };
    match outcome {
        Ok(()) => {
            app.projection_failures.clear(material_id);
            Ok(())
        }
        Err((message, event)) => {
            if let Err(error) =
                note_store::record_projection_error(&app.db, material_id, version, &message).await
            {
                observe::capture(
                    &error.to_string(),
                    None,
                    &[
                        ("materialId", material_id),
                        ("stage", "projection_record_error"),
                    ],
                );
            }
            match previous {
                Some(first) => observe::log(
                    observe::Level::Warn,
                    "projection failed again",
                    json!({ "error": message, "event_id": first, "materialId": material_id }),
                ),
                None => {
                    let id = observe::capture(
                        &message,
                        event.as_deref(),
                        &[("materialId", material_id), ("stage", "projection")],
                    );
                    app.projection_failures
                        .set(material_id, id.unwrap_or_default());
                }
            }
            Err(message)
        }
    }
}

/// Projects a material from its durable rows: a room loaded nowhere here,
/// the cadence, and every quiz projection (a quiz projects from both its
/// documents, read together at one version).
pub async fn project_durable(app: &Shared, material_id: &str) -> Result<i64, String> {
    let Some(durable) = note_store::durable(&app.db, material_id)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Err("material not found".into());
    };
    let version = durable.version;
    let projected = tokio::task::spawn_blocking(move || projected(&durable))
        .await
        .map_err(|error| error.to_string())??;
    let Some((content, asset_ids)) = projected else {
        if app.projection_refused.refuse(material_id, version) {
            observe::log(
                observe::Level::Warn,
                "projection refused",
                json!({ "materialId": material_id, "reason": UNREADABLE_QUIZ, "version": version }),
            );
            if let Err(error) =
                note_store::record_projection_error(&app.db, material_id, version, UNREADABLE_QUIZ)
                    .await
            {
                observe::capture(
                    &error.to_string(),
                    None,
                    &[
                        ("materialId", material_id),
                        ("stage", "projection_record_error"),
                    ],
                );
            }
        }
        return Err(UNREADABLE_QUIZ.into());
    };
    project(app, material_id, version, &content, asset_ids).await?;
    Ok(version)
}

/// The content a material's durable documents project to, with a quiz's
/// editor assets; none for a quiz holding a block this version cannot read,
/// which the projection, and so the stored quiz, would drop (Epo 2026-10-13).
fn projected(
    durable: &note_store::Durable,
) -> Result<Option<(Value, Option<Vec<String>>)>, String> {
    use yrs::Transact;
    let replay = |base: &[u8], rows: &[Vec<u8>]| -> Result<Doc, String> {
        let doc = ydoc::scratch_doc();
        ydoc::replay(&doc, base, rows).map_err(|error| error.to_string())?;
        Ok(doc)
    };
    let doc = replay(&durable.base, &durable.rows)?;
    let (value, asset_ids) = match &durable.keys {
        Some((base, rows)) => {
            let keys = replay(base, rows)?;
            let (content, keys) = (doc.transact(), keys.transact());
            if items::quiz::holds_unknown_block(&content) || items::quiz::holds_unknown_block(&keys)
            {
                return Ok(None);
            }
            (
                items::quiz::value(&content, &keys),
                Some(items::quiz::asset_ids(&content, &keys)),
            )
        }
        None => (Model::of(&durable.kind).value(&doc.transact())?, None),
    };
    Ok(Some((
        json!({ "schemaVersion": 1, "value": value }),
        asset_ids,
    )))
}

/// The safety net for projections no room made (a crash before its idle or
/// unload projection): rows idle past the threshold whose room is not loaded
/// here. Every 5 s.
pub async fn run_pending(app: Shared) {
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    loop {
        tick.tick().await;
        let idle = app.config.projection_idle.as_secs_f64();
        let pending = match note_store::pending_projections(&app.db, idle, 25).await {
            Ok(pending) => pending,
            Err(error) => {
                observe::capture(
                    &error.to_string(),
                    None,
                    &[("stage", "projection_pending_query")],
                );
                continue;
            }
        };
        let loaded: Vec<String> = app.rooms.names();
        for (material_id, version) in pending {
            // Refused for good at this version: no retry every 5 s (R2-L2).
            if app.projection_refused.held(&material_id, version) {
                continue;
            }
            let prefixes = [
                format!("material:{material_id}:"),
                format!("keys:{material_id}:"),
            ];
            if loaded.iter().any(|room| {
                prefixes
                    .iter()
                    .any(|prefix| room.starts_with(prefix.as_str()))
            }) {
                continue;
            }
            // project() records and reports its own failure.
            let _ = project_durable(&app, &material_id).await;
        }
    }
}

/// Path segment encoding for ids (URL-safe already; kept for parity).
pub fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use serde_json::json;

    use super::{Refused, projected};
    use crate::note_store::Durable;

    /// A quiz holding a block this version cannot read projects to nothing
    /// (the projection would drop the block), and its refusal is held per
    /// stored version: new once, held until the version moves, so the
    /// pending scan stops retrying it every 5 s and logs it once (R2-L2).
    /// Fails if the refusal is not held, or the quiz projects.
    #[test]
    fn an_unreadable_quiz_projection_is_refused_once_per_version() {
        let durable = |stem: serde_json::Value| {
            let value = [json!({ "type": "quiz", "id": "quiz", "children": [{
                "type": "quiz_question", "id": "q1", "children": [{ "text": "" }],
                "question": {
                    "id": "q1", "labels": "letters", "layout": "paper", "stem": stem,
                    "parts": [{
                        "id": "q1:part:1", "marks": 1, "solution": [],
                        "blocks": [{ "type": "text", "text": "True?" }],
                        "answer": { "type": "boolean", "correct": true },
                    }],
                },
            }] })];
            let (content, keys) = items::quiz::states_from_value(&value, 0);
            Durable {
                version: 3,
                base: content,
                rows: Vec::new(),
                kind: "quiz".into(),
                keys: Some((keys, Vec::new())),
            }
        };
        assert!(
            projected(&durable(json!([{ "type": "timeline", "events": [] }])))
                .unwrap()
                .is_none()
        );
        assert!(
            projected(&durable(json!([{ "type": "text", "text": "Stem" }])))
                .unwrap()
                .is_some()
        );
        let refused = Refused::default();
        assert!(!refused.held("q", 3));
        assert!(refused.refuse("q", 3));
        assert!(!refused.refuse("q", 3), "logged once per version");
        assert!(refused.held("q", 3));
        assert!(!refused.held("q", 4), "a new version projects again");
    }
}
