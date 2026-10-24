//! Per-update admission of a writer's update to a source room, on the room
//! task before the apply: the state byte cap by estimate (persistence.ts
//! `updateFitsRoom`), the Office root rule (officeRoots.ts
//! `officeUpdateViolation`), the PPTX speaker notes cap and the ordering rule
//! (`inspectUpdate`'s unheld). O(update) except the exact measure near the
//! cap, which runs at most once per [MEASURE_EVERY] updates or
//! [MEASURE_GROWTH] bytes of estimated growth, with the update's apply
//! work-limited (Epo 2026-10-19).

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::Arc;

use office_service::Format;
use ydoc::{Incoming, Inspection};
use yrs::block::{Item, ItemContent, ItemPtr, UpdateParent};
use yrs::branch::{BranchID, BranchPtr};
use yrs::updates::decoder::Decode;
use yrs::{Any, ClientID, Doc, ID, ReadTxn, StateVector, Transact, Update};

use crate::SourceFormat;

const PPTX_META: &str = "pptx:meta";
/// Speaker notes a person may write on a slide, in Unicode code points (Epo
/// 2026-10-22); the PPTX editor's notes panel stops at the same count.
pub const MAX_SLIDE_NOTES_CHARS: usize = 4000;
/// A slide map's speaker notes: a string, written whole.
const NOTES_KEY: &str = "notes";
/// Updates between two exact measures of a room near its cap: one past the
/// estimate meanwhile is refused by the estimate alone. A measure costs about
/// 13 ms per MB of state in release (0.9 s at 64 MiB), so a writer at the
/// allowance's 200 updates a second costs a room at most one every 5 s.
pub const MEASURE_EVERY: u32 = 1000;
/// Estimated growth since the last exact measure after which the next may
/// run sooner: the update allowance's byte burst, so a large action's pieces
/// over existing content near the cap are measured, not refused by the
/// estimate alone. At the allowance's 2 MiB a second that is one measure per
/// 4 s per writer at most.
pub const MEASURE_GROWTH: u64 = 8 << 20;

/// A source room's running state size: the bytes of the state and of each
/// update applied since it was last measured, the bytes that measure found,
/// and the updates left before the next exact measure may run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Estimate {
    pub bytes: u64,
    pub measured: u64,
    pub until_measure: u32,
}

impl Estimate {
    pub fn new(bytes: u64) -> Self {
        Estimate {
            bytes,
            measured: bytes,
            until_measure: 0,
        }
    }

    /// An applied update of `bytes` whose deletes freed `freed` payload bytes
    /// (`ydoc::apply_freeing`, Epo 2026-10-19): overwrites, deletes and
    /// replaced pictures do not drift the estimate toward refusals, and it
    /// stays an upper bound of the state.
    pub fn applied(&mut self, bytes: u64, freed: u64) {
        self.bytes = (self.bytes + bytes).saturating_sub(freed);
    }
}
/// The one pptx:meta key a remote update may write (comment flavour).
const PPTX_WRITABLE_META_KEY: &str = "commentFlavor";

/// Why a writer's update may not enter a source room.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `Source checkpoint exceeds byte limit` (incident `over_limit/source_state_bytes`).
    StateBytes,
    /// `officeUpdateViolation`'s message (incident `save_refused/office_update`).
    OfficeUpdate(String),
    /// Not a Yjs update: the connection closes, no incident (the TS threw from
    /// the decode).
    Malformed(String),
}

impl Refusal {
    pub fn message(&self) -> &str {
        match self {
            Refusal::StateBytes => "Source checkpoint exceeds byte limit",
            Refusal::OfficeUpdate(message) | Refusal::Malformed(message) => message,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Admission {
    Accept,
    /// The room cannot place it yet: the server drops it and resyncs.
    Unheld,
    Refuse(Refusal),
}

/// Admits a writer's update to a source room under its `cap`
/// ([`crate::state_cap`]) less the write reserve ([`crate::admission_cap`]).
/// `estimate` is the room's running state size: the server adds each applied
/// update's bytes (the load's included); crossing the limit measures exactly
/// and resets it.
pub fn admit_update(
    doc: &Doc,
    format: SourceFormat,
    update: &[u8],
    estimate: &mut Estimate,
    cap: u64,
) -> Admission {
    let decoded = match Update::decode_v1(update) {
        Ok(decoded) => decoded,
        Err(error) => {
            return Admission::Refuse(Refusal::Malformed(format!("malformed yjs update: {error}")));
        }
    };
    match fits_room(doc, update, estimate, crate::admission_cap(cap)) {
        Ok(true) => {}
        Ok(false) => return Admission::Refuse(Refusal::StateBytes),
        Err(error) => return Admission::Refuse(Refusal::Malformed(error)),
    }
    let txn = doc.transact();
    let office = match format {
        SourceFormat::Docx => Some(Format::Docx),
        SourceFormat::Xlsx => Some(Format::Xlsx),
        SourceFormat::Pptx => Some(Format::Pptx),
        SourceFormat::Text => None,
    };
    let unheld = match office {
        Some(format) => match office_update_violation(&txn, &decoded, format) {
            Err(message) => return Admission::Refuse(Refusal::OfficeUpdate(message)),
            Ok(unheld) => unheld,
        },
        None => match ydoc::inspect_update(&txn, &decoded) {
            Ok(inspection) => inspection.unheld,
            Err(error) => return Admission::Refuse(Refusal::Malformed(error.to_string())),
        },
    };
    if unheld {
        Admission::Unheld
    } else {
        Admission::Accept
    }
}

/// Whether the update keeps the room within the cap: by the estimate, and
/// past it by one exact measure of the room plus the update (at most once
/// per [MEASURE_EVERY] updates, or once the estimate grew [MEASURE_GROWTH]
/// since the last), which also resets the estimate. The update's apply to
/// the measured copy is limited to `ydoc::MAX_WORK` steps.
fn fits_room(doc: &Doc, update: &[u8], estimate: &mut Estimate, cap: u64) -> Result<bool, String> {
    estimate.until_measure = estimate.until_measure.saturating_sub(1);
    if estimate.bytes + update.len() as u64 <= cap {
        return Ok(true);
    }
    if estimate.until_measure > 0 && estimate.bytes < estimate.measured + MEASURE_GROWTH {
        return Ok(false);
    }
    estimate.until_measure = MEASURE_EVERY;
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    estimate.bytes = state.len() as u64;
    estimate.measured = estimate.bytes;
    let candidate = ydoc::scratch_doc();
    let decoded = Update::decode_v1(&state).map_err(|error| error.to_string())?;
    candidate
        .transact_mut()
        .apply_update(decoded)
        .map_err(|error| error.to_string())?;
    let mut txn = candidate.transact_mut();
    txn.limit_work(ydoc::MAX_WORK);
    let decoded = Update::decode_v1(update).map_err(|error| error.to_string())?;
    let costly = || {
        format!(
            "update would take yrs more than {} steps to place",
            ydoc::MAX_WORK
        )
    };
    match txn.apply_update(decoded) {
        Ok(()) => {}
        Err(yrs::error::UpdateError::WorkBudgetExceeded(_)) => return Err(costly()),
        Err(error) => return Err(error.to_string()),
    }
    if txn.work() > ydoc::MAX_WORK {
        return Err(costly());
    }
    let measured = txn.encode_state_as_update_v1(&StateVector::default()).len() as u64;
    Ok(measured <= cap)
}

/// Why a client update may not enter an Office room (`Err`), else whether the
/// room cannot integrate it yet (`Ok(unheld)`). Each new struct must sit under
/// one of the engine's document roots, in PPTX writes and deletions under
/// pptx:meta must stay inside commentFlavor, as the engines require, no
/// slide's speaker notes may grow past [MAX_SLIDE_NOTES_CHARS], and a picture
/// added in Word or PowerPoint keeps the image limits ([crate::pictures]).
pub fn office_update_violation<T: ReadTxn>(
    txn: &T,
    update: &Update,
    format: Format,
) -> Result<bool, String> {
    let incoming = Incoming::new(update);
    let Inspection {
        containers, unheld, ..
    } = ydoc::inspect(txn, &incoming).map_err(|error| error.to_string())?;
    let roots = office_service::document_roots(format);
    for found in &containers {
        if !roots.contains(&&*found.root) {
            return Err(format!(
                "Office update writes outside the {} document roots ({})",
                format.as_str(),
                found.root
            ));
        }
        if format == Format::Pptx
            && &*found.root == PPTX_META
            && found.key.as_deref() != Some(PPTX_WRITABLE_META_KEY)
        {
            return Err("Office update writes pptx:meta beyond commentFlavor".into());
        }
    }
    // An unheld update is dropped, and its references may not resolve yet.
    if format == Format::Pptx && !unheld {
        notes_violation(txn, &incoming)?;
    }
    if matches!(format, Format::Docx | Format::Pptx) && !unheld {
        crate::pictures::picture_violation(txn, &incoming)?;
    }
    let deletes = deletions(update);
    if format != Format::Pptx || deletes.is_empty() {
        return Ok(unheld);
    }
    let Some(meta) = BranchID::get_root(txn, PPTX_META) else {
        return Ok(unheld);
    };
    for (key, item) in meta.map_items() {
        if &**key != PPTX_WRITABLE_META_KEY && touched(item, &deletes) {
            return Err("Office update deletes pptx:meta beyond commentFlavor".into());
        }
    }
    Ok(unheld)
}

/// Refuses a PPTX update that leaves a slide's speaker notes longer than
/// [MAX_SLIDE_NOTES_CHARS] and longer than before it (Epo 2026-10-22). Reads
/// only the update's new entries over the cap in bytes that it does not delete
/// itself, each placed as yrs places it ([slot_of]): one at a nested map's
/// `notes` key (only slides have one) is held to the value that map has now,
/// or to none for a map the update creates. One that loses to a concurrent
/// write is held too: only a client past the notes panel's cap writes one.
fn notes_violation<T: ReadTxn>(txn: &T, incoming: &Incoming) -> Result<(), String> {
    // Built for an update with a long string only; most carry none.
    let mut state = None;
    let mut slots = HashMap::new();
    for item in incoming.items() {
        let Some(text) = entry_text(item.content()) else {
            continue;
        };
        // A string's bytes bound its code points.
        if text.len() <= MAX_SLIDE_NOTES_CHARS {
            continue;
        }
        let state = state.get_or_insert_with(|| txn.state_vector());
        let ID { client, clock } = *item.id();
        let end = clock + item.len();
        if end <= state.get(&client) || incoming.deletes(&client, clock, end) {
            continue;
        }
        let chars = text.chars().count();
        if chars <= MAX_SLIDE_NOTES_CHARS {
            continue;
        }
        let slot = slot_of(txn, state, incoming, item, &mut slots);
        if slot.key.as_deref() != Some(NOTES_KEY) {
            continue;
        }
        let before = match slot.parent {
            Parent::Held(map) if map.item().is_some() => map
                .entry_item(NOTES_KEY)
                .filter(|value| !value.is_deleted())
                .and_then(|value| entry_text(value.content()).map(|text| text.chars().count()))
                .unwrap_or(0),
            Parent::New => 0,
            _ => continue,
        };
        if chars > before {
            return Err(format!(
                "Office update grows a slide's speaker notes past {MAX_SLIDE_NOTES_CHARS} characters"
            ));
        }
    }
    Ok(())
}

/// Where yrs places a decoded entry: the type it lands in and its key.
#[derive(Clone)]
struct Slot {
    parent: Parent,
    key: Option<Arc<str>>,
}

/// The type a decoded entry lands in.
#[derive(Clone, Copy)]
enum Parent {
    /// One the room holds: a root or a nested map.
    Held(BranchPtr),
    /// One the update creates.
    New,
    /// A root the entry names.
    Root,
    /// None: yrs drops the entry.
    Dropped,
}

/// [Slot] of a decoded entry as yrs integrates it. Its left is its origin,
/// or the last unit the room holds of its client when the room holds its
/// first units (`BlockSet::exclude` splits those off), and its right is its
/// right origin; a side reads as absent when the room collected it, or when it
/// is an update entry with no type to land in (a type the update creates is
/// taken as placed). Its type is the one it names, else its left's, else its
/// right's (`Update::missing_dependency`); its key is its left's, else its
/// right's, else its own (`TransactionMut::integrate_item`). The update's
/// entries it refers to are placed first, each once (`slots`), without
/// recursion; a reference cycle (an unheld update, never checked) reads as
/// absent.
fn slot_of<T: ReadTxn>(
    txn: &T,
    state: &StateVector,
    incoming: &Incoming,
    start: &Item,
    slots: &mut HashMap<ID, Slot>,
) -> Slot {
    let held = |id: &ID| id.clock < state.get(&id.client);
    let store = txn.store();
    let sides = |item: &Item| {
        let ID { client, clock } = *item.id();
        let first = state.get(&client);
        let left = if clock < first {
            Some(ID::new(client, first - 1))
        } else {
            item.origin().copied()
        };
        [left, item.right_origin().copied()]
    };
    let mut visiting = HashSet::new();
    let mut stack = vec![start];
    while let Some(&item) = stack.last() {
        if slots.contains_key(item.id()) {
            stack.pop();
            continue;
        }
        let refs = sides(item);
        let waiting: Vec<&Item> = refs
            .iter()
            .flatten()
            .filter(|side| !held(side))
            .filter_map(|side| incoming.item_at(side))
            .filter(|side| !slots.contains_key(side.id()) && !visiting.contains(side.id()))
            .collect();
        if visiting.insert(*item.id()) && !waiting.is_empty() {
            stack.extend(waiting);
            continue;
        }
        let [left, right] = refs.map(|side| {
            let side = side?;
            if held(&side) {
                let entry = store.get_item(&side)?;
                return Some(Slot {
                    parent: entry.parent_branch().map_or(Parent::Dropped, Parent::Held),
                    key: entry.parent_sub().cloned(),
                });
            }
            let slot = slots.get(incoming.item_at(&side)?.id())?;
            (!matches!(slot.parent, Parent::Dropped)).then(|| slot.clone())
        });
        let parent = match item.update_parent() {
            UpdateParent::Root(_) => Parent::Root,
            UpdateParent::Item(holder) if held(holder) => {
                match store.get_item(holder).as_deref().map(Item::content) {
                    Some(ItemContent::Type(map)) => Parent::Held(BranchPtr::from(map.as_ref())),
                    _ => Parent::Dropped,
                }
            }
            UpdateParent::Item(_) => Parent::New,
            _ => left
                .as_ref()
                .or(right.as_ref())
                .map_or(Parent::Dropped, |side| side.parent),
        };
        let key = [&left, &right]
            .into_iter()
            .flatten()
            .find_map(|side| side.key.clone())
            .or_else(|| item.parent_sub().cloned());
        slots.insert(*item.id(), Slot { parent, key });
        stack.pop();
    }
    slots[start.id()].clone()
}

/// The string a map entry's content reads as (`ItemContent::get_last`),
/// without copying it.
fn entry_text(content: &ItemContent) -> Option<&str> {
    match content {
        ItemContent::Any(values) => match values.last()? {
            Any::String(text) => Some(text.as_ref()),
            _ => None,
        },
        ItemContent::Embed(Any::String(text)) => Some(text.as_ref()),
        ItemContent::JSON(values) => values.last().map(String::as_str),
        ItemContent::String(text) => Some(text.as_str()),
        _ => None,
    }
}

fn deletions(update: &Update) -> HashMap<ClientID, Vec<Range<u32>>> {
    update
        .delete_set()
        .iter()
        .map(|(client, ranges)| (*client, ranges.iter().cloned().collect()))
        .collect()
}

fn touched(item: ItemPtr, deletes: &HashMap<ClientID, Vec<Range<u32>>>) -> bool {
    if item.is_deleted() {
        return false;
    }
    let id = item.id();
    let hit = deletes.get(&id.client).is_some_and(|ranges| {
        ranges
            .iter()
            .any(|range| range.start < id.clock + item.len() && id.clock < range.end)
    });
    hit || matches!(item.content(), ItemContent::Type(branch) if touches(BranchPtr::from(branch.as_ref()), deletes))
}

fn touches(branch: BranchPtr, deletes: &HashMap<ClientID, Vec<Range<u32>>>) -> bool {
    if branch.map_items().any(|(_, item)| touched(item, deletes)) {
        return true;
    }
    let mut next = branch.start();
    while let Some(item) = next {
        if touched(item, deletes) {
            return true;
        }
        next = item.right();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_SOURCE_STATE_BYTES;
    use yrs::{Map, MapPrelim, Text};

    fn encode(doc: &Doc, since: &StateVector) -> Vec<u8> {
        doc.transact().encode_state_as_update_v1(since)
    }

    fn apply(doc: &Doc, update: &[u8]) {
        doc.transact_mut()
            .apply_update(Update::decode_v1(update).unwrap())
            .unwrap();
    }

    /// The client's change made by `edit`, as an update over its prior state.
    fn delta(client: &Doc, edit: impl FnOnce()) -> Vec<u8> {
        let before = client.transact().state_vector();
        edit();
        encode(client, &before)
    }

    fn verdict(room: &Doc, format: SourceFormat, update: &[u8]) -> Admission {
        let mut estimate = Estimate::default();
        admit_update(
            room,
            format,
            update,
            &mut estimate,
            MAX_SOURCE_STATE_BYTES as u64,
        )
    }

    // officeRoots.test.ts: an update the room cannot integrate in order is unheld.
    #[test]
    fn an_update_the_room_cannot_integrate_in_order_is_unheld() {
        let room = Doc::with_client_id(1);
        let stories = room.get_or_insert_text("stories");
        stories.insert(&mut room.transact_mut(), 0, "hello");
        let client = Doc::with_client_id(2);
        let text = client.get_or_insert_text("stories");
        apply(&client, &encode(&room, &StateVector::default()));
        let typed = delta(&client, || {
            text.insert(&mut client.transact_mut(), 5, " world")
        });
        let docx = SourceFormat::Docx;
        let ahead = delta(&client, || text.insert(&mut client.transact_mut(), 0, ">"));
        assert_eq!(verdict(&room, docx, &ahead), Admission::Unheld);
        let deleted = delta(&client, || {
            text.remove_range(&mut client.transact_mut(), 6, 2)
        });
        assert_eq!(verdict(&room, docx, &deleted), Admission::Unheld);
        apply(&room, &typed);
        let behind = delta(&client, || text.insert(&mut client.transact_mut(), 0, "<"));
        assert_eq!(verdict(&room, docx, &behind), Admission::Unheld);
        let held = room.transact().state_vector();
        apply(&room, &encode(&client, &held));
        let placed = delta(&client, || text.insert(&mut client.transact_mut(), 0, "!"));
        assert_eq!(verdict(&room, docx, &placed), Admission::Accept);
    }

    // A text update that skips its client's clocks is unheld.
    #[test]
    fn a_text_update_that_skips_its_clocks_is_unheld() {
        let room = Doc::with_client_id(1);
        let source = room.get_or_insert_text("source");
        source.insert(&mut room.transact_mut(), 0, "hello");
        let client = Doc::with_client_id(2);
        let text = client.get_or_insert_text("source");
        apply(&client, &encode(&room, &StateVector::default()));
        text.insert(&mut client.transact_mut(), 5, "!");
        let skipped = delta(&client, || text.insert(&mut client.transact_mut(), 0, ">"));
        assert_eq!(
            verdict(&room, SourceFormat::Text, &skipped),
            Admission::Unheld
        );
        let whole = encode(&client, &room.transact().state_vector());
        assert_eq!(
            verdict(&room, SourceFormat::Text, &whole),
            Admission::Accept
        );
        apply(&room, &whole);
        // Text rooms have no root rule.
        let other = delta(&client, || {
            client
                .get_or_insert_map("elsewhere")
                .insert(&mut client.transact_mut(), "k", "v");
        });
        assert_eq!(
            verdict(&room, SourceFormat::Text, &other),
            Admission::Accept
        );
    }

    #[test]
    fn office_writes_stay_inside_the_engine_roots() {
        let room = Doc::with_client_id(1);
        room.get_or_insert_map("pptx:meta")
            .insert(&mut room.transact_mut(), "schemaVersion", 3);
        room.get_or_insert_map("pptx:meta").insert(
            &mut room.transact_mut(),
            PPTX_WRITABLE_META_KEY,
            "modern",
        );
        let pptx = SourceFormat::Pptx;
        // Each case from a fresh client: a client's update carries its whole
        // delete set, so an earlier refused deletion would ride along.
        let case = |client_id: u64, edit: &dyn Fn(&Doc)| {
            let client = Doc::with_client_id(client_id);
            apply(&client, &encode(&room, &StateVector::default()));
            delta(&client, || edit(&client))
        };
        let meta = |client: &Doc| client.get_or_insert_map("pptx:meta");

        let flavour = case(2, &|client| {
            meta(client).insert(&mut client.transact_mut(), PPTX_WRITABLE_META_KEY, "legacy");
        });
        assert_eq!(verdict(&room, pptx, &flavour), Admission::Accept);
        let schema = case(3, &|client| {
            meta(client).insert(&mut client.transact_mut(), "schemaVersion", 4);
        });
        assert_eq!(
            verdict(&room, pptx, &schema),
            Admission::Refuse(Refusal::OfficeUpdate(
                "Office update writes pptx:meta beyond commentFlavor".into()
            ))
        );
        let removed = case(4, &|client| {
            meta(client).remove(&mut client.transact_mut(), "schemaVersion");
        });
        assert_eq!(
            verdict(&room, pptx, &removed),
            Admission::Refuse(Refusal::OfficeUpdate(
                "Office update deletes pptx:meta beyond commentFlavor".into()
            ))
        );
        let stray = case(5, &|client| {
            client
                .get_or_insert_map("stray")
                .insert(&mut client.transact_mut(), "k", "v");
        });
        assert_eq!(
            verdict(&room, pptx, &stray),
            Admission::Refuse(Refusal::OfficeUpdate(
                "Office update writes outside the pptx document roots (stray)".into()
            ))
        );
        // A nested write names its top-level root through its holder.
        let slides = case(6, &|client| {
            let slides = client.get_or_insert_map("pptx:slides");
            let slide = slides.insert(&mut client.transact_mut(), "s1", MapPrelim::default());
            slide.insert(&mut client.transact_mut(), "title", "T");
        });
        assert_eq!(verdict(&room, pptx, &slides), Admission::Accept);
        apply(&room, &slides);
        let nested = case(7, &|client| {
            let slides = client.get_or_insert_map("pptx:slides");
            let slide = slides.get(&client.transact(), "s1");
            let Some(yrs::Out::YMap(slide)) = slide else {
                panic!("slide");
            };
            slide.insert(&mut client.transact_mut(), "body", "B");
        });
        assert_eq!(verdict(&room, pptx, &nested), Admission::Accept);
        assert_eq!(
            verdict(&room, SourceFormat::Docx, &nested),
            Admission::Refuse(Refusal::OfficeUpdate(
                "Office update writes outside the docx document roots (pptx:slides)".into()
            ))
        );
        assert!(matches!(
            verdict(&room, pptx, b"\xff\xff"),
            Admission::Refuse(Refusal::Malformed(_))
        ));
    }

    // Security regression (Epo 2026-10-24, Q287): whatever client sends it, a
    // picture a Word or PowerPoint edit adds is refused past 2,400 px on its
    // long side, read from its header, or as EMF or WMF.
    #[test]
    fn a_picture_past_the_image_limits_is_refused_in_word_and_powerpoint() {
        use base64::Engine;
        let png = |width: u32| {
            let mut out = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
            out.extend(width.to_be_bytes());
            out.extend(10u32.to_be_bytes());
            out.extend([8, 2, 0, 0, 0, 0, 0, 0, 0]);
            out
        };
        let room = Doc::with_client_id(1);
        let refused = Admission::Refuse(Refusal::OfficeUpdate(
            "Office update adds a picture over 2 MiB or 2400 px".into(),
        ));
        let docx = |client_id: u64, bytes: Vec<u8>| {
            let client = Doc::with_client_id(client_id);
            delta(&client, || {
                let src = format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                );
                let image = yrs::Any::from(std::collections::HashMap::from([
                    ("type".to_owned(), yrs::Any::from("image")),
                    ("src".to_owned(), yrs::Any::from(src)),
                ]));
                client.get_or_insert_text("stories").insert_embed(
                    &mut client.transact_mut(),
                    0,
                    image,
                );
            })
        };
        let pptx = |client_id: u64, bytes: Vec<u8>| {
            let client = Doc::with_client_id(client_id);
            delta(&client, || {
                let slides = client.get_or_insert_map("pptx:slides");
                let shape = slides.insert(&mut client.transact_mut(), "s1", MapPrelim::default());
                shape.insert(
                    &mut client.transact_mut(),
                    "pendingMedia",
                    yrs::Any::Buffer(bytes.into()),
                );
            })
        };
        assert_eq!(
            verdict(&room, SourceFormat::Docx, &docx(2, png(2400))),
            Admission::Accept
        );
        assert_eq!(
            verdict(&room, SourceFormat::Docx, &docx(3, png(2401))),
            refused
        );
        assert_eq!(
            verdict(&room, SourceFormat::Pptx, &pptx(4, png(2400))),
            Admission::Accept
        );
        assert_eq!(
            verdict(&room, SourceFormat::Pptx, &pptx(5, png(2401))),
            refused
        );
        assert_eq!(
            verdict(
                &room,
                SourceFormat::Pptx,
                &pptx(6, vec![0xd7, 0xcd, 0xc6, 0x9a, 0, 0])
            ),
            Admission::Refuse(Refusal::OfficeUpdate(
                "Office update adds an EMF or WMF picture".into()
            ))
        );
    }

    // Security regression (Epo 2026-10-22): whatever client writes it, an
    // update may not grow a slide's speaker notes past 4,000 code points,
    // while an over-cap note may shrink and other slides stay editable.
    #[test]
    fn a_slides_speaker_notes_may_not_grow_past_the_cap() {
        let room = Doc::with_client_id(1);
        let slides = room.get_or_insert_map("pptx:slides");
        for (id, notes) in [("s1", "short".to_string()), ("s2", "o".repeat(5000))] {
            let slide = slides.insert(&mut room.transact_mut(), id, MapPrelim::default());
            slide.insert(&mut room.transact_mut(), NOTES_KEY, notes);
        }
        let set = |client: &Doc, slide: &str, notes: &str| {
            let slides = client.get_or_insert_map("pptx:slides");
            let Some(yrs::Out::YMap(slide)) = slides.get(&client.transact(), slide) else {
                panic!("slide");
            };
            slide.insert(&mut client.transact_mut(), NOTES_KEY, notes);
        };
        // Each case from a fresh client that keeps what it deletes, so an
        // overwritten value rides along in the update as written.
        let case = |client_id: u64, edit: &dyn Fn(&Doc)| {
            let mut options = yrs::Options::with_client_id(ClientID::new(client_id));
            options.skip_gc = true;
            let client = Doc::with_options(options);
            apply(&client, &encode(&room, &StateVector::default()));
            delta(&client, || edit(&client))
        };
        let pptx = SourceFormat::Pptx;
        let refused = Admission::Refuse(Refusal::OfficeUpdate(
            "Office update grows a slide's speaker notes past 4000 characters".into(),
        ));
        let n = |count: usize| "n".repeat(count);

        assert_eq!(
            verdict(&room, pptx, &case(2, &|c| set(c, "s1", &n(4000)))),
            Admission::Accept
        );
        assert_eq!(
            verdict(&room, pptx, &case(3, &|c| set(c, "s1", &n(4001)))),
            refused
        );
        // Code points, not bytes or UTF-16 units.
        let faces = |count: usize| "😀".repeat(count);
        assert_eq!(
            verdict(&room, pptx, &case(4, &|c| set(c, "s1", &faces(4000)))),
            Admission::Accept
        );
        assert_eq!(
            verdict(&room, pptx, &case(5, &|c| set(c, "s1", &faces(4001)))),
            refused
        );
        // An over-cap note may shrink or keep its length, not grow.
        assert_eq!(
            verdict(&room, pptx, &case(6, &|c| set(c, "s2", &n(4999)))),
            Admission::Accept
        );
        assert_eq!(
            verdict(&room, pptx, &case(7, &|c| set(c, "s2", &n(5000)))),
            Admission::Accept
        );
        assert_eq!(
            verdict(&room, pptx, &case(8, &|c| set(c, "s2", &n(5001)))),
            refused
        );
        // Another slide stays editable beside it.
        assert_eq!(
            verdict(&room, pptx, &case(9, &|c| set(c, "s1", "edited"))),
            Admission::Accept
        );
        // A slide the update creates starts from no notes.
        let created = case(10, &|c| {
            let slides = c.get_or_insert_map("pptx:slides");
            let slide = slides.insert(&mut c.transact_mut(), "s3", MapPrelim::default());
            slide.insert(&mut c.transact_mut(), NOTES_KEY, n(4001));
        });
        assert_eq!(verdict(&room, pptx, &created), refused);
        // Two writes in one update: a long one it deletes itself does not
        // count, and a long one it keeps is placed through its origin, the
        // first write, in the update.
        let cut_back = case(11, &|c| {
            set(c, "s1", &n(4001));
            set(c, "s1", "back");
        });
        assert_eq!(verdict(&room, pptx, &cut_back), Admission::Accept);
        let grown = case(12, &|c| {
            set(c, "s1", "first");
            set(c, "s1", &n(4001));
        });
        assert_eq!(verdict(&room, pptx, &grown), refused);
        // Other keys are not notes.
        let named = case(13, &|c| {
            let slides = c.get_or_insert_map("pptx:slides");
            let Some(yrs::Out::YMap(slide)) = slides.get(&c.transact(), "s1") else {
                panic!("slide");
            };
            slide.insert(&mut c.transact_mut(), "name", n(4001));
        });
        assert_eq!(verdict(&room, pptx, &named), Admission::Accept);
    }

    /// One client's string entries as Yjs v1 writes them, from `clock`, with
    /// no deletions. Each is `(origin, right origin, holder, key, values)`: an
    /// entry with neither origin names its map by the item holding it and, in
    /// a map, its key.
    #[allow(clippy::type_complexity)]
    fn crafted(
        client: u64,
        clock: u32,
        entries: &[(Option<ID>, Option<ID>, ID, Option<&str>, &[&str])],
    ) -> Vec<u8> {
        use yrs::block::{BLOCK_ITEM_ANY_REF_NUMBER, HAS_ORIGIN, HAS_PARENT_SUB, HAS_RIGHT_ORIGIN};
        use yrs::encoding::write::Write;
        let mut bytes: Vec<u8> = Vec::new();
        bytes.write_var(1u32);
        bytes.write_var(entries.len() as u32);
        bytes.write_var(client);
        bytes.write_var(clock);
        for &(origin, right, holder, key, values) in entries {
            let named = origin.is_none() && right.is_none();
            let mut info = BLOCK_ITEM_ANY_REF_NUMBER;
            info |= if origin.is_some() { HAS_ORIGIN } else { 0 };
            info |= if right.is_some() { HAS_RIGHT_ORIGIN } else { 0 };
            info |= if named && key.is_some() {
                HAS_PARENT_SUB
            } else {
                0
            };
            bytes.write_u8(info);
            for id in [origin, right].into_iter().flatten() {
                bytes.write_var(id.client.get());
                bytes.write_var(id.clock);
            }
            if named {
                bytes.write_var(0u32);
                bytes.write_var(holder.client.get());
                bytes.write_var(holder.clock);
                if let Some(key) = key {
                    bytes.write_string(key);
                }
            }
            bytes.write_var(values.len() as u32);
            for value in values {
                Any::from(*value).encode(&mut bytes);
            }
        }
        bytes.write_var(0u32);
        bytes
    }

    /// A room with slides s1 (notes "short") and s2 (notes "other").
    fn two_slides() -> Doc {
        let room = Doc::with_client_id(1);
        let slides = room.get_or_insert_map("pptx:slides");
        for (id, notes) in [("s1", "short"), ("s2", "other")] {
            let slide = slides.insert(&mut room.transact_mut(), id, MapPrelim::default());
            slide.insert(&mut room.transact_mut(), NOTES_KEY, notes);
        }
        room
    }

    fn slide(doc: &Doc, id: &str) -> yrs::MapRef {
        let slides = doc.get_or_insert_map("pptx:slides");
        let Some(yrs::Out::YMap(slide)) = slides.get(&doc.transact(), id) else {
            panic!("slide");
        };
        slide
    }

    fn slide_holder(doc: &Doc, id: &str) -> ID {
        *BranchPtr::from(slide(doc, id).as_ref())
            .item()
            .unwrap()
            .id()
    }

    /// The item holding a slide's notes value.
    fn notes_entry(doc: &Doc, id: &str) -> ID {
        *BranchPtr::from(slide(doc, id).as_ref())
            .entry_item(NOTES_KEY)
            .unwrap()
            .id()
    }

    /// The code points slide s1's notes would hold with `update` applied (to
    /// a copy of the room).
    fn s1_notes_after(room: &Doc, update: &[u8]) -> usize {
        let copy = Doc::with_client_id(99);
        apply(&copy, &encode(room, &StateVector::default()));
        apply(&copy, update);
        match slide(&copy, "s1").get(&copy.transact(), NOTES_KEY) {
            Some(yrs::Out::Any(Any::String(text))) => text.chars().count(),
            other => panic!("notes {other:?}"),
        }
    }

    fn notes_refused() -> Admission {
        Admission::Refuse(Refusal::OfficeUpdate(
            "Office update grows a slide's speaker notes past 4000 characters".into(),
        ))
    }

    // Security regression (Epo 2026-10-22, notes-cap review H1 a): an entry
    // after a keyless entry in slide 1's map and before slide 2's notes lands
    // at slide 1's notes (yrs takes the map from the left, the key from the
    // right), so it is held to the cap there.
    #[test]
    fn an_entry_after_a_keyless_one_is_held_to_its_right_origins_key() {
        let room = two_slides();
        let s1 = slide_holder(&room, "s1");
        let s2_notes = *BranchPtr::from(slide(&room, "s2").as_ref())
            .entry_item(NOTES_KEY)
            .unwrap()
            .id();
        let long = "n".repeat(4001);
        let keyless = ID::new(ClientID::new(50), 0);
        let update = crafted(
            50,
            0,
            &[
                (None, None, s1, None, &["L"]),
                (Some(keyless), Some(s2_notes), s1, None, &[long.as_str()]),
            ],
        );
        assert_eq!(s1_notes_after(&room, &update), 4001);
        assert_eq!(verdict(&room, SourceFormat::Pptx, &update), notes_refused());
    }

    // Security regression (Epo 2026-10-22, notes-cap review H1 b): an entry
    // re-sent from a clock the room holds, naming another key, lands after
    // the held unit at its key, slide 1's notes, so it is held to the cap
    // there.
    #[test]
    fn a_resent_entry_is_held_to_its_held_units_key() {
        let room = two_slides();
        let client = Doc::with_client_id(60);
        apply(&client, &encode(&room, &StateVector::default()));
        let short = delta(&client, || {
            slide(&client, "s1").insert(&mut client.transact_mut(), NOTES_KEY, "x");
        });
        assert_eq!(
            verdict(&room, SourceFormat::Pptx, &short),
            Admission::Accept
        );
        apply(&room, &short);
        let long = "n".repeat(4001);
        let s1 = slide_holder(&room, "s1");
        let update = crafted(
            60,
            0,
            &[(None, None, s1, Some("zzz"), &["x", long.as_str()])],
        );
        assert_eq!(s1_notes_after(&room, &update), 4001);
        assert_eq!(verdict(&room, SourceFormat::Pptx, &update), notes_refused());
    }

    // Security regression (Epo 2026-10-22, notes-cap review r2 L1): with no
    // left, or a left the room collected, an entry takes its map and key from
    // its right origin. yrs places it before that map's value, so it never
    // shows, but it is held to the cap there all the same.
    #[test]
    fn an_entry_with_no_left_takes_its_map_and_key_from_its_right_origin() {
        let room = two_slides();
        let slides = room.get_or_insert_map("pptx:slides");
        let s3 = slides.insert(&mut room.transact_mut(), "s3", MapPrelim::default());
        s3.insert(&mut room.transact_mut(), NOTES_KEY, "gone");
        let collected = notes_entry(&room, "s3");
        slides.remove(&mut room.transact_mut(), "s3");
        assert!(room.transact().store().get_item(&collected).is_none());
        let (s1, s1_notes) = (slide_holder(&room, "s1"), notes_entry(&room, "s1"));
        let long = "n".repeat(4001);
        for (client, left) in [(50, None), (51, Some(collected))] {
            let update = crafted(
                client,
                0,
                &[(left, Some(s1_notes), s1, None, &[long.as_str()])],
            );
            assert_eq!(s1_notes_after(&room, &update), "short".len());
            assert_eq!(verdict(&room, SourceFormat::Pptx, &update), notes_refused());
        }
    }

    // Security regression (Epo 2026-10-22, notes-cap review r2 L1): an entry
    // re-sent from a held unit in slide 2's notes, naming slide 1, lands in
    // slide 1's map as its notes (yrs deletes slide 2's value), so it is held
    // to slide 1's notes, not to slide 2's over-cap upload.
    #[test]
    fn an_entry_naming_its_map_is_held_there_not_at_its_lefts() {
        let room = two_slides();
        let client = Doc::with_client_id(60);
        apply(&client, &encode(&room, &StateVector::default()));
        let upload = delta(&client, || {
            slide(&client, "s2").insert(&mut client.transact_mut(), NOTES_KEY, "o".repeat(5000));
        });
        apply(&room, &upload);
        let long = "n".repeat(4001);
        let s1 = slide_holder(&room, "s1");
        let update = crafted(
            60,
            0,
            &[(None, None, s1, Some("zzz"), &["o", long.as_str()])],
        );
        assert_eq!(s1_notes_after(&room, &update), 4001);
        assert_eq!(verdict(&room, SourceFormat::Pptx, &update), notes_refused());
    }

    // Security regression (Epo 2026-10-22, notes-cap review r2 L1): a chain
    // of the update's own entries carries the key: a keyless entry in slide
    // 1's map, one after it before slide 2's notes (slide 1's notes, as shape
    // a), then the long one after that, which becomes slide 1's notes.
    #[test]
    fn a_chain_of_the_updates_entries_carries_the_key() {
        let room = two_slides();
        let s1 = slide_holder(&room, "s1");
        let s2_notes = notes_entry(&room, "s2");
        let keyless = ID::new(ClientID::new(50), 0);
        let first = ID::new(ClientID::new(50), 1);
        let long = "n".repeat(4001);
        let update = crafted(
            50,
            0,
            &[
                (None, None, s1, None, &["L"]),
                (Some(keyless), Some(s2_notes), s1, None, &["first"]),
                (Some(first), None, s1, None, &[long.as_str()]),
            ],
        );
        assert_eq!(s1_notes_after(&room, &update), 4001);
        assert_eq!(verdict(&room, SourceFormat::Pptx, &update), notes_refused());
    }

    #[test]
    fn the_byte_cap_measures_exactly_only_past_the_estimate() {
        let cap = MAX_SOURCE_STATE_BYTES as u64;
        let room = Doc::with_client_id(1);
        let text = room.get_or_insert_text("source");
        text.insert(&mut room.transact_mut(), 0, "hello");
        let client = Doc::with_client_id(2);
        apply(&client, &encode(&room, &StateVector::default()));
        let typed = delta(&client, || {
            client
                .get_or_insert_text("source")
                .insert(&mut client.transact_mut(), 0, "x")
        });
        let mut estimate = Estimate::new(10);
        assert_eq!(
            admit_update(&room, SourceFormat::Text, &typed, &mut estimate, cap),
            Admission::Accept
        );
        assert_eq!(estimate.bytes, 10);
        // An estimate over the cap measures the room (and resets the estimate).
        let mut estimate = Estimate::new(cap);
        assert_eq!(
            admit_update(&room, SourceFormat::Text, &typed, &mut estimate, cap),
            Admission::Accept
        );
        let exact = encode(&room, &StateVector::default()).len() as u64;
        assert_eq!(estimate.bytes, exact);
        // The exact measure refuses an update that takes the room past the cap.
        let mut estimate = Estimate::default();
        assert_eq!(
            fits_room(&room, &typed, &mut estimate, exact + 100),
            Ok(true)
        );
        let mut estimate = Estimate::new(exact + 100);
        assert_eq!(
            fits_room(&room, &typed, &mut estimate, exact + 1),
            Ok(false)
        );
        assert_eq!(estimate.bytes, exact);
    }

    /// Near the cap the exact measure runs once per MEASURE_EVERY updates;
    /// an update past the estimate meanwhile is refused by the estimate.
    #[test]
    fn the_exact_measure_runs_once_per_measure_every_updates() {
        let room = Doc::with_client_id(1);
        let text = room.get_or_insert_text("source");
        text.insert(&mut room.transact_mut(), 0, "hello");
        let client = Doc::with_client_id(2);
        apply(&client, &encode(&room, &StateVector::default()));
        let typed = delta(&client, || {
            client
                .get_or_insert_text("source")
                .insert(&mut client.transact_mut(), 0, "x")
        });
        let exact = encode(&room, &StateVector::default()).len() as u64;
        let cap = exact + 100;
        let mut estimate = Estimate::new(cap);
        assert_eq!(fits_room(&room, &typed, &mut estimate, cap), Ok(true));
        assert_eq!(estimate.bytes, exact);
        // Past the estimate again before MEASURE_EVERY updates: refused.
        estimate.bytes = cap;
        for _ in 1..MEASURE_EVERY {
            assert_eq!(fits_room(&room, &typed, &mut estimate, cap), Ok(false));
            assert_eq!(estimate.bytes, cap);
        }
        assert_eq!(fits_room(&room, &typed, &mut estimate, cap), Ok(true));
        assert_eq!(estimate.bytes, exact);
    }

    /// Rate-limit review r3 S4: an estimate grown by MEASURE_GROWTH since the
    /// last measure (a large action's pieces over existing content) measures
    /// again at once instead of refusing until MEASURE_EVERY updates went.
    #[test]
    fn the_exact_measure_also_runs_after_large_estimated_growth() {
        let room = Doc::with_client_id(1);
        let text = room.get_or_insert_text("source");
        text.insert(&mut room.transact_mut(), 0, "hello");
        let client = Doc::with_client_id(2);
        apply(&client, &encode(&room, &StateVector::default()));
        let typed = delta(&client, || {
            client
                .get_or_insert_text("source")
                .insert(&mut client.transact_mut(), 0, "x")
        });
        let exact = encode(&room, &StateVector::default()).len() as u64;
        let cap = MEASURE_GROWTH;
        let mut estimate = Estimate::new(cap);
        assert_eq!(fits_room(&room, &typed, &mut estimate, cap), Ok(true));
        assert_eq!(estimate.bytes, exact);
        // Pieces applied since: just under the growth, still refused.
        estimate.bytes = exact + MEASURE_GROWTH - 1;
        assert_eq!(fits_room(&room, &typed, &mut estimate, cap), Ok(false));
        // At the growth, measured again within MEASURE_EVERY updates.
        estimate.bytes = exact + MEASURE_GROWTH;
        assert_eq!(fits_room(&room, &typed, &mut estimate, cap), Ok(true));
        assert_eq!(estimate.bytes, exact);
    }

    /// A room and a client synced with it, each with its own client id.
    fn synced_pair() -> (Doc, Doc) {
        let room = Doc::with_options(ydoc::doc_options(1));
        let client = Doc::with_options(ydoc::doc_options(2));
        room.get_or_insert_text("source")
            .insert(&mut room.transact_mut(), 0, "hello");
        apply(&client, &encode(&room, &StateVector::default()));
        (room, client)
    }

    /// Admits `update` by the estimate alone (no exact measure within the
    /// window), applies it to the room, and updates the estimate with what
    /// it freed; the estimate stays an upper bound of the room's state.
    fn admit_and_apply(
        room: &Doc,
        update: &[u8],
        estimate: &mut Estimate,
        cap: u64,
        seed: Option<&StateVector>,
    ) -> Option<u64> {
        if fits_room(room, update, estimate, cap) != Ok(true) {
            return None;
        }
        let (content, freed) =
            ydoc::apply_freeing(room, Update::decode_v1(update).unwrap(), seed).unwrap();
        estimate.applied(content.len() as u64, freed);
        let state = encode(room, &StateVector::default()).len() as u64;
        assert!(estimate.bytes >= state, "{} < {state}", estimate.bytes);
        Some(freed)
    }

    /// Epo 2026-10-19: what an update's deletes free comes off the
    /// estimate, so a picture swapped twice near the cap (insert, replace,
    /// replace) goes in within one measure window. Fails when the estimate
    /// only grows (the third picture is refused).
    #[test]
    fn a_picture_swapped_twice_near_the_cap_fits_the_estimate() {
        let (room, client) = synced_pair();
        let pictures = client.get_or_insert_map("pictures");
        let exact = encode(&room, &StateVector::default()).len() as u64;
        let cap = exact + 1_000_000;
        let mut estimate = Estimate::new(exact);
        estimate.until_measure = MEASURE_EVERY;
        for byte in [1u8, 2, 3] {
            let swap = delta(&client, || {
                pictures.insert(&mut client.transact_mut(), "picture", vec![byte; 400_000]);
            });
            let freed = admit_and_apply(&room, &swap, &mut estimate, cap, None);
            assert!(freed.is_some(), "picture {byte} refused");
        }
    }

    /// An Office room's seed content deleted frees nothing (the stored
    /// change only marks it): the estimate does not drop, so content that
    /// would cross the cap is still refused by it. Fails when seed deletes
    /// count.
    #[test]
    fn deleting_seed_content_does_not_lower_the_estimate() {
        let room = Doc::with_options(ydoc::doc_options(1));
        room.get_or_insert_text("source")
            .insert(&mut room.transact_mut(), 0, &"s".repeat(300_000));
        let seed = room.transact().state_vector();
        let client = Doc::with_options(ydoc::doc_options(2));
        apply(&client, &encode(&room, &StateVector::default()));
        let source = client.get_or_insert_text("source");
        let exact = encode(&room, &StateVector::default()).len() as u64;
        let cap = exact + 400_000;
        let mut estimate = Estimate::new(exact);
        estimate.until_measure = MEASURE_EVERY;
        let cleared = delta(&client, || {
            source.remove_range(&mut client.transact_mut(), 0, 300_000)
        });
        let freed = admit_and_apply(&room, &cleared, &mut estimate, cap, Some(&seed));
        assert_eq!(freed, Some(0));
        let typed = delta(&client, || {
            source.insert(&mut client.transact_mut(), 0, &"t".repeat(400_000))
        });
        assert_eq!(fits_room(&room, &typed, &mut estimate, cap), Ok(false));
    }

    /// Text typed and then deleted takes its bytes off the estimate; text an
    /// update types and deletes itself was never added, so it frees nothing.
    #[test]
    fn text_typed_then_deleted_lowers_the_estimate_by_its_bytes() {
        let (room, client) = synced_pair();
        let source = client.get_or_insert_text("source");
        let cap = u64::MAX;
        let mut estimate = Estimate::new(encode(&room, &StateVector::default()).len() as u64);
        let text = "typed ".repeat(2_000);
        let typed = delta(&client, || {
            source.insert(&mut client.transact_mut(), 5, &text)
        });
        assert_eq!(
            admit_and_apply(&room, &typed, &mut estimate, cap, None),
            Some(0)
        );
        let before = estimate.bytes;
        let deleted = delta(&client, || {
            source.remove_range(&mut client.transact_mut(), 5, text.len() as u32)
        });
        let freed = admit_and_apply(&room, &deleted, &mut estimate, cap, None);
        assert_eq!(freed, Some(text.len() as u64));
        assert!(before - estimate.bytes + 64 >= text.len() as u64);
        // A merged pair (as drafts merge): the insert and its delete arrive
        // in one update.
        let inserted = delta(&client, || {
            source.insert(&mut client.transact_mut(), 0, "gone")
        });
        let removed = delta(&client, || {
            source.remove_range(&mut client.transact_mut(), 0, 4)
        });
        let own = yrs::merge_updates_v1([inserted.as_slice(), removed.as_slice()]).unwrap();
        assert_eq!(
            admit_and_apply(&room, &own, &mut estimate, cap, None),
            Some(0)
        );
    }

    /// A deleted item the commit does not collect (a document keeping its
    /// deleted content) frees nothing.
    #[test]
    fn content_the_commit_keeps_frees_nothing() {
        let mut options = ydoc::doc_options(1);
        options.skip_gc = true;
        let room = Doc::with_options(options);
        room.get_or_insert_text("source")
            .insert(&mut room.transact_mut(), 0, "kept content");
        let client = Doc::with_options(ydoc::doc_options(2));
        apply(&client, &encode(&room, &StateVector::default()));
        let deleted = delta(&client, || {
            client
                .get_or_insert_text("source")
                .remove_range(&mut client.transact_mut(), 0, 4)
        });
        let (_, freed) =
            ydoc::apply_freeing(&room, Update::decode_v1(&deleted).unwrap(), None).unwrap();
        assert_eq!(freed, 0);
    }

    /// The exact measure applies the update to a copy within ydoc::MAX_WORK
    /// steps: a costlier one is refused instead of placed.
    #[test]
    fn the_exact_measure_limits_the_updates_work() {
        use yrs::encoding::write::Write;
        // 1,500 characters each typed at the start, then deleted, and an
        // update of as many items with only a right origin, each a tombstone
        // from the last back: yrs scans from the start to each right origin,
        // 1,500 * 1,499 / 2 steps, past the budget.
        let tombstones = 1_500u32;
        let room = Doc::with_client_id(1);
        let text = room.get_or_insert_text("source");
        for _ in 0..tombstones {
            text.insert(&mut room.transact_mut(), 0, "t");
        }
        text.remove_range(&mut room.transact_mut(), 0, tombstones);
        let mut ids = Vec::new();
        {
            let _txn = room.transact();
            let branch: &yrs::branch::Branch = text.as_ref();
            let mut next = branch.start();
            while let Some(item) = next {
                ids.push(*item.id());
                next = item.right();
            }
        }
        let mut bytes: Vec<u8> = Vec::new();
        bytes.write_var(1u32);
        bytes.write_var(tombstones);
        bytes.write_var(1_000u64);
        bytes.write_var(0u32);
        for right in ids.iter().rev() {
            bytes.write_u8(0x40 | 4); // a right origin, a string
            bytes.write_var(right.client.get());
            bytes.write_var(right.clock);
            bytes.write_string("x");
        }
        bytes.write_var(0u32);
        let cap = MAX_SOURCE_STATE_BYTES as u64;
        let mut estimate = Estimate::new(cap);
        let measured = fits_room(&room, &bytes, &mut estimate, cap);
        assert!(
            measured
                .as_ref()
                .is_err_and(|error| error.contains("steps to place")),
            "{measured:?}"
        );
    }

    /// The room's own cap refuses, not only the ceiling every room shares.
    #[test]
    fn an_update_past_the_rooms_cap_is_refused() {
        let room = Doc::with_client_id(1);
        let text = room.get_or_insert_text("source");
        text.insert(&mut room.transact_mut(), 0, "hello");
        let client = Doc::with_client_id(2);
        apply(&client, &encode(&room, &StateVector::default()));
        let typed = delta(&client, || {
            client.get_or_insert_text("source").insert(
                &mut client.transact_mut(),
                0,
                &"x".repeat(64),
            )
        });
        let exact = encode(&room, &StateVector::default()).len() as u64;
        let mut estimate = Estimate::new(exact);
        assert_eq!(
            admit_update(&room, SourceFormat::Text, &typed, &mut estimate, exact + 8),
            Admission::Refuse(Refusal::StateBytes)
        );
        let reserve = crate::STATE_WRITE_RESERVE_BYTES;
        let mut estimate = Estimate::new(exact);
        assert_eq!(
            admit_update(
                &room,
                SourceFormat::Text,
                &typed,
                &mut estimate,
                exact + 1024 + reserve
            ),
            Admission::Accept
        );
        // Under the cap but into the reserve the room's own writes need
        // (Epo 2026-10-17): refused, so the save's exact check holds.
        let mut estimate = Estimate::new(exact);
        assert_eq!(
            admit_update(
                &room,
                SourceFormat::Text,
                &typed,
                &mut estimate,
                exact + 1024
            ),
            Admission::Refuse(Refusal::StateBytes)
        );
    }
}
