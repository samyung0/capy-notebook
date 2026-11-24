use std::sync::Arc;

use yrs::{Doc, GetString, Map, MapPrelim, ReadTxn, StateVector, Text, Transact};

use super::*;

fn doc(client: u64) -> Doc {
    Doc::with_options(doc_options(client))
}

fn sync(from: &Doc, to: &Doc) {
    let sv = to.transact().state_vector();
    let update = from.transact().encode_state_as_update_v1(&sv);
    to.transact_mut()
        .apply_update(decode(&update).unwrap())
        .unwrap();
}

/// What `edit` adds to `client`, as an update since its state before.
fn delta(client: &Doc, edit: impl FnOnce(&mut yrs::TransactionMut)) -> Vec<u8> {
    let before = client.transact().state_vector();
    edit(&mut client.transact_mut());
    client.transact().encode_state_as_update_v1(&before)
}

fn unheld(room: &Doc, update: &[u8]) -> bool {
    inspect_update(&room.transact(), &decode(update).unwrap())
        .unwrap()
        .unheld
}

// officeRoots.test: an update the room cannot integrate in order is unheld.
#[test]
fn an_update_out_of_order_is_unheld() {
    let room = doc(1);
    room.get_or_insert_text("stories")
        .insert(&mut room.transact_mut(), 0, "hello");
    let client = doc(2);
    sync(&room, &client);
    let text = client.get_or_insert_text("stories");
    let typed = delta(&client, |txn| text.insert(txn, 5, " world"));
    // The room never got `typed`: a keystroke elsewhere skips its clocks, and
    // deleting part of it refers to nothing the room holds.
    assert!(unheld(
        &room,
        &delta(&client, |txn| text.insert(txn, 0, ">"))
    ));
    assert!(unheld(
        &room,
        &delta(&client, |txn| text.remove_range(txn, 6, 2))
    ));
    room.transact_mut()
        .apply_update(decode(&typed).unwrap())
        .unwrap();
    // Still behind the '>' and the deletion.
    assert!(unheld(
        &room,
        &delta(&client, |txn| text.insert(txn, 0, "<"))
    ));
    sync(&client, &room);
    let fine = delta(&client, |txn| text.insert(txn, 0, "!"));
    let inspection = inspect_update(&room.transact(), &decode(&fine).unwrap()).unwrap();
    assert!(!inspection.unheld);
    assert_eq!(
        inspection.containers,
        vec![Container {
            root: Arc::from("stories"),
            key: None
        }]
    );
}

// officeRoots.test: a text update that skips its client's clocks is unheld.
#[test]
fn a_text_update_that_skips_clocks_is_unheld() {
    let room = doc(1);
    room.get_or_insert_text("source")
        .insert(&mut room.transact_mut(), 0, "hello");
    let client = doc(2);
    sync(&room, &client);
    let text = client.get_or_insert_text("source");
    text.insert(&mut client.transact_mut(), 5, "!"); // never reached the room
    let vector = client.transact().state_vector();
    text.insert(&mut client.transact_mut(), 0, ">");
    let skipping = client.transact().encode_state_as_update_v1(&vector);
    assert!(unheld(&room, &skipping));
    let whole = client
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    assert!(!unheld(&room, &whole));
}

// Containers resolve through origins, parents and map keys, held or new.
#[test]
fn containers_follow_origins_parents_and_keys() {
    let room = doc(1);
    let meta = room.get_or_insert_map("pptx:meta");
    {
        let mut txn = room.transact_mut();
        meta.insert(&mut txn, "commentFlavor", "a");
        let nested = meta.insert(&mut txn, "slides", MapPrelim::default());
        nested.insert(&mut txn, "one", 1);
    }
    let client = doc(2);
    sync(&room, &client);
    let client_meta = client.get_or_insert_map("pptx:meta");
    let update = delta(&client, |txn| {
        client_meta.insert(txn, "commentFlavor", "b");
        let slides = client_meta
            .get(txn, "slides")
            .unwrap()
            .cast::<yrs::MapRef>()
            .unwrap();
        slides.insert(txn, "two", 2);
        let fresh = client_meta.insert(txn, "fresh", MapPrelim::default());
        fresh.insert(txn, "inner", 3);
    });
    let mut containers = inspect_update(&room.transact(), &decode(&update).unwrap())
        .unwrap()
        .containers;
    containers.sort_by(|a, b| a.key.cmp(&b.key));
    let keys: Vec<_> = containers
        .iter()
        .map(|c| c.key.as_deref().unwrap_or(""))
        .collect();
    assert_eq!(keys, vec!["commentFlavor", "fresh", "fresh", "slides"]);
    assert!(containers.iter().all(|c| &*c.root == "pptx:meta"));
}

// A reference to a garbage-collected struct (its type was deleted) drops the
// struct (gone): no container, not unheld.
#[test]
fn a_struct_in_a_collected_type_is_gone() {
    let room = doc(1);
    let map = room.get_or_insert_map("m");
    {
        let mut txn = room.transact_mut();
        let nested = map.insert(&mut txn, "n", yrs::TextPrelim::new("abc"));
        let _ = nested;
    }
    let client = doc(2);
    sync(&room, &client);
    map.remove(&mut room.transact_mut(), "n");
    let client_text = client
        .get_or_insert_map("m")
        .get(&client.transact(), "n")
        .unwrap()
        .cast::<yrs::TextRef>()
        .unwrap();
    let update = delta(&client, |txn| client_text.insert(txn, 1, "x"));
    let inspection = inspect_update(&room.transact(), &decode(&update).unwrap()).unwrap();
    assert!(!inspection.unheld);
    assert!(inspection.containers.is_empty());
}

/// A room holding `text` in the map entry "n" of root "m", a client synced
/// with it, and that client's nested text.
fn nested(text: &str) -> (Doc, Doc, yrs::TextRef) {
    let room = doc(1);
    room.get_or_insert_map("m")
        .insert(&mut room.transact_mut(), "n", yrs::TextPrelim::new(text));
    let client = doc(2);
    sync(&room, &client);
    let nested = client
        .get_or_insert_map("m")
        .get(&client.transact(), "n")
        .unwrap()
        .cast::<yrs::TextRef>()
        .unwrap();
    (room, client, nested)
}

fn hidden_units(room: &Doc, update: &[u8]) -> u32 {
    inspect_update(&room.transact(), &decode(update).unwrap())
        .unwrap()
        .hidden_units
}

// Hidden typing (Q237): typing into a paragraph the room deleted lands next
// to units the room collected with it, so the room would never show it.
#[test]
fn typing_into_a_deleted_paragraph_is_hidden() {
    let (room, client, nested) = nested("abc");
    room.get_or_insert_map("m")
        .remove(&mut room.transact_mut(), "n");
    let update = delta(&client, |txn| nested.insert(txn, 3, "xy"));
    assert_eq!(hidden_units(&room, &update), 2);
}

// An explicit-parent insert (an empty paragraph has no neighbour) into an
// element the room deleted: its holder is deleted.
#[test]
fn an_insert_whose_parent_the_room_deleted_is_hidden() {
    let (room, client, nested) = nested("");
    room.get_or_insert_map("m")
        .remove(&mut room.transact_mut(), "n");
    let update = delta(&client, |txn| nested.insert(txn, 0, "xyz"));
    assert_eq!(hidden_units(&room, &update), 3);
}

// Typing after a sibling the room deleted shows: the sibling's own
// deletion hides nothing, and neither do attributes or a live paragraph.
#[test]
fn typing_after_a_deleted_sibling_is_not_hidden() {
    let (room, client, nested) = nested("abc");
    let room_nested = room
        .get_or_insert_map("m")
        .get(&room.transact(), "n")
        .unwrap()
        .cast::<yrs::TextRef>()
        .unwrap();
    room_nested.remove_range(&mut room.transact_mut(), 1, 1);
    let update = delta(&client, |txn| nested.insert(txn, 2, "x"));
    assert_eq!(hidden_units(&room, &update), 0);
    let update = delta(&client, |txn| nested.insert(txn, 0, "y"));
    assert_eq!(hidden_units(&room, &update), 0);
}

// yjsUpdateMessage.test: a read-only acknowledgement against client changes.
#[test]
fn an_acknowledgement_is_no_change() {
    let room = doc(1);
    room.get_or_insert_text("content")
        .insert(&mut room.transact_mut(), 0, "durable");
    let client = doc(2);
    sync(&room, &client);
    let room_sv = room.transact().state_vector();
    let ack = client.transact().encode_state_as_update_v1(&room_sv);
    assert!(!contains_changes(&room.transact(), &decode(&ack).unwrap()));
    client
        .get_or_insert_text("content")
        .insert(&mut client.transact_mut(), 7, " change");
    let change = client.transact().encode_state_as_update_v1(&room_sv);
    assert!(contains_changes(
        &room.transact(),
        &decode(&change).unwrap()
    ));
}

// yjsUpdateMessage.test: deletions the room holds against new ones.
#[test]
fn held_deletions_are_no_change() {
    let room = doc(1);
    let text = room.get_or_insert_text("content");
    text.insert(&mut room.transact_mut(), 0, "durable text");
    text.remove_range(&mut room.transact_mut(), 0, 3);
    let client = doc(2);
    sync(&room, &client);
    let vector = room.transact().state_vector();
    let same = client.transact().encode_state_as_update_v1(&vector);
    assert!(!contains_changes(&room.transact(), &decode(&same).unwrap()));
    client
        .get_or_insert_text("content")
        .remove_range(&mut client.transact_mut(), 0, 2);
    let deleting = client.transact().encode_state_as_update_v1(&vector);
    assert!(contains_changes(
        &room.transact(),
        &decode(&deleting).unwrap()
    ));
}

// Delta rows replay to the room exactly, carry only new deletions, and hide
// the given items.
#[test]
fn delta_rows_replay_to_the_room() {
    let room = doc(1);
    let text = room.get_or_insert_text("content");
    let markers = room.get_or_insert_map(CONTRIBUTORS_ROOT);
    text.insert(&mut room.transact_mut(), 0, "hello world");
    text.remove_range(&mut room.transact_mut(), 0, 6);
    let base = room
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let mut durable = Durable::of(&room.transact());

    let mut rows = Vec::new();
    for round in 0..5u32 {
        text.insert(&mut room.transact_mut(), 0, "x");
        text.remove_range(&mut room.transact_mut(), 1, 1);
        markers.insert(&mut room.transact_mut(), "k", round);
        let marker = room
            .transact()
            .store()
            .get_item(&ID::new(
                ClientID::new(1),
                room.transact().state_vector().get(&ClientID::new(1)) - 1,
            ))
            .map(|item| *item.id());
        let (row, next) = delta_update(&room.transact(), &durable, marker.as_slice());
        // Only this round's deletions, not the whole delete set again.
        let decoded = decode(&row).unwrap();
        assert!(!decoded.delete_set().contains(&ID::new(ClientID::new(1), 0)));
        rows.push(row);
        durable = next;
    }
    let replayed = scratch_doc();
    replay(&replayed, &base, &rows).unwrap();
    let text_after = replayed.get_or_insert_text("content");
    assert_eq!(
        text_after.get_string(&replayed.transact()),
        text.get_string(&room.transact())
    );
    // Every marker went into the rows deleted.
    let replayed_markers = replayed.get_or_insert_map(CONTRIBUTORS_ROOT);
    assert_eq!(replayed_markers.len(&replayed.transact()), 0);
}

// A row that refers to content no stored row holds leaves pending content.
#[test]
fn replay_refuses_pending_content() {
    let source = doc(1);
    let text = source.get_or_insert_text("content");
    text.insert(&mut source.transact_mut(), 0, "a");
    let first = source
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    text.insert(&mut source.transact_mut(), 1, "b");
    let sv2 = source.transact().state_vector();
    text.insert(&mut source.transact_mut(), 2, "c");
    let third = source.transact().encode_state_as_update_v1(&sv2);
    let target = scratch_doc();
    assert!(matches!(
        replay(&target, &first, &[third]),
        Err(ReplayError::Pending)
    ));
}

/// A struct referring to its own or a later clock of its client can never
/// integrate (a client integrates in clock order): malformed, not unheld.
#[test]
fn a_reference_forward_in_its_own_client_is_malformed() {
    use yrs::encoding::write::Write;
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "hello");
    // Client 77: struct k takes struct k + 1 as its origin; the last one a
    // character the room holds.
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(3u32);
    bytes.write_var(77u64);
    bytes.write_var(0u32);
    for k in 0..3u32 {
        bytes.write_u8(0x80 | 4);
        if k < 2 {
            bytes.write_var(77u64);
            bytes.write_var(k + 1);
        } else {
            bytes.write_var(1u64);
            bytes.write_var(4u32);
        }
        bytes.write_string("x");
    }
    bytes.write_var(0u32);
    let inspected = inspect_update(&room.transact(), &decode(&bytes).unwrap());
    assert!(
        matches!(inspected, Err(UpdateError::Decode(_))),
        "{inspected:?}"
    );
    // Its own earlier clock is how typing chains: fine.
    let client = doc(2);
    sync(&room, &client);
    let text = client.get_or_insert_text("t");
    let typed = delta(&client, |txn| {
        text.insert(txn, 5, "a");
        text.insert(txn, 6, "b");
    });
    assert!(!unheld(&room, &typed));
}

/// Two sections for one client whose structs overlap (found by the fuzz):
/// yrs would place the struct twice and free the first while the text still
/// links it. Malformed: the patched yrs refuses it at decode, the inspection
/// if it ever decodes.
#[test]
fn overlapping_structs_of_one_client_are_malformed() {
    use yrs::encoding::write::Write;
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "hello");
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(2u32);
    for origin in [1u32, 3] {
        bytes.write_var(1u32);
        bytes.write_var(77u64);
        bytes.write_var(0u32);
        bytes.write_u8(0x80 | 4);
        bytes.write_var(1u64);
        bytes.write_var(origin);
        bytes.write_string("x");
    }
    bytes.write_var(0u32);
    let inspected = decode(&bytes).and_then(|update| inspect_update(&room.transact(), &update));
    assert!(
        matches!(inspected, Err(UpdateError::Decode(_))),
        "{inspected:?}"
    );
}

/// Updates of `count` concurrent writers each typing at the same place of a
/// room's text, merged into one.
fn concurrent_at_one_spot(room: &Doc, first_client: u64, count: u64) -> Vec<u8> {
    let updates: Vec<Vec<u8>> = (0..count)
        .map(|k| {
            let writer = doc(first_client + k);
            sync(room, &writer);
            let text = writer.get_or_insert_text("t");
            delta(&writer, |txn| text.insert(txn, 2, "x"))
        })
        .collect();
    yrs::merge_updates_v1(&updates).unwrap()
}

/// A class of 100 typing their first character into one place at once is
/// one burst, never refused (Epo, 2026-10-08: the per-spot cap is dropped).
#[test]
fn a_classroom_burst_into_one_place_is_taken() {
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "hello");
    let burst = concurrent_at_one_spot(&room, 10, 100);
    let inspected = inspect_update(&room.transact(), &decode(&burst).unwrap()).unwrap();
    assert!(!inspected.unheld);
    let trial = inspected
        .trial
        .expect("a burst of 100 clients is tried on a copy");
    let text = trial.get_or_insert_text("t");
    assert_eq!(text.get_string(&trial.transact()).matches('x').count(), 100);
}

/// A keystroke, or a short run of one client next to what the room holds,
/// applies directly; an edit of many structs, of several clients, or placed
/// where the room holds other items is tried on a copy first.
#[test]
fn only_a_small_edit_skips_the_trial() {
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "hello");
    let tried = |bytes: &[u8]| {
        inspect_update(&room.transact(), &decode(bytes).unwrap())
            .unwrap()
            .trial
            .is_some()
    };
    let writer = doc(2);
    sync(&room, &writer);
    let text = writer.get_or_insert_text("t");
    // One character, then typing, a bold word and a deletion in one update.
    assert!(!tried(&delta(&writer, |txn| text.insert(txn, 2, "x"))));
    let writer = doc(3);
    sync(&room, &writer);
    let text = writer.get_or_insert_text("t");
    assert!(!tried(&delta(&writer, |txn| {
        text.insert(txn, 5, "a");
        text.insert(txn, 6, "b");
        text.insert(txn, 0, "c");
        text.remove_range(txn, 3, 1);
    })));
    // More than SMALL_EDIT structs.
    let writer = doc(4);
    sync(&room, &writer);
    let text = writer.get_or_insert_text("t");
    assert!(tried(&delta(&writer, |txn| {
        for k in 0..=SMALL_EDIT as u32 {
            text.insert(txn, k % 5, "y");
        }
    })));
    // Two clients.
    assert!(tried(&concurrent_at_one_spot(&room, 10, 2)));
    // A writer that missed another's character, typing at the same place.
    let late = doc(5);
    sync(&room, &late);
    let earlier = doc(6);
    sync(&room, &earlier);
    let text = earlier.get_or_insert_text("t");
    let typed = delta(&earlier, |txn| text.insert(txn, 2, "e"));
    room.transact_mut()
        .apply_update(decode(&typed).unwrap())
        .unwrap();
    let text = late.get_or_insert_text("t");
    assert!(tried(&delta(&late, |txn| text.insert(txn, 2, "l"))));
}

/// A reconnect's catch-up repeats the writer's whole delete set: only
/// deletions the room does not hold yet count toward a small edit (Epo,
/// 2026-10-08), so it applies directly, while as many new deletions take the
/// trial.
#[test]
fn a_reconnect_repeating_held_deletions_is_a_small_edit() {
    let room = doc(1);
    let text = room.get_or_insert_text("t");
    text.insert(&mut room.transact_mut(), 0, &"abcd".repeat(20));
    // 40 separate deletions, which the writer's catch-up will repeat.
    for k in 0..40u32 {
        text.remove_range(&mut room.transact_mut(), k, 1);
    }
    let tried = |bytes: &[u8]| {
        inspect_update(&room.transact(), &decode(bytes).unwrap())
            .unwrap()
            .trial
            .is_some()
    };
    let writer = doc(2);
    sync(&room, &writer);
    let typed = writer.get_or_insert_text("t");
    typed.insert(&mut writer.transact_mut(), 3, "x");
    let catch_up = writer
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    assert!(decode(&catch_up).unwrap().delete_set().iter().count() > 0);
    assert!(!tried(&catch_up));
    // 20 deletions the room has not seen.
    let deleter = doc(3);
    sync(&room, &deleter);
    let target = deleter.get_or_insert_text("t");
    let removed = delta(&deleter, |txn| {
        for k in 0..20 {
            target.remove_range(txn, k, 1);
        }
    });
    assert!(tried(&removed));
}

/// Security regression (REVIEW3 S1): structs the room holds cost no trial,
/// so a crafted update of a thousand of them and one keystroke is a small
/// edit; reading them still costs, so it is not applied inline. The
/// predicate counts the structs it looks at, stopping past [SMALL_EDIT]; a
/// keystroke stays inline.
#[test]
fn held_structs_in_bulk_are_not_applied_inline() {
    let room = doc(1);
    let writer = doc(2);
    let text = writer.get_or_insert_text("t");
    // A thousand separate items: each prepended, so none merges.
    for _ in 0..1_000 {
        text.insert(&mut writer.transact_mut(), 0, "h");
    }
    sync(&writer, &room);
    text.insert(&mut writer.transact_mut(), 0, "k");
    let everything = writer
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let keystroke = delta(&writer, |txn| text.insert(txn, 0, "j"));
    let inline = |bytes: &[u8]| {
        let update = decode(bytes).unwrap();
        let incoming = Incoming::new(&update);
        steps::take();
        let inline = applies_inline(&room.transact(), &incoming, bytes.len());
        (inline, steps::take().of(steps::Walk::Inline))
    };
    // 1,001 structs, 1,000 of them held: a small edit (no trial), not inline.
    let update = decode(&everything).unwrap();
    assert!(small_edit(&room.transact(), &Incoming::new(&update)));
    assert!(everything.len() <= INLINE_BYTES);
    assert_eq!(inline(&everything), (false, SMALL_EDIT as u64 + 1));
    // The writer's next keystroke, one struct, stays inline; a 70 KB paste,
    // one struct too, is past INLINE_BYTES.
    sync(&writer, &room);
    assert_eq!(inline(&keystroke), (true, 1));
    let paste = delta(&writer, |txn| text.insert(txn, 0, &"p".repeat(70_000)));
    let update = decode(&paste).unwrap();
    assert!(small_edit(&room.transact(), &Incoming::new(&update)));
    assert_eq!(inline(&paste), (false, 0));
}

/// Security regression (Epo 2026-10-08, trial sizing): an update near the
/// 4 MiB message cap made only of deletions the room holds already costs the
/// held-deletion check at most the work budget in steps, then takes the trial.
#[test]
fn held_deletions_up_to_the_message_cap_stay_within_the_budget() {
    use yrs::encoding::write::Write;
    // 170 clients, each with 16,000 units the room holds deleted: clocks
    // under 16,384 take two bytes, so 8,000 one-unit ranges per client
    // (every other unit) fit 1,360,000 ranges, past the budget, in 4 MiB.
    let (clients, per_client) = (170u64, 8_000u32);
    let room = doc(1);
    for client in 0..clients {
        let writer = doc(1_000 + client);
        let text = writer.get_or_insert_text("t");
        text.insert(
            &mut writer.transact_mut(),
            0,
            &"d".repeat(2 * per_client as usize),
        );
        text.remove_range(&mut writer.transact_mut(), 0, 2 * per_client);
        sync(&writer, &room);
    }
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(0u32); // no structs
    bytes.write_var(clients);
    for client in 0..clients {
        bytes.write_var(1_000 + client);
        bytes.write_var(per_client);
        for k in 0..per_client {
            bytes.write_var(2 * k);
            bytes.write_var(1u32);
        }
    }
    assert!(
        (3 << 20..=4 << 20).contains(&bytes.len()),
        "{}",
        bytes.len()
    );
    steps::take();
    let inspected = inspect_update(&room.transact(), &decode(&bytes).unwrap());
    let spent = steps::take().of(steps::Walk::Deletions);
    assert!(inspected.is_ok(), "{inspected:?}");
    // The check spends the whole budget before it gives up, and no more.
    assert!(spent > MAX_WORK, "{spent} steps");
    assert!(spent <= MAX_WORK + 64, "{spent} steps");
}

/// Structs of the update that wait on each other stay pending after the
/// trial: refused, while one waiting on a unit neither side holds is unheld.
#[test]
fn structs_waiting_on_each_other_are_refused() {
    use yrs::encoding::write::Write;
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "hello");
    // Client 900: struct 0 after 901:0, struct 1 after a held character;
    // client 901: struct 0 after 900:1, which comes after 900:0.
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(2u32);
    bytes.write_var(2u32);
    bytes.write_var(900u64);
    bytes.write_var(0u32);
    for (client, clock) in [(901u64, 0u32), (1, 2)] {
        bytes.write_u8(0x80 | 4);
        bytes.write_var(client);
        bytes.write_var(clock);
        bytes.write_string("a");
    }
    bytes.write_var(1u32);
    bytes.write_var(901u64);
    bytes.write_var(0u32);
    bytes.write_u8(0x80 | 4);
    bytes.write_var(900u64);
    bytes.write_var(1u32);
    bytes.write_string("c");
    bytes.write_var(0u32);
    let inspected = inspect_update(&room.transact(), &decode(&bytes).unwrap());
    assert!(
        matches!(&inspected, Err(UpdateError::Decode(message)) if message.contains("cycle")),
        "{inspected:?}"
    );
    // A struct after a held character, before one of a client the room has
    // never seen: unheld (it may arrive), not refused.
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(1u32);
    bytes.write_var(900u64);
    bytes.write_var(0u32);
    bytes.write_u8(0x80 | 0x40 | 4);
    bytes.write_var(1u64);
    bytes.write_var(2u32);
    bytes.write_var(777u64);
    bytes.write_var(0u32);
    bytes.write_string("a");
    bytes.write_var(0u32);
    assert!(unheld(&room, &bytes));
}

/// A text of `tombstones` characters each typed at its start, then all
/// deleted, and an update of as many one-character items with only a right
/// origin, each a tombstone from the last back: every item has a spot of its
/// own, but yrs scans from the start of the text to the right origin of each.
fn fanned(tombstones: u32) -> (Doc, Vec<u8>) {
    use yrs::encoding::write::Write;
    let room = doc(1);
    let text = room.get_or_insert_text("t");
    for _ in 0..tombstones {
        text.insert(&mut room.transact_mut(), 0, "t");
    }
    text.remove_range(&mut room.transact_mut(), 0, tombstones);
    let mut ids: Vec<ID> = Vec::new();
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
    (room, bytes)
}

/// An update whose placement costs yrs more than 1,000,000 steps on the
/// trial copy is refused, whatever its spots (Epo, 2026-10-08).
#[test]
fn a_costly_update_is_refused() {
    let inspect =
        |room: &Doc, bytes: &[u8]| inspect_update(&room.transact(), &decode(bytes).unwrap());
    // 1,414 * 1,413 / 2 = 998,991 scan steps (and nothing else): taken;
    // 1,415 * 1,414 / 2 = 1,000,405: refused.
    let (room, bytes) = fanned(1_414);
    assert!(inspect(&room, &bytes).is_ok());
    let (room, bytes) = fanned(1_415);
    assert!(matches!(inspect(&room, &bytes), Err(UpdateError::Costly)));
}

/// Security regression (notes REVIEW4 M9): `clients` forged clients, each
/// struct's origin the struct of the client before, made yrs's struct picker
/// recurse once per client: 20,000 overflowed a 2 MiB stack (a tokio
/// worker's) and aborted the process. Applied directly here, with no work
/// budget, on such a stack.
#[test]
fn a_chain_of_clients_applies_on_a_task_stack() {
    use yrs::encoding::write::Write;
    let clients = 20_000u64;
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "h");
    let state = room
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(clients);
    for k in 0..clients {
        let client = 1_000 + k;
        bytes.write_var(1u32);
        bytes.write_var(client);
        bytes.write_var(0u32);
        bytes.write_u8(0x80 | 4);
        let (origin, clock) = if k == 0 { (1, 0) } else { (client - 1, 0) };
        bytes.write_var(origin);
        bytes.write_var(clock);
        bytes.write_string("x");
    }
    bytes.write_var(0u32);
    // Admission still tries it on a copy, and refuses it: the trial sizing
    // counts the 20,000 structs the room lacks. The notes walks' cycle checks
    // rely on this to keep an admitted chain short (REVIEW2, REVIEW3 M7).
    let inspected = inspect_update(&room.transact(), &decode(&bytes).unwrap());
    assert!(
        matches!(inspected, Err(UpdateError::Costly)),
        "{inspected:?}"
    );
    let length = std::thread::Builder::new()
        .stack_size(2 << 20)
        .spawn(move || {
            let room = doc(1);
            room.transact_mut()
                .apply_update(decode(&state).unwrap())
                .unwrap();
            room.transact_mut()
                .apply_update(decode(&bytes).unwrap())
                .unwrap();
            let text = room.get_or_insert_text("t");
            text.len(&room.transact())
        })
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(length, 1 + clients as u32);
}

/// The live format markers of the Y.Text at `stories.body`.
fn live_format_markers(doc: &Doc) -> usize {
    let txn = doc.transact();
    let stories = txn.get_map("stories").unwrap();
    let Some(yrs::Out::YText(body)) = stories.get(&txn, "body") else {
        panic!("no story")
    };
    let branch: &yrs::branch::Branch = body.as_ref();
    let mut count = 0;
    let mut next = branch.start();
    while let Some(item) = next {
        if !item.is_deleted() && matches!(item.content(), yrs::block::ItemContent::Format(..)) {
            count += 1;
        }
        next = item.right();
    }
    count
}

// Room documents run no formatting cleanup (Epo D3, 2026-10-09, for Office
// rooms; note rooms take the same options). A peer bolds a letter while
// another deletes it; both markers then enclose nothing, and a room with
// yrs's cleanup on deletes them for itself only, so it would read differently
// from the peers that keep them.
#[test]
fn a_room_keeps_the_format_markers_its_peers_sent() {
    // Rooms take a random client (0); the same holds for a chosen one.
    for room_client in [0, 9] {
        let room = doc(room_client);
        let writer = doc(1);
        let stories = writer.get_or_insert_map("stories");
        let body = stories.insert(
            &mut writer.transact_mut(),
            "body",
            yrs::TextPrelim::new("abc"),
        );
        let other = doc(2);
        sync(&writer, &room);
        sync(&writer, &other);
        let bold = delta(&writer, |txn| {
            let attrs = yrs::types::Attrs::from([(Arc::from("bold"), yrs::Any::Bool(true))]);
            body.format(txn, 1, 1, attrs);
        });
        let Some(yrs::Out::YText(theirs)) = other
            .get_or_insert_map("stories")
            .get(&other.transact(), "body")
        else {
            panic!("no story")
        };
        let deletion = delta(&other, |txn| theirs.remove_range(txn, 1, 1));
        for update in [bold, deletion] {
            apply(&room, decode(&update).unwrap()).unwrap();
        }
        assert_eq!(live_format_markers(&room), 2, "room client {room_client}");
        sync(&room, &writer);
        assert_eq!(
            room.transact()
                .encode_state_as_update_v1(&StateVector::default()),
            writer
                .transact()
                .encode_state_as_update_v1(&StateVector::default()),
            "the room and a peer hold the same document"
        );
    }
}

/// A step 1's answer is known to be large without encoding it: the walk
/// counts what lies past the asker's state, a merged text block only from
/// where the asker stopped (a returning member's resync stays small).
#[test]
fn a_step_1_answer_is_large_only_for_what_lies_past_the_asker() {
    let room = doc(1);
    let text = room.get_or_insert_text("content");
    text.insert(&mut room.transact_mut(), 0, &"a".repeat(300_000));
    let nearly = room.transact().state_vector();
    text.insert(&mut room.transact_mut(), 300_000, &"b".repeat(1_000));
    let txn = room.transact();
    assert!(answer_at_least(&txn, &StateVector::default(), 256 << 10));
    assert!(!answer_at_least(&txn, &txn.state_vector(), 256 << 10));
    assert!(!answer_at_least(&txn, &nearly, 256 << 10));
    assert!(answer_at_least(&txn, &nearly, 1_000));
    assert!(!answer_at_least(&txn, &nearly, 1_002));
}

/// Held from a step 2 (in-place collection, step 1): a reconnecting tab's
/// step 2 resends its whole delete set, and the room holds only what it
/// deletes that the room held undeleted, its own deletions. Fails if the
/// deletions another writer made already come back as this one's.
#[test]
fn a_step_2_adds_only_its_own_deletions() {
    let room = doc(1);
    room.get_or_insert_text("content")
        .insert(&mut room.transact_mut(), 0, "abcdef");
    let (alice, bob) = (doc(10), doc(20));
    sync(&room, &alice);
    sync(&room, &bob);
    // Bob deletes "ab", and the room takes it.
    let text = bob.get_or_insert_text("content");
    let deleted = delta(&bob, |txn| text.remove_range(txn, 0, 2));
    let (_, bobs) = apply_deleting(&room, decode(&deleted).unwrap()).unwrap();
    assert!(!bobs.is_empty());
    // Alice, offline, heard it, then deleted "ef" herself.
    sync(&bob, &alice);
    let text = alice.get_or_insert_text("content");
    text.remove_range(&mut alice.transact_mut(), 2, 2);
    let step2 = alice
        .transact()
        .encode_state_as_update_v1(&room.transact().state_vector());
    // It resends Bob's deletion too.
    assert!(
        decode(&step2)
            .unwrap()
            .delete_set()
            .contains(&ID::new(ClientID::new(1), 0))
    );
    let (_, alices) = apply_deleting(&room, decode(&step2).unwrap()).unwrap();
    let mut expected = IdSet::new();
    let base = room.transact().state_vector().get(&ClientID::new(1));
    expected.insert(ID::new(ClientID::new(1), base - 2), 2);
    assert_eq!(alices, expected);
    assert_eq!(
        room.get_or_insert_text("content")
            .get_string(&room.transact()),
        "cd"
    );
    // Sent again, it deletes nothing new.
    let (_, again) = apply_deleting(&room, decode(&step2).unwrap()).unwrap();
    assert!(again.is_empty());
}

/// Q549: typing that lands in a story the room holds deleted, and a delete of
/// text the room holds deleted: the room's own update does not carry them, and
/// the flag says so; ordinary typing and deletes keep the room's encoding.
#[test]
fn apply_freeing_tells_when_its_update_says_less_than_the_writer() {
    let writer = doc(2);
    let room = doc(1);
    let stories = writer.get_or_insert_map("stories");
    {
        let mut txn = writer.transact_mut();
        let text = stories.insert(&mut txn, "story", yrs::TextPrelim::new("hello"));
        text.insert(&mut txn, 5, " there");
    }
    sync(&writer, &room);
    let text: yrs::TextRef = {
        let txn = writer.transact();
        stories.get(&txn, "story").unwrap().cast().unwrap()
    };

    let typing = delta(&writer, |txn| text.insert(txn, 0, "live "));
    let (relayed, _, lost) = apply_freeing(&room, decode(&typing).unwrap(), None).unwrap();
    assert_eq!(lost, Lost::default());
    assert!(!relayed.is_empty());
    let removal = delta(&writer, |txn| text.remove_range(txn, 0, 5));
    let (_, _, lost) = apply_freeing(&room, decode(&removal).unwrap(), None).unwrap();
    assert_eq!(lost, Lost::default());
    // Told twice, as a reconnect's step 2 does with a whole delete set.
    let (_, _, lost) = apply_freeing(&room, decode(&removal).unwrap(), None).unwrap();
    assert!(lost.deletions && !lost.landed);

    // Someone else's delete of the whole story reaches the room first.
    {
        let other = doc(3);
        sync(&room, &other);
        let before = other.transact().state_vector();
        other
            .get_or_insert_map("stories")
            .remove(&mut other.transact_mut(), "story");
        let delete = other.transact().encode_state_as_update_v1(&before);
        apply_freeing(&room, decode(&delete).unwrap(), None).unwrap();
    }

    let landed = delta(&writer, |txn| text.insert(txn, 2, "PEER"));
    let (relayed, _, lost) = apply_freeing(&room, decode(&landed).unwrap(), None).unwrap();
    assert!(lost.landed);
    assert!(!relayed.windows(4).any(|window| window == b"PEER"));
    let told = yrs::merge_updates_v1([landed.as_slice()]).unwrap();
    assert!(told.windows(4).any(|window| window == b"PEER"));
    // Stored state holds none of it.
    let state = room
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    assert!(!state.windows(4).any(|window| window == b"PEER"));
}

/// An update of one GC struct, which carries no bytes: `len` clocks of
/// `client` from `clock`.
fn collected(client: u64, clock: u32, len: u32) -> Vec<u8> {
    use yrs::encoding::write::Write;
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(1u32);
    bytes.write_var(client);
    bytes.write_var(clock);
    bytes.write_u8(0);
    bytes.write_var(len);
    bytes.write_var(0u32);
    bytes
}

/// An update of deletions alone: `ranges` (clock, length) of `client`, in
/// that order.
fn deleting(client: u64, ranges: &[(u32, u32)]) -> Vec<u8> {
    use yrs::encoding::write::Write;
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(0u32);
    bytes.write_var(1u32);
    bytes.write_var(client);
    bytes.write_var(ranges.len() as u32);
    for (clock, len) in ranges {
        bytes.write_var(*clock);
        bytes.write_var(*len);
    }
    bytes
}

/// Security regression (board review 2.1): a GC struct, a deleted item and
/// a deleted range claim any number of clocks in a few bytes, and yrs adds a
/// clock and a length unchecked, so two GC structs of 4,000,000,000 and
/// 400,000,000 clocks wrapped their client's clock in a release build and
/// left a room whose stored state no longer loaded. No struct and no deleted
/// range of an admitted update ends past [MAX_CLOCK]. Fails, in a debug and
/// a release build alike, if one does.
#[test]
fn a_clock_past_the_ceiling_is_refused() {
    use yrs::encoding::write::Write;
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "hello");
    let inspect = |bytes: &[u8]| inspect_update(&room.transact(), &decode(bytes).unwrap());
    let past = |bytes: &[u8]| matches!(inspect(bytes), Err(UpdateError::Decode(reason)) if reason.contains("past clock"));
    // At the ceiling a struct is taken; one clock further it is not.
    assert!(inspect(&collected(2, 0, MAX_CLOCK)).is_ok_and(|taken| !taken.unheld));
    assert!(past(&collected(2, 0, MAX_CLOCK + 1)));
    assert!(past(&collected(2, 0, 4_000_000_000)));
    // A deleted item of `u32::MAX` units under the root.
    let mut deleted: Vec<u8> = Vec::new();
    deleted.write_var(1u32);
    deleted.write_var(1u32);
    deleted.write_var(2u64);
    deleted.write_var(0u32);
    deleted.write_u8(1);
    deleted.write_var(1u32);
    deleted.write_string("t");
    deleted.write_var(u32::MAX);
    deleted.write_var(0u32);
    assert!(past(&deleted));
    // A deleted range: to the ceiling it is only unheld.
    assert!(inspect(&deleting(2, &[(0, MAX_CLOCK)])).is_ok_and(|taken| taken.unheld));
    assert!(past(&deleting(2, &[(MAX_CLOCK, 1)])));
    assert!(past(&deleting(1, &[(0, u32::MAX)])));
    // Sums past `u32::MAX`: yrs's decoder panics on them in a debug build
    // (the room catches it and refuses the sender) and wraps in a release
    // build, where the first struct, or the range's end before its start,
    // is refused. Never taken.
    let mut pair = collected(2, 0, 4_000_000_000);
    pair[1] = 2;
    pair.pop();
    pair.write_u8(0);
    pair.write_var(400_000_000u32);
    pair.write_var(0u32);
    for bytes in [pair, deleting(1, &[(4_000_000_000, 400_000_000)])] {
        let taken = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            decode(&bytes).is_ok_and(|update| inspect_update(&room.transact(), &update).is_ok())
        }));
        assert!(!matches!(taken, Ok(true)));
    }
}

/// A text of `units` of `unit` in one item, under client 1.
fn one_text(unit: &str, units: usize) -> Doc {
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, &unit.repeat(units));
    room
}

fn placing_of(room: &Doc, bytes: &[u8]) -> Result<Placing, UpdateError> {
    let update = decode(bytes).unwrap();
    let txn = room.transact();
    placing(&txn, &txn.state_vector(), &Incoming::new(&update))
}

/// `count` one-character items of client 2, each typed inside client 1's
/// text at its own spot `gap` units after the one before.
fn typed_inside(count: u32, gap: u32) -> Vec<u8> {
    use yrs::encoding::write::Write;
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(count);
    bytes.write_var(2u64);
    bytes.write_var(0u32);
    for k in 0..count {
        bytes.write_u8(0x80 | 0x40 | 4);
        bytes.write_var(1u64);
        bytes.write_var(k * gap);
        bytes.write_var(1u64);
        bytes.write_var(k * gap + 1);
        bytes.write_string("y");
    }
    bytes.write_var(0u32);
    bytes
}

/// The bounds the tests inspect a bounded room with (a board's).
const BOUNDS: Bounds = Bounds { depth: 64 };

/// [inspect_bounded] of `bytes` against `room`.
fn counting(room: &Doc, bytes: &[u8]) -> Result<Inspection, UpdateError> {
    let update = decode(bytes).unwrap();
    inspect_bounded(&room.transact(), &Incoming::new(&update), BOUNDS)
}

/// Security regression (board review 2.2): yrs copies both halves of an
/// item's content at every split and counts a split as one step, so 320,000
/// one-character deletions out of one text of 640,000 characters passed the
/// work limit and held a room for 27 s. A room that counts its splits
/// ([inspect_bounded], a canvas's board) counts the content each
/// one copies and walks toward [MAX_WORK]: such an update is refused before
/// any copy of the room applies it, in whichever order its ranges come, and
/// so are characters typed all over one text. Fails if either is taken.
#[test]
fn splitting_one_text_over_and_over_is_refused_where_splits_count() {
    let room = one_text("x", 200_000);
    let every_fourth: Vec<(u32, u32)> = (0..50_000).map(|k| (4 * k + 1, 1)).collect();
    let back: Vec<(u32, u32)> = every_fourth.iter().rev().copied().collect();
    for ranges in [&every_fourth, &back] {
        let bytes = deleting(1, ranges);
        assert!(matches!(
            placing_of(&room, &bytes),
            Err(UpdateError::Costly)
        ));
        assert!(matches!(counting(&room, &bytes), Err(UpdateError::Costly)));
    }
    assert!(matches!(
        counting(&room, &typed_inside(20_000, 10)),
        Err(UpdateError::Costly)
    ));
    // What an editor sends is taken: a replace-all of 200 places, twenty
    // characters typed in twenty places.
    let places: Vec<(u32, u32)> = (0..200).map(|k| (1_000 * k + 1, 3)).collect();
    for bytes in [deleting(1, &places), typed_inside(20, 10_000)] {
        let inspection = counting(&room, &bytes).unwrap();
        assert!(!inspection.unheld && inspection.trial.is_some());
    }
}

/// Every other room inspects as before the count existed ([inspect]; whether
/// they should count is undecided): 5,000 scattered deletions out of one
/// text of 100,000 characters, whose splits alone are past [MAX_WORK], are
/// tried on a copy and taken, as yrs counts few steps for them.
#[test]
fn an_inspection_that_counts_no_splits_takes_what_it_took() {
    let room = one_text("x", 100_000);
    let bytes = deleting(1, &(0..5_000).map(|k| (20 * k + 1, 1)).collect::<Vec<_>>());
    assert!(matches!(counting(&room, &bytes), Err(UpdateError::Costly)));
    let inspection = inspect_update(&room.transact(), &decode(&bytes).unwrap()).unwrap();
    assert!(!inspection.unheld && inspection.trial.is_some());
}

/// What a split costs: the units of the piece it copies, six times over for
/// text that is not ASCII, and the units before the cut, in the update's
/// order (a second cut splits what the first left). A list's item costs its
/// values; a deleted item and a block's edge cost nothing.
#[test]
fn a_split_costs_the_piece_it_copies_and_walks() {
    let splits = |room: &Doc, bytes: &[u8]| placing_of(room, bytes).unwrap().splits;
    let ascii = one_text("x", 96_000);
    // One deletion to the end: one cut in the middle.
    let half = deleting(1, &[(48_000, 48_000)]);
    assert_eq!(splits(&ascii, &half), 48_000 / 16 + 96_000 / 192);
    assert_eq!(
        splits(&one_text("\u{4e2d}", 96_000), &half),
        48_000 / 16 + 6 * 96_000 / 192
    );
    // Two cuts, the second in the piece the first left: it walks from the
    // first cut on. Backward, each cut walks from the start of the text.
    let forward = deleting(1, &[(32_000, 32_000)]);
    assert_eq!(
        splits(&ascii, &forward),
        (32_000 / 16 + 96_000 / 192) + (32_000 / 16 + 64_000 / 192)
    );
    let backward = deleting(1, &[(80_000, 16_000), (64_000, 16_000)]);
    assert_eq!(
        splits(&ascii, &backward),
        (80_000 / 16 + 96_000 / 192) + (64_000 / 16 + 80_000 / 192)
    );
    // A character typed after the first one cuts once (its right origin
    // starts where its origin ends): nothing to walk, the whole text copied.
    assert_eq!(splits(&ascii, &typed_inside(1, 0)), 96_000 / 192);
    let list = doc(1);
    let array = list.get_or_insert_array("a");
    yrs::Array::insert_range(&array, &mut list.transact_mut(), 0, vec![1.5f64; 4_000]);
    assert_eq!(splits(&list, &deleting(1, &[(2_000, 2_000)])), 4_000 / 4);
    // Deleted already, and a whole item: no cut.
    let text = ascii.get_or_insert_text("t");
    text.remove_range(&mut ascii.transact_mut(), 0, 96_000);
    let held = placing_of(&ascii, &half).unwrap();
    assert_eq!((held.splits, held.deletions), (0, 0));
    let whole = placing_of(&one_text("x", 96_000), &deleting(1, &[(0, 96_000)])).unwrap();
    assert_eq!((whole.splits, whole.deletions), (0, 1));
}

/// A keystroke in the middle of a long text splits it once. Where splits
/// count ([inspect_bounded]) it is tried on a copy once it costs more than a
/// small edit's share ([SMALL_SPLITS]); where they do not it stays a small
/// edit, applied inline.
#[test]
fn a_costly_split_is_not_a_small_edit_where_splits_count() {
    let keystroke = |units: usize| {
        let room = one_text("x", units);
        let writer = doc(2);
        sync(&room, &writer);
        let text = writer.get_or_insert_text("t");
        let bytes = delta(&writer, |txn| text.insert(txn, units as u32 / 2, "k"));
        let update = decode(&bytes).unwrap();
        let txn = room.transact();
        let incoming = Incoming::new(&update);
        let tried = inspect_bounded(&txn, &incoming, BOUNDS)
            .unwrap()
            .trial
            .is_some();
        let uncounted = inspect(&txn, &incoming).unwrap().trial.is_some();
        (
            tried,
            (uncounted, applies_inline(&txn, &incoming, bytes.len())),
        )
    };
    assert_eq!(keystroke(100_000), (false, (false, true)));
    assert_eq!(keystroke(3_000_000), (true, (false, true)));
}

/// Runs `check` on a thread with the 2 MiB stack a server task has.
fn on_task_stack<T: Send + 'static>(check: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(2 << 20)
        .spawn(check)
        .unwrap()
        .join()
        .unwrap()
}

/// A tab (client 2) of `room` that nested `depth` maps under the root map
/// `blocks`, the update that did it, and the deepest map. The top map is
/// the tab's first struct.
fn chained(room: &Doc, depth: usize) -> (Doc, Vec<u8>, yrs::MapRef) {
    let tab = doc(2);
    sync(room, &tab);
    let blocks = tab.get_or_insert_map("blocks");
    let mut deepest = None;
    let bytes = delta(&tab, |txn| {
        let mut current: yrs::MapRef = blocks.insert(txn, "d", MapPrelim::default());
        for _ in 1..depth {
            current = current.insert(txn, "k", MapPrelim::default());
        }
        deepest = Some(current);
    });
    (tab, bytes, deepest.unwrap())
}

fn too_deep(inspected: &Result<Inspection, UpdateError>) -> bool {
    matches!(inspected, Err(UpdateError::Decode(reason)) if reason.contains("nested"))
}

/// Security regression (board review 2, finding 1): a board has no rule on
/// what its content is, so nothing bounded how deep its types nest, and yrs
/// deletes and collects nested types by recursion: a chain of 8,000 maps and
/// the deletion of its top overflowed a worker's 2 MiB stack, which aborts
/// the process. A bounded room refuses a type past its depth: the deepest
/// chain it takes, one level more, and what still fits under the deepest
/// map. Every other room inspects as before. Fails if a deeper type enters.
#[test]
fn a_bounded_room_refuses_a_type_nested_past_its_depth() {
    let room = doc(1);
    room.get_or_insert_map("blocks");
    let depth = BOUNDS.depth as usize;
    let (_, over, _) = chained(&room, depth + 1);
    assert!(too_deep(&counting(&room, &over)));
    assert!(inspect_update(&room.transact(), &decode(&over).unwrap()).is_ok());
    let (tab, chain, deepest) = chained(&room, depth);
    assert!(counting(&room, &chain).is_ok_and(|taken| !taken.unheld));
    apply(&room, decode(&chain).unwrap()).unwrap();
    // Under the deepest map: a value and a text's characters fit, a type
    // of their own does not.
    let more = delta(&tab, |txn| {
        deepest.insert(txn, "n", 1.5);
    });
    assert!(counting(&room, &more).is_ok_and(|taken| !taken.unheld));
    apply(&room, decode(&more).unwrap()).unwrap();
    let deeper = delta(&tab, |txn| {
        deepest.insert(txn, "m", MapPrelim::default());
    });
    assert!(too_deep(&counting(&room, &deeper)));
}

/// Security regression (board review 2, finding 1): the depth is read
/// before anything recurses. One update holding a chain of 20,000 maps and
/// the deletion of its top is refused on a task's stack (its trial on a copy
/// would overflow it), and the deepest chain a bounded room holds is deleted
/// there by one range. Fails by aborting the test process.
#[test]
fn a_deep_chain_and_its_deletion_stay_on_a_task_stack() {
    use yrs::encoding::write::Write;
    // The top of a tab's chain deleted by one range, which names none of
    // what the chain holds.
    let top = |bytes: &mut Vec<u8>| {
        bytes.write_var(1u32);
        bytes.write_var(2u64);
        bytes.write_var(1u32);
        bytes.write_var(0u32);
        bytes.write_var(1u32);
    };
    let room = doc(1);
    room.get_or_insert_map("blocks");
    let (_, mut chain, _) = chained(&room, 20_000);
    assert_eq!(chain.pop(), Some(0));
    top(&mut chain);
    let refused = on_task_stack({
        let room = room.clone();
        move || too_deep(&counting(&room, &chain))
    });
    assert!(refused);
    let (_, chain, _) = chained(&room, BOUNDS.depth as usize);
    apply(&room, decode(&chain).unwrap()).unwrap();
    let mut gone = vec![0u8];
    top(&mut gone);
    let left = on_task_stack(move || {
        let taken = counting(&room, &gone).unwrap();
        assert!(!taken.unheld && taken.unnamed && taken.trial.is_some());
        apply(&room, decode(&gone).unwrap()).unwrap();
        room.get_or_insert_map("blocks").len(&room.transact())
    });
    assert_eq!(left, 0);
}

/// Security regression (board review 2, finding 2): the inspection walks
/// from each new struct's place up to its root, and nothing counted the
/// holders it passes: 2,000 entries under a chain of 100,000 maps took 12 s.
/// With the depth bounded a walk passes at most that many holders, and they
/// count toward a bounded room's work: 1,000 entries under its deepest map
/// pass 64 holders each, and 250,000 are refused before the walk. Fails if
/// the walk grows past the depth, or goes uncounted.
#[test]
fn the_walks_to_the_roots_count_toward_a_bounded_rooms_work() {
    let room = doc(1);
    room.get_or_insert_map("blocks");
    let depth = u64::from(BOUNDS.depth);
    let (tab, chain, deepest) = chained(&room, depth as usize);
    apply(&room, decode(&chain).unwrap()).unwrap();
    let entries = |count: u32| {
        delta(&tab, |txn| {
            for entry in 0..count {
                deepest.insert(txn, format!("e{entry}"), 1.5);
            }
        })
    };
    let few = entries(1_000);
    let _ = steps::take();
    assert!(counting(&room, &few).is_ok_and(|taken| !taken.unheld));
    assert_eq!(steps::take().of(steps::Walk::Holders), 1_000 * depth);
    apply(&room, decode(&few).unwrap()).unwrap();
    // (64 + 1) hops charged for each, 16 to a step: past a million steps.
    let many = entries(250_000);
    let _ = steps::take();
    assert!(matches!(counting(&room, &many), Err(UpdateError::Costly)));
    assert_eq!(steps::take().of(steps::Walk::Holders), 0);
}

/// Board review 2, finding 3: a bounded room holds an update's work to one
/// budget, by count: yrs's own steps cost three of its million each (a
/// conflict scan's step is about 70 ns in the trial and again in the apply,
/// so 333,333 of them hold the room about 50 ms; any other room takes a
/// million, about 140 ms), and they share it with the splits. 816 items
/// each placed before a tombstone scan 332,520 steps: taken; 817 are not;
/// and 600 are not once the update's deletions split a long text for more
/// than what the scans leave.
#[test]
fn a_bounded_room_holds_scans_and_splits_to_one_budget() {
    use yrs::encoding::write::Write;
    let (room, bytes) = fanned(816);
    assert!(counting(&room, &bytes).is_ok_and(|taken| !taken.unheld));
    let (room, bytes) = fanned(817);
    assert!(matches!(counting(&room, &bytes), Err(UpdateError::Costly)));
    // 600 scan 179,700 steps (539,100 of the budget). 1,000 deletions out
    // of a text of 100,000 characters split it for 526,850 more.
    let (room, mut scans) = fanned(600);
    let long = room.get_or_insert_text("u");
    long.insert(&mut room.transact_mut(), 0, &"x".repeat(100_000));
    let first = 600;
    let cuts: Vec<(u32, u32)> = (0..1_000).map(|k| (first + 100 * k + 1, 1)).collect();
    let splits = deleting(1, &cuts);
    assert_eq!(placing_of(&room, &splits).unwrap().splits, 526_850);
    assert!(counting(&room, &scans).is_ok());
    assert!(counting(&room, &splits).is_ok());
    assert_eq!(scans.pop(), Some(0));
    scans.write_var(1u32);
    scans.extend_from_slice(&splits[2..]);
    assert!(matches!(counting(&room, &scans), Err(UpdateError::Costly)));
}

/// Board review 2, finding 4: yrs deletes what a deleted type holds, and an
/// update built by hand need not name it; each piece may then end larger
/// than it was, which a room that bounds its state by what an update names
/// must measure. A bounded inspection tells when an update deletes a held
/// type, by a range or by writing its map key again, whose live content its
/// own deleted ranges do not name, and tries it on a copy. An editor's
/// deletion names it all.
#[test]
fn a_bounded_inspection_tells_content_deleted_unnamed() {
    use yrs::encoding::write::Write;
    let room = doc(1);
    let blocks = room.get_or_insert_map("blocks");
    let tab = doc(2);
    let held = tab.get_or_insert_map("blocks");
    let made = delta(&tab, |txn| {
        let block = held.insert(txn, "b", MapPrelim::default());
        block.insert(txn, "x", 1.5);
        block.insert(txn, "text", yrs::TextPrelim::new("hello"));
    });
    apply(&room, decode(&made).unwrap()).unwrap();
    assert_eq!(blocks.len(&room.transact()), 1);
    // The block alone, by its id; and its key written again with no range.
    let by_range = deleting(2, &[(0, 1)]);
    let mut by_key: Vec<u8> = Vec::new();
    by_key.write_var(1u32);
    by_key.write_var(1u32);
    by_key.write_var(3u64);
    by_key.write_var(0u32);
    by_key.write_u8(0x20 | 8);
    by_key.write_var(1u32);
    by_key.write_string("blocks");
    by_key.write_string("b");
    by_key.write_var(1u32);
    by_key.write_u8(126);
    by_key.write_var(0u32);
    for bytes in [&by_range, &by_key] {
        let taken = counting(&room, bytes).unwrap();
        assert!(taken.unnamed && taken.trial.is_some() && !taken.unheld);
        let incoming = decode(bytes).unwrap();
        // Any other room reads no such thing.
        assert!(!inspect_update(&room.transact(), &incoming).unwrap().unnamed);
    }
    // The tab's own deletion, and its own overwrite, name everything.
    let peer = doc(4);
    sync(&room, &peer);
    let theirs = peer.get_or_insert_map("blocks");
    let erased = delta(&tab, |txn| {
        held.remove(txn, "b");
    });
    let written = delta(&peer, |txn| {
        theirs.insert(txn, "b", 2.5);
    });
    for bytes in [&erased, &written] {
        assert!(!counting(&room, bytes).unwrap().unnamed);
    }
}

/// A transaction's deleted ids are a sorted list in yrs, and each one that
/// lands out of order moves those after it, which nothing counts: a
/// six-byte range deleting a type whose 100,000 scattered values it does not
/// name held a room 0.8 s in the trial and again in the apply (release,
/// 2026-11-18). What an update deletes unnamed counts toward a bounded
/// room's work as the entries it may move: 15,000 values are taken, 16,000
/// refused untried, and the tab's own removal, which names them, is charged
/// nothing.
#[test]
fn content_deleted_unnamed_counts_toward_a_bounded_rooms_work() {
    use yrs::Array;
    let listed = |count: u32| {
        let room = doc(1);
        room.get_or_insert_map("blocks");
        let tab = doc(2);
        let blocks = tab.get_or_insert_map("blocks");
        let made = delta(&tab, |txn| {
            let block = blocks.insert(txn, "b", MapPrelim::default());
            let list = block.insert(txn, "a", yrs::ArrayPrelim::default());
            for value in 0..count {
                list.push_front(txn, f64::from(value));
            }
        });
        apply(&room, decode(&made).unwrap()).unwrap();
        (room, tab, blocks)
    };
    // The block alone, by its id.
    let top = deleting(2, &[(0, 1)]);
    let (room, tab, blocks) = listed(15_000);
    assert!(counting(&room, &top).is_ok_and(|taken| taken.unnamed));
    let own = delta(&tab, |txn| {
        blocks.remove(txn, "b");
    });
    assert_eq!(placing_of(&room, &own).unwrap().cascade.unnamed, 0);
    assert!(counting(&room, &own).is_ok_and(|taken| !taken.unnamed));
    let (room, _, _) = listed(16_000);
    assert_eq!(placing_of(&room, &top).unwrap().cascade.unnamed, 16_001);
    assert!(matches!(counting(&room, &top), Err(UpdateError::Costly)));
    // Any other room reads it as before.
    assert!(inspect_update(&room.transact(), &decode(&top).unwrap()).is_ok());
}

/// One character typed by client 2 after each of `places` of client 1's
/// text, in that order.
fn typed_at(places: &[u32]) -> Vec<u8> {
    use yrs::encoding::write::Write;
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(places.len() as u32);
    bytes.write_var(2u64);
    bytes.write_var(0u32);
    for at in places {
        bytes.write_u8(0x80 | 0x40 | 4);
        bytes.write_var(1u64);
        bytes.write_var(*at);
        bytes.write_var(1u64);
        bytes.write_var(*at + 1);
        bytes.write_string("y");
    }
    bytes.write_var(0u32);
    bytes
}

/// Board review 2, finding 5: what a person does to a long text in one
/// update is taken whatever its order (an offline tab's edits arrive as one
/// update, in the order made): 1,000 characters typed, or deleted, all over
/// one item of 20,000 characters, from its start on, from its end back and
/// shuffled. From the end back is the costliest, about two thirds of the
/// budget. Fails if the split count refuses one.
#[test]
fn a_bounded_room_takes_a_thousand_edits_all_over_a_long_text() {
    let room = one_text("x", 20_000);
    let ascending: Vec<u32> = (0..1_000).map(|k| 20 * k + 7).collect();
    let descending: Vec<u32> = ascending.iter().rev().copied().collect();
    let mut shuffled = ascending.clone();
    let mut seed = 7u64;
    for at in (1..shuffled.len()).rev() {
        seed = seed * 16_807 % 2_147_483_647;
        shuffled.swap(at, (seed % (at as u64 + 1)) as usize);
    }
    for places in [&ascending, &descending, &shuffled] {
        let ranges: Vec<(u32, u32)> = places.iter().map(|at| (*at, 1)).collect();
        for bytes in [typed_at(places), deleting(1, &ranges)] {
            let taken = counting(&room, &bytes);
            assert!(taken.is_ok_and(|taken| !taken.unheld));
        }
    }
    let spent = placing_of(&room, &typed_at(&descending)).unwrap().splits;
    assert!((600_000..750_000).contains(&spent), "{spent}");
}
