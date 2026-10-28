//! A note room's server costs in the Plate layout and the blocks layout, on
//! the same content (todo-blocksuite-spike.md, "6. Measure"): seed, room load,
//! a fresh joiner's step-1 answer, `value()`, the blocks structural check, and
//! the admission of a keystroke and of a large paste. Timed (min and median of
//! `RUNS`, default 5), with the heap a loaded room keeps (counted by the
//! global allocator, an idea from capy-harness 2026-10-27-yrs-vs-yocto).
//!
//! The server crate is a binary, so the room steps are rebuilt here from the
//! library calls `server/src/model.rs` makes:
//! - load: `ydoc::replay` of the stored state once (the server integrates a
//!   note load twice, room.rs), the roots check, `Model::stored`'s
//!   projection and canonical check, and `Model::measure`;
//! - Plate admission: `notes::limits::Validator` with the load's metrics as
//!   its bound, as `Model::validator` builds it;
//! - blocks admission: `BlocksValidator::check` (model.rs), which copies the
//!   room, applies the update, repairs, checks and projects on every update.
//!
//! Usage: `layout-cost <values.json>`, a JSON object of name -> Plate value
//! (run.sh writes the load-test and common-subset notes). Prints one JSON
//! object per note and layout.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Instant;

use serde_json::{Value, json};
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Array, ArrayPrelim, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Text,
    TextPrelim, TextRef, Transact, Update, WriteTxn, XmlTextRef,
};

struct Counting;

static LIVE: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size() as isize, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        LIVE.fetch_add(size as isize - layout.size() as isize, Ordering::Relaxed);
        unsafe { System.realloc(ptr, layout, size) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

#[derive(Clone, Copy, PartialEq)]
enum Layout2 {
    Plate,
    Blocks,
}

impl Layout2 {
    fn name(self) -> &'static str {
        match self {
            Layout2::Plate => "plate",
            Layout2::Blocks => "blocks",
        }
    }
}

const PASTE_PARAGRAPHS: usize = 150;
const PASTE_CHARS: usize = 300;

fn runs() -> usize {
    std::env::var("RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5)
}

/// Min and median milliseconds of `f` over `runs()` runs, and its last result.
fn time<R>(mut f: impl FnMut() -> R) -> (Value, R) {
    let mut ms = Vec::new();
    let mut last = None;
    for _ in 0..runs() {
        let start = Instant::now();
        let result = f();
        ms.push(start.elapsed().as_secs_f64() * 1000.0);
        last = Some(result);
    }
    ms.sort_by(f64::total_cmp);
    let round = |v: f64| (v * 100.0).round() / 100.0;
    (
        json!({ "minMs": round(ms[0]), "medianMs": round(ms[ms.len() / 2]) }),
        last.expect("RUNS is at least 1"),
    )
}

fn state_from_value(layout: Layout2, value: &[Value]) -> Vec<u8> {
    match layout {
        Layout2::Plate => notes::slate_yjs::state_from_value(value, 1),
        Layout2::Blocks => blocks::state_from_value(value, 1).expect("the blocks layout holds it"),
    }
}

fn project<T: ReadTxn>(layout: Layout2, txn: &T) -> Vec<Value> {
    match layout {
        Layout2::Plate => notes::plate::value(txn).expect("projects"),
        Layout2::Blocks => blocks::value(txn).expect("projects"),
    }
}

/// The room load: replay, roots, the stored check and the measure.
fn load(layout: Layout2, state: &[u8]) -> (Doc, notes::limits::Metrics) {
    let doc = ydoc::scratch_doc();
    ydoc::replay(&doc, state, &[] as &[Vec<u8>]).expect("replays");
    let metrics = {
        let txn = doc.transact();
        match layout {
            Layout2::Plate => {
                notes::validate::assert_roots(&txn).expect("roots");
                let value = notes::plate::value(&txn).expect("projects");
                notes::material::assert_canonical(&value, "note").expect("canonical");
                notes::limits::measure(&txn).expect("measures")
            }
            Layout2::Blocks => {
                // `Model::stored` checks a repaired copy (D3), then measures.
                let copy = copy_of(&txn);
                blocks::repair(&mut copy.transact_mut());
                let repaired = copy.transact();
                blocks::check(&repaired).expect("structure");
                let value = blocks::value(&repaired).expect("projects");
                notes::material::assert_canonical(&value, "note").expect("canonical");
                notes::limits::measure_value(&blocks::value(&txn).expect("projects"))
            }
        }
    };
    (doc, metrics)
}

fn copy_of<T: ReadTxn>(txn: &T) -> Doc {
    let copy = ydoc::scratch_doc();
    let state = txn.encode_state_as_update_v1(&StateVector::default());
    ydoc::replay(&copy, &state, &[] as &[Vec<u8>]).expect("replays");
    copy
}

fn client_of(room: &Doc) -> Doc {
    let client = Doc::with_options(ydoc::doc_options(9));
    let state = room
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    client
        .transact_mut()
        .apply_update(Update::decode_v1(&state).expect("decodes"))
        .expect("applies");
    client
}

fn since(room: &Doc, client: &Doc) -> Vec<u8> {
    client
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector())
}

/// The note's first block's text (its title heading).
fn first_text(layout: Layout2, doc: &Doc) -> Result<TextOrXml, String> {
    let txn = doc.transact();
    match layout {
        Layout2::Plate => {
            let root = notes::plate::content_root(&txn).ok_or("no content")?;
            let delta = notes::plate::insert_delta(&root).map_err(|e| e.to_string())?;
            match delta.first().map(|op| &op.insert) {
                Some(notes::plate::Insert::Element(branch)) => {
                    Ok(TextOrXml::Xml(XmlTextRef::from(*branch)))
                }
                _ => Err("no first block".into()),
            }
        }
        Layout2::Blocks => {
            let blocks = txn.get_map(blocks::BLOCKS_ROOT).ok_or("no blocks")?;
            let note = map_at(&txn, &blocks, blocks::NOTE_ID)?;
            let Some(Out::YArray(children)) = note.get(&txn, "sys:children") else {
                return Err("no note children".into());
            };
            let first = children.get(&txn, 0).map(|out| out.to_string(&txn));
            let block = map_at(&txn, &blocks, &first.ok_or("empty note")?)?;
            match block.get(&txn, "prop:text") {
                Some(Out::YText(text)) => Ok(TextOrXml::Text(text)),
                _ => Err("first block has no text".into()),
            }
        }
    }
}

enum TextOrXml {
    Text(TextRef),
    Xml(XmlTextRef),
}

fn map_at<T: ReadTxn>(txn: &T, map: &MapRef, key: &str) -> Result<MapRef, String> {
    match map.get(txn, key) {
        Some(Out::YMap(found)) => Ok(found),
        _ => Err(format!("no block {key}")),
    }
}

/// A client's keystroke at the end of the title.
fn keystroke(layout: Layout2, room: &Doc) -> Vec<u8> {
    let client = client_of(room);
    let target = first_text(layout, &client).expect("a title");
    {
        let mut txn = client.transact_mut();
        match target {
            TextOrXml::Text(text) => {
                let at = text.len(&txn);
                text.insert(&mut txn, at, "x");
            }
            TextOrXml::Xml(text) => {
                let at = text.len(&txn);
                text.insert(&mut txn, at, "x");
            }
        }
    }
    since(room, &client)
}

/// A client's paste of `PASTE_PARAGRAPHS` paragraphs at the end of the note,
/// written as each editor writes a paragraph.
fn paste(layout: Layout2, room: &Doc) -> Vec<u8> {
    let client = client_of(room);
    let line = "pasted words ".repeat(PASTE_CHARS / 13 + 1)[..PASTE_CHARS].to_string();
    {
        let mut txn = client.transact_mut();
        match layout {
            Layout2::Plate => {
                let root = notes::plate::content_root(&txn).expect("content");
                let at = XmlTextRef::from(root).len(&txn);
                let nodes: Vec<Value> = (0..PASTE_PARAGRAPHS)
                    .map(|i| json!({ "type": "p", "id": format!("paste{i}"), "children": [{ "text": line }] }))
                    .collect();
                notes::slate_yjs::insert_nodes(&mut txn, root, at, &nodes);
            }
            Layout2::Blocks => {
                let blocks = txn.get_or_insert_map(blocks::BLOCKS_ROOT);
                let Some(Out::YMap(note)) = blocks.get(&txn, blocks::NOTE_ID) else {
                    panic!("no note block");
                };
                let Some(Out::YArray(children)) = note.get(&txn, "sys:children") else {
                    panic!("no note children");
                };
                for i in 0..PASTE_PARAGRAPHS {
                    let id = format!("paste{i}");
                    paragraph(&mut txn, &blocks, &id, &line);
                    let at = children.len(&txn);
                    children.insert(&mut txn, at, Any::from(id.as_str()));
                }
            }
        }
    }
    since(room, &client)
}

/// An `affine:paragraph` as the blocks layout writes one (blocks/src/store.rs).
fn paragraph(txn: &mut yrs::TransactionMut, blocks: &MapRef, id: &str, line: &str) {
    let block = blocks.insert(txn, id, MapPrelim::default());
    block.insert(txn, "sys:id", id);
    block.insert(txn, "sys:flavour", "affine:paragraph");
    block.insert(txn, "sys:version", Any::Number(1.0));
    block.insert(txn, "sys:children", ArrayPrelim::from(Vec::<Any>::new()));
    block.insert(txn, "prop:collapsed", false);
    let text: TextRef = block.insert(txn, "prop:text", TextPrelim::new(""));
    text.insert(txn, 0, line);
    block.insert(txn, "prop:type", "text");
}

/// The room's admission of `update`, as the server's validator for the
/// layout runs it; what it answered.
fn admit(layout: Layout2, room: &Doc, metrics: notes::limits::Metrics, update: &[u8]) -> String {
    let decoded = ydoc::decode(update).expect("decodes");
    match layout {
        Layout2::Plate => {
            let mut validator = notes::limits::Validator {
                bound: Some(metrics),
                metrics: Some(metrics),
                ..notes::limits::Validator::new("note")
            };
            match validator.admit(room, &decoded) {
                Ok(admission) => format!("{admission:?}"),
                Err(refusal) => format!("refused: {refusal}"),
            }
        }
        Layout2::Blocks => admit_blocks(room, metrics, &decoded, update)
            .unwrap_or_else(|refusal| format!("refused: {refusal}")),
    }
}

/// `BlocksValidator::check` (server/src/model.rs) for a live update.
fn admit_blocks(
    room: &Doc,
    metrics: notes::limits::Metrics,
    update: &Update,
    bytes: &[u8],
) -> Result<String, String> {
    let txn = room.transact();
    let incoming = ydoc::Incoming::new(update);
    let inspection = ydoc::inspect(&txn, &incoming).map_err(|e| e.to_string())?;
    if inspection.unheld {
        return Ok("Unheld".into());
    }
    let in_roots = inspection.containers.iter().all(|container| {
        container.key.is_some()
            && (&*container.root == blocks::BLOCKS_ROOT
                || &*container.root == ydoc::CONTRIBUTORS_ROOT)
    });
    if !in_roots {
        return Err("an update outside the blocks document's roots".into());
    }
    let candidate = match inspection.trial {
        Some(trial) => trial,
        None => {
            let candidate = ydoc::scratch_doc();
            let state = txn.encode_state_as_update_v1(&StateVector::default());
            ydoc::replay(&candidate, &state, &[bytes]).map_err(|e| e.to_string())?;
            candidate
        }
    };
    drop(txn);
    blocks::repair(&mut candidate.transact_mut());
    let candidate = candidate.transact();
    blocks::check(&candidate).map_err(|e| e.to_string())?;
    let value = blocks::value(&candidate).map_err(|e| e.to_string())?;
    notes::material::assert_canonical(&value, "note").map_err(|e| e.to_string())?;
    let next = notes::limits::measure_value(&value);
    if let Some(code) = notes::limits::limit_code(&next)
        && !notes::limits::recovers(&next, Some(&metrics))
    {
        return Err(format!("limit {}", code.as_str()));
    }
    Ok("Accepted".into())
}

fn measure(name: &str, value: &[Value], layout: Layout2) -> Value {
    let (seed, state) = time(|| state_from_value(layout, value));

    let before = LIVE.load(Ordering::Relaxed);
    let (room, metrics) = load(layout, &state);
    let kept_mb = (LIVE.load(Ordering::Relaxed) - before) as f64 / 1_048_576.0;
    drop((room, metrics));
    let (load_time, (room, metrics)) = time(|| load(layout, &state));

    let (replay, _) = time(|| {
        let doc = ydoc::scratch_doc();
        ydoc::replay(&doc, &state, &[] as &[Vec<u8>]).expect("replays");
        doc
    });
    let (value_time, projected) = time(|| project(layout, &room.transact()));
    let check =
        (layout == Layout2::Blocks).then(|| time(|| blocks::check(&room.transact()).is_ok()).0);
    let (step1, answer) = time(|| {
        room.transact()
            .encode_state_as_update_v1(&StateVector::default())
    });

    let key = keystroke(layout, &room);
    let (key_time, key_answer) = time(|| admit(layout, &room, metrics, &key));
    let big = paste(layout, &room);
    let (paste_time, paste_answer) = time(|| admit(layout, &room, metrics, &big));

    json!({
        "note": name,
        "layout": layout.name(),
        "contentBytes": metrics.content_bytes,
        "nodeCount": metrics.node_count,
        "topLevelBlocks": projected.len(),
        "stateBytes": state.len(),
        "seed": seed,
        "load": load_time,
        "loadReplayOnly": replay,
        "loadKeptMB": (kept_mb * 10.0).round() / 10.0,
        "value": value_time,
        "structuralCheck": check,
        "step1Answer": { "bytes": answer.len(), "time": step1 },
        "keystrokeAdmission": { "bytes": key.len(), "answer": key_answer, "time": key_time },
        "pasteAdmission": {
            "paragraphs": PASTE_PARAGRAPHS,
            "bytes": big.len(),
            "answer": paste_answer,
            "time": paste_time,
        },
    })
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: layout-cost <values.json>");
    let notes: serde_json::Map<String, Value> =
        serde_json::from_slice(&std::fs::read(path).expect("reads the values")).expect("JSON");
    for (name, value) in &notes {
        let value = value.as_array().expect("a Plate value");
        for layout in [Layout2::Plate, Layout2::Blocks] {
            println!("{}", measure(name, value, layout));
        }
    }
}
