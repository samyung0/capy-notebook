//! Pending effects of a source save (sourceDocuments.ts `textEffects`,
//! `trimEffect`, `effectTokens`), and the text an Office edit inserted and
//! deleted (Q405's reindex count). Offsets, cuts and lengths are UTF-16 code
//! units, as the TS measured them and as Go and the browser read them.

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

/// The one contiguous replacement turning `before` into `after`, or none
/// when they are equal (textEffects).
pub fn text_effects(before: &[u16], after: &[u16]) -> Vec<NetEffect> {
    text_effects_with(before, after.len(), |index| after[index], 0, 0)
}

/// [`text_effects`] over `after` read through `at`, with its first `head`
/// and last `tail` units known to equal `before`'s: the scans skip them, so
/// the work is the changed span's, not the text's.
pub(crate) fn text_effects_with(
    before: &[u16],
    after_len: usize,
    at: impl Fn(usize) -> u16,
    head: usize,
    tail: usize,
) -> Vec<NetEffect> {
    let mut prefix = head.min(before.len()).min(after_len);
    while prefix < before.len() && prefix < after_len && before[prefix] == at(prefix) {
        prefix += 1;
    }
    if prefix == before.len() && prefix == after_len {
        return Vec::new();
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
    let removed = string(&before[prefix..end_before]);
    let inserted = string(&(prefix..end_after).map(&at).collect::<Vec<_>>());
    let id = office_service::sha256_hex(
        serde_json::to_string(&(prefix, &removed, &inserted)).unwrap_or_default(),
    );
    let operation = match (removed.is_empty(), inserted.is_empty()) {
        (false, false) => Operation::Replace,
        (false, true) => Operation::Remove,
        (true, _) => Operation::Add,
    };
    vec![NetEffect {
        id,
        kind: EffectKind::Text,
        operation,
        label: format!("Text at UTF-16 offset {prefix}"),
        before: Some(removed),
        after: Some(inserted),
        asset_ref: None,
        image_sha256: None,
    }]
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
        text_effects(&utf16(before), &utf16(after))
    }

    // sourceDocuments.test.ts: text effects retain Unicode, exact line
    // endings, removals and undo cancellation.
    #[test]
    fn text_effects_keep_unicode_line_endings_and_removals() {
        let [emoji] = texts("a\r\n😀z", "a\r\n😁z").try_into().unwrap();
        assert_eq!(emoji.before.as_deref(), Some("😀"));
        assert_eq!(emoji.after.as_deref(), Some("😁"));
        assert_eq!(emoji.label, "Text at UTF-16 offset 3");
        assert_eq!(emoji.operation, Operation::Replace);
        let [removed] = texts("a\r\n", "").try_into().unwrap();
        assert_eq!(
            (
                removed.before.as_deref(),
                removed.after.as_deref(),
                removed.operation
            ),
            (Some("a\r\n"), Some(""), Operation::Remove)
        );
        assert!(texts("same", "same").is_empty());
        let [added] = texts("ab", "aXb").try_into().unwrap();
        assert_eq!(added.operation, Operation::Add);
        // The id hashes JSON.stringify([prefix, removed, inserted]).
        assert_eq!(added.id, office_service::sha256_hex(r#"[1,"","X"]"#));
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
