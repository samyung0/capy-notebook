//! Discards and lineage moves (`collaboration/src/eviction.ts`, the discard
//! half of `evictLocalRoom`): a discard that threw unsaved room state away
//! moves the room's name on (a material's schema, a source's epoch) before
//! the room is accepted again, so a client holding that state goes to
//! recovery instead of resyncing it.

use std::time::Duration;

use serde_json::json;

use crate::app::Shared;
use crate::auth::RoomName;
use crate::incidents::{self, Cause, Incident, Kind};
use crate::note_store;
use crate::observe;

/// A failed lineage move retries this often; the room stays refused meanwhile.
const DISCARD_RETRY: Duration = Duration::from_secs(5);

/// Moves the lineage of a discarded room, retrying until it lands, then
/// accepts the room again. `epoch_reset` is recorded when this instance moved it.
pub async fn move_lineage(app: &Shared, room: &str, cause: Cause) {
    loop {
        let moved = match RoomName::parse(room) {
            Some(RoomName::Material {
                material_id,
                schema,
            }) => note_store::reset_lineage(&app.db, &material_id, schema)
                .await
                .map_err(|error| error.to_string()),
            Some(RoomName::Source { .. }) => Err("source rooms are not served yet".to_owned()),
            None => Ok(false),
        };
        match moved {
            Ok(moved) => {
                if moved {
                    incidents::record(
                        app,
                        vec![Incident {
                            cause: Cause {
                                kind: Kind::EpochReset,
                                reason: Some(cause.kind.as_str().to_owned()),
                            },
                            room: room.to_owned(),
                            size_bytes: None,
                            user_id: None,
                        }],
                    );
                }
                app.evictions.accept(room);
                observe::log(
                    observe::Level::Info,
                    "room_discarded",
                    json!({ "moved": moved, "reason": cause.kind.as_str(), "room": room }),
                );
                return;
            }
            Err(error) => {
                observe::capture(&error, None, &[("room", room), ("stage", "discard_retry")]);
                tokio::time::sleep(DISCARD_RETRY).await;
            }
        }
    }
}
