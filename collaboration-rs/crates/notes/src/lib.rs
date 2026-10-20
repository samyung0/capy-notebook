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
//!
//! The room admits only update shapes a real editor writes (Epo,
//! 2026-10-08): `limits::Validator::admit` refuses, through `ydoc::inspect`
//! and its own content check, what is valid Yjs but no editor produces and
//! would cost the room time or memory (a struct referring forward in its own
//! client, overlapping structs of one client, structs waiting on each other,
//! invisible content), and every walk it does stays linear in the update. An
//! update past a small edit is first applied to a copy of the room with yrs
//! counting its own work, and refused past `ydoc::MAX_WORK` steps.
//! `tests/admit_cost.rs` times admit and apply on each hostile shape,
//! `tests/fuzz_admit.rs` mutates real and crafted updates, and
//! `tests/yjs_traffic.rs` admits traffic made by Yjs itself. See
//! openwiki/frontend/plate-editor.md.

pub mod bound;
// Generated from server/internal/embeds by `pnpm gen:openapi`.
#[rustfmt::skip]
pub mod catalog;
pub mod children;
pub mod commands;
pub mod edit;
pub mod index_text;
pub mod json;
pub mod limits;
pub mod markdown;
pub mod material;
pub mod plate;
pub mod prescan;
pub mod questions;
pub mod repair;
pub mod slate;
pub mod slate_yjs;
pub mod validate;

pub use plate::CONTENT_ROOT;
