//! Pure functions over a note's yrs document (track rust-notes): the Plate
//! projection exactly as `@slate-yjs/core` gives it, exact metrics and the
//! per-update growth bound, agent edit commands, children, questions and
//! material validation. No I/O, clocks or globals: the server owns rooms,
//! Postgres, API calls and timers.
//!
//! Documents must count text in UTF-16 units (`yrs::OffsetKind::Utf16`), as
//! Yjs and Slate do: [`doc_options`].

pub mod bound;
pub mod json;
pub mod limits;
pub mod plate;
pub mod slate;
pub mod slate_yjs;
pub mod update;
pub mod validate;

pub use plate::CONTENT_ROOT;

/// Options for a note document: UTF-16 offsets, garbage collection on.
pub fn doc_options(client_id: u64) -> yrs::Options {
    let mut options = yrs::Options::with_client_id(yrs::block::ClientID::new(client_id));
    options.offset_kind = yrs::OffsetKind::Utf16;
    options
}
