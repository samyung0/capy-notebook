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

/// The Plate envelope of a document, off the room's thread.
pub async fn content_of(doc: Doc) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        use yrs::Transact;
        let txn = doc.transact();
        let value = notes::plate::value(&txn).map_err(|error| error.to_string())?;
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
) -> Result<(), String> {
    let content = content_of(doc).await?;
    project(app, material_id, version, &content).await
}

/// `POST /internal/collaboration/materials/{id}/projection`.
pub async fn project(
    app: &Shared,
    material_id: &str,
    version: i64,
    content: &Value,
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
        .json(&json!({ "content": content, "yjsVersion": version }));
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

/// Projects a material from its durable rows (a room loaded nowhere here).
pub async fn project_durable(app: &Shared, material_id: &str) -> Result<i64, String> {
    let Some((_, version, base, rows)) = note_store::durable(&app.db, material_id)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Err("material not found".into());
    };
    let doc = tokio::task::spawn_blocking(move || -> Result<Doc, String> {
        let doc = ydoc::scratch_doc();
        ydoc::replay(&doc, &base, &rows).map_err(|error| error.to_string())?;
        Ok(doc)
    })
    .await
    .map_err(|error| error.to_string())??;
    project_doc(app, material_id, version, doc).await?;
    Ok(version)
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
        for (material_id, _) in pending {
            let prefix = format!("material:{material_id}:");
            if loaded.iter().any(|room| room.starts_with(&prefix)) {
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
