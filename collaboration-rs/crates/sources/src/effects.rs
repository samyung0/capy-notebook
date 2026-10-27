//! Pending effects of a source save (sourceDocuments.ts `textEffects`,
//! `trimEffect`, `effectTokens`), and the text an Office edit inserted and
//! deleted (Q405's reindex count). Offsets, cuts and lengths are UTF-16 code
//! units, as the TS measured them and as Go and the browser read them.

use std::ops::Range;

use office_service::{EffectKind, NetEffect, Operation};
use unicode_script::{Script, UnicodeScript};
use yrs::block::{Item, ItemContent};
use yrs::{Any, BranchID, ReadTxn, TransactionMut};

/// Context kept on each side of an Office text change; '…' marks a cut.
pub const EFFECT_CONTEXT_CHARS: usize = 40;

pub fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// Slices are cut on code point boundaries, so this never loses a unit.
fn string(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn low_surrogate(unit: Option<&u16>) -> bool {
    unit.is_some_and(|unit| (0xDC00..=0xDFFF).contains(unit))
}

/// A text file's pending effects (Q416, Epo 2026-10-27): the lines that
/// changed between the baseline and the text now, by a diff whose cost grows
/// with the changed lines, not the file. A run of changed lines is one
/// effect, trimmed to its changed span and [`EFFECT_CONTEXT_CHARS`] of
/// context (Office's [`trim_effect`]); past [`LINE_DIFF_CELLS`] the change is
/// one placeholder counting its lines, as a note's heavy line diff is
/// (materialdoc/note_effects.go).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextChange {
    pub effects: Vec<NetEffect>,
    /// [`effect_tokens`] of the effects; a placeholder counts the whole
    /// change, as the reindex threshold measures it.
    pub tokens: u64,
    /// Where the text differs from the baseline: its first differing UTF-16
    /// unit and the units from there that differ (none when equal).
    pub span: Option<(usize, usize)>,
}

/// The diff's bound, notes' `lineDiffCells`: its trace keeps (D + 1)^2
/// cells for D changed lines, so it stops past 511.
pub const LINE_DIFF_CELLS: usize = 1 << 18;

/// The diff's work budget in line comparisons (Q435): repeated short lines
/// let every diagonal run far, so past this the change is the placeholder.
pub const LINE_DIFF_STEPS: usize = 1 << 24;

/// A read's cap on pending changes (Q435): a run of changed lines worth more
/// is the placeholder, so one long line edited in two far places does not
/// store the text between them.
/// IMPORTANT: KEEP IN SYNC WITH READ_PENDING_TOKENS IN pipeline/pipeline/retrieval/pending.py
pub const READ_PENDING_TOKENS: u64 = 16_000;

/// [`TextChange`] from `before` to `after`.
pub fn text_effects(before: &[u16], after: &[u16]) -> TextChange {
    text_effects_with(before, after.len(), |index| after[index], 0, 0)
}

/// [`text_effects`] over `after` read through `at`, with its first `head`
/// and last `tail` units known to equal `before`'s: the scans skip them, so
/// the work is the changed span's (widened to whole lines), not the text's.
pub(crate) fn text_effects_with(
    before: &[u16],
    after_len: usize,
    at: impl Fn(usize) -> u16,
    head: usize,
    tail: usize,
) -> TextChange {
    let mut prefix = head.min(before.len()).min(after_len);
    while prefix < before.len() && prefix < after_len && before[prefix] == at(prefix) {
        prefix += 1;
    }
    if prefix == before.len() && prefix == after_len {
        return TextChange::default();
    }
    if prefix > 0 && low_surrogate(before.get(prefix)) {
        prefix -= 1;
    }
    // The known-equal tail, as far as the scan below would walk it.
    let skip = tail.min(before.len() - prefix).min(after_len - prefix);
    let (mut end_before, mut end_after) = (before.len() - skip, after_len - skip);
    while end_before > prefix && end_after > prefix && before[end_before - 1] == at(end_after - 1) {
        end_before -= 1;
        end_after -= 1;
    }
    if end_before < before.len() && low_surrogate(before.get(end_before)) {
        end_before += 1;
        end_after += 1;
    }
    // The changed span widened to whole lines; past it both texts agree.
    let newline = u16::from(b'\n');
    let from = before[..prefix]
        .iter()
        .rposition(|unit| *unit == newline)
        .map_or(0, |at| at + 1);
    let rest = before[end_before..]
        .iter()
        .position(|unit| *unit == newline)
        .unwrap_or(before.len() - end_before);
    let old = &before[from..end_before + rest];
    let new: Vec<u16> = (from..end_after + rest).map(&at).collect();
    let (a, b) = (lines(old), lines(&new));
    let span = Some((prefix, end_after - prefix));
    // The text's lines now, a final newline ending the last rather than
    // starting another: counted only for a placeholder, O(text).
    let total = || {
        let ends = after_len > 0 && at(after_len - 1) == newline;
        before.iter().filter(|unit| **unit == newline).count() + 1 - a.len() + b.len()
            - usize::from(ends)
    };
    let Some(hunks) = line_hunks(&a, &b) else {
        // A heavy change: its lines counted, its text left out.
        let mut count = TextCount::default();
        count.add_units(&before[prefix..end_before]);
        count.add_units(&new[prefix - from..end_after - from]);
        let (head, tail) = common_ends(&a, &b);
        let changed = (a.len() - head - tail).max(b.len() - head - tail);
        return TextChange {
            effects: vec![placeholder(
                changed,
                total(),
                prefix,
                count.tokens(),
                operation(end_before > prefix, end_after > prefix),
            )],
            tokens: count.tokens(),
            span,
        };
    };
    // Where each line of `b` starts in the text now.
    let mut starts = Vec::with_capacity(b.len() + 1);
    starts.push(from);
    for line in &b {
        starts.push(starts[starts.len() - 1] + line.len() + 1);
    }
    let mut lines_now = None;
    let mut tokens = 0;
    let effects: Vec<NetEffect> = hunks
        .into_iter()
        .map(|(removed, added)| {
            let join = |texts: &[&[u16]]| string(&texts.join(&newline));
            let (gone, came) = (join(&a[removed.clone()]), join(&b[added.clone()]));
            let offset = starts[added.start].min(from + new.len());
            let operation = operation(!removed.is_empty(), !added.is_empty());
            let effect = trim_effect(NetEffect {
                id: office_service::sha256_hex(
                    serde_json::to_string(&(offset, &gone, &came)).unwrap_or_default(),
                ),
                kind: EffectKind::Text,
                operation,
                label: format!("Text at UTF-16 offset {offset}"),
                before: Some(gone),
                after: Some(came),
                asset_ref: None,
                image_sha256: None,
            });
            let weight = effect_tokens(std::slice::from_ref(&effect));
            tokens += weight;
            if weight <= READ_PENDING_TOKENS {
                return effect;
            }
            let changed = removed.len().max(added.len());
            placeholder(
                changed,
                *lines_now.get_or_insert_with(total),
                offset,
                weight,
                operation,
            )
        })
        .collect();
    TextChange {
        effects,
        tokens,
        span,
    }
}

/// A change too heavy to list: `changed of total lines changed`, no text.
/// Its id hashes where it is, its weight and its label, not its text.
fn placeholder(
    changed: usize,
    total: usize,
    offset: usize,
    tokens: u64,
    operation: Operation,
) -> NetEffect {
    let label = format!("{changed} of {total} lines changed");
    NetEffect {
        id: office_service::sha256_hex(
            serde_json::to_string(&(offset, tokens, &label)).unwrap_or_default(),
        ),
        kind: EffectKind::Text,
        operation,
        label,
        before: None,
        after: None,
        asset_ref: None,
        image_sha256: None,
    }
}

fn operation(removed: bool, added: bool) -> Operation {
    match (removed, added) {
        (true, true) => Operation::Replace,
        (true, false) => Operation::Remove,
        (false, _) => Operation::Add,
    }
}

/// The lines of `text`, split at '\n' (a '\r' stays on its line).
fn lines(text: &[u16]) -> Vec<&[u16]> {
    text.split(|unit| *unit == u16::from(b'\n')).collect()
}

/// The runs of lines `a` lost and `b` gained, as (lines of `a`, lines of
/// `b`), in order: Myers' O(ND) diff, so the work grows with the changed
/// lines D. None once its trace would pass [`LINE_DIFF_CELLS`] or its line
/// comparisons [`LINE_DIFF_STEPS`].
fn line_hunks(a: &[&[u16]], b: &[&[u16]]) -> Option<Vec<(Range<usize>, Range<usize>)>> {
    let (head, tail) = common_ends(a, b);
    let (x0, y0) = (head, head);
    let (n, m) = (
        (a.len() - head - tail) as isize,
        (b.len() - head - tail) as isize,
    );
    let limit = (n + m).min(LINE_DIFF_CELLS.isqrt() as isize - 1);
    // v[k + limit + 1]: the furthest x on diagonal k = x - y.
    let at = |k: isize| (k + limit + 1) as usize;
    let mut v = vec![0isize; 2 * limit as usize + 3];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = None;
    let mut steps = 0usize;
    'search: for d in 0..=limit {
        for k in (-d..=d).step_by(2) {
            let mut x = if k == -d || (k != d && v[at(k - 1)] < v[at(k + 1)]) {
                v[at(k + 1)]
            } else {
                v[at(k - 1)] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x0 + x as usize] == b[y0 + y as usize] {
                x += 1;
                y += 1;
                steps += 1;
            }
            steps += 1;
            if steps > LINE_DIFF_STEPS {
                return None;
            }
            v[at(k)] = x;
            if x >= n && y >= m {
                found = Some(d);
                break 'search;
            }
        }
        trace.push(v[at(-d)..=at(d)].to_vec());
    }
    let d = found?;
    // Back from the end: each step's last edit is one line lost or gained.
    let (mut lost, mut gained) = (vec![false; n as usize], vec![false; m as usize]);
    let (mut x, mut y) = (n, m);
    for d in (1..=d).rev() {
        let previous = &trace[d as usize - 1];
        let get = |k: isize| previous[(k + d - 1) as usize];
        let k = x - y;
        let down = k == -d || (k != d && get(k - 1) < get(k + 1));
        let k = if down { k + 1 } else { k - 1 };
        let (px, py) = (get(k), get(k) - k);
        if down {
            gained[py as usize] = true;
        } else {
            lost[px as usize] = true;
        }
        (x, y) = (px, py);
    }
    let mut hunks = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < lost.len() || j < gained.len() {
        let (i0, j0) = (i, j);
        while i < lost.len() && lost[i] {
            i += 1;
        }
        while j < gained.len() && gained[j] {
            j += 1;
        }
        if (i, j) == (i0, j0) {
            (i, j) = (i + 1, j + 1);
        } else {
            hunks.push((x0 + i0..x0 + i, y0 + j0..y0 + j));
        }
    }
    Some(hunks)
}

/// Lengths of the common prefix and the non-overlapping common suffix.
fn common_ends<T: PartialEq>(a: &[T], b: &[T]) -> (usize, usize) {
    let mut prefix = 0;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < a.len() - prefix
        && suffix < b.len() - prefix
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }
    (prefix, suffix)
}

/// An Office text effect reduced to its changed span plus context. A move
/// carries no text at all.
pub fn trim_effect(mut effect: NetEffect) -> NetEffect {
    if effect.operation == Operation::Move {
        effect.before = None;
        effect.after = None;
        return effect;
    }
    let (Some(before), Some(after)) = (&effect.before, &effect.after) else {
        return effect;
    };
    let (before, after) = (utf16(before), utf16(after));
    let (prefix, suffix) = common_ends(&before, &after);
    let cut = |text: &[u16]| {
        let mut from = prefix.saturating_sub(EFFECT_CONTEXT_CHARS);
        let mut to = text.len() - suffix.saturating_sub(EFFECT_CONTEXT_CHARS);
        if from > 0 && low_surrogate(text.get(from)) {
            from -= 1;
        }
        if to < text.len() && low_surrogate(text.get(to)) {
            to += 1;
        }
        format!(
            "{}{}{}",
            if from > 0 { "…" } else { "" },
            string(&text[from..to]),
            if to < text.len() { "…" } else { "" }
        )
    };
    effect.after = Some(cut(&after));
    effect.before = Some(cut(&before));
    effect
}

fn cjk(character: char) -> bool {
    // Nothing in these scripts sits below Hangul Jamo (U+1100), so most text
    // skips the script lookup, which cost ~0.5 s for an 8 MB text effect.
    character >= '\u{1100}'
        && matches!(
            character.script(),
            Script::Han | Script::Hiragana | Script::Katakana | Script::Hangul
        )
}

/// Estimated tokens of a change list: 4 UTF-16 units a token, except changed
/// CJK characters, one each; the shared context counts at the 4-unit rate in
/// every script. A move counts 0; any other non-text effect 1 more.
pub fn effect_tokens(effects: &[NetEffect]) -> u64 {
    effects
        .iter()
        .filter(|effect| effect.operation != Operation::Move)
        .map(|effect| {
            let before: Vec<char> = effect
                .before
                .as_deref()
                .unwrap_or_default()
                .chars()
                .collect();
            let after: Vec<char> = effect
                .after
                .as_deref()
                .unwrap_or_default()
                .chars()
                .collect();
            let (prefix, suffix) = common_ends(&before, &after);
            let changed = before[prefix..before.len() - suffix]
                .iter()
                .chain(&after[prefix..after.len() - suffix])
                .filter(|character| cjk(**character))
                .count() as u64;
            let units = (effect
                .before
                .as_deref()
                .unwrap_or_default()
                .encode_utf16()
                .count()
                + effect
                    .after
                    .as_deref()
                    .unwrap_or_default()
                    .encode_utf16()
                    .count()) as u64;
            (units - changed).div_ceil(4) + changed + u64::from(effect.kind != EffectKind::Text)
        })
        .sum()
}

/// Text an Office edit inserted and deleted: UTF-16 units, but CJK
/// characters, which count one token each.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextCount {
    pub units: u64,
    pub cjk: u64,
}

impl TextCount {
    /// [`effect_tokens`]' rule: 4 UTF-16 units a token, a CJK character one.
    pub fn tokens(self) -> u64 {
        self.units.div_ceil(4) + self.cjk
    }

    /// The characters of UTF-16 `text`.
    fn add_units(&mut self, text: &[u16]) {
        for character in char::decode_utf16(text.iter().copied()) {
            match character {
                Ok(character) if cjk(character) => self.cjk += 1,
                Ok(character) => self.units += character.len_utf16() as u64,
                Err(_) => self.units += 1,
            }
        }
    }

    /// The characters of `text` within UTF-16 units `from..to`.
    fn add(&mut self, text: &str, from: u32, to: u32) {
        let mut at = 0;
        for character in text.chars() {
            if at >= to {
                break;
            }
            if at >= from {
                if cjk(character) {
                    self.cjk += 1;
                } else {
                    self.units += character.len_utf16() as u64;
                }
            }
            at += character.len_utf16() as u32;
        }
    }

    /// An XLSX cell's content (a stable record): its value and formula text.
    fn add_cell(&mut self, value: &Any) {
        let Any::String(json) = value else {
            return;
        };
        let Ok(cell) = serde_json::from_str::<serde_json::Value>(json) else {
            return;
        };
        let value = match &cell["value"]["value"] {
            serde_json::Value::String(text) => text.clone(),
            serde_json::Value::Number(number) => number.to_string(),
            serde_json::Value::Bool(true) => "TRUE".into(),
            serde_json::Value::Bool(false) => "FALSE".into(),
            _ => String::new(),
        };
        let formula = cell["formula"]["text"].as_str().unwrap_or_default();
        for text in [value.as_str(), formula] {
            self.add(text, 0, u32::MAX);
        }
    }
}

/// Whether `item` is an XLSX cell's content: an entry of a sheet's
/// `contents` map under `xlsx:sheets` (its `styles` map is formatting).
fn xlsx_cell(item: &Item) -> bool {
    let Some(contents) = item.parent_branch().and_then(|branch| branch.item()) else {
        return false;
    };
    if contents.parent_sub().map(|key| &**key) != Some("contents") {
        return false;
    }
    contents
        .parent_branch()
        .and_then(|sheet| sheet.item())
        .and_then(|sheet| sheet.parent_branch())
        .is_some_and(
            |sheets| matches!(sheets.id(), BranchID::Root(name) if &*name == "xlsx:sheets"),
        )
}

/// Whether everything `txn` inserted and deleted is a contributor marker
/// (`ydoc::CONTRIBUTORS_ROOT`): a store's marker clear, or a writer's marker
/// written on its own, changes nothing in the document (Q435).
pub fn markers_only(txn: &TransactionMut<'_>) -> bool {
    let store = ReadTxn::store(txn);
    [txn.insert_set(), txn.delete_set()].iter().all(|set| {
        set.iter().all(|(client, ranges)| {
            ranges.iter().all(|range| {
                store.blocks_in(client, range.clone()).all(|(_, item)| {
                    item.and_then(|item| item.parent_branch()).is_some_and(|parent| {
                        matches!(parent.id(), BranchID::Root(name) if &*name == ydoc::CONTRIBUTORS_ROOT)
                    })
                })
            })
        })
    })
}

/// The text `txn` inserted and deleted (Q405, Epo 2026-10-26): Y.Text
/// strings (Word and PowerPoint stories) and XLSX cell contents, gross, so
/// a replacement counts both sides; formatting, attributes and structure
/// count nothing. Read before the commit, while what it deleted still holds
/// its content.
pub fn edited_text(txn: &TransactionMut<'_>) -> TextCount {
    let store = ReadTxn::store(txn);
    let mut count = TextCount::default();
    for set in [txn.insert_set(), txn.delete_set()] {
        for (client, ranges) in set.iter() {
            for range in ranges.iter() {
                for (block, item) in store.blocks_in(client, range.clone()) {
                    let Some(item) = item else { continue };
                    match item.content() {
                        ItemContent::String(text) => {
                            let from = range.start.saturating_sub(block.clock);
                            let to = range.end.min(block.clock + block.len) - block.clock;
                            count.add(text.as_str(), from, to);
                        }
                        ItemContent::Any(values) if xlsx_cell(&item) => {
                            values.iter().for_each(|value| count.add_cell(value));
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effect(before: Option<&str>, after: Option<&str>, operation: Operation) -> NetEffect {
        NetEffect {
            id: "p".into(),
            kind: EffectKind::Text,
            operation,
            label: "Paragraph".into(),
            before: before.map(str::to_owned),
            after: after.map(str::to_owned),
            asset_ref: None,
            image_sha256: None,
        }
    }

    fn texts(before: &str, after: &str) -> Vec<NetEffect> {
        text_effects(&utf16(before), &utf16(after)).effects
    }

    // Text effects are the changed lines, trimmed (Q416), with Unicode and
    // exact line endings; an equal text has none.
    #[test]
    fn text_effects_are_changed_lines_with_unicode_and_line_endings() {
        let [emoji] = texts("a\r\n😀z", "a\r\n😁z").try_into().unwrap();
        assert_eq!(emoji.before.as_deref(), Some("😀z"));
        assert_eq!(emoji.after.as_deref(), Some("😁z"));
        assert_eq!(emoji.label, "Text at UTF-16 offset 3");
        assert_eq!(emoji.operation, Operation::Replace);
        let [removed] = texts("a\r\nb", "b").try_into().unwrap();
        assert_eq!(
            (
                removed.before.as_deref(),
                removed.after.as_deref(),
                removed.operation
            ),
            (Some("a\r"), Some(""), Operation::Remove)
        );
        let [added] = texts("a\nc", "a\nb\nc").try_into().unwrap();
        assert_eq!(
            (
                added.before.as_deref(),
                added.after.as_deref(),
                added.operation
            ),
            (Some(""), Some("b"), Operation::Add)
        );
        assert_eq!(added.label, "Text at UTF-16 offset 2");
        // A long line keeps its change and 40 units of context a side.
        let (head, tail) = ("a".repeat(100), "z".repeat(100));
        let [word] = texts(&format!("{head}old{tail}"), &format!("{head}new{tail}"))
            .try_into()
            .unwrap();
        assert_eq!(
            word.after,
            Some(format!("…{}new{}…", &head[60..], &tail[60..]))
        );
        // The id hashes [offset, lines lost, lines gained].
        assert_eq!(added.id, office_service::sha256_hex(r#"[2,"","b"]"#));
        assert_eq!(
            text_effects(&utf16("same"), &utf16("same")),
            TextChange::default()
        );
    }

    // Q416: two far-apart edits in a large file are two small hunks, not one
    // span over everything between them.
    #[test]
    fn far_apart_edits_are_small_hunks() {
        let base: String = (0..200_000)
            .map(|i| format!("line {i} of the file\n"))
            .collect();
        let edited = base.replacen("line 10 of", "line ten of", 1).replacen(
            "line 199990 of",
            "line END of",
            1,
        );
        let change = text_effects(&utf16(&base), &utf16(&edited));
        let [first, last] = change.effects.clone().try_into().unwrap();
        assert_eq!(
            (first.before.as_deref(), first.after.as_deref()),
            (Some("line 10 of the file"), Some("line ten of the file"))
        );
        assert_eq!(
            (last.before.as_deref(), last.after.as_deref()),
            (
                Some("line 199990 of the file"),
                Some("line END of the file")
            )
        );
        assert!(serde_json::to_string(&change.effects).unwrap().len() < 1000);
        assert_eq!(change.tokens, effect_tokens(&change.effects));
        // The window still spans both: the next save diffs within it.
        let (prefix, inserted) = change.span.unwrap();
        assert_eq!(prefix, base.find("10 of").unwrap());
        assert!(inserted > 4_000_000);
    }

    // Q416: a change past the diff's bound is one placeholder counting its
    // lines, without text, and its tokens are the whole change's; a few
    // changed lines in the same file stay hunks.
    #[test]
    fn heavy_changes_are_a_placeholder() {
        let base: String = (0..2000).map(|i| format!("row {i}\n")).collect();
        let heavy: String = (0..2000).map(|i| format!("ROW {i}\n")).collect();
        let change = text_effects(&utf16(&base), &utf16(&heavy));
        let [placeholder] = change.effects.try_into().unwrap();
        // A final newline ends the last line (Q435).
        assert_eq!(placeholder.label, "2000 of 2000 lines changed");
        assert_eq!((placeholder.before, placeholder.after), (None, None));
        assert_eq!(placeholder.operation, Operation::Replace);
        let mut whole = TextCount::default();
        whole.add_units(&utf16(&base[..base.len() - " 1999\n".len()]));
        whole.add_units(&utf16(&heavy[..heavy.len() - " 1999\n".len()]));
        assert_eq!(change.tokens, whole.tokens());
        let few = base
            .replacen("row 5\n", "ROW 5\n", 1)
            .replacen("row 500\n", "", 1)
            .replacen("row 1500\n", "row 1500\nnew\n", 1);
        let ops: Vec<Operation> = texts(&base, &few).iter().map(|e| e.operation).collect();
        assert_eq!(ops, [Operation::Replace, Operation::Remove, Operation::Add]);
    }

    // Q435: a run of changed lines over the read cap is the placeholder, so
    // one 30 MiB line edited near both ends stores no text between them;
    // its tokens still count the whole run.
    #[test]
    fn a_hunk_over_the_read_cap_is_a_placeholder() {
        let line = "x".repeat(30 << 20);
        let edited = format!("A{}Z", &line[1..line.len() - 1]);
        let change = text_effects(&utf16(&format!("{line}\n")), &utf16(&format!("{edited}\n")));
        let [placeholder] = change.effects.try_into().unwrap();
        assert_eq!(placeholder.label, "1 of 1 lines changed");
        assert_eq!((placeholder.before, placeholder.after), (None, None));
        assert!(change.tokens > READ_PENDING_TOKENS);
    }

    // Q435: alternating short lines let every other diagonal run far, so the
    // work grows with lines times edits; past the budget (about 50M steps here)
    // the change is the placeholder, though its 500 edits are under the cap.
    #[test]
    fn the_line_diff_stops_at_its_work_budget() {
        let base: String = (0..400_000).map(|i| ["a\n", "b\n"][i % 2]).collect();
        let mut edited: Vec<&str> = base.lines().collect();
        for i in 0..250 {
            edited[i * 1600 + 800] = "c";
        }
        let edited = edited.join("\n") + "\n";
        let [placeholder] = texts(&base, &edited).try_into().unwrap();
        // As the cap's placeholder, it counts the window's lines, the first
        // changed line to the last.
        assert_eq!(placeholder.label, "398401 of 400000 lines changed");
    }

    // The cap a hunk is measured against is the pipeline's read cap.
    #[test]
    fn the_read_cap_matches_the_pipeline() {
        let pending = include_str!("../../../../pipeline/pipeline/retrieval/pending.py");
        assert!(
            pending.contains(&format!(
                "READ_PENDING_TOKENS = {}_{:03}\n",
                READ_PENDING_TOKENS / 1000,
                READ_PENDING_TOKENS % 1000
            )),
            "pending.py's READ_PENDING_TOKENS is not {READ_PENDING_TOKENS}"
        );
    }

    // Office text effects keep the changed span with 40 characters of context.
    #[test]
    fn trim_keeps_the_changed_span_with_context() {
        let (head, tail) = ("a".repeat(50), "z".repeat(50));
        let edit = effect(
            Some(&format!("{head}old{tail}")),
            Some(&format!("{head}NEW{tail}")),
            Operation::Replace,
        );
        let trimmed = trim_effect(edit.clone());
        assert_eq!(
            trimmed.after,
            Some(format!("…{}NEW{}…", &head[10..], &tail[10..]))
        );
        assert_eq!(
            trimmed.before,
            Some(format!("…{}old{}…", &head[10..], &tail[10..]))
        );
        // A cut never splits a surrogate pair; an addition is its own change.
        let emoji = "😀".repeat(30);
        let mut paired = edit.clone();
        paired.before = Some(format!("{emoji}ax"));
        paired.after = Some(format!("{emoji}ay"));
        assert_eq!(
            trim_effect(paired).before,
            Some(format!("…{}ax", "😀".repeat(20)))
        );
        let mut leading = edit.clone();
        leading.before = Some(format!("xa{emoji}"));
        leading.after = Some(format!("ya{emoji}"));
        assert_eq!(
            trim_effect(leading).before,
            Some(format!("xa{}…", "😀".repeat(20)))
        );
        let mut added = edit.clone();
        added.before = None;
        added.operation = Operation::Add;
        assert_eq!(trim_effect(added.clone()), added);
        // A move keeps no text and weighs nothing.
        let moved = trim_effect(effect(Some(&head), Some(&head), Operation::Move));
        assert_eq!((moved.before.clone(), moved.after.clone()), (None, None));
        let mut image = moved.clone();
        image.kind = EffectKind::Image;
        assert_eq!(effect_tokens(&[moved, image]), 0);
        // The floor `cjk` checks first.
        assert!((0..0x1100).filter_map(char::from_u32).all(|c| !matches!(
            c.script(),
            Script::Han | Script::Hiragana | Script::Katakana | Script::Hangul
        )));
    }

    // Effect context counts 4 units a token in every script, changed CJK per
    // character.
    #[test]
    fn tokens_count_context_at_four_units_and_changed_cjk_per_character() {
        let edit = |head: &str, tail: &str, from: &str, to: &str| {
            effect(
                Some(&format!("…{head}{from}{tail}…")),
                Some(&format!("…{head}{to}{tail}…")),
                Operation::Replace,
            )
        };
        assert_eq!(
            effect_tokens(&[edit(&"a".repeat(40), &"z".repeat(40), "cat", "dog")]),
            43
        );
        assert_eq!(
            effect_tokens(&[edit(&"漢".repeat(40), &"字".repeat(40), "猫", "犬")]),
            43
        );
        assert_eq!(
            effect_tokens(&[effect(None, Some(&"漢".repeat(500)), Operation::Add)]),
            500
        );
    }
}
