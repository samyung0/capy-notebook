//! Text save effects at 1/10/30 MiB: from the change (#12) against the whole
//! text read and compared, after one keystroke in the middle following an
//! earlier edit (so a previous window exists).
//!
//!   cargo run --release -p sources --example text_probe -- <MiB> <reps> <near|far>
//!
//! `near`: the earlier edit sits just before the keystroke (typing on);
//! `far`: it sits at the start, so the one effect spans half the file.

#![allow(clippy::print_stdout, clippy::unwrap_used)]

use std::time::Instant;

use serde_json::json;
use sources::effects::utf16;
use sources::text::{TEXT_ROOT, full_text_effects, text_doc, text_effects_from_change, text_seed};
use yrs::updates::decoder::Decode;
use yrs::{GetString, ReadTxn, Text, Transact, Update};

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mib: usize = args[1].parse().unwrap();
    let reps: usize = args[2].parse().unwrap();
    let far = args.get(3).is_some_and(|scenario| scenario == "far");
    let line = "The quick brown fox jumps over the lazy dog 漢字 0123456789\n";
    let base = line.repeat(mib * 1024 * 1024 / line.len());
    let baseline = utf16(&base);
    let room = text_doc(1);
    room.transact_mut()
        .apply_update(Update::decode_v1(&text_seed(base.as_bytes()).unwrap()).unwrap())
        .unwrap();
    let text = room.get_or_insert_text(TEXT_ROOT);
    let middle = (baseline.len() / 2) as u32;
    // An earlier saved edit near the start, then the keystroke being saved.
    let earlier = if far { 100 } else { middle - 50 };
    text.insert(&mut room.transact_mut(), earlier, "earlier ");
    let window = {
        let txn = room.transact();
        full_text_effects(&text.get_string(&txn), &baseline).window
    };
    let durable = room.transact().state_vector();
    text.insert(&mut room.transact_mut(), middle, "x");
    let row = room.transact().encode_state_as_update_v1(&durable);
    let row = Update::decode_v1(&row).unwrap();
    let (mut change, mut whole) = (Vec::new(), Vec::new());
    for _ in 0..reps {
        let txn = room.transact();
        let at = Instant::now();
        let fast = text_effects_from_change(&txn, &row, &baseline, window);
        change.push(at.elapsed().as_secs_f64() * 1000.0);
        let at = Instant::now();
        let slow = full_text_effects(&text.get_string(&txn), &baseline);
        whole.push(at.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(fast, slow);
    }
    println!(
        "{}",
        json!({ "mib": mib, "scenario": if far { "far" } else { "near" }, "fromChangeMs": median(change), "wholeMs": median(whole), "reps": reps })
    );
}
