//! Text sources: one `Y.Text` named `source` holding the file's text.

use std::collections::HashMap;
use std::ops::Range;

use office_service::NetEffect;
use yrs::block::ItemContent;
use yrs::branch::{BranchID, BranchPtr};
use yrs::updates::decoder::Decode;
use yrs::{
    ClientID, Doc, GetString, ID, OffsetKind, Options, ReadTxn, Text, Transact, Update, UpdateBlock,
};

use crate::effects::{text_effects, text_effects_with, utf16};

pub const TEXT_ROOT: &str = "source";

/// A working document for text sources: UTF-16 offsets, as the browser and
/// the TS server indexed `Y.Text`.
pub fn text_doc(client_id: u64) -> Doc {
    Doc::with_options(Options {
        client_id: yrs::block::ClientID::new(client_id),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
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

impl TextWindow {
    fn of(effects: &[NetEffect], len: usize) -> Option<Self> {
        let effect = effects.first()?;
        let prefix = effect
            .label
            .strip_prefix("Text at UTF-16 offset ")
            .and_then(|offset| offset.parse().ok())?;
        Some(Self {
            prefix,
            inserted: effect
                .after
                .as_deref()
                .map_or(0, |text| text.encode_utf16().count()),
            len,
        })
    }
}

/// A text save's effects and the window the next save starts from.
#[derive(Clone, Debug, PartialEq)]
pub struct TextSave {
    pub effects: Vec<NetEffect>,
    pub window: Option<TextWindow>,
}

/// The text's effects and window against `baseline`, read whole (the load,
/// and the slow paths of a save).
pub fn full_text_effects(text: &str, baseline: &[u16]) -> TextSave {
    let current = utf16(text);
    let effects = text_effects(baseline, &current);
    let window = TextWindow::of(&effects, current.len());
    TextSave { effects, window }
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
        let live = match item.content() {
            ItemContent::String(text) if !item.is_deleted() => text.utf16_len(),
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
            let len = text.utf16_len();
            if index + len > from {
                let skip = from.saturating_sub(index);
                let take = (to - index).min(len) - skip;
                out.extend(text.as_str().encode_utf16().skip(skip).take(take));
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
    let Some((lo, hi)) = window else {
        return TextSave {
            effects: Vec::new(),
            window: None,
        };
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
    let effects = text_effects_with(baseline, len, at, lo, len - hi);
    let window = TextWindow::of(&effects, len);
    TextSave { effects, window }
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

    // The save's text effects from the change equal the whole-text ones, over
    // random edits by two writers, saves in between and edits that undo
    // earlier ones (the effect shrinks back).
    #[test]
    fn effects_from_the_change_equal_the_whole_text_comparison() {
        for seed in 1..=200u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
            let base = [
                "hello world",
                "",
                "😀 a\r\nb 漢字",
                "line\n".repeat(50).as_str(),
            ][rng.below(4)]
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
}
