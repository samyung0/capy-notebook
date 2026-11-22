//! Pure checks over a canvas board's yrs document, for the canvas room (Epo
//! 2026-11-22, "sure A then": the room checks every update against the
//! board's rules and refuses on entry one that breaks them). No I/O: the
//! server owns the room.
//!
//! - [catalog]: what a board holds and its limits, generated from the
//!   gateway's board catalog (`pnpm gen:openapi`), as the browser's is.
//! - [rules]: the rules an element and a block keep, the browser's
//!   `boardRules.ts` (RULES.md beside the branch's notes; parity tests hold
//!   the two together).
//! - [admit]: an update checked against them, linear in the update.

pub mod admit;
// Generated from server/internal/boardcatalog by `pnpm gen:openapi`.
#[rustfmt::skip]
pub mod catalog;
pub mod rules;

pub use admit::{ROOT, admit_shapes};

/// The deepest a board nests a type below its root (`ydoc::Bounds`), so
/// yrs's recursion through nested types stays shallow: a chain of 8,000
/// maps and the deletion of its top overflowed a worker's 2 MiB stack. A
/// resource bound like the size cap. The editor's deepest today is 5
/// (blocks, the surface block, its elements' holder and map, an element, the
/// element's own text or map), measured on the first state (3) and a saved
/// board with a plane card (5).
pub const DEPTH: u32 = 64;
