//! A note room's server CPU and memory in the Plate layout and the blocks
//! layout, on the same content, for each editing state
//! (todo-blocksuite-spike.md, "6. Measure"; D9: run on the production box,
//! README "Layout cost").
//!
//! The room's admission is the server's own: `collaboration-rs/crates/
//! server/src/model.rs` is compiled into this binary (the server crate is a
//! binary, so it cannot be a dependency), so the blocks growth bound
//! (`blocks::bound`) and the exact check are what a room runs. Around it,
//! [Room::receive] repeats the document steps `room.rs` takes per update:
//! decode, `contains_changes`, the collected-history check, the heavy
//! choice, admission, `apply_deleting` with the session's held deletions,
//! the repair on entry (skipped after an update admitted on the bound) and
//! the child-writes check. Left out, equal in both layouts: contributor
//! markers, client-id binding, rate limits, sockets, stores and the child
//! pass's call to the gateway.
//!
//! Clients are yrs docs in this process, each writing what its editor
//! writes (Plate: slate-yjs XmlText; blocks: `blocks` map entries and
//! `sys:children`). Only the room's work is timed (thread CPU, wall) and
//! counted (heap through the global allocator); the clients' is not.
//!
//! Usage: `layout-cost <values.json>`. Env: `NOTES` (load-test,small),
//! `LAYOUTS` (plate,blocks), `STATES` (all), `SCALE` (1: one hour of
//! editing, 60 s of typing; 0.1 for a smoke run), `ROOMS` (20 idle rooms),
//! `RUNS` (5 repeats of the one-shot steps). One JSON object per line.

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use yrs::types::xml::Xml;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Array, ArrayPrelim, Doc, IdSet, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Text,
    TextPrelim, TextRef, Transact, TransactionMut, Update, XmlTextRef,
};

#[allow(dead_code, clippy::all)]
#[path = "../../../../../collaboration-rs/crates/server/src/model.rs"]
mod model;

use model::{Admitted, Model, RoomValidator};

// ---------------------------------------------------------------- memory

struct Counting;

static LIVE: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicIsize = AtomicIsize::new(0);

fn grew(by: isize) {
    let now = LIVE.fetch_add(by, Ordering::Relaxed) + by;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        grew(layout.size() as isize);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        grew(size as isize - layout.size() as isize);
        unsafe { System.realloc(ptr, layout, size) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

fn live() -> isize {
    LIVE.load(Ordering::Relaxed)
}

fn mb(bytes: isize) -> f64 {
    (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

fn ms(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 1000.0 * 100.0).round() / 100.0
}

/// The process's resident set (MiB): /proc on Linux, `ps` elsewhere.
fn rss_mb() -> f64 {
    let kb = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("VmRSS:"))
                .and_then(|line| line.split_whitespace().nth(1)?.parse::<f64>().ok())
        })
        .or_else(|| {
            let out = std::process::Command::new("ps")
                .args(["-o", "rss=", "-p", &std::process::id().to_string()])
                .output()
                .ok()?;
            String::from_utf8_lossy(&out.stdout).trim().parse().ok()
        })
        .unwrap_or(f64::NAN);
    (kb / 1024.0 * 10.0).round() / 10.0
}

/// glibc keeps freed pages until a trim: the server's MALLOC_TRIM_THRESHOLD_
/// returns them as it goes, so the reading after a drop trims as it would.
fn trim() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
}

fn thread_cpu() -> Duration {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

// ---------------------------------------------------------------- settings

fn env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn scale() -> f64 {
    env_f64("SCALE", 1.0)
}

fn scaled(n: f64) -> usize {
    ((n * scale()).round() as usize).max(1)
}

fn runs() -> usize {
    env_f64("RUNS", 5.0) as usize
}

fn list(name: &str, default: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_else(|_| default.into())
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A tiny deterministic generator: each run edits the same places.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

// ---------------------------------------------------------------- meter

/// The room's work in one state: CPU, wall, heap growth and the largest
/// transient heap above it, per-update timings.
#[derive(Default)]
struct Meter {
    cpu: Duration,
    wall: Duration,
    /// Heap the room kept from its sections (approximate: net growth less
    /// the broadcast it hands out).
    kept: isize,
    peak: isize,
    admission: Vec<f64>,
    per_update: Vec<f64>,
    heavy: u64,
    refused: Vec<String>,
}

impl Meter {
    fn run<R>(&mut self, f: impl FnOnce() -> R) -> R {
        let before = live();
        PEAK.store(before, Ordering::Relaxed);
        let (cpu, wall) = (thread_cpu(), Instant::now());
        let result = f();
        self.cpu += thread_cpu() - cpu;
        self.wall += wall.elapsed();
        self.peak = self
            .peak
            .max(self.kept + PEAK.load(Ordering::Relaxed) - before);
        result
    }

    fn json(&self, base: isize) -> Value {
        let pct = |values: &[f64], p: f64| -> Value {
            if values.is_empty() {
                return Value::Null;
            }
            let mut sorted = values.to_vec();
            sorted.sort_by(f64::total_cmp);
            let at = ((sorted.len() as f64 - 1.0) * p).round() as usize;
            json!((sorted[at] * 1000.0).round() / 1000.0)
        };
        let mut refused: HashMap<&str, u64> = HashMap::new();
        for reason in &self.refused {
            *refused.entry(reason.as_str()).or_default() += 1;
        }
        json!({
            "cpuMs": ms(self.cpu),
            "wallMs": ms(self.wall),
            "updates": self.per_update.len(),
            "heavyUpdates": self.heavy,
            "admissionMs": { "p50": pct(&self.admission, 0.5), "p95": pct(&self.admission, 0.95), "max": pct(&self.admission, 1.0) },
            "perUpdateMs": { "p50": pct(&self.per_update, 0.5), "p95": pct(&self.per_update, 0.95), "max": pct(&self.per_update, 1.0) },
            "heapPeakMB": mb(base + self.peak),
            "refused": refused,
        })
    }
}

// ---------------------------------------------------------------- the room

#[derive(Clone, Copy, PartialEq)]
enum L {
    Plate,
    Blocks,
}

impl L {
    fn name(self) -> &'static str {
        match self {
            L::Plate => "plate",
            L::Blocks => "blocks",
        }
    }
    fn model(self) -> Model {
        match self {
            L::Plate => Model::Note,
            L::Blocks => Model::Blocks,
        }
    }
}

const ROOM_CLIENT: u64 = 1_000_001;

struct Room {
    layout: L,
    doc: Doc,
    validator: RoomValidator,
    /// Each open session's held deletions, one batch a minute (sessions.rs).
    held: HashMap<u64, Vec<IdSet>>,
    /// What the last collection's window deleted (the late check's input).
    collected: IdSet,
}

/// The room load (`room.rs` load): replay the stored state into a scratch
/// doc, integrate its state into the room's doc, measure, the stored check,
/// the validator.
fn load(layout: L, stored: &[u8]) -> Room {
    let model = layout.model();
    let scratch = ydoc::scratch_doc();
    ydoc::replay(&scratch, stored, &[] as &[Vec<u8>]).expect("replays");
    let state = scratch
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    drop(scratch);
    let doc = Doc::with_options(ydoc::doc_options(ROOM_CLIENT));
    let metrics = {
        let mut txn = doc.transact_mut();
        txn.apply_update(ydoc::decode(&state).expect("decodes"))
            .expect("applies");
        drop(txn);
        let txn = doc.transact();
        model.assert_roots(&txn).expect("roots");
        let metrics = model.measure(&txn).expect("measures");
        let refused = model.stored("note", &txn).expect("stored check");
        assert!(refused.is_none(), "loads read-only: {refused:?}");
        metrics
    };
    Room {
        layout,
        doc,
        validator: model.validator("note", metrics),
        held: HashMap::new(),
        collected: IdSet::new(),
    }
}

impl Room {
    /// A writer's update through the room's document steps; the broadcast
    /// (the applied content and any repair) or the refusal.
    fn receive(&mut self, meter: &mut Meter, session: u64, bytes: &[u8]) -> Option<Vec<u8>> {
        let started = Instant::now();
        let before = live();
        let (result, admission, heavy) = meter.run(|| self.steps(session, bytes));
        meter
            .per_update
            .push(started.elapsed().as_secs_f64() * 1000.0);
        meter.admission.push(admission);
        meter.heavy += u64::from(heavy);
        match result {
            Ok(broadcast) => {
                meter.kept += live() - before - broadcast.capacity() as isize;
                Some(broadcast)
            }
            Err(reason) => {
                meter.kept += live() - before;
                meter.refused.push(reason);
                None
            }
        }
    }

    fn steps(&mut self, session: u64, bytes: &[u8]) -> (Result<Vec<u8>, String>, f64, bool) {
        let model = self.layout.model();
        let Ok(update) = ydoc::decode(bytes) else {
            return (Err("malformed".into()), 0.0, false);
        };
        if !ydoc::contains_changes(&self.doc.transact(), &update) {
            return (Ok(Vec::new()), 0.0, false);
        }
        // A connected tab's typing under a block deleted since goes with the
        // block (Q446); only history a collection discarded is late.
        if matches!(
            ydoc::gc::named_collected(&self.doc.transact(), &update, &self.collected),
            ydoc::gc::Named::Window
        ) {
            return (Err("late".into()), 0.0, false);
        }
        let heavy = {
            let txn = self.doc.transact();
            match self.layout {
                L::Plate => notes::limits::heavy(&txn, &update, bytes.len(), "note"),
                L::Blocks => {
                    let incoming = ydoc::Incoming::new(&update);
                    !(ydoc::applies_inline(&txn, &incoming, bytes.len())
                        && self.validator.bounds(&txn, &incoming))
                }
            }
        };
        let admit = Instant::now();
        let verdict = self.validator.admit(&self.doc, &update, false);
        let admission = admit.elapsed().as_secs_f64() * 1000.0;
        match verdict {
            Admitted::Accepted => {}
            Admitted::Unheld => return (Err("unheld".into()), admission, heavy),
            Admitted::Hidden => return (Err("hidden".into()), admission, heavy),
            Admitted::Limit(code, _) => {
                return (Err(format!("limit {}", code.as_str())), admission, heavy);
            }
            Admitted::Refused(reason) => return (Err(reason), admission, heavy),
        }
        let (mut content, deleted) = match ydoc::apply_deleting(&self.doc, update) {
            Ok(applied) => applied,
            Err(error) => return (Err(error.to_string()), admission, heavy),
        };
        if !deleted.is_empty() {
            let batches = self.held.entry(session).or_default();
            match batches.last_mut() {
                Some(batch) => batch.merge_with(deleted),
                None => batches.push(deleted),
            }
        }
        if !content.is_empty() {
            if model.repairs() && !self.validator.admitted_on_bound() {
                let update = ydoc::decode(bytes).expect("decoded once");
                let mut txn = self.doc.transact_mut();
                model.repair_on_entry(&mut txn, &update, "note");
                let fix = ydoc::committed_update(txn);
                if !fix.is_empty() {
                    self.validator.invalidate();
                    content = yrs::merge_updates_v1([content.as_slice(), fix.as_slice()])
                        .expect("merges");
                }
            }
            let update = ydoc::decode(bytes).expect("decoded once");
            let txn = self.doc.transact();
            let _children = match self.layout {
                L::Plate => notes::children::child_writes(&txn, &update).is_some(),
                L::Blocks => blocks::children::child_writes(&txn, &update).is_some(),
            };
        }
        (Ok(content), admission, heavy)
    }

    /// A new minute's batch for every session (sessions.rs batches a minute).
    fn next_minute(&mut self) {
        for batches in self.held.values_mut() {
            if batches.last().is_some_and(|b| !b.is_empty()) {
                batches.push(IdSet::new());
            }
        }
    }

    /// Every counted session's held deletions (`Sessions::holds`).
    fn holds(&self) -> IdSet {
        let mut held = IdSet::new();
        for batch in self.held.values().flatten() {
            held.merge_with(batch.clone());
        }
        held
    }

    fn exact_checks(&self) -> Option<u64> {
        match &self.validator {
            RoomValidator::Blocks(validator) => Some(validator.exact_checks),
            _ => None,
        }
    }

    fn state_bytes(&self) -> usize {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
            .len()
    }
}

// ---------------------------------------------------------------- clients

/// One editor's document: a session's Y.Doc and the paragraph it types in.
struct Client {
    id: u64,
    doc: Doc,
    /// The top-level index it types at.
    at: usize,
    typed: u32,
    /// Paragraph ids it created (blocks) or counts (Plate) it may delete.
    made: Vec<String>,
}

fn client(room: &Room, id: u64, at: usize) -> Client {
    let doc = Doc::with_options(ydoc::doc_options(id));
    let state = room
        .doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    doc.transact_mut()
        .apply_update(Update::decode_v1(&state).expect("decodes"))
        .expect("applies");
    Client {
        id,
        doc,
        at,
        typed: 0,
        made: Vec::new(),
    }
}

fn deliver(client: &Client, update: &[u8]) {
    if update.is_empty() {
        return;
    }
    client
        .doc
        .transact_mut()
        .apply_update(Update::decode_v1(update).expect("decodes"))
        .expect("applies");
}

fn note_children<T: ReadTxn>(txn: &T) -> (MapRef, yrs::ArrayRef) {
    let blocks = txn.get_map(blocks::BLOCKS_ROOT).expect("blocks root");
    let Some(Out::YMap(note)) = blocks.get(txn, blocks::NOTE_ID) else {
        panic!("no note block");
    };
    let Some(Out::YArray(children)) = note.get(txn, "sys:children") else {
        panic!("no note children");
    };
    (blocks, children)
}

/// The top-level paragraphs' indexes: where clients type.
fn paragraphs(layout: L, doc: &Doc) -> Vec<usize> {
    let txn = doc.transact();
    match layout {
        L::Plate => {
            let root = notes::plate::content_root(&txn).expect("content");
            let delta = notes::plate::insert_delta(&root).expect("delta");
            delta
                .iter()
                .enumerate()
                .filter_map(|(i, op)| match &op.insert {
                    notes::plate::Insert::Element(branch) => {
                        let text = XmlTextRef::from(*branch);
                        (text.get_attribute(&txn, "type").map(|t| t.to_string(&txn))
                            == Some("p".into()))
                        .then_some(i)
                    }
                    _ => None,
                })
                .collect()
        }
        L::Blocks => {
            let (blocks, children) = note_children(&txn);
            children
                .iter(&txn)
                .enumerate()
                .filter_map(|(i, id)| {
                    let Some(Out::YMap(block)) = blocks.get(&txn, &id.to_string(&txn)) else {
                        return None;
                    };
                    let flavour = block.get(&txn, "sys:flavour")?.to_string(&txn);
                    let kind = block.get(&txn, "prop:type").map(|t| t.to_string(&txn));
                    (flavour == "affine:paragraph" && kind.as_deref() == Some("text")).then_some(i)
                })
                .collect()
        }
    }
}

enum Target {
    Xml(XmlTextRef),
    Text(TextRef),
}

/// The paragraph at top-level index `at`, if that is one.
fn target_at<T: ReadTxn>(layout: L, txn: &T, at: usize) -> Option<Target> {
    match layout {
        L::Plate => {
            let root = notes::plate::content_root(txn)?;
            let delta = notes::plate::insert_delta(&root).ok()?;
            match &delta.get(at)?.insert {
                notes::plate::Insert::Element(branch) => {
                    let text = XmlTextRef::from(*branch);
                    (text.get_attribute(txn, "type")?.to_string(txn) == "p")
                        .then_some(Target::Xml(text))
                }
                _ => None,
            }
        }
        L::Blocks => {
            let (blocks, children) = note_children(txn);
            let id = children.get(txn, at as u32)?.to_string(txn);
            let Some(Out::YMap(block)) = blocks.get(txn, &id) else {
                return None;
            };
            if block.get(txn, "sys:flavour")?.to_string(txn) != "affine:paragraph" {
                return None;
            }
            match block.get(txn, "prop:text") {
                Some(Out::YText(text)) => Some(Target::Text(text)),
                _ => None,
            }
        }
    }
}

const KEYS: &[u8] = b"etaoin shrdlu";

/// A keystroke at the end of the client's paragraph, or (`erase` > 0) a
/// backspace over that many of its own typed characters; the update its
/// editor sends.
fn key(layout: L, c: &mut Client, erase: u32) -> Option<Vec<u8>> {
    let mut txn = c.doc.transact_mut();
    let target = target_at(layout, &txn, c.at)?;
    // Another session may have moved a shorter paragraph to this index.
    let len = match &target {
        Target::Xml(text) => text.len(&txn),
        Target::Text(text) => text.len(&txn),
    };
    let erase = erase.min(c.typed).min(len);
    let ch = KEYS[c.typed as usize % KEYS.len()] as char;
    match target {
        Target::Xml(text) => {
            if erase > 0 {
                text.remove_range(&mut txn, len - erase, erase);
            } else {
                text.insert(&mut txn, len, &ch.to_string());
            }
        }
        Target::Text(text) => {
            if erase > 0 {
                text.remove_range(&mut txn, len - erase, erase);
            } else {
                text.insert(&mut txn, len, &ch.to_string());
            }
        }
    }
    if erase > 0 {
        c.typed -= erase;
    } else {
        c.typed += 1;
    }
    Some(ydoc::committed_update(txn))
}

/// An `affine:paragraph` as the blocks layout writes one (blocks/src/store.rs).
fn block_paragraph(txn: &mut TransactionMut, blocks: &MapRef, id: &str, line: &str) {
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

fn plate_paragraph(id: &str, line: &str) -> Value {
    json!({ "type": "p", "id": id, "children": [{ "text": line }] })
}

/// New paragraphs after index `at` (Enter at a paragraph's end, or a paste).
fn insert_paragraphs(layout: L, c: &Client, at: usize, ids: &[String], line: &str) -> Vec<u8> {
    let mut txn = c.doc.transact_mut();
    match layout {
        L::Plate => {
            let root = notes::plate::content_root(&txn).expect("content");
            let nodes: Vec<Value> = ids.iter().map(|id| plate_paragraph(id, line)).collect();
            notes::slate_yjs::insert_nodes(&mut txn, root, at as u32, &nodes);
        }
        L::Blocks => {
            let (blocks, children) = note_children(&txn);
            for (i, id) in ids.iter().enumerate() {
                block_paragraph(&mut txn, &blocks, id, line);
                children.insert(&mut txn, (at + i) as u32, Any::from(id.as_str()));
            }
        }
    }
    ydoc::committed_update(txn)
}

/// Deletes the top-level block at `at` (BlockSuite also deletes its map
/// entry and its descendants').
fn delete_block(layout: L, c: &Client, at: usize) -> Vec<u8> {
    let mut txn = c.doc.transact_mut();
    match layout {
        L::Plate => {
            let root = notes::plate::content_root(&txn).expect("content");
            XmlTextRef::from(root).remove_range(&mut txn, at as u32, 1);
        }
        L::Blocks => {
            let (blocks, children) = note_children(&txn);
            let id = children
                .get(&txn, at as u32)
                .expect("child")
                .to_string(&txn);
            children.remove(&mut txn, at as u32);
            // With its descendants, as BlockSuite's deleteBlock does.
            let mut doomed = vec![id];
            while let Some(id) = doomed.pop() {
                if let Some(Out::YMap(block)) = blocks.get(&txn, &id)
                    && let Some(Out::YArray(kids)) = block.get(&txn, "sys:children")
                {
                    doomed.extend(kids.iter(&txn).map(|kid| kid.to_string(&txn)));
                }
                blocks.remove(&mut txn, &id);
            }
        }
    }
    ydoc::committed_update(txn)
}

/// Moves the top-level block at `from` to `to`: slate-yjs moveNode deletes
/// and re-inserts the node; BlockSuite moves the id in `sys:children`.
fn move_block(layout: L, c: &Client, from: usize, to: usize) -> Vec<u8> {
    let node = (layout == L::Plate).then(|| {
        let value = notes::plate::value(&c.doc.transact()).expect("projects");
        value[from].clone()
    });
    let mut txn = c.doc.transact_mut();
    match layout {
        L::Plate => {
            let root = notes::plate::content_root(&txn).expect("content");
            XmlTextRef::from(root).remove_range(&mut txn, from as u32, 1);
            notes::slate_yjs::insert_nodes(&mut txn, root, to as u32, &[node.expect("node")]);
        }
        L::Blocks => {
            let (_, children) = note_children(&txn);
            let id = children
                .get(&txn, from as u32)
                .expect("child")
                .to_string(&txn);
            children.remove(&mut txn, from as u32);
            children.insert(&mut txn, to as u32, Any::from(id.as_str()));
        }
    }
    ydoc::committed_update(txn)
}

fn top_len(layout: L, doc: &Doc) -> usize {
    let txn = doc.transact();
    match layout {
        L::Plate => {
            let root = notes::plate::content_root(&txn).expect("content");
            XmlTextRef::from(root).len(&txn) as usize
        }
        L::Blocks => note_children(&txn).1.len(&txn) as usize,
    }
}

// ---------------------------------------------------------------- states

struct Note<'a> {
    name: &'a str,
    layout: L,
    seed: &'a [u8],
}

fn line(note: &Note, state: &str, mut fields: Value) -> Value {
    let base = json!({ "note": note.name, "layout": note.layout.name(), "state": state });
    if let (Value::Object(base), Value::Object(more)) = (base, fields.take()) {
        let mut out = base;
        out.extend(more);
        Value::Object(out)
    } else {
        unreachable!()
    }
}

fn emit(value: Value) {
    println!("{value}");
}

/// A room loaded, the heap its load kept, and the meter's base.
fn fresh(note: &Note) -> (Room, isize) {
    let before = live();
    let room = load(note.layout, note.seed);
    (room, live() - before)
}

/// The heap the room holds: what dropping it gives back.
fn footprint(room: Room) -> isize {
    let before = live();
    drop(room);
    before - live()
}

fn finish(note: &Note, state: &str, room: Room, base: isize, meter: &Meter, extra: Value) {
    let exact = room.exact_checks();
    let state_bytes = room.state_bytes();
    let rss = rss_mb();
    let kept = footprint(room);
    let mut fields = meter.json(base);
    fields["heapLoadMB"] = json!(mb(base));
    fields["heapKeptMB"] = json!(mb(kept));
    fields["exactChecks"] = json!(exact);
    fields["stateBytes"] = json!(state_bytes);
    fields["processRssMB"] = json!(rss);
    if let (Value::Object(out), Value::Object(more)) = (&mut fields, extra) {
        out.extend(more);
    }
    emit(line(note, state, fields));
    trim();
}

/// Idle loaded rooms: load cost, and heap and RSS each keeps.
fn idle(note: &Note) {
    let count = env_f64("ROOMS", 20.0).max(1.0) as usize;
    trim();
    let (rss0, heap0) = (rss_mb(), live());
    let (cpu, wall) = (thread_cpu(), Instant::now());
    let rooms: Vec<Room> = (0..count).map(|_| load(note.layout, note.seed)).collect();
    let (cpu, wall) = (thread_cpu() - cpu, wall.elapsed());
    let heap = live() - heap0;
    let rss = rss_mb() - rss0;
    let one = rooms.len();
    drop(rooms);
    trim();
    let rss_after = rss_mb() - rss0;
    emit(line(
        note,
        "idle",
        json!({
            "rooms": one,
            "loadCpuMsPerRoom": ms(cpu / one as u32),
            "loadWallMsPerRoom": ms(wall / one as u32),
            "heapPerRoomMB": mb(heap / one as isize),
            "rssPerRoomMB": ((rss / one as f64) * 10.0).round() / 10.0,
            "rssLeftAfterUnloadMB": (rss_after * 10.0).round() / 10.0,
            "seedStateBytes": note.seed.len(),
        }),
    ));
}

/// `peers` clients typing at 10 keys/s for `seconds`: one key each per
/// 100 ms round, every tenth a backspace; each round's updates reach the
/// other peers after the round (concurrent within it).
fn typing(note: &Note, state: &str, peers: usize, seconds: f64) {
    let (mut room, base) = fresh(note);
    let spots = paragraphs(note.layout, &room.doc);
    let mut clients: Vec<Client> = (0..peers)
        .map(|i| {
            client(
                &room,
                10 + i as u64,
                spots[spots.len() * (i + 1) / (peers + 1)],
            )
        })
        .collect();
    let rounds = scaled(seconds * 10.0);
    let mut meter = Meter::default();
    for round in 0..rounds {
        let mut out = Vec::new();
        for (i, c) in clients.iter_mut().enumerate() {
            let update = key(note.layout, c, u32::from(round % 10 == 9)).expect("a paragraph");
            if let Some(broadcast) = room.receive(&mut meter, c.id, &update) {
                out.push((i, broadcast));
            }
        }
        for (from, update) in &out {
            for (i, c) in clients.iter().enumerate() {
                if i != *from {
                    deliver(c, update);
                }
            }
        }
        if round % 600 == 599 {
            room.next_minute();
        }
    }
    let seconds_typed = rounds as f64 / 10.0;
    let cpu_per_s = ms(meter.cpu) / seconds_typed;
    finish(
        note,
        state,
        room,
        base,
        &meter,
        json!({ "peers": peers, "secondsTyped": seconds_typed, "cpuMsPerSecond": (cpu_per_s * 100.0).round() / 100.0 }),
    );
}

/// A burst of 50 block moves by one client, each its own update.
fn moves(note: &Note) {
    let (mut room, base) = fresh(note);
    let c = client(&room, 20, 0);
    let mut rng = Lcg(7);
    let mut meter = Meter::default();
    for _ in 0..50 {
        let len = top_len(note.layout, &c.doc);
        let from = 1 + rng.below(len - 1);
        let to = 1 + rng.below(len - 2);
        let update = move_block(note.layout, &c, from, to);
        if let Some(broadcast) = room.receive(&mut meter, c.id, &update) {
            // The repair, if any, comes back to the writer too.
            deliver(&c, &broadcast);
        }
    }
    finish(note, "moves-50", room, base, &meter, json!({}));
}

/// One paste of 150 paragraphs of 300 characters at the note's end.
fn paste(note: &Note) {
    let mut times = Vec::new();
    let mut last = None;
    for _ in 0..runs() {
        let (mut room, base) = fresh(note);
        let c = client(&room, 21, 0);
        let line_text = "pasted words ".repeat(24)[..300].to_string();
        let ids: Vec<String> = (0..150).map(|i| format!("paste{i}")).collect();
        let at = top_len(note.layout, &c.doc);
        let update = insert_paragraphs(note.layout, &c, at, &ids, &line_text);
        let mut meter = Meter::default();
        room.receive(&mut meter, c.id, &update);
        times.push(ms(meter.cpu));
        last = Some((room, base, meter, update.len()));
    }
    let (room, base, meter, bytes) = last.expect("RUNS is at least 1");
    times.sort_by(f64::total_cmp);
    finish(
        note,
        "paste-150",
        room,
        base,
        &meter,
        json!({ "updateBytes": bytes, "cpuMsRuns": { "min": times[0], "median": times[times.len() / 2] } }),
    );
}

/// A fresh joiner's step-1 answer: the room's whole state.
fn step1(note: &Note) {
    let (room, base) = fresh(note);
    let mut meter = Meter::default();
    let mut bytes = 0;
    for _ in 0..runs() {
        let answer = meter.run(|| {
            room.doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default())
        });
        bytes = answer.len();
    }
    let mut fields = meter.json(base);
    fields["cpuMsPerAnswer"] = json!(ms(meter.cpu / runs() as u32));
    fields["answerBytes"] = json!(bytes);
    fields["openBudgetShare"] =
        json!((bytes as f64 / (80.0 * 1_048_576.0) * 1000.0).round() / 1000.0);
    fields["heapKeptMB"] = json!(mb(footprint(room)));
    emit(line(note, "step1-fresh", fields));
}

/// A tab offline for 500 updates (typing, backspaces, two new paragraphs)
/// while a peer typed 100 keys online; on reconnect the room answers its
/// step 1 and admits its step 2 (everything the room lacks, one update).
fn reconnect(note: &Note) {
    let (mut room, base) = fresh(note);
    let spots = paragraphs(note.layout, &room.doc);
    let mut offline = client(&room, 30, spots[spots.len() / 3]);
    let mut online = client(&room, 31, spots[2 * spots.len() / 3]);
    let mut meter = Meter::default();
    for i in 0..scaled(100.0) {
        let update = key(note.layout, &mut online, u32::from(i % 10 == 9)).expect("a paragraph");
        room.receive(&mut meter, online.id, &update);
    }
    let mut rng = Lcg(11);
    let drafts = scaled(500.0);
    for i in 0..drafts {
        if i == drafts / 3 || i == 2 * drafts / 3 {
            let id = format!("draft{i}");
            let at = offline.at + 1;
            let _ = insert_paragraphs(note.layout, &offline, at, &[id], "");
            offline.at = at;
            offline.typed = 0;
        } else {
            let _ = key(note.layout, &mut offline, u32::from(rng.chance(10)));
        }
    }
    let online_meter = meter;
    let mut meter = Meter::default();
    let client_sv = offline.doc.transact().state_vector();
    let answer = meter.run(|| room.doc.transact().encode_state_as_update_v1(&client_sv));
    let step2 = offline
        .doc
        .transact()
        .encode_state_as_update_v1(&room.doc.transact().state_vector());
    room.receive(&mut meter, offline.id, &step2);
    finish(
        note,
        "reconnect-500",
        room,
        base,
        &meter,
        json!({
            "offlineUpdates": drafts,
            "step2Bytes": step2.len(),
            "answerBytes": answer.len(),
            "onlineTypingCpuMs": ms(online_meter.cpu),
        }),
    );
}

/// One hour of editing by three rotating sessions (each lives 20 minutes,
/// then leaves cleanly and a new one joins): an edit a second each, mostly
/// typing (85%), with word backspaces (8%), new paragraphs (4%), deleted
/// blocks (2%) and moves (1%).
/// Then the live collection at the hour (`collect_live`: collect, reload
/// and the guard), and the room's unload fold and reload.
fn session_hour(note: &Note) {
    let (mut room, base) = fresh(note);
    let seconds = scaled(3600.0);
    let life = scaled(1200.0);
    let mut next_id = 100u64;
    let mut spots = paragraphs(note.layout, &room.doc);
    let mut sessions: Vec<Client> = (0..3)
        .map(|i| {
            next_id += 1;
            client(&room, next_id, spots[spots.len() * (i + 1) / 4])
        })
        .collect();
    let window_at_load = ydoc::gc::Window::of(&room.doc.transact(), 1);
    let mut window_late = None;
    let mut rng = Lcg(23);
    let mut meter = Meter::default();
    let mut ops: HashMap<&str, u64> = HashMap::new();
    let mut refused = Vec::new();
    for second in 0..seconds {
        if second > 0 && second % 60 == 0 {
            room.next_minute();
        }
        // Rotation: session k ends at (k+1)·life/3 and every life after.
        if second > 0 && second % (life / 3).max(1) == 0 {
            let k = (second / (life / 3).max(1)) % 3;
            let ended = sessions[k].id;
            room.held.remove(&ended);
            next_id += 1;
            spots = paragraphs(note.layout, &room.doc);
            sessions[k] = client(&room, next_id, spots[rng.below(spots.len())]);
            // A window the new session has reached (an hourly snapshot may
            // land here): the best case for the collection at the hour.
            if second >= seconds * 2 / 3 && window_late.is_none() {
                window_late = Some(ydoc::gc::Window::of(&room.doc.transact(), 2));
            }
        }
        let mut out = Vec::new();
        for (i, c) in sessions.iter_mut().enumerate() {
            let roll = rng.below(100);
            let len = top_len(note.layout, &c.doc);
            let (op, update) = if roll < 85 {
                ("key", key(note.layout, c, 0))
            } else if roll < 93 {
                // A word's worth of backspaces, as one update.
                let erase = 1 + rng.below(6) as u32;
                ("backspace", key(note.layout, c, erase))
            } else if roll < 97 {
                let id = format!("s{}p{}", c.id, c.made.len());
                let at = (c.at + 1).min(len);
                let update = insert_paragraphs(note.layout, c, at, std::slice::from_ref(&id), "");
                c.made.push(id);
                c.at = at;
                c.typed = 0;
                ("enter", Some(update))
            } else if roll < 99 {
                // Deletes a block below its own paragraph, never its own.
                let at = (c.at + 1 + rng.below(20)).min(len - 1);
                if at == c.at || len < 10 {
                    continue;
                }
                ("delete", Some(delete_block(note.layout, c, at)))
            } else {
                let from = (c.at + 2 + rng.below(20)).min(len - 1);
                let to = 1 + rng.below(len - 2);
                if from == c.at || to == c.at {
                    continue;
                }
                ("move", Some(move_block(note.layout, c, from, to)))
            };
            let Some(update) = update else { continue };
            *ops.entry(op).or_default() += 1;
            match room.receive(&mut meter, c.id, &update) {
                Some(broadcast) => out.push((i, broadcast)),
                // A refused editor reloads on a fresh document (Epo
                // 2026-10-18); its later updates would all be unheld.
                None => refused.push(i),
            }
        }
        for i in refused.drain(..) {
            room.held.remove(&sessions[i].id);
            next_id += 1;
            let at = sessions[i].at;
            sessions[i] = client(&room, next_id, at);
        }
        // Everyone hears the second's updates; a session whose paragraph
        // moved under it types where its index now points.
        for (from, update) in &out {
            for (i, c) in sessions.iter().enumerate() {
                if i != *from {
                    deliver(c, update);
                }
            }
        }
        for c in sessions.iter_mut() {
            let len = top_len(note.layout, &c.doc);
            if c.at >= len || target_at(note.layout, &c.doc.transact(), c.at).is_none() {
                let spots = paragraphs(note.layout, &c.doc);
                c.at = spots[rng.below(spots.len())];
                c.typed = 0;
            }
        }
    }
    let held = room.holds();
    let held_ranges: usize = held.iter().map(|(_, ranges)| ranges.iter().count()).sum();
    let held_heap = {
        let before = live();
        let copy: Vec<Vec<IdSet>> = room.held.values().cloned().collect();
        let size = live() - before;
        drop(copy);
        size
    };
    let state_before = room.state_bytes();
    let exact = room.exact_checks();
    // The hour's numbers, without dropping the room.
    let mut fields = meter.json(base);
    fields["heapLoadMB"] = json!(mb(base));
    fields["heapRoomMB"] = json!(mb(base + meter.kept));
    fields["heldHeapMB"] = json!(mb(held_heap));
    fields["heldRanges"] = json!(held_ranges);
    fields["exactChecks"] = json!(exact);
    fields["stateBytes"] = json!(state_before);
    fields["simulatedSeconds"] = json!(seconds);
    fields["ops"] = json!(ops);
    fields["processRssMB"] = json!(rss_mb());
    emit(line(note, "session-hour", fields));

    // The live collection at the hour, under each window.
    let mut collected_room = None;
    for (label, window) in [
        ("hourly-window", Some(&window_at_load)),
        ("late-window", window_late.as_ref()),
    ] {
        let Some(window) = window else { continue };
        let mut meter = Meter::default();
        let before = live();
        let result = meter.run(|| collect_live(note.layout, &room.doc, window, &held));
        let fields = match result {
            Ok(Some((doc, units))) => {
                let kept = live() - before;
                let state = doc
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default())
                    .len();
                let collected_heap = {
                    let b = live();
                    drop(doc);
                    b - live()
                };
                let _ = kept;
                if label == "late-window" {
                    collected_room = Some(window.clone());
                }
                json!({ "window": label, "units": units, "stateBytesBefore": state_before, "stateBytesAfter": state, "heapAfterMB": mb(collected_heap) })
            }
            Ok(None) => json!({ "window": label, "units": 0, "stateBytesBefore": state_before }),
            Err(error) => json!({ "window": label, "guardRefused": error }),
        };
        let mut out = meter.json(0);
        out["heapRoomBeforeMB"] = json!(mb(base + meter.kept));
        if let (Value::Object(out), Value::Object(more)) = (&mut out, fields) {
            out.extend(more);
        }
        emit(line(note, "gc-collect", out));
    }

    // Unload: the fold collects with no live client (the unload fold), the
    // room is dropped; reload: a load of the folded state.
    let window = collected_room.unwrap_or(window_at_load);
    let mut meter = Meter::default();
    let folded = meter.run(|| ydoc::gc::collect(&room.doc, &window, &held, None));
    trim();
    let rss_before = rss_mb();
    let freed = footprint(room);
    trim();
    let rss_after = rss_mb();
    let mut fields = meter.json(0);
    fields["foldedStateBytes"] = json!(folded.state.len());
    fields["foldUnits"] = json!(folded.units);
    fields["heapFreedMB"] = json!(mb(freed));
    fields["rssFreedMB"] = json!(((rss_before - rss_after) * 10.0).round() / 10.0);
    emit(line(note, "unload", fields));

    let mut meter = Meter::default();
    let before = live();
    let room = meter.run(|| load(note.layout, &folded.state));
    let kept = live() - before;
    let mut fields = meter.json(0);
    fields["heapKeptMB"] = json!(mb(kept));
    fields["stateBytes"] = json!(folded.state.len());
    drop(room);
    emit(line(note, "reload", fields));
}

/// `note_store::collect_live`: collect, load the state into a new doc and
/// guard it (roots, value and state vector as before).
fn collect_live(
    layout: L,
    doc: &Doc,
    window: &ydoc::gc::Window,
    held: &IdSet,
) -> Result<Option<(Doc, u64)>, String> {
    let client = doc.client_id();
    let collected = ydoc::gc::collect(doc, window, held, Some(client));
    if collected.units == 0 {
        return Ok(None);
    }
    let loaded = Doc::with_options(ydoc::doc_options(client.get()));
    ydoc::replay(&loaded, &collected.state, &[] as &[&[u8]]).map_err(|e| e.to_string())?;
    {
        let model = layout.model();
        let (before, after) = (doc.transact(), loaded.transact());
        model.assert_roots(&after)?;
        if model.document_value(&before)? != model.document_value(&after)? {
            return Err("the collected state holds another value".into());
        }
        if before.state_vector() != after.state_vector() {
            return Err("the collected state holds another state vector".into());
        }
    }
    Ok(Some((loaded, collected.units)))
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: layout-cost <values.json>");
    let values: serde_json::Map<String, Value> =
        serde_json::from_slice(&std::fs::read(path).expect("reads the values")).expect("JSON");
    let states = list(
        "STATES",
        "idle,step1-fresh,typing-1,typing-5,moves-50,paste-150,reconnect-500,session-hour",
    );
    emit(json!({
        "meta": true,
        "scale": scale(),
        "runs": runs(),
        "rooms": env_f64("ROOMS", 20.0),
        "states": states,
        "sha": std::env::var("CAPY_SHA").ok(),
        "malloc": {
            "arenaMax": std::env::var("MALLOC_ARENA_MAX").ok(),
            "trimThreshold": std::env::var("MALLOC_TRIM_THRESHOLD_").ok(),
            "mmapThreshold": std::env::var("MALLOC_MMAP_THRESHOLD_").ok(),
        },
        "processRssMB": rss_mb(),
    }));
    for name in list("NOTES", "load-test,small") {
        let value = values
            .get(&name)
            .unwrap_or_else(|| panic!("no note {name} in the values"))
            .as_array()
            .expect("a Plate value");
        for layout in list("LAYOUTS", "plate,blocks") {
            let layout = match layout.as_str() {
                "plate" => L::Plate,
                "blocks" => L::Blocks,
                other => panic!("unknown layout {other}"),
            };
            let seed = match layout {
                L::Plate => notes::slate_yjs::state_from_value(value, 1),
                L::Blocks => {
                    blocks::state_from_value(value, 1).expect("the blocks layout holds it")
                }
            };
            let note = Note {
                name: &name,
                layout,
                seed: &seed,
            };
            for state in &states {
                let started = Instant::now();
                match state.as_str() {
                    "idle" => idle(&note),
                    "step1-fresh" => step1(&note),
                    "typing-1" => typing(&note, "typing-1", 1, 60.0),
                    "typing-5" => typing(&note, "typing-5", 5, 60.0),
                    "moves-50" => moves(&note),
                    "paste-150" => paste(&note),
                    "reconnect-500" => reconnect(&note),
                    // Emits session-hour, gc-collect (per window), unload, reload.
                    "session-hour" => session_hour(&note),
                    other => panic!("unknown state {other}"),
                }
                eprintln!(
                    "{} {} {state}: {:.1} s",
                    note.name,
                    layout.name(),
                    started.elapsed().as_secs_f64()
                );
            }
        }
    }
}
