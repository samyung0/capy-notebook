//! The Capy collaboration server (rust-core). Phase 1 is the design
//! (capy-harness/2026-10-06-rust-round/rust-core/DESIGN.md); this binary is a
//! placeholder so the workspace builds while the crates take shape.

fn main() {
    let _ = (
        notes::CONTENT_ROOT,
        sources::MAX_SOURCE_STATE_BYTES,
        ydoc::CONTRIBUTORS_ROOT,
    );
}
