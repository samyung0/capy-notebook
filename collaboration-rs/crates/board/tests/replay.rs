#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Every update the editor sent in the growth bench's sessions
//! (`tests/fixtures/editor-sessions.json.gz`, written by
//! `bench/collaboration/scripts/board-growth.growth.ts`, each session from
//! the board's first state) is admitted. With `--nocapture` in release it
//! prints each update's admission time (median, p99, max): the placement
//! with its trial, and the content check alone.
mod common;

use std::io::Read;
use std::time::{Duration, Instant};

use base64::Engine;
use common::*;
use serde_json::Value;

fn sessions() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/editor-sessions.json.gz"
    );
    let file = std::fs::File::open(path)
        .unwrap_or_else(|error| panic!("{path}: {error} (written by the growth bench)"));
    let mut text = String::new();
    flate2::read::GzDecoder::new(file)
        .read_to_string(&mut text)
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

fn spread(name: &str, mut times: Vec<Duration>) {
    times.sort();
    let at = |share: f64| times[((times.len() - 1) as f64 * share) as usize];
    eprintln!(
        "{name}: {} updates, median {:?}, p99 {:?}, max {:?}",
        times.len(),
        at(0.5),
        at(0.99),
        at(1.0)
    );
}

#[test]
fn every_editor_update_is_admitted() {
    let (mut whole_times, mut shape_times) = (Vec::new(), Vec::new());
    for session in sessions()["sessions"].as_array().unwrap() {
        let name = session["name"].as_str().unwrap();
        let room = room();
        for (at, update) in session["updates"].as_array().unwrap().iter().enumerate() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(update.as_str().unwrap())
                .unwrap();
            let decoded = ydoc::decode(&bytes).unwrap();
            let started = Instant::now();
            let verdict = {
                let txn = yrs::Transact::transact(&room);
                let incoming = ydoc::Incoming::new(&decoded);
                let bounds = ydoc::Bounds {
                    depth: board::DEPTH,
                };
                let inspection = ydoc::inspect_bounded(&txn, &incoming, bounds).unwrap();
                assert!(!inspection.unheld, "{name}: update {at} unheld");
                let checking = Instant::now();
                let verdict = board::admit_shapes(&txn, &incoming, inspection.trial.as_ref());
                shape_times.push(checking.elapsed());
                verdict
            };
            whole_times.push(started.elapsed());
            assert_eq!(verdict, Ok(()), "{name}: update {at}");
            ydoc::apply(&room, decoded).unwrap();
        }
    }
    spread("placement and content check", whole_times);
    spread("content check", shape_times);
}
