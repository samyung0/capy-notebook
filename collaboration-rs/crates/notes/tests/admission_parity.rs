#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! The admission/save parity property (Epo 2026-10-19, gates CI): an update
//! a note room admits never leaves a document its store refuses once the
//! room's repairs ran, so no writer's update can reset the room. Seeded
//! updates from the embed catalog (every element type, its required,
//! forbidden and closed keys, keys and marks no node carries, repeated ids,
//! widths, text and elements into any element or the root, deletions,
//! retypes, marks), one or two writers at a time forked from the room, go
//! through `Validator::admit`; each admitted one is applied, the entry repair
//! runs (`repair::on_entry`), and where the store check
//! (`material::assert_canonical`) refuses the result, the save repair
//! (`repair::repair`) must make it pass. A sweep first makes every single
//! catalog write on every element from the seeded room (each key its type
//! names and the keys no node carries, set to good, empty, null, boolean and
//! number values and unset; every type; text, a paragraph, deletions, marks).
//! Fails with the case, or the seed, step and updates, to replay.
//! PARITY_STEPS and PARITY_SEED run more or other random cases.

use notes::limits::{Admission, Validator};
use notes::{catalog, material, plate, repair, slate_yjs};
use serde_json::{Value, json};
use yrs::branch::BranchPtr;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlTextPrelim, XmlTextRef};

/// xorshift64.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

fn read_json(path: &str) -> Value {
    let path = format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The every-block note shared with Go, its imported fences named as rows.
fn every_block_note() -> Vec<Value> {
    let fixture = read_json("server/internal/materialdoc/testdata/every-block-note.json");
    let mut note = fixture["value"].as_array().unwrap().clone();
    for node in &mut note {
        if let Some(fence) = node.as_object_mut().filter(|n| n.contains_key("pending")) {
            fence.remove("pending");
            let row = format!("mat_{}", fence["refKind"].as_str().unwrap());
            fence.insert("materialId".into(), json!(row));
        }
    }
    note
}

fn diagram() -> Vec<Value> {
    vec![
        json!({ "type": "mermaid", "id": "m", "source": "flowchart LR\n  A --> B", "children": [
            { "type": "mermaid_caption", "children": [{ "text": "Flow" }] },
        ] }),
        json!({ "type": "p", "id": "after", "children": [{ "text": "notes" }] }),
    ]
}

fn load(state: &[u8], client: u64) -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(client));
    doc.transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
    doc
}

fn state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// Every element of a peer's note with its live length, the root first.
fn elements(peer: &Doc) -> Vec<BranchPtr> {
    let txn = peer.transact();
    let root = plate::content_root(&txn).unwrap();
    let mut out = vec![root];
    let mut at = 0;
    while at < out.len() {
        if let Ok(delta) = plate::insert_delta(&out[at]) {
            for op in delta {
                if let plate::Insert::Element(element) = op.insert {
                    out.push(element);
                }
            }
        }
        at += 1;
    }
    out
}

/// An element's live `type`.
fn type_of(element: BranchPtr) -> Option<String> {
    let entry = element
        .entry_item("type")
        .filter(|entry| !entry.is_deleted())?;
    match entry.content() {
        yrs::block::ItemContent::Any(values) => match values.last() {
            Some(Any::String(kind)) => Some(kind.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// The top-level ids a peer's note holds.
fn top_ids(peer: &Doc) -> Vec<String> {
    plate::value(&peer.transact())
        .unwrap_or_default()
        .iter()
        .filter_map(|node| node["id"].as_str().map(str::to_owned))
        .collect()
}

/// A value from the catalog's world for `key`: mostly what the store takes,
/// sometimes what it refuses.
fn value_for(rng: &mut Rng, key: &str, ids: &[String]) -> Any {
    let good = rng.chance(75);
    match key {
        "type" => {
            if rng.chance(8) {
                Any::from("toggle")
            } else if rng.chance(40) {
                Any::from(*rng.pick(&["p", "h2", "blockquote", "callout"]))
            } else {
                Any::from(rng.pick(catalog::ELEMENTS).name)
            }
        }
        "id" if !ids.is_empty() && rng.chance(30) => Any::from(rng.pick(ids).as_str()),
        "id" if good => Any::from(format!("id{}", rng.next() % 100_000)),
        "width" if good => Any::from(*rng.pick(&["50%", "100%", "20%"])),
        "width" => Any::from(*rng.pick(&["5%", "50", "abc"])),
        "assetId" if good => Any::from("asset_1"),
        "provider" if good => Any::from("youtube"),
        "videoId" if good => Any::from("dQw4w9WgXcQ"),
        "refKind" if good => Any::from(*rng.pick(&["quiz", "flashcards"])),
        "materialId" if good => Any::from("mat_x"),
        "html" if good => Any::from("<b>hi</b>"),
        "source" if good => Any::from("flowchart LR\n  A --> B"),
        "caption" if good => Any::from("A caption"),
        _ if good => Any::from(*rng.pick(&["x", "center", "1"])),
        _ => rng
            .pick(&[Any::Null, Any::Bool(true), Any::Number(3.0)])
            .clone(),
    }
}

/// The keys a write picks from: the catalog's required, forbidden and closed
/// ones, and the keys and marks no node carries.
fn key_pool() -> Vec<&'static str> {
    let mut keys: Vec<&'static str> = vec![
        "type",
        "id",
        "width",
        "text",
        "children",
        "suggestion",
        "suggestion_9",
        "align",
        "indent",
        "pending",
        "block",
    ];
    for element in catalog::ELEMENTS {
        keys.extend(element.required);
        keys.extend(element.forbidden);
        keys.extend(element.fields.unwrap_or(&[]));
    }
    keys.sort_unstable();
    keys.dedup();
    keys
}

const MARKS: [&str; 7] = [
    "bold",
    "italic",
    "code",
    "comment_1",
    "suggestion_7",
    "children",
    "type",
];

/// A new element: a catalog type (a paragraph often), some keys, and either
/// the empty leaf, text, or a child paragraph.
fn new_element(
    rng: &mut Rng,
    txn: &mut yrs::TransactionMut,
    parent: &XmlTextRef,
    index: u32,
    keys: &[&'static str],
    ids: &[String],
) {
    let kind = if rng.chance(45) {
        "p"
    } else {
        rng.pick(catalog::ELEMENTS).name
    };
    let element = parent.insert_embed(txn, index, XmlTextPrelim::new(""));
    if !rng.chance(4) {
        element.insert_attribute(txn, "type", kind);
    }
    if !rng.chance(10) {
        let id = value_for(rng, "id", ids);
        element.insert_attribute(txn, "id", id);
    }
    // The type's own required keys, mostly.
    if let Some(entry) = catalog::element(kind) {
        for key in entry.required {
            if !rng.chance(10) {
                let value = value_for(rng, key, ids);
                element.insert_attribute(txn, *key, value);
            }
        }
    }
    for _ in 0..rng.below(3) {
        let key = *rng.pick(keys);
        let value = value_for(rng, key, ids);
        element.insert_attribute(txn, key, value);
    }
    match rng.below(4) {
        0 => element.insert(txn, 0, "typed"),
        1 => {
            let child = element.insert_embed(txn, 0, XmlTextPrelim::new(""));
            child.insert_attribute(txn, "type", "p");
            child.insert(txn, 0, "nested");
        }
        _ => {}
    }
}

/// One writer's random edit of `peer`.
fn mutate(rng: &mut Rng, peer: &Doc, keys: &[&'static str], log: &mut Vec<String>) {
    let ids = top_ids(peer);
    let all = elements(peer);
    // The root a third of the time for structure, otherwise an element of a
    // type picked first, so rare types (a video) come up as often as
    // paragraphs.
    let target = if rng.chance(35) {
        all[0]
    } else {
        let mut kinds: Vec<Option<String>> = all.iter().map(|e| type_of(*e)).collect();
        kinds.sort();
        kinds.dedup();
        let kind = rng.pick(&kinds).clone();
        let of_kind: Vec<BranchPtr> = all
            .iter()
            .copied()
            .filter(|e| type_of(*e) == kind)
            .collect();
        *rng.pick(&of_kind)
    };
    let text = XmlTextRef::from(target);
    let mut txn = peer.transact_mut();
    let len = text.len(&txn);
    match rng.below(9) {
        0 | 1 => {
            let index = rng.below(len as usize + 1) as u32;
            new_element(rng, &mut txn, &text, index, keys, &ids);
            log.push(format!("new element at {index}"));
        }
        2 => {
            let index = rng.below(len as usize + 1) as u32;
            text.insert(&mut txn, index, "abc");
            log.push(format!("text at {index}"));
        }
        3 if len > 0 => {
            let from = rng.below(len as usize) as u32;
            let count = 1 + rng.below((len - from) as usize) as u32;
            text.remove_range(&mut txn, from, count);
            log.push(format!("remove {from}+{count}"));
        }
        4 if len > 0 => {
            let from = rng.below(len as usize) as u32;
            let count = 1 + rng.below((len - from) as usize) as u32;
            let mark = *rng.pick(&MARKS);
            let mut attrs = yrs::types::Attrs::new();
            attrs.insert(
                mark.into(),
                if rng.chance(80) {
                    Any::Bool(true)
                } else {
                    Any::Null
                },
            );
            text.format(&mut txn, from, count, attrs);
            log.push(format!("mark {mark} {from}+{count}"));
        }
        5 if target.item().is_some() => {
            // Mostly a key the element's own type names in the catalog.
            let own: Vec<&'static str> = type_of(target)
                .and_then(|kind| catalog::element(&kind))
                .map(|element| {
                    let mut own = vec!["width", "text", "suggestion", "id", "type"];
                    own.extend(element.required);
                    own.extend(element.forbidden);
                    own.extend(element.fields.unwrap_or(&[]));
                    own
                })
                .unwrap_or_default();
            let key = if !own.is_empty() && rng.chance(70) {
                *rng.pick(&own)
            } else {
                *rng.pick(keys)
            };
            let value = value_for(rng, key, &ids);
            log.push(format!("set {key}={value:?}"));
            text.insert_attribute(&mut txn, key, value);
        }
        6 if target.item().is_some() => {
            let key = *rng.pick(keys);
            text.remove_attribute(&mut txn, &key.to_owned());
            log.push(format!("unset {key}"));
        }
        7 => {
            // Everything at the top level goes (two writers may each take
            // half of it).
            let root = XmlTextRef::from(all[0]);
            let total = root.len(&txn);
            if total > 0 {
                let half = if rng.chance(50) {
                    total
                } else {
                    1 + rng.below(total as usize) as u32
                };
                root.remove_range(&mut txn, total - half, half);
                log.push(format!("remove top {}+{half}", total - half));
            }
        }
        _ => {
            // A paste of a valid block from the catalog's world.
            let root = all[0];
            let at = rng.below(XmlTextRef::from(root).len(&txn) as usize + 1) as u32;
            let id = format!("paste{}", rng.next() % 1000);
            slate_yjs::insert_nodes(
                &mut txn,
                root,
                at,
                &[json!({
                    "type": "p", "id": id, "children": [{ "text": "pasted" }, { "text": "bold", "bold": true }],
                })],
            );
            log.push(format!("paste at {at}"));
        }
    }
}

/// One update as the room takes it: admitted, applied, repaired on entry,
/// and, where the store refuses the result, repaired at save once. Ok(true)
/// when admitted; Err with the store's reason when the repairs do not make
/// the document one the store takes.
fn arrive(room: &Doc, validator: &mut Validator, bytes: &[u8], kind: &str) -> Result<bool, String> {
    let update = Update::decode_v1(bytes).unwrap();
    match validator.admit(room, &update) {
        Ok(Admission::Accepted) => {}
        Ok(Admission::Unheld) | Err(_) => return Ok(false),
    }
    room.transact_mut().apply_update(update).unwrap();
    let repaired = {
        let mut txn = room.transact_mut();
        !repair::on_entry(&mut txn, &Update::decode_v1(bytes).unwrap(), kind).is_empty()
    };
    if repaired {
        validator.invalidate();
    }
    let check = |room: &Doc| {
        plate::value(&room.transact())
            .map_err(|error| error.to_string())
            .and_then(|value| {
                material::assert_canonical(&value, kind).map_err(|error| error.to_string())
            })
    };
    if let Err(first) = check(room) {
        repair::repair(&mut room.transact_mut(), kind);
        validator.invalidate();
        if let Err(error) = check(room) {
            let value =
                plate::value(&room.transact()).map(|value| serde_json::to_string(&value).unwrap());
            return Err(format!("{error} (first {first})\nvalue: {value:?}"));
        }
    }
    Ok(true)
}

/// Runs the property on one room of material kind `kind`.
fn run(kind: &str, seed_value: &[Value], seed: u64, steps: usize) -> (usize, usize) {
    let room = load(&slate_yjs::state_from_value(seed_value, 1), 1);
    material::assert_canonical(&plate::value(&room.transact()).unwrap(), kind).unwrap();
    let keys = key_pool();
    let mut rng = Rng(seed);
    let mut validator = Validator::new(kind);
    let (mut admitted, mut refused) = (0, 0);
    let mut client = 100;
    for step in 0..steps {
        let base = state(&room);
        let writers = if rng.chance(30) { 2 } else { 1 };
        let mut updates = Vec::new();
        for _ in 0..writers {
            client += 1;
            let peer = load(&base, client);
            let before = peer.transact().state_vector();
            let mut log = Vec::new();
            for _ in 0..1 + rng.below(3) {
                mutate(&mut rng, &peer, &keys, &mut log);
            }
            updates.push((peer.transact().encode_state_as_update_v1(&before), log));
        }
        for (bytes, log) in &updates {
            match arrive(&room, &mut validator, bytes, kind) {
                Ok(true) => admitted += 1,
                Ok(false) => refused += 1,
                Err(error) => panic!(
                    "{kind} seed {seed} step {step}: an admitted update leaves a document the store refuses after the repairs: {error}\nedits: {log:?}\nupdate: {bytes:?}"
                ),
            }
        }
    }
    (admitted, refused)
}

fn env_number(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

#[test]
fn admitted_updates_leave_a_document_the_store_takes() {
    let seed = env_number("PARITY_SEED", 0x5eed_2026_1019);
    let steps = env_number("PARITY_STEPS", 300) as usize;
    let note = every_block_note();
    let diagram = diagram();
    let mut totals = (0, 0);
    for (index, (kind, value)) in [
        ("note", &note),
        ("mindmap", &diagram),
        ("diagram", &diagram),
    ]
    .into_iter()
    .enumerate()
    {
        let (admitted, refused) = run(kind, value, seed + index as u64, steps);
        totals.0 += admitted;
        totals.1 += refused;
    }
    // Enough of both, or the generator tests nothing.
    assert!(totals.0 > steps / 2, "only {} admitted", totals.0);
    assert!(totals.1 > steps / 4, "only {} refused", totals.1);
}

/// A value the store takes for `key`, where there is one.
fn good_value(key: &str) -> Any {
    match key {
        "width" => Any::from("50%"),
        "assetId" => Any::from("asset_1"),
        "provider" => Any::from("youtube"),
        "videoId" => Any::from("dQw4w9WgXcQ"),
        "refKind" => Any::from("quiz"),
        "materialId" => Any::from("mat_x"),
        "html" => Any::from("<b>hi</b>"),
        "source" => Any::from("flowchart LR\n  A --> B"),
        "caption" => Any::from("A caption"),
        "id" => Any::from("fresh_id"),
        _ => Any::from("x"),
    }
}

/// One write on an element of a peer's note.
type Write = Box<dyn Fn(&mut yrs::TransactionMut, &XmlTextRef)>;

/// The single writes the sweep makes on one element: each key its type
/// names in the catalog and the keys no node carries, set to a good value,
/// strings, null, a boolean and a number, and unset; each catalog type;
/// text, a paragraph and deletions inside it; each mark over its text.
fn writes(kind: Option<&str>, root: bool) -> Vec<(String, Write)> {
    let mut out: Vec<(String, Write)> = Vec::new();
    if !root {
        let mut keys: Vec<&'static str> = vec![
            "width",
            "text",
            "children",
            "suggestion",
            "suggestion_1",
            "id",
            "pending",
            "indent",
            "align",
            "url",
            "src",
            "assetId",
            "block",
            "caption",
            "source",
        ];
        if let Some(element) = kind.and_then(catalog::element) {
            keys.extend(element.required);
            keys.extend(element.forbidden);
            keys.extend(element.fields.unwrap_or(&[]));
        }
        keys.sort_unstable();
        keys.dedup();
        for key in keys {
            let values = [
                good_value(key),
                Any::from("x"),
                Any::from(""),
                Any::Null,
                Any::Bool(true),
                Any::Number(3.0),
            ];
            for value in values {
                out.push((
                    format!("set {key}={value:?}"),
                    Box::new(move |txn, element| {
                        element.insert_attribute(txn, key, value.clone());
                    }),
                ));
            }
            out.push((
                format!("unset {key}"),
                Box::new(move |txn, element| element.remove_attribute(txn, &key.to_owned())),
            ));
        }
        for name in catalog::ELEMENTS
            .iter()
            .map(|element| element.name)
            .chain(["toggle"])
        {
            out.push((
                format!("type {name}"),
                Box::new(move |txn, element| {
                    element.insert_attribute(txn, "type", name);
                }),
            ));
        }
    }
    out.push((
        "text".into(),
        Box::new(|txn, element| element.insert(txn, 0, "typed")),
    ));
    out.push((
        "paragraph".into(),
        Box::new(|txn, element| {
            let child = element.insert_embed(txn, 0, XmlTextPrelim::new(""));
            child.insert_attribute(txn, "type", "p");
            child.insert_attribute(txn, "id", "swept");
            child.insert(txn, 0, "inside");
        }),
    ));
    out.push((
        "delete all".into(),
        Box::new(|txn, element| {
            let len = element.len(txn);
            if len > 0 {
                element.remove_range(txn, 0, len);
            }
        }),
    ));
    out.push((
        "delete first".into(),
        Box::new(|txn, element| {
            if element.len(txn) > 0 {
                element.remove_range(txn, 0, 1);
            }
        }),
    ));
    for mark in MARKS {
        out.push((
            format!("mark {mark}"),
            Box::new(move |txn, element| {
                let len = element.len(txn);
                if len > 0 {
                    let mut attrs = yrs::types::Attrs::new();
                    attrs.insert(mark.into(), Any::Bool(true));
                    element.format(txn, 0, len, attrs);
                }
            }),
        ));
    }
    out
}

/// The sweep on one room: every single write of [writes] on every element,
/// each from the room as seeded.
fn sweep(kind: &str, seed_value: &[Value]) -> (usize, usize) {
    let base = slate_yjs::state_from_value(seed_value, 1);
    let shape = load(&base, 1);
    let targets: Vec<(Option<String>, bool)> = elements(&shape)
        .into_iter()
        .enumerate()
        .map(|(index, element)| (type_of(element), index == 0))
        .collect();
    let (mut admitted, mut refused) = (0, 0);
    for (index, (target, root)) in targets.iter().enumerate() {
        for (what, write) in writes(target.as_deref(), *root) {
            let peer = load(&base, 2);
            let before = peer.transact().state_vector();
            let element = XmlTextRef::from(elements(&peer)[index]);
            write(&mut peer.transact_mut(), &element);
            let bytes = peer.transact().encode_state_as_update_v1(&before);
            let room = load(&base, 1);
            match arrive(&room, &mut Validator::new(kind), &bytes, kind) {
                Ok(true) => admitted += 1,
                Ok(false) => refused += 1,
                Err(error) => panic!(
                    "{kind}: `{what}` on element {index} ({target:?}) is admitted and leaves a document the store refuses after the repairs: {error}"
                ),
            }
        }
    }
    (admitted, refused)
}

/// Every single catalog write on every element of a note, a mindmap and a
/// diagram, from the room as seeded: whatever admission takes, the store
/// takes once the repairs ran.
#[test]
fn every_single_catalog_write_leaves_a_document_the_store_takes() {
    let note = every_block_note();
    let diagram = diagram();
    for (kind, value) in [
        ("note", &note),
        ("mindmap", &diagram),
        ("diagram", &diagram),
    ] {
        let (admitted, refused) = sweep(kind, value);
        assert!(
            admitted > 0 && refused > 0,
            "{kind}: {admitted} admitted, {refused} refused"
        );
    }
}
