//! Memory and encoded state of one Office collaboration room after a scripted
//! edit history (bench/collaboration/reports/2026-10-17-office-room-memory.md).
//!
//!   cargo run --release -- <docx|pptx|xlsx> <file> [edits] [checkpoints]
//!
//! `edits` defaults to 10000, `checkpoints` to "1000,10000". A client replica
//! makes the edits through the fork's engines (docx-edit `EditingDoc`,
//! pptx-edit `DeckSession`, the betteroffice-xlsx `Workbook`, whose cell and
//! style ops go through `authority::stable`); each transaction's update goes
//! into a room document held as collaboration-rs holds one
//! (`ydoc::doc_options(0)`, GC on). Every 25 edits the room saves as
//! `start_source_store` does (a `ydoc::delta_update` row plus the whole-state
//! encode for the engine) and folds as `SourceStore::fold` does once the log
//! passes max(256 KiB, the stored state) or 1000 rows.
//!
//! Memory is the allocator's usable size of every live block (`malloc_size`
//! on macOS, `malloc_usable_size` on Linux) counted on the thread that holds
//! the room, so the client replica is not in it. Prints one JSON object.

#![allow(clippy::print_stdout, clippy::unwrap_used)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{Value, json};
use ydoc::Durable;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, ReadTxn, StateVector, Transact, Update};

// ---- counting allocator ------------------------------------------------

unsafe extern "C" {
    #[cfg(target_os = "macos")]
    fn malloc_size(ptr: *const c_void) -> usize;
    #[cfg(target_os = "linux")]
    fn malloc_usable_size(ptr: *mut c_void) -> usize;
}

fn usable(ptr: *mut u8) -> i64 {
    #[cfg(target_os = "macos")]
    return unsafe { malloc_size(ptr as *const c_void) as i64 };
    #[cfg(target_os = "linux")]
    return unsafe { malloc_usable_size(ptr as *mut c_void) as i64 };
}

thread_local! {
    /// Usable bytes and blocks this thread allocated minus what it freed.
    static HELD: Cell<(i64, i64)> = const { Cell::new((0, 0)) };
}

fn track(bytes: i64, blocks: i64) {
    let _ = HELD.try_with(|held| {
        let (b, n) = held.get();
        held.set((b + bytes, n + blocks));
    });
}

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            track(usable(ptr), 1);
        }
        ptr
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            track(usable(ptr), 1);
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        track(-usable(ptr), -1);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let old = usable(ptr);
        let new = unsafe { System.realloc(ptr, layout, new_size) };
        if !new.is_null() {
            track(usable(new) - old, 0);
        }
        new
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[derive(Clone, Copy, Default, Debug)]
struct Held {
    bytes: i64,
    blocks: i64,
}

impl std::ops::AddAssign for Held {
    fn add_assign(&mut self, other: Held) {
        self.bytes += other.bytes;
        self.blocks += other.blocks;
    }
}

/// What `f` left allocated on this thread.
fn held<T>(f: impl FnOnce() -> T) -> (T, Held) {
    let (b0, n0) = HELD.with(Cell::get);
    let out = f();
    let (b1, n1) = HELD.with(Cell::get);
    (
        out,
        Held {
            bytes: b1 - b0,
            blocks: n1 - n0,
        },
    )
}

fn vec_usable(v: &Vec<u8>) -> i64 {
    if v.capacity() == 0 {
        0
    } else {
        usable(v.as_ptr() as *mut u8)
    }
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn round(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

// ---- the room ------------------------------------------------------------

const SAVE_EVERY: usize = 25;
const FOLD_MIN_BYTES: usize = 256 * 1024;
const FOLD_MAX_ROWS: usize = 1000;

/// Structs in a document's store: live items, deleted items (content kept
/// only by GC's rules) and garbage-collected runs.
fn blocks(doc: &Doc) -> Value {
    let txn = doc.transact();
    let store = txn.store();
    let (mut live, mut deleted, mut gc) = (0u64, 0u64, 0u64);
    for (client, end) in txn.state_vector().iter() {
        for (_, item) in store.blocks_in(client, 0..*end) {
            match item {
                Some(item) if item.is_deleted() => deleted += 1,
                Some(_) => live += 1,
                None => gc += 1,
            }
        }
    }
    json!({ "live": live, "deleted": deleted, "gc": gc })
}

struct Room {
    doc: Doc,
    durable: Durable,
    /// The doc plus its durable cover, as the room task holds them.
    held: Held,
    seed: Vec<u8>,
    seed_vector: StateVector,
    stored: Option<Vec<u8>>,
    log: Vec<Vec<u8>>,
    log_bytes: usize,
    saves: usize,
    row_ms: Vec<f64>,
    encode_ms: Vec<f64>,
    folds: Vec<Value>,
}

fn apply_layers(doc: &Doc, layers: &[&[u8]]) {
    let mut txn = doc.transact_mut();
    for layer in layers {
        txn.apply_update(Update::decode_v1(layer).unwrap()).unwrap();
    }
    assert!(
        txn.store().pending_update().is_none() && txn.store().pending_ds().is_none(),
        "replay left pending structs"
    );
}

impl Room {
    fn open(seed: Vec<u8>) -> Self {
        let ((doc, durable), held) = held(|| {
            let doc = Doc::with_options(ydoc::doc_options(0));
            apply_layers(&doc, &[&seed]);
            let durable = Durable::of(&doc.transact());
            (doc, durable)
        });
        let seed_vector = Update::decode_v1(&seed).unwrap().state_vector();
        Self {
            doc,
            durable,
            held,
            seed,
            seed_vector,
            stored: None,
            log: Vec::new(),
            log_bytes: 0,
            saves: 0,
            row_ms: Vec::new(),
            encode_ms: Vec::new(),
            folds: Vec::new(),
        }
    }

    /// One client update, as the room integrates it. What the room kept.
    fn apply(&mut self, update: &[u8]) -> Held {
        let ((), kept) = held(|| apply_layers(&self.doc, &[update]));
        self.held += kept;
        kept
    }

    fn encode(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// A source store: the row since the durable cover, and the whole state
    /// the engine gets; then a fold if the log is past its limits.
    fn save(&mut self) {
        let ((row, durable, row_ms, encode_ms), kept) = held(|| {
            let at = Instant::now();
            let (row, durable) = ydoc::delta_update(&self.doc.transact(), &self.durable, &[]);
            let row_ms = ms(at);
            let at = Instant::now();
            let whole = self.encode();
            let encode_ms = ms(at);
            drop(whole);
            (row, durable, row_ms, encode_ms)
        });
        let ((), replaced) = held(|| self.durable = durable);
        self.held += Held {
            bytes: kept.bytes - vec_usable(&row) + replaced.bytes,
            blocks: kept.blocks - i64::from(row.capacity() > 0) + replaced.blocks,
        };
        self.row_ms.push(row_ms);
        self.encode_ms.push(encode_ms);
        self.saves += 1;
        if row.len() > 2 {
            self.log_bytes += row.len();
            self.log.push(row);
        }
        let stored = self.stored.as_ref().map_or(0, Vec::len);
        if self.log_bytes >= FOLD_MIN_BYTES.max(stored) || self.log.len() >= FOLD_MAX_ROWS {
            let fold = self.fold();
            self.folds.push(fold);
        }
    }

    /// `SourceStore::fold`: seed, stored state and rows replayed into a
    /// scratch document, encoded as the change over the seed.
    fn fold(&mut self) -> Value {
        let (rows, row_bytes) = (self.log.len(), self.log_bytes);
        let at = Instant::now();
        let (scratch, scratch_held) = held(|| {
            let scratch = ydoc::scratch_doc();
            let mut layers: Vec<&[u8]> = vec![&self.seed];
            layers.extend(self.stored.as_deref());
            layers.extend(self.log.iter().map(Vec::as_slice));
            apply_layers(&scratch, &layers);
            scratch
        });
        let state = scratch
            .transact()
            .encode_state_as_update_v1(&self.seed_vector);
        drop(scratch);
        let fold_ms = ms(at);
        let out = json!({
            "rows": rows,
            "rowBytes": row_bytes,
            "storedBytes": state.len(),
            "ms": round(fold_ms),
            "scratchHeldBytes": scratch_held.bytes,
        });
        self.stored = Some(state);
        self.log.clear();
        self.log_bytes = 0;
        out
    }

    /// The room loaded again from the seed and the stored state (after a
    /// fold the log is empty).
    fn reload(&self) -> Value {
        let (doc, kept) = held(|| {
            let doc = Doc::with_options(ydoc::doc_options(0));
            let mut layers: Vec<&[u8]> = vec![&self.seed];
            layers.extend(self.stored.as_deref());
            layers.extend(self.log.iter().map(Vec::as_slice));
            apply_layers(&doc, &layers);
            doc
        });
        let out = json!({
            "heldBytes": kept.bytes,
            "heldBlocks": kept.blocks,
            "structs": blocks(&doc),
            "stateBytes": doc.transact().encode_state_as_update_v1(&StateVector::default()).len(),
        });
        drop(doc);
        out
    }
}

// ---- edits -------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next() % n }
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }
}

/// Edit kinds with their weight per 100 edits.
type Mix = &'static [(&'static str, u64)];

const DOCX_MIX: Mix = &[
    ("type", 70),
    ("backspace", 8),
    ("bold", 6),
    ("enter", 6),
    ("crossDelete", 4),
    ("tableRow", 6),
];
const PPTX_MIX: Mix = &[
    ("type", 70),
    ("backspace", 8),
    ("bold", 6),
    ("enter", 6),
    ("crossDelete", 4),
    ("shapeMove", 6),
];
const XLSX_MIX: Mix = &[("type", 70), ("clear", 10), ("rangeStyle", 20)];

fn pick(rng: &mut Rng, mix: Mix) -> &'static str {
    let total: u64 = mix.iter().map(|(_, w)| w).sum();
    let mut at = rng.below(total);
    for (kind, weight) in mix {
        if at < *weight {
            return kind;
        }
        at -= weight;
    }
    unreachable!()
}

const TEXT: &[u8] = b"the quick brown fox jumps over the lazy dog ";
/// Keystrokes before the caret jumps elsewhere.
const BURST: u32 = 20;

/// A client replica: makes one edit of `kind`, Err when the engine refuses it.
trait Client {
    fn edit(&mut self, kind: &str, rng: &mut Rng) -> Result<(), String>;
    fn info(&self) -> Value;
}

type Updates = Arc<Mutex<Vec<Vec<u8>>>>;

struct Caret {
    at: u32,
    left: u32,
    typed: usize,
}

impl Caret {
    fn new() -> Self {
        Self {
            at: 0,
            left: 0,
            typed: 0,
        }
    }
    /// The caret for the next keystroke in a story of `len`; jumps after a burst.
    fn place(&mut self, rng: &mut Rng, len: u32) -> u32 {
        if self.left == 0 || self.at >= len {
            self.at = rng.below(u64::from(len.max(1))) as u32;
            self.left = BURST;
        }
        self.left -= 1;
        self.at
    }
    fn char(&mut self) -> String {
        let c = TEXT[self.typed % TEXT.len()] as char;
        self.typed += 1;
        c.to_string()
    }
}

// DOCX

struct DocxClient {
    doc: docx_edit::EditingDoc,
    story: String,
    tables: u32,
    caret: Caret,
    seed_source: &'static str,
    _sub: yrs::Subscription,
}

fn docx_ctx() -> docx_edit::EditCtx {
    docx_edit::EditCtx::local("bench", "2026-10-17T00:00:00Z")
}

impl DocxClient {
    fn open(base: &[u8], seed: &[u8], updates: Updates) -> Self {
        // The editor seeds from the file; use that when it is the server's seed.
        let mut doc = docx_edit::EditingDoc::new(4242);
        let mut seed_source = "docx-edit seed_from_docx";
        if docx_edit::seed_from_docx(&doc, base).is_err() || doc.encode_state_as_update_v1() != seed
        {
            doc = docx_edit::EditingDoc::new(4242);
            doc.load_state_v1(seed).unwrap();
            seed_source = "server seed (load_state_v1)";
        }
        let story = {
            let txn = doc.yrs_doc().transact();
            let stories = txn.get_map("stories").unwrap();
            let ids: Vec<String> = stories.keys(&txn).map(str::to_owned).collect();
            drop(txn);
            ids.into_iter()
                .max_by_key(|id| doc.story_len(id).unwrap_or(0))
                .unwrap()
        };
        let tables = doc.story_embeds(&story, "table").unwrap().len() as u32;
        let sub = doc
            .yrs_doc()
            .observe_update_v1(move |_, event| updates.lock().unwrap().push(event.update.clone()))
            .unwrap();
        Self {
            doc,
            story,
            tables,
            caret: Caret::new(),
            seed_source,
            _sub: sub,
        }
    }
}

impl Client for DocxClient {
    fn edit(&mut self, kind: &str, rng: &mut Rng) -> Result<(), String> {
        use docx_edit::{CellLoc, FormatPolicy, Position, SimpleFormat, StoryRange};
        let s = self.story.as_str();
        let len = self.doc.story_len(s).map_err(|e| e.to_string())?;
        let err = |e: &dyn std::fmt::Display| e.to_string();
        match kind {
            "type" => {
                let at = self.caret.place(rng, len);
                let ch = self.caret.char();
                match self.doc.insert_text(
                    &docx_ctx(),
                    Position::new(s, at),
                    &ch,
                    FormatPolicy::Inherit,
                ) {
                    Ok(_) => {
                        self.caret.at += 1;
                        Ok(())
                    }
                    Err(e) => {
                        self.caret.left = 0;
                        Err(err(&e))
                    }
                }
            }
            "backspace" => {
                let at = self.caret.place(rng, len);
                if at == 0 {
                    return Err("caret at start".into());
                }
                let out = self
                    .doc
                    .delete_range(&docx_ctx(), StoryRange::new(s, at - 1, at));
                self.caret.at = at - 1;
                out.map(|_| ()).map_err(|e| err(&e))
            }
            "bold" => {
                let start = rng.below(u64::from(len.saturating_sub(41))) as u32;
                let end = (start + rng.range(5, 40) as u32).min(len - 1);
                self.doc
                    .toggle_format(
                        &docx_ctx(),
                        StoryRange::new(s, start, end),
                        SimpleFormat::Bold,
                    )
                    .map(|_| ())
                    .map_err(|e| err(&e))
            }
            "enter" => {
                let at = self.caret.place(rng, len);
                let out = self.doc.split_paragraph(&docx_ctx(), Position::new(s, at));
                self.caret.at = at + 1;
                out.map(|_| ()).map_err(|e| err(&e))
            }
            "crossDelete" => {
                let paragraphs = self.doc.paragraphs(s).map_err(|e| err(&e))?;
                if paragraphs.len() < 2 {
                    return Err("one paragraph".into());
                }
                // From inside one paragraph into the next, both text only, so
                // the selection never takes a table with it.
                let i = rng.below(paragraphs.len() as u64 - 1) as usize;
                let mark = |p: &docx_edit::ParagraphSnapshot| {
                    self.doc
                        .paragraph_mark_position(&p.para_id)
                        .map(|at| at.index)
                        .map_err(|e| err(&e))
                };
                let units = |p: &docx_edit::ParagraphSnapshot| p.text.encode_utf16().count() as u32;
                let (here, next) = (&paragraphs[i], &paragraphs[i + 1]);
                let (m0, m1) = (mark(here)?, mark(next)?);
                let starts = if i == 0 {
                    0
                } else {
                    mark(&paragraphs[i - 1])? + 1
                };
                if m0 - starts != units(here) || m1 - m0 != units(next) + 1 {
                    return Err("next to a table".into());
                }
                let start = m0 - (rng.range(1, 12) as u32).min(units(here));
                let end = m0 + 1 + (rng.range(1, 12) as u32).min(units(next));
                self.caret.left = 0;
                self.doc
                    .delete_range(&docx_ctx(), StoryRange::new(s, start, end))
                    .map(|_| ())
                    .map_err(|e| err(&e))
            }
            "tableRow" => {
                if self.tables == 0 {
                    return Err("no tables".into());
                }
                let table = rng.below(u64::from(self.tables)) as u32;
                self.doc
                    .insert_row(&docx_ctx(), &CellLoc::new(s, table, 0, 0), true)
                    .map(|_| ())
                    .map_err(|e| err(&e))
            }
            _ => unreachable!(),
        }
    }

    fn info(&self) -> Value {
        json!({
            "story": self.story,
            "storyLen": self.doc.story_len(&self.story).unwrap_or(0),
            "paragraphs": self.doc.paragraphs(&self.story).map(|p| p.len()).unwrap_or(0),
            "tables": self.tables,
            "clientSeed": self.seed_source,
        })
    }
}

// PPTX

struct PptxClient {
    deck: pptx_edit::DeckSession,
    stories: Vec<String>,
    shapes: Vec<(String, String)>,
    size: (i64, i64),
    story: usize,
    caret: Caret,
    _sub: yrs::Subscription,
}

fn pptx_ctx() -> pptx_edit::EditCtx {
    pptx_edit::EditCtx::local("bench")
}

impl PptxClient {
    fn open(base: &[u8], seed: &[u8], updates: Updates) -> Self {
        let deck = pptx_edit::DeckSession::open_from_update_with_source(seed, base, 4242).unwrap();
        let snapshot = deck.snapshot().unwrap();
        let mut stories = Vec::new();
        let mut shapes = Vec::new();
        fn walk(shape: &pptx_edit::ShapeSnapshot, stories: &mut Vec<String>) {
            for story in &shape.text_stories {
                if story.length > 1 {
                    stories.push(story.id.clone());
                }
            }
            for child in &shape.children {
                walk(child, stories);
            }
        }
        for slide in &snapshot.slides {
            for shape in &slide.shapes {
                walk(shape, &mut stories);
                shapes.push((slide.id.clone(), shape.id.clone()));
            }
        }
        let sub = deck
            .observe_update_v1(move |event| updates.lock().unwrap().push(event.update))
            .unwrap();
        Self {
            deck,
            stories,
            shapes,
            size: (snapshot.width_emu, snapshot.height_emu),
            story: 0,
            caret: Caret::new(),
            _sub: sub,
        }
    }

    fn story_len(&self, id: &str) -> Result<u32, String> {
        self.deck
            .story(id)
            .map(|story| story.length)
            .map_err(|e| e.to_string())
    }
}

impl Client for PptxClient {
    fn edit(&mut self, kind: &str, rng: &mut Rng) -> Result<(), String> {
        let err = |e: pptx_edit::EditError| e.to_string();
        // A burst types into one story; a jump may land in another.
        if self.caret.left == 0 && kind != "shapeMove" {
            self.story = rng.below(self.stories.len() as u64) as usize;
        }
        let id = self.stories[self.story].clone();
        // The final pilcrow is not a caret position.
        let len = self.story_len(&id)?.saturating_sub(1);
        match kind {
            "type" => {
                let at = self.caret.place(rng, len + 1);
                let ch = self.caret.char();
                match self.deck.insert_text(
                    &pptx_ctx(),
                    &id,
                    at,
                    &ch,
                    &pptx_edit::TextStyle::default(),
                ) {
                    Ok(_) => {
                        self.caret.at += 1;
                        Ok(())
                    }
                    Err(e) => {
                        self.caret.left = 0;
                        Err(err(e))
                    }
                }
            }
            "backspace" => {
                let at = self.caret.place(rng, len + 1);
                if at == 0 {
                    return Err("caret at start".into());
                }
                self.caret.at = at - 1;
                self.deck
                    .delete_text(&pptx_ctx(), &id, at - 1, at)
                    .map(|_| ())
                    .map_err(err)
            }
            "bold" => {
                let start = rng.below(u64::from(len.saturating_sub(5)).max(1)) as u32;
                let end = (start + rng.range(5, 40) as u32).min(len);
                let patch = pptx_edit::TextStylePatch {
                    bold: Some(true),
                    ..Default::default()
                };
                self.deck
                    .format_text(&pptx_ctx(), &id, start, end, &patch)
                    .map(|_| ())
                    .map_err(err)
            }
            "enter" => {
                let at = self.caret.place(rng, len + 1);
                self.caret.at = at + 1;
                self.deck
                    .insert_paragraph_break(&pptx_ctx(), &id, at)
                    .map(|_| ())
                    .map_err(err)
            }
            "crossDelete" => {
                // The editor's selection delete across paragraphs.
                let paragraphs = self.deck.story(&id).map_err(err)?.paragraphs;
                if paragraphs.len() < 2 {
                    self.caret.left = 0;
                    return Err("one paragraph".into());
                }
                let first = rng.below(paragraphs.len() as u64 - 1) as usize;
                let mark: u32 = paragraphs[..=first]
                    .iter()
                    .map(|p| {
                        p.runs
                            .iter()
                            .map(|r| r.text.encode_utf16().count() as u32)
                            .sum::<u32>()
                            + 1
                    })
                    .sum::<u32>()
                    - 1;
                let start = mark.saturating_sub(rng.range(1, 12) as u32);
                let end = (mark + 1 + rng.range(1, 12) as u32).min(len);
                self.caret.left = 0;
                self.deck
                    .replace_text(
                        &pptx_ctx(),
                        &id,
                        start,
                        end,
                        "",
                        &pptx_edit::TextStyle::default(),
                    )
                    .map(|_| ())
                    .map_err(err)
            }
            "shapeMove" => {
                let (slide, shape) = &self.shapes[rng.below(self.shapes.len() as u64) as usize];
                let x = rng.below(self.size.0.max(1) as u64 / 2) as i64;
                let y = rng.below(self.size.1.max(1) as u64 / 2) as i64;
                self.deck
                    .move_shape(&pptx_ctx(), slide, shape, x, y)
                    .map(|_| ())
                    .map_err(err)
            }
            _ => unreachable!(),
        }
    }

    fn info(&self) -> Value {
        json!({
            "stories": self.stories.len(),
            "shapes": self.shapes.len(),
            "clientSeed": "server seed (open_from_update_with_source)",
        })
    }
}

// XLSX

struct XlsxClient {
    workbook: betteroffice_xlsx::Workbook,
    sheets: Vec<(betteroffice_xlsx::SheetId, u32, u32)>,
    caret: Option<(usize, u32, u32)>,
    left: u32,
    seed_matches: bool,
    _sub: betteroffice_xlsx::UpdateSubscription,
}

impl XlsxClient {
    fn open(base: &[u8], seed: &[u8], updates: Updates) -> Self {
        let workbook = betteroffice_xlsx::Workbook::open_collaborative(base, 4242).unwrap();
        let seed_matches = workbook.encode_state_as_update_v1() == seed;
        let model = workbook.model();
        let sheets = model
            .sheets
            .iter()
            .enumerate()
            .map(|(index, sheet)| {
                let (rows, cols) = sheet
                    .used_range()
                    .map_or((0, 0), |range| (range.end.row, range.end.col));
                (betteroffice_xlsx::SheetId(index as u32), rows, cols)
            })
            .filter(|(_, rows, cols)| *rows > 1 && *cols > 0)
            .collect();
        let sub = workbook
            .observe_update_v1(move |event| updates.lock().unwrap().push(event.update))
            .unwrap();
        Self {
            workbook,
            sheets,
            caret: None,
            left: 0,
            seed_matches,
            _sub: sub,
        }
    }

    fn random_cell(&self, rng: &mut Rng) -> (usize, u32, u32) {
        let sheet = rng.below(self.sheets.len() as u64) as usize;
        let (_, rows, cols) = self.sheets[sheet];
        (
            sheet,
            rng.range(1, u64::from(rows)) as u32,
            rng.below(u64::from(cols) + 1) as u32,
        )
    }
}

impl Client for XlsxClient {
    fn edit(&mut self, kind: &str, rng: &mut Rng) -> Result<(), String> {
        use betteroffice_xlsx::{CalculationOptions, CellRange, CellRef, StylePatch};
        let options = CalculationOptions {
            now_serial: Some(46_000.0),
        };
        let err = |e: betteroffice_xlsx::Error| e.to_string();
        match kind {
            // A value and Enter: the caret moves down; after a burst it jumps.
            "type" | "clear" => {
                if self.left == 0 || self.caret.is_none() {
                    self.caret = Some(self.random_cell(rng));
                    self.left = BURST;
                }
                self.left -= 1;
                let (sheet, row, col) = self.caret.unwrap();
                let input = if kind == "clear" {
                    String::new()
                } else if col < 3 {
                    format!("{} note", rng.range(1, 999))
                } else {
                    rng.range(0, 100).to_string()
                };
                self.caret = Some((sheet, row + 1, col));
                let id = self.sheets[sheet].0;
                self.workbook
                    .edit_cell(id, CellRef::new(row, col), &input, options)
                    .map(|_| ())
                    .map_err(err)
            }
            // A dragged selection, then bold or a fill from the toolbar.
            "rangeStyle" => {
                let (sheet, row, col) = self.random_cell(rng);
                let (_, rows, cols) = self.sheets[sheet];
                let end_row = (row + rng.range(0, 29) as u32).min(rows);
                let end_col = (col + rng.range(0, 7) as u32).min(cols);
                let mut patch = StylePatch::default();
                if rng.below(2) == 0 {
                    patch.bold = Some(rng.below(2) == 0);
                } else {
                    patch.fill_color = Some(
                        ["#FFF2CC", "#DDEBF7", "#E2EFDA", "#FCE4D6"][rng.below(4) as usize].into(),
                    );
                }
                let id = self.sheets[sheet].0;
                self.workbook
                    .patch_range_style(
                        id,
                        CellRange::new(CellRef::new(row, col), CellRef::new(end_row, end_col)),
                        patch,
                        options,
                    )
                    .map(|_| ())
                    .map_err(err)
            }
            _ => unreachable!(),
        }
    }

    fn info(&self) -> Value {
        json!({
            "editedSheets": self.sheets.iter().map(|(id, rows, cols)| json!([id.0, rows, cols])).collect::<Vec<_>>(),
            "clientSeed": "open_collaborative",
            "clientStateIsSeed": self.seed_matches,
        })
    }
}

// ---- the run -----------------------------------------------------------

#[derive(Default)]
struct KindStats {
    done: u64,
    refused: u64,
    updates: u64,
    wire_bytes: u64,
    room_bytes: i64,
    refusals: BTreeMap<String, u64>,
}

fn xlsx_replica(base: &[u8], state: &[u8]) -> Value {
    let sha = office_service::sha256_hex(base);
    let replicas = office_service::XlsxReplicas::new(1 << 36);
    let checkpoint = office_service::Checkpoint {
        format: office_service::Format::Xlsx,
        schema_version: 1,
        base_sha256: &sha,
        state,
    };
    let at = Instant::now();
    let (effects, opened) = held(|| {
        replicas
            .pending_effects(base, checkpoint, "room")
            .map(|effects| effects.len())
    });
    let first_ms = ms(at);
    let at = Instant::now();
    let (_, again) = held(|| {
        replicas
            .pending_effects(base, checkpoint, "room")
            .map(|e| e.len())
    });
    let hit_ms = ms(at);
    let stats = replicas.stats();
    let (_, dropped) = held(|| replicas.drop_room("room"));
    json!({
        "effects": effects.map_err(|e| e.to_string()),
        "missMs": round(first_ms),
        "hitMs": round(hit_ms),
        "openHeldBytes": opened.bytes,
        "hitHeldBytes": again.bytes,
        "replicaBytes": -dropped.bytes,
        "estimatedBytes": stats.replica_bytes,
    })
}

fn run(format: &str, path: &str, edits: usize, checkpoints: &[usize]) -> Value {
    let base = std::fs::read(path).unwrap();
    let service_format = match format {
        "docx" => office_service::Format::Docx,
        "pptx" => office_service::Format::Pptx,
        "xlsx" => office_service::Format::Xlsx,
        other => panic!("unknown format {other}"),
    };
    let at = Instant::now();
    let seed = office_service::seed(service_format, &base).unwrap();
    let seed_ms = ms(at);
    let updates: Updates = Arc::default();
    let at = Instant::now();
    let (mut client, mix): (Box<dyn Client>, Mix) = match format {
        "docx" => (
            Box::new(DocxClient::open(&base, &seed, updates.clone())),
            DOCX_MIX,
        ),
        "pptx" => (
            Box::new(PptxClient::open(&base, &seed, updates.clone())),
            PPTX_MIX,
        ),
        _ => (
            Box::new(XlsxClient::open(&base, &seed, updates.clone())),
            XLSX_MIX,
        ),
    };
    let client_open_ms = ms(at);
    updates.lock().unwrap().clear();
    let mut room = Room::open(seed.clone());
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut kinds: BTreeMap<&str, KindStats> = BTreeMap::new();
    let mut out_checkpoints = Vec::new();
    let mut wire = (0u64, 0u64);
    let mut done = 0usize;
    let mut attempts = 0usize;
    let checkpoint = |room: &mut Room, done: usize, wire: (u64, u64), edit_ms: f64| -> Value {
        if done > 0 {
            room.save();
        }
        let at = Instant::now();
        let state = room.encode();
        let first_encode = ms(at);
        let encode_ms = median(
            (0..5)
                .map(|_| {
                    let at = Instant::now();
                    drop(room.encode());
                    ms(at)
                })
                .collect(),
        );
        let replica = (format == "xlsx").then(|| xlsx_replica(&base, &state));
        let live = json!({
            "heldBytes": room.held.bytes,
            "heldBlocks": room.held.blocks,
            "structs": blocks(&room.doc),
            "stateBytes": state.len(),
            "encodeMs": round(encode_ms),
            "firstEncodeMs": round(first_encode),
        });
        let log = json!({ "rows": room.log.len(), "bytes": room.log_bytes });
        let saves = json!({
            "count": room.saves,
            "rowMsMedian": round(median(room.row_ms.clone())),
            "encodeMsMedian": round(median(room.encode_ms.clone())),
            "encodeMsMax": round(room.encode_ms.iter().copied().fold(0.0, f64::max)),
            "folds": room.folds.len(),
        });
        let fold = (done > 0).then(|| room.fold());
        let reload = room.reload();
        json!({
            "edits": done,
            "editMs": round(edit_ms),
            "updates": wire.0,
            "wireBytes": wire.1,
            "room": live,
            "logBeforeFold": log,
            "saves": saves,
            "fold": fold,
            "afterFold": reload,
            "xlsxReplica": replica,
        })
    };
    out_checkpoints.push(checkpoint(&mut room, 0, wire, 0.0));
    let started = Instant::now();
    let mut next = checkpoints
        .iter()
        .copied()
        .filter(|c| *c <= edits)
        .peekable();
    while done < edits {
        attempts += 1;
        assert!(attempts < edits * 20, "too many refused edits");
        let kind = pick(&mut rng, mix);
        let stats = kinds.entry(kind).or_default();
        match client.edit(kind, &mut rng) {
            Ok(()) => stats.done += 1,
            Err(error) => {
                stats.refused += 1;
                let key: String = error.chars().take(60).collect();
                *stats.refusals.entry(key).or_default() += 1;
                updates.lock().unwrap().clear();
                continue;
            }
        }
        let pending: Vec<Vec<u8>> = std::mem::take(&mut *updates.lock().unwrap());
        for update in pending {
            let kept = room.apply(&update);
            stats.updates += 1;
            stats.wire_bytes += update.len() as u64;
            stats.room_bytes += kept.bytes;
            wire.0 += 1;
            wire.1 += update.len() as u64;
        }
        done += 1;
        if next.peek() == Some(&done) {
            next.next();
            let edit_ms = ms(started);
            out_checkpoints.push(checkpoint(&mut room, done, wire, edit_ms));
        } else if done % SAVE_EVERY == 0 {
            room.save();
        }
    }
    let kinds: BTreeMap<&str, Value> = kinds
        .into_iter()
        .map(|(kind, s)| {
            (
                kind,
                json!({
                    "done": s.done,
                    "refused": s.refused,
                    "updates": s.updates,
                    "wireBytes": s.wire_bytes,
                    "roomHeldBytes": s.room_bytes,
                    "refusals": s.refusals,
                }),
            )
        })
        .collect();
    let info = client.info();
    let in_run_folds = room.folds.clone();
    drop(client);
    // The running count against what dropping the room frees.
    let counted = room.held.bytes;
    let Room { doc, durable, .. } = room;
    let ((), freed) = held(|| {
        drop(doc);
        drop(durable);
    });
    json!({
        "format": format,
        "file": path,
        "fileBytes": base.len(),
        "seedBytes": seed.len(),
        "seedMs": round(seed_ms),
        "clientOpenMs": round(client_open_ms),
        "client": info,
        "attempts": attempts,
        "checkpoints": out_checkpoints,
        "inRunFolds": in_run_folds,
        "kinds": kinds,
        "dropCheck": { "countedBytes": counted, "freedBytes": -freed.bytes },
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let format = args.get(1).expect("format").clone();
    let path = args.get(2).expect("file").clone();
    let edits: usize = args.get(3).map_or(10_000, |n| n.parse().unwrap());
    let checkpoints: Vec<usize> = args
        .get(4)
        .map_or("1000,10000", String::as_str)
        .split(',')
        .map(|n| n.parse().unwrap())
        .collect();
    // The engines recurse over document trees (office-service: 8 MiB or more).
    let out = std::thread::Builder::new()
        .stack_size(256 << 20)
        .spawn(move || run(&format, &path, edits, &checkpoints))
        .unwrap()
        .join()
        .unwrap();
    println!("{out}");
}
