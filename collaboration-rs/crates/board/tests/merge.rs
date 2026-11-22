#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Two people's adds to one keyed list at the same moment (Epo 2026-11-22,
//! "sure A"): each fills a chart's bars to the tools' cap from one base, the
//! room takes both, and the merged chart holds more than the cap and at most
//! twice it, which the room counts as fitting.
mod common;

use common::*;
use yrs::{Map, Transact, any};

#[test]
fn two_writers_at_the_cap_merge_within_twice_it() {
    let room = room();
    let (_, mut chart) = editor_elements("c1")
        .into_iter()
        .find(|(kind, _)| *kind == "chart")
        .unwrap();
    chart.retain(|(key, _)| key != "bars");
    chart.push(("bars".into(), m(&[])));
    send(
        &room,
        &update(&tab(&room, 7), |doc| add_element(doc, "c1", &chart)),
    )
    .unwrap();
    let cap = board::catalog::BARS_MAX;
    let fill = |writer: &yrs::Doc, prefix: &str| {
        update(writer, |doc| {
            let value = elements(doc, &doc.transact());
            let element = map_at(&doc.transact(), &value, "c1");
            let bars = map_at(&doc.transact(), &element, "bars");
            let mut txn = doc.transact_mut();
            for n in 0..cap {
                let id = format!("{prefix}{n}");
                let bar = keyed(
                    &format!("a{n}"),
                    any!({ "id": id.clone(), "value": 1, "label": "x" }),
                );
                bars.insert(&mut txn, id, bar);
            }
        })
    };
    let (a, b) = (tab(&room, 8), tab(&room, 9));
    let (first, second) = (fill(&a, "a"), fill(&b, "b"));
    assert_eq!(send(&room, &first), Ok(()));
    assert_eq!(send(&room, &second), Ok(()));
    let txn = room.transact();
    let element = map_at(&txn, &elements(&room, &txn), "c1");
    let held = map_at(&txn, &element, "bars").len(&txn) as usize;
    assert!(
        held > cap && held <= board::rules::merged_cap(cap),
        "{held} bars"
    );
}
