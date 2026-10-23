//! The sample the browser's WASM build is held to
//! (src/features/collaboration/lateMerge/lateMerge.test.ts): a Plate note
//! whose tab went offline and edited while the room edited and collected
//! units the tab still holds. The native merge gives exactly the stored
//! bytes, and so must the WASM one. `LATE_MERGE_WRITE_SAMPLE=1` writes the
//! sample again (after a deliberate change to the merge's output).
#![allow(clippy::unwrap_used)] // Tests panic on a broken case.

mod support;

use std::path::PathBuf;

use support::collect::collect;
use support::note::{Note, edit, sync};
use support::rng::Rng;
use yrs::{ID, IdSet, ReadTxn, Transact};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// (the tab's document, the room's collected document).
fn sample() -> (Vec<u8>, Vec<u8>) {
    let mut rng = Rng::new(7);
    let mut room = Note::new(1, "s");
    for k in 0..4 {
        let n = room.root.children.len() - 1;
        let len = room.block_chars(n);
        let text = format!("paragraph {k} has some words in it");
        let ops = room.insert_ops(n, len, &text);
        room.apply(&ops);
        let ops = room.split_ops(n, len + text.chars().count());
        room.apply(&ops);
    }
    let mut tab = Note::load(2, "t-", &room.state());
    let mut other = Note::load(3, "o-", &room.state());
    for _ in 0..30 {
        edit(&mut tab, &mut rng);
        edit(&mut other, &mut rng);
        sync(&other, &mut room);
        sync(&room, &mut other);
    }
    let (sv, ds) = {
        let txn = room.doc.transact();
        (txn.state_vector(), txn.snapshot().delete_set)
    };
    let current = collect(&room.doc, &sv, &ds, &IdSet::new());
    (tab.state(), current)
}

/// Units the tab holds that the room had and collected: the merge redirects
/// them.
fn collected_units(old: &[u8], current: &[u8]) -> usize {
    let (old, current) = (Note::load(8, "x", old), Note::load(9, "y", current));
    let (otxn, ctxn) = (old.doc.transact(), current.doc.transact());
    let held = ctxn.state_vector();
    let mut count = 0;
    for (client, clock) in otxn.state_vector().iter() {
        for k in 0..held.get(client).min(*clock) {
            if ctxn.store().get_item(&ID::new(*client, k)).is_none() {
                count += 1;
            }
        }
    }
    count
}

#[test]
fn the_native_merge_gives_the_samples_bytes() {
    if std::env::var_os("LATE_MERGE_WRITE_SAMPLE").is_some() {
        let (old, current) = sample();
        let merged = late_merge::merge(&old, &[], &current).unwrap();
        std::fs::create_dir_all(fixture("")).unwrap();
        std::fs::write(fixture("sample-old.bin"), &old).unwrap();
        std::fs::write(fixture("sample-current.bin"), &current).unwrap();
        std::fs::write(fixture("sample-merged.bin"), &merged).unwrap();
    }
    let old = std::fs::read(fixture("sample-old.bin")).unwrap();
    let current = std::fs::read(fixture("sample-current.bin")).unwrap();
    assert!(
        collected_units(&old, &current) > 0,
        "the sample exercises collected units"
    );
    let merged = late_merge::merge(&old, &[], &current).unwrap();
    assert_eq!(merged, std::fs::read(fixture("sample-merged.bin")).unwrap());
    // The merged document holds the tab's text.
    let mut room = Note::load(9, "y", &current);
    room.receive(&merged);
    assert!(!room.pending());
}
