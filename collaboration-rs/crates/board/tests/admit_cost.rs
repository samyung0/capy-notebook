#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! The content check's cost, counted, not timed (Epo, 2026-10-08): the steps
//! of its walks (`Walk::Board`) stay linear in the update, plus the entities
//! it touches. A small edit on a large board reads that one entity, and a
//! reconnect repeating a long delete set costs a step per deleted run, so a
//! walk that turned quadratic, or read the whole board, fails here.
mod common;

use common::*;
use ydoc::steps::Walk;
use yrs::encoding::write::Write;

/// Board steps per byte of the update: linear walks measure about 1 on the
/// shapes below; one that turned quadratic takes thousands at these sizes.
const STEPS_PER_BYTE: u64 = 4;

/// The content check's steps on `bytes` (admitted), apart from the
/// placement's.
fn board_steps(room: &yrs::Doc, bytes: &[u8]) -> u64 {
    let update = ydoc::decode(bytes).unwrap();
    let txn = yrs::Transact::transact(room);
    let incoming = ydoc::Incoming::new(&update);
    let bounds = ydoc::Bounds {
        depth: board::DEPTH,
    };
    let inspection = ydoc::inspect_bounded(&txn, &incoming, bounds).unwrap();
    ydoc::steps::take();
    board::admit_shapes(&txn, &incoming, inspection.trial.as_ref()).unwrap();
    ydoc::steps::take().of(Walk::Board)
}

/// The fields of a brush stroke of `points` points.
fn stroke(id: &str, points: usize) -> Fields {
    let line: Vec<yrs::Any> = (0..points)
        .map(|n| yrs::any!([n as f64 * 1.5, n as f64 * 0.75]))
        .collect();
    fields(&[
        ("type", a(yrs::Any::from("brush"))),
        ("id", a(yrs::Any::from(id))),
        ("lineWidth", a(yrs::any!(4))),
        ("points", a(yrs::Any::Array(line.into()))),
        ("xywh", place()),
    ])
}

/// A board of `count` strokes of 20 points, drawn one update at a time.
fn board_of(count: usize) -> yrs::Doc {
    let room = room();
    let writer = tab(&room, 7);
    for n in 0..count {
        let id = format!("s{n}");
        send(
            &room,
            &update(&writer, |doc| add_element(doc, &id, &stroke(&id, 20))),
        )
        .unwrap();
    }
    room
}

#[test]
fn a_large_update_costs_steps_linear_in_its_bytes() {
    let room = room();
    let bytes = update(&tab(&room, 8), |doc| {
        for n in 0..2_000 {
            let id = format!("s{n}");
            add_element(doc, &id, &stroke(&id, 20));
        }
    });
    let steps = board_steps(&room, &bytes);
    let structs = ydoc::decode(&bytes).unwrap().blocks().count() as u64;
    assert!(steps >= structs, "{steps} steps for {structs} structs");
    assert!(
        steps <= STEPS_PER_BYTE * bytes.len() as u64,
        "{steps} steps for {} bytes",
        bytes.len()
    );
}

/// Moving one stroke reads that stroke, whatever else the board holds.
#[test]
fn a_small_edit_on_a_large_board_reads_only_what_it_touches() {
    let steps = |count: usize| {
        let room = board_of(count);
        let moved = update(&tab(&room, 8), |doc| {
            set_element(
                doc,
                "s0",
                &fields(&[("xywh", a(yrs::any!("[5,5,200,100]")))]),
            )
        });
        board_steps(&room, &moved)
    };
    let (small, large) = (steps(10), steps(2_000));
    assert_eq!(
        small, large,
        "{small} steps on 10 strokes, {large} on 2,000"
    );
    assert!(large < 200, "{large} steps");
}

/// A tiny update whose delete range covers a client's whole history is held
/// to the work budget: past `ydoc::MAX_WORK` blocks walked it is refused as
/// any update that costs too much, having walked no further.
#[test]
fn a_delete_range_over_a_long_history_is_held_to_the_budget() {
    let room = room();
    // Over a million blocks of the room's own client: values put at the
    // front one by one, which yrs never merges.
    {
        let filler = room.get_or_insert_array("filler");
        let mut txn = yrs::Transact::transact_mut(&room);
        for _ in 0..1_000_100 {
            yrs::Array::insert(&filler, &mut txn, 0, yrs::Any::Null);
        }
    }
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(0u32); // no structs
    bytes.write_var(1u32);
    bytes.write_var(900u64); // the room's client (`common::room`)
    bytes.write_var(1u32);
    bytes.write_var(0u32);
    bytes.write_var(2_000_000u32);
    let update = ydoc::decode(&bytes).unwrap();
    let txn = yrs::Transact::transact(&room);
    let incoming = ydoc::Incoming::new(&update);
    ydoc::steps::take();
    // Refused in the deletion walk, before any entity is read: no trial.
    let verdict = board::admit_shapes(&txn, &incoming, None);
    let steps = ydoc::steps::take().of(Walk::Board);
    assert_eq!(verdict, Err(ydoc::UpdateError::Costly.to_string()));
    assert!(steps <= ydoc::MAX_WORK + 100, "{steps} steps");
}

/// A reconnect's catch-up repeats the writer's whole delete set: what the
/// room holds deleted costs a step a run and is not read again.
#[test]
fn a_reconnect_repeating_a_long_delete_set_is_linear() {
    let room = room();
    let writer = tab(&room, 7);
    for n in 0..3_000 {
        let id = format!("s{n}");
        send(
            &room,
            &update(&writer, |doc| add_element(doc, &id, &stroke(&id, 4))),
        )
        .unwrap();
        send(&room, &update(&writer, |doc| remove_element(doc, &id))).unwrap();
    }
    // The writer's whole state, as its reconnect sends it.
    let catch_up = whole(&writer);
    let decoded = ydoc::decode(&catch_up).unwrap();
    let ranges: u64 = decoded
        .delete_set()
        .iter()
        .map(|(_, ranges)| ranges.iter().count() as u64)
        .sum();
    assert!(ranges > 0);
    let steps = board_steps(&room, &catch_up);
    assert!(
        steps <= STEPS_PER_BYTE * catch_up.len() as u64,
        "{steps} steps for {} bytes",
        catch_up.len()
    );
}
