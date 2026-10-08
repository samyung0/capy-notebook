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
/// links it. Malformed.
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
    let inspected = inspect_update(&room.transact(), &decode(&bytes).unwrap());
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
    let spent = steps::take();
    assert!(inspected.is_ok(), "{inspected:?}");
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
