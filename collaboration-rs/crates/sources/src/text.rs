//! Text sources: one `Y.Text` named `source` holding the file's text.

use std::collections::HashMap;
use std::ops::Range;

use office_service::NetEffect;
use yrs::block::ItemContent;
use yrs::branch::{BranchID, BranchPtr};
use yrs::updates::decoder::Decode;
use yrs::{ClientID, Doc, GetString, ID, ReadTxn, Text, Transact, Update, UpdateBlock};

use crate::effects::{TextChange, text_effects, text_effects_with, utf16};

pub const TEXT_ROOT: &str = "source";

/// A working document for text sources under exactly `client_id`, with
/// every room's options (`ydoc::doc_options`): UTF-16 offsets, as the browser
/// and the TS server indexed `Y.Text`, and no formatting cleanup.
pub fn text_doc(client_id: u64) -> Doc {
    let mut options = ydoc::doc_options(0);
    options.client_id = yrs::block::ClientID::new(client_id);
    Doc::with_options(options)
}

/// A text source's bytes as text: newlines and a BOM kept, invalid UTF-8
/// refused (TextDecoder fatal, ignoreBOM).
pub fn decode_text(bytes: &[u8]) -> Result<&str, std::str::Utf8Error> {
    std::str::from_utf8(bytes)
}

/// seed(base) of a text source, written under client 0 so every instance
/// seeds the same lineage for a state that is still NULL (textSeed).
pub fn text_seed(bytes: &[u8]) -> Result<Vec<u8>, std::str::Utf8Error> {
    let text = decode_text(bytes)?;
    let doc = text_doc(0);
    let root = doc.get_or_insert_text(TEXT_ROOT);
    {
        let mut txn = doc.transact_mut();
        root.insert(&mut txn, 0, text);
    }
    Ok(doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default()))
}

/// The text a state holds (textState).
pub fn text_state(state: &[u8]) -> Result<String, yrs::encoding::read::Error> {
    let doc = text_doc(1);
    let root = doc.get_or_insert_text(TEXT_ROOT);
    let update = Update::decode_v1(state)?;
    let mut txn = doc.transact_mut();
    let _ = txn.apply_update(update);
    Ok(root.get_string(&txn))
}

/// Where a text room's pending effect sits, as of its last save: the text
/// matches the baseline outside `[prefix, prefix + inserted)` and is `len`
/// UTF-16 units long. `None` (in [`TextSave`]) means the text equals it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextWindow {
    pub prefix: usize,
    pub inserted: usize,
    pub len: usize,
}

/// A text save's effects and their tokens, the window the next save starts
/// from, and the opening text the file's list card shows (Go writes it to
/// `files.preview`).
#[derive(Clone, Debug, PartialEq)]
pub struct TextSave {
    pub effects: Vec<NetEffect>,
    pub tokens: u64,
    pub window: Option<TextWindow>,
    pub preview: String,
}

impl TextSave {
    fn new(change: TextChange, len: usize, preview: String) -> Self {
        Self {
            effects: change.effects,
            tokens: change.tokens,
            window: change.span.map(|(prefix, inserted)| TextWindow {
                prefix,
                inserted,
                len,
            }),
            preview,
        }
    }
}

/// The text's effects and window against `baseline`, read whole (the load,
/// and the slow paths of a save).
pub fn full_text_effects(text: &str, baseline: &[u16]) -> TextSave {
    let current = utf16(text);
    let mut preview = Preview::default();
    preview.push(text);
    TextSave::new(
        text_effects(baseline, &current),
        current.len(),
        preview.text,
    )
}

/// How many characters of a text source its list card shows.
pub const PREVIEW_CHARS: usize = 600;

/// A text source's opening characters read as ingest reads them
/// (pipeline/ingest/thumbnail.py `_store_text_preview`, a UTF-8-sig
/// text-mode read): a leading BOM dropped, `\r\n` and `\r` read as `\n`,
/// [`PREVIEW_CHARS`] characters, then NUL removed (jsonb holds none). The
/// same text gives ingest's preview and a save's.
#[derive(Default)]
struct Preview {
    text: String,
    read: usize,
    started: bool,
    after_cr: bool,
}

impl Preview {
    /// Reads the next part of the text; false once the preview is full.
    fn push(&mut self, part: &str) -> bool {
        for character in part.chars() {
            if self.read == PREVIEW_CHARS {
                return false;
            }
            let first = !std::mem::replace(&mut self.started, true);
            let after_cr = std::mem::replace(&mut self.after_cr, character == '\r');
            match character {
                '\u{feff}' if first => {}
                '\n' if after_cr => {}
                '\r' => self.read('\n'),
                character => self.read(character),
            }
        }
        self.read < PREVIEW_CHARS
    }

    fn read(&mut self, character: char) {
        self.read += 1;
        if character != '\0' {
            self.text.push(character);
        }
    }
}

/// The preview of a room's text, reading its items from the start only as
/// far as the preview needs: O(preview), not O(text).
fn text_preview(branch: BranchPtr) -> String {
    let mut preview = Preview::default();
    let mut next = branch.start();
    while let Some(item) = next {
        if let ItemContent::String(text) = item.content()
            && !item.is_deleted()
            && !preview.push(text.as_str())
        {
            break;
        }
        next = item.right();
    }
    preview.text
}

/// The UTF-16 span of the items a change touched, and the text's length,
/// counting string content only, as `Y.Text.toString()` reads it.
struct Walk {
    touched: Option<(usize, usize)>,
    len: usize,
}

fn walk_items(branch: BranchPtr, touched: impl Fn(&ID, u32) -> bool) -> Walk {
    let mut index = 0usize;
    let mut span: Option<(usize, usize)> = None;
    let mut next = branch.start();
    while let Some(item) = next {
        // A string item's clock length is its UTF-16 length.
        let live = match item.content() {
            ItemContent::String(_) if !item.is_deleted() => item.len() as usize,
            _ => 0,
        };
        if touched(item.id(), item.len()) {
            let (lo, hi) = span.get_or_insert((index, index + live));
            *lo = (*lo).min(index);
            *hi = (*hi).max(index + live);
        }
        index += live;
        next = item.right();
    }
    Walk {
        touched: span,
        len: index,
    }
}

/// Where UTF-16 offset `units` of `text` falls: the byte index of the code
/// point holding it and the units of that code point before it (1 inside a
/// surrogate pair). An ASCII prefix is skipped at once.
fn utf16_offset(text: &str, units: usize) -> (usize, usize) {
    let bytes = text.as_bytes();
    if bytes.len() >= units && bytes[..units].is_ascii() {
        return (units, 0);
    }
    let mut counted = 0;
    for (at, character) in text.char_indices() {
        let width = character.len_utf16();
        if counted + width > units {
            return (at, units - counted);
        }
        counted += width;
    }
    (bytes.len(), 0)
}

/// UTF-16 units `[from, to)` of the text.
fn text_units(branch: BranchPtr, from: usize, to: usize) -> Vec<u16> {
    let mut out = Vec::with_capacity(to - from);
    let mut index = 0usize;
    let mut next = branch.start();
    while let Some(item) = next {
        if index >= to {
            break;
        }
        if let ItemContent::String(text) = item.content()
            && !item.is_deleted()
        {
            let len = item.len() as usize;
            if index + len > from {
                let skip = from.saturating_sub(index);
                let take = (to - index).min(len) - skip;
                let text = text.as_str();
                let (at, inside) = utf16_offset(text, skip);
                out.extend(text[at..].encode_utf16().skip(inside).take(take));
            }
            index += len;
        }
        next = item.right();
    }
    out
}

/// A text save's effects from the change (#12): `row` (the room's update
/// since its durable state) names the items that changed, which with the
/// previous effect's window bound where the text can differ from `baseline`;
/// only that span is read from the room. Equal to [`full_text_effects`] on
/// the whole text.
pub fn text_effects_from_change<T: ReadTxn>(
    txn: &T,
    row: &Update,
    baseline: &[u16],
    previous: Option<TextWindow>,
) -> TextSave {
    // No `source` type yet: nothing was ever written, the text is empty.
    let Some(branch) = BranchID::get_root(txn, TEXT_ROOT) else {
        return full_text_effects("", baseline);
    };
    let mut ranges: HashMap<ClientID, Vec<Range<u32>>> = HashMap::new();
    for block in row.blocks() {
        let (client, range) = match block {
            UpdateBlock::Item(item) => (
                item.id().client,
                item.id().clock..item.id().clock + item.len(),
            ),
            UpdateBlock::Gc(range) | UpdateBlock::Skip(range) => {
                (range.client, range.clock..range.clock + range.len)
            }
        };
        ranges.entry(client).or_default().push(range);
    }
    for (client, deleted) in row.delete_set().iter() {
        ranges
            .entry(*client)
            .or_default()
            .extend(deleted.iter().cloned());
    }
    for list in ranges.values_mut() {
        list.sort_by_key(|range| range.start);
    }
    let walk = walk_items(branch, |id, len| {
        ranges.get(&id.client).is_some_and(|list| {
            let end = id.clock + len;
            list[..list.partition_point(|range| range.start < end)]
                .iter()
                .any(|range| range.end > id.clock)
        })
    });
    let len = walk.len;
    // Outside this span the text equals the baseline: the change's span,
    // joined with the previous effect's (moved by the change when after it).
    let mut window = walk.touched;
    if let Some(previous) = previous {
        let delta = len as i64 - previous.len as i64;
        let end = previous.prefix + previous.inserted;
        window = Some(match window {
            Some((lo, hi)) => {
                let moved = if end <= lo {
                    end
                } else {
                    (end as i64 + delta).max(0) as usize
                };
                (previous.prefix.min(lo), hi.max(moved))
            }
            None => (previous.prefix, end),
        });
    }
    let preview = text_preview(branch);
    let Some((lo, hi)) = window else {
        return TextSave::new(TextChange::default(), len, preview);
    };
    let lo = lo.min(len);
    let hi = hi.clamp(lo, len);
    let middle = text_units(branch, lo, hi);
    let shift = len as i64 - baseline.len() as i64;
    let at = |index: usize| -> u16 {
        if index < lo {
            baseline[index]
        } else if index < hi {
            middle[index - lo]
        } else {
            baseline[(index as i64 - shift) as usize]
        }
    };
    TextSave::new(
        text_effects_with(baseline, len, at, lo, len - hi),
        len,
        preview,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seed_is_deterministic_and_reads_back() {
        let bytes = "\u{feff}line one\r\nzwei 😀\n".as_bytes();
        let seed = text_seed(bytes).unwrap();
        assert_eq!(seed, text_seed(bytes).unwrap());
        assert_eq!(text_state(&seed).unwrap(), "\u{feff}line one\r\nzwei 😀\n");
        assert!(text_seed(&[0xff, 0xfe, 0x00]).is_err());
    }

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
    }

    const PIECES: [&str; 8] = ["a", "xyz", "😀", "漢字", "\r\n", "", "e\u{301}", "  "];

    /// A UTF-16 offset of `text` that does not split a surrogate pair.
    fn boundary(text: &str, rng: &mut Rng) -> u32 {
        let starts: Vec<u32> = text
            .char_indices()
            .map(|(byte, _)| text[..byte].encode_utf16().count() as u32)
            .chain([text.encode_utf16().count() as u32])
            .collect();
        starts[rng.below(starts.len())]
    }

    fn edit(doc: &Doc, rng: &mut Rng) {
        let text = doc.get_or_insert_text(TEXT_ROOT);
        let current = text.get_string(&doc.transact());
        let at = boundary(&current, rng);
        if rng.below(3) == 0 && !current.is_empty() {
            let end = boundary(&current, rng);
            let (from, to) = (at.min(end), at.max(end));
            text.remove_range(&mut doc.transact_mut(), from, to - from);
        } else {
            let piece = PIECES[rng.below(PIECES.len())].repeat(1 + rng.below(3));
            text.insert(&mut doc.transact_mut(), at, &piece);
        }
    }

    fn sync(from: &Doc, to: &Doc) {
        let vector = to.transact().state_vector();
        let update = from.transact().encode_state_as_update_v1(&vector);
        to.transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
    }

    // The save's text effects and preview from the change equal the
    // whole-text ones, over random edits by two writers, saves in between and
    // edits that undo earlier ones (the effect shrinks back); one base is
    // longer than the preview, with a line break on its cut.
    #[test]
    fn effects_from_the_change_equal_the_whole_text_comparison() {
        for seed in 1..=200u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
            let base = [
                "hello world",
                "",
                "😀 a\r\nb 漢字",
                "line\n".repeat(50).as_str(),
                format!("\u{feff}{}\r\n{}", "x".repeat(597), "ab\r\n".repeat(20)).as_str(),
            ][rng.below(5)]
            .to_owned();
            let baseline = utf16(&base);
            let seed_state = text_seed(base.as_bytes()).unwrap();
            let room = text_doc(1);
            room.transact_mut()
                .apply_update(Update::decode_v1(&seed_state).unwrap())
                .unwrap();
            let writers = [text_doc(2), text_doc(3)];
            for writer in &writers {
                sync(&room, writer);
            }
            let mut durable = room.transact().state_vector();
            let mut window = None;
            for _ in 0..30 {
                let writer = &writers[rng.below(2)];
                sync(&room, writer);
                for _ in 0..1 + rng.below(4) {
                    edit(writer, &mut rng);
                }
                sync(writer, &room);
                if rng.below(2) == 0 {
                    continue;
                }
                // A store: the row is the room's update since its durable state.
                let row = room.transact().encode_state_as_update_v1(&durable);
                let row = Update::decode_v1(&row).unwrap();
                let txn = room.transact();
                let fast = text_effects_from_change(&txn, &row, &baseline, window);
                let text = txn.get_text(TEXT_ROOT).map(|text| text.get_string(&txn));
                let whole = full_text_effects(text.as_deref().unwrap_or_default(), &baseline);
                assert_eq!(fast, whole, "seed {seed}");
                window = fast.window;
                durable = txn.state_vector();
            }
        }
    }

    // Q416: a save whose change undoes the room's earlier edits back to the
    // baseline has no effect and no window, in a large file too.
    #[test]
    fn an_undo_back_to_the_baseline_has_no_effect() {
        let base: String = (0..20_000).map(|i| format!("line {i}\n")).collect();
        let baseline = utf16(&base);
        let room = text_doc(1);
        room.transact_mut()
            .apply_update(Update::decode_v1(&text_seed(base.as_bytes()).unwrap()).unwrap())
            .unwrap();
        let text = room.get_or_insert_text(TEXT_ROOT);
        let save = |durable: &yrs::StateVector, window| {
            let row = room.transact().encode_state_as_update_v1(durable);
            let row = Update::decode_v1(&row).unwrap();
            let txn = room.transact();
            (
                text_effects_from_change(&txn, &row, &baseline, window),
                txn.state_vector(),
            )
        };
        let durable = room.transact().state_vector();
        text.insert(&mut room.transact_mut(), 7, "EDIT ");
        text.insert(&mut room.transact_mut(), 150_000, "FAR ");
        let (edited, durable) = save(&durable, None);
        assert_eq!(edited.effects.len(), 2);
        assert!(edited.window.is_some());
        text.remove_range(&mut room.transact_mut(), 150_000, 4);
        text.remove_range(&mut room.transact_mut(), 7, 5);
        let (undone, _) = save(&durable, edited.window);
        assert_eq!(
            (undone.effects, undone.tokens, undone.window),
            (Vec::new(), 0, None)
        );
    }

    fn preview(text: &str) -> String {
        full_text_effects(text, &[]).preview
    }

    // The values a UTF-8-sig text-mode read of 600 characters with NUL
    // removed gives in Python (ingest's `_store_text_preview`), checked there.
    #[test]
    fn the_preview_reads_the_text_as_ingest_does() {
        assert_eq!(preview("\u{feff}a\r\nb\rc\0d"), "a\nb\ncd");
        assert_eq!(preview("\r\r\n\n"), "\n\n\n");
        assert_eq!(preview("a\u{feff}"), "a\u{feff}");
        assert_eq!(preview("\u{feff}\u{feff}b"), "\u{feff}b");
        assert_eq!(preview(&format!("{}q", "\0".repeat(10))), "q");
        let cut = preview(&format!("{}\r\ny", "x".repeat(599)));
        assert_eq!(cut, format!("{}\n", "x".repeat(599)));
        assert_eq!(
            preview(&format!("{}\r\n", "x".repeat(600))),
            "x".repeat(600)
        );
        assert_eq!(preview(&"é😀".repeat(400)).chars().count(), PREVIEW_CHARS);
        assert_eq!(preview(""), "");
    }
}
