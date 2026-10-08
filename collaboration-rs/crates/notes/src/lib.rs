//! Pure functions over a note's yrs document (track rust-notes): the Plate
//! projection exactly as `@slate-yjs/core` gives it, exact metrics and the
//! per-update growth bound, agent edit commands, children, questions and
//! material validation. No I/O, clocks or globals: the server (`crates/server`)
//! owns rooms, Postgres, API calls and timers. Interface contract:
//! capy-harness/2026-10-06-rust-round/rust-core/DESIGN.md section 6.
//!
//! A note document has two roots: `content` (a Y.XmlText written by
//! `@slate-yjs/core`, children are Y.XmlText blocks) and the server-owned
//! contributor marker map (`ydoc::CONTRIBUTORS_ROOT`). Documents count text
//! in UTF-16 units, as Yjs and Slate do (`ydoc::doc_options`).

pub mod bound;
pub mod children;
pub mod commands;
pub mod edit;
pub mod json;
pub mod limits;
pub mod markdown;
pub mod material;
pub mod plate;
pub mod questions;
pub mod slate;
pub mod slate_yjs;
pub mod validate;

pub use plate::CONTENT_ROOT;
