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

/// `items` one-character structs with neither origin nor right origin in the
/// root text `t`, from `clients` client ids (one struct each, or all from one).
fn without_origins(items: u32, clients: u32) -> Vec<u8> {
    use yrs::encoding::write::Write;
    let mut bytes: Vec<u8> = Vec::new();
    let per = items / clients;
    bytes.write_var(clients);
    for client in 0..clients {
        bytes.write_var(per);
        bytes.write_var(1_000 + client as u64);
        bytes.write_var(0u32);
        for _ in 0..per {
            bytes.write_u8(4); // a string, no origins: the parent follows
            bytes.write_var(1u32); // the parent is a root, by name
            bytes.write_string("t");
            bytes.write_string("x");
        }
    }
    bytes.write_var(0u32);
    bytes
}

/// No more than 64 items may claim one spot of a text (Epo, 2026-10-08):
/// the room's and the update's together, of any clients.
#[test]
fn a_crowded_spot_is_refused() {
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "hello");
    let inspect =
        |room: &Doc, bytes: &[u8]| inspect_update(&room.transact(), &decode(bytes).unwrap());
    // 64 writers typing at one place at once: accepted; 65: refused.
    assert!(inspect(&room, &concurrent_at_one_spot(&room, 10, 64)).is_ok());
    assert!(matches!(
        inspect(&room, &concurrent_at_one_spot(&room, 10, 65)),
        Err(UpdateError::Crowded)
    ));
    // Items without origins (the start of an empty text): from one client or
    // from forged client ids, one each.
    let empty = doc(1);
    empty.get_or_insert_text("t");
    assert!(inspect(&empty, &without_origins(64, 1)).is_ok());
    assert!(matches!(
        inspect(&empty, &without_origins(65, 1)),
        Err(UpdateError::Crowded)
    ));
    assert!(matches!(
        inspect(&empty, &without_origins(20_000, 20_000)),
        Err(UpdateError::Crowded)
    ));
    // The room's items at the spot count: 60 there, 5 more refused, 4 taken.
    let crowded = doc(1);
    crowded
        .get_or_insert_text("t")
        .insert(&mut crowded.transact_mut(), 0, "hello");
    let sixty = concurrent_at_one_spot(&crowded, 100, 60);
    crowded
        .transact_mut()
        .apply_update(decode(&sixty).unwrap())
        .unwrap();
    let more = |count| {
        // Writers that synced before the 60 arrived write at the same spot.
        let before = doc(1);
        before
            .get_or_insert_text("t")
            .insert(&mut before.transact_mut(), 0, "hello");
        concurrent_at_one_spot(&before, 200, count)
    };
    assert!(inspect(&crowded, &more(4)).is_ok());
    assert!(matches!(
        inspect(&crowded, &more(5)),
        Err(UpdateError::Crowded)
    ));
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

/// The placement estimate counts the steps yrs takes (Epo, 2026-10-08): one
/// per item a conflict scan passes; checked against an instrumented yrs on
/// the corpus and these shapes.
#[test]
fn placement_counts_the_steps_yrs_scans() {
    let cost = |room: &Doc, bytes: &[u8], budget| {
        placement_cost(
            &room.transact(),
            &Incoming::new(&decode(bytes).unwrap()),
            budget,
        )
    };
    let room = doc(1);
    room.get_or_insert_text("t")
        .insert(&mut room.transact_mut(), 0, "hello");
    // Concurrent writers at one place: each placed after one step.
    assert_eq!(
        cost(&room, &concurrent_at_one_spot(&room, 10, 64), u64::MAX),
        Some(63)
    );
    // Fanned: n - 1 tombstones scanned for the first item, then one fewer each.
    let (room, bytes) = fanned(100);
    assert_eq!(cost(&room, &bytes, u64::MAX), Some(4_950));
    assert_eq!(cost(&room, &bytes, 4_950), Some(4_950));
    assert_eq!(cost(&room, &bytes, 4_949), None);
}

/// An update whose placement would cost yrs more than 100,000 steps is
/// refused, whatever its spots (Epo, 2026-10-08).
#[test]
fn a_costly_update_is_refused() {
    let inspect =
        |room: &Doc, bytes: &[u8]| inspect_update(&room.transact(), &decode(bytes).unwrap());
    // 447 * 446 / 2 = 99,681 steps: taken; 448 * 447 / 2 = 100,128: refused.
    let (room, bytes) = fanned(447);
    assert!(inspect(&room, &bytes).is_ok());
    let (room, bytes) = fanned(448);
    assert!(matches!(inspect(&room, &bytes), Err(UpdateError::Costly)));
}
