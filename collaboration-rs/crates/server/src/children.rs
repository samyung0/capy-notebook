//! The children pass (`server.ts` childrenPass, `children.ts` adoptChildren):
//! a writer's update or an agent edit that wrote asset ids or `material_ref`
//! ids makes those children the note's own. The room runs its passes one at a
//! time in update order (`room.rs`); this module asks the API and queues a
//! pass for a room that is not loaded here (it loads for the pass).

use std::time::Duration;

use notes::children::{ChildAnswer, ChildPlan};
use serde::Deserialize;
use serde_json::json;

use crate::app::Shared;
use crate::auth::RoomName;
use crate::room::{self, ChildPass, RoomCmd};

const ASSETS_PER_CALL: usize = 50;
const BLOCKS_PER_CALL: usize = 20;
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Queues a pass on `room`, loading the room as `actor` when it is not
/// loaded here (an agent edit's change).
pub fn queue(app: &Shared, room: &str, actor: &str, update: Vec<u8>) {
    let Some(name) = RoomName::parse(room) else {
        return;
    };
    let pass = ChildPass {
        actor: actor.to_owned(),
        update,
        notify: None,
    };
    let (app, room, actor) = (app.clone(), room.to_owned(), actor.to_owned());
    tokio::spawn(async move {
        // A room that unloads between the lookup and the send is spawned again.
        let mut pass = Box::new(pass);
        for _ in 0..2 {
            let handle = app
                .rooms
                .get_or_spawn(&room, |id| room::spawn(&app, &name, id, &actor));
            match handle.tx.send(RoomCmd::ChildPass(pass)).await {
                Ok(()) => return,
                Err(error) => match error.0 {
                    RoomCmd::ChildPass(back) => pass = back,
                    _ => return,
                },
            }
        }
    });
}

#[derive(Deserialize)]
struct Adopted {
    id: String,
    #[serde(rename = "sourceId", default)]
    source_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdoptAnswer {
    assets: Vec<Adopted>,
    materials: Vec<Adopted>,
    storage_refused: bool,
}

/// `adoptChildren`: the API makes each child the material's own (or says to
/// drop it), in batches of 50 assets and 20 blocks. Whether storage refused a
/// copy, with the answer.
pub async fn adopt(
    app: &Shared,
    material_id: &str,
    actor: &str,
    plan: &ChildPlan,
) -> Result<(ChildAnswer, bool), String> {
    let mut answer = ChildAnswer::default();
    let mut refused = false;
    let calls = plan
        .asset_ids
        .len()
        .div_ceil(ASSETS_PER_CALL)
        .max(plan.blocks.len().div_ceil(BLOCKS_PER_CALL));
    let url = format!(
        "{}/internal/collaboration/materials/{}/children",
        app.config.api_url,
        crate::projection::urlencode(material_id)
    );
    for call in 0..calls {
        let assets: Vec<&String> = plan
            .asset_ids
            .iter()
            .skip(call * ASSETS_PER_CALL)
            .take(ASSETS_PER_CALL)
            .collect();
        let blocks: Vec<_> = plan
            .blocks
            .iter()
            .skip(call * BLOCKS_PER_CALL)
            .take(BLOCKS_PER_CALL)
            .collect();
        let body = json!({
            "actorUserId": actor,
            "assetIds": assets,
            "materials": blocks
                .iter()
                .map(|block| json!({ "copy": block.copy, "materialId": block.material_id }))
                .collect::<Vec<_>>(),
        });
        let response = app
            .http
            .post(&url)
            .header("x-collaboration-secret", &app.config.secret)
            .json(&body)
            .timeout(CALL_TIMEOUT)
            .send()
            .await
            .map_err(|error| format!("children adoption failed: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let text: String = text.chars().take(500).collect();
            return Err(format!(
                "children adoption failed ({}): {text}",
                status.as_u16()
            ));
        }
        let result: AdoptAnswer = response
            .json()
            .await
            .map_err(|error| format!("children adoption answer: {error}"))?;
        for asset in result.assets {
            answer.assets.insert(asset.source_id, asset.id);
        }
        for (index, material) in result.materials.into_iter().enumerate() {
            if let Some(block) = blocks.get(index) {
                answer.blocks.insert(block.block_id.clone(), material.id);
            }
        }
        refused |= result.storage_refused;
    }
    Ok((answer, refused))
}
