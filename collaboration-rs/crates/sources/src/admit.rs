//! Per-update admission of a writer's update to a source room, on the room
//! task before the apply: the state byte cap by estimate (persistence.ts
//! `updateFitsRoom`), the Office root rule (officeRoots.ts
//! `officeUpdateViolation`) and the ordering rule (`inspectUpdate`'s unheld).
//! O(update) except the exact measure near the cap.

use std::collections::HashMap;
use std::ops::Range;

use office_service::Format;
use ydoc::Inspection;
use yrs::block::{ItemContent, ItemPtr};
use yrs::branch::{BranchID, BranchPtr};
use yrs::updates::decoder::Decode;
use yrs::{ClientID, Doc, ReadTxn, StateVector, Transact, Update};

use crate::SourceFormat;

const PPTX_META: &str = "pptx:meta";
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
    estimate: &mut u64,
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
/// past it by one exact measure of the room plus the update, which also
/// resets the estimate.
fn fits_room(doc: &Doc, update: &[u8], estimate: &mut u64, cap: u64) -> Result<bool, String> {
    if *estimate + update.len() as u64 <= cap {
        return Ok(true);
    }
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    *estimate = state.len() as u64;
    let candidate = ydoc::scratch_doc();
    let mut txn = candidate.transact_mut();
    for bytes in [&state[..], update] {
        let decoded = Update::decode_v1(bytes).map_err(|error| error.to_string())?;
        txn.apply_update(decoded)
            .map_err(|error| error.to_string())?;
    }
    let measured = txn.encode_state_as_update_v1(&StateVector::default()).len() as u64;
    Ok(measured <= cap)
}

/// Why a client update may not enter an Office room (`Err`), else whether the
/// room cannot integrate it yet (`Ok(unheld)`). Each new struct must sit under
/// one of the engine's document roots, and in PPTX writes and deletions under
/// pptx:meta must stay inside commentFlavor, as the engines require.
pub fn office_update_violation<T: ReadTxn>(
    txn: &T,
    update: &Update,
    format: Format,
) -> Result<bool, String> {
    let Inspection {
        containers, unheld, ..
    } = ydoc::inspect_update(txn, update).map_err(|error| error.to_string())?;
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
        let mut estimate = 0;
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
        let mut estimate = 10;
        assert_eq!(
            admit_update(&room, SourceFormat::Text, &typed, &mut estimate, cap),
            Admission::Accept
        );
        assert_eq!(estimate, 10);
        // An estimate over the cap measures the room (and resets the estimate).
        let mut estimate = cap;
        assert_eq!(
            admit_update(&room, SourceFormat::Text, &typed, &mut estimate, cap),
            Admission::Accept
        );
        let exact = encode(&room, &StateVector::default()).len() as u64;
        assert_eq!(estimate, exact);
        // The exact measure refuses an update that takes the room past the cap.
        let mut estimate = 0;
        assert_eq!(
            fits_room(&room, &typed, &mut estimate, exact + 100),
            Ok(true)
        );
        let mut estimate = exact + 100;
        assert_eq!(
            fits_room(&room, &typed, &mut estimate, exact + 1),
            Ok(false)
        );
        assert_eq!(estimate, exact);
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
        let mut estimate = exact;
        assert_eq!(
            admit_update(&room, SourceFormat::Text, &typed, &mut estimate, exact + 8),
            Admission::Refuse(Refusal::StateBytes)
        );
        let reserve = crate::STATE_WRITE_RESERVE_BYTES;
        let mut estimate = exact;
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
        let mut estimate = exact;
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
