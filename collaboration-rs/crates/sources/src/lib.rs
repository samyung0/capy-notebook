//! Office and text source rooms (track rust-sources), over the fork's native
//! Office engines (`office-service`, track office-native). Pure where it can
//! be: the server (`crates/server`) owns rooms, Postgres, the gateway calls,
//! Redis and timers. Interface contract: DESIGN.md section 6.

use serde::{Deserialize, Serialize};

/// The Yjs state cap of a source room (`MAX_SOURCE_STATE_BYTES`).
pub const MAX_SOURCE_STATE_BYTES: usize = 100 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceFormat {
    Docx,
    Xlsx,
    Pptx,
    Text,
}
