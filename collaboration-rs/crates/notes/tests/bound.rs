#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! The growth bound and the room validator beyond the single-writer
//! sequences: three writers on stale copies delivering merged or queued
//! updates (plate REVIEW1 M3).
mod common;

#[test]
fn three_writers_are_bounded_and_refused_as_the_node_server_did() {
    let mut failures = Vec::new();
    for seed in 1..=6 {
        let corpus = common::load(&format!("multi-{seed}"));
        let mut room = common::Room::new(
            &common::bytes(&corpus["initial"]),
            corpus["roomClient"].as_u64().unwrap(),
        );
        for (index, record) in corpus["deliveries"].as_array().unwrap().iter().enumerate() {
            let at = format!("multi-{seed} delivery {index}");
            room.deliver(
                record,
                &common::bytes(&record["update"]),
                &at,
                &mut failures,
            );
        }
        eprintln!("multi-{seed}: {}", room.summary());
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
