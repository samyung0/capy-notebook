//! Flashcard set documents (live-items DESIGN.md 1.4): one root map `cards`,
//! card id to `{order, front: Y.Text, back: Y.Text, image?: {assetId}}`. The
//! projection is today's Plate envelope (a `flashcards` block of `flashcard`
//! elements), so Go, study state and every reader keep their JSON.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map as JsonMap, Value, json};
use yrs::block::ItemContent;
use yrs::types::TypeRef;
use yrs::{
    Any, Doc, GetString, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, Text, TextPrelim,
    TextRef, Transact, TransactionMut, WriteTxn,
};

use notes::edit::{DocumentCommand, EditError, EditErrorCode};
use ydoc::Incoming;
use ydoc::steps::{Walk, step};

use crate::locate::{Locator, Place};
use crate::{Growth, order};

pub const ROOT: &str = "cards";
/// The projected `flashcards` block's id (one block per set document).
pub const BLOCK_ID: &str = "flashcards";
/// Card fronts and backs, in characters: the card save API's 4,000 and the
/// decided 2,000-character back (human/frontend/plate-editor.md 2026-10-06).
pub const MAX_FRONT: usize = notes::catalog::CARD_FRONT_MAX;
pub const MAX_BACK: usize = notes::catalog::CARD_BACK_MAX;
const MAX_ID: usize = 128;
/// JSON a new card adds besides its id and texts:
/// `{"type":"flashcard","id":"","children":[{"type":"flashcard_front","children":[{"text":""}]},…back…]},`
const CARD_BYTES: u64 = 150;
const CARD_NODES: u64 = 5;
/// `,"image":{"assetId":""}` besides the id.
const IMAGE_BYTES: u64 = 24;

/// A card as the projection and the server writes read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Card {
    pub id: String,
    pub order: String,
    pub front: String,
    pub back: String,
    pub image: Option<String>,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn text_of<T: ReadTxn>(txn: &T, card: &MapRef, field: &str) -> String {
    match card.get(txn, field) {
        Some(Out::YText(text)) => text.get_string(txn),
        _ => String::new(),
    }
}

fn card_of<T: ReadTxn>(txn: &T, id: &str, card: &MapRef) -> Card {
    let order = match card.get(txn, "order") {
        Some(Out::Any(Any::String(order))) => order.to_string(),
        _ => String::new(),
    };
    let image = match card.get(txn, "image") {
        Some(Out::Any(Any::Map(image))) => match image.get("assetId") {
            Some(Any::String(asset)) => Some(asset.to_string()),
            _ => None,
        },
        _ => None,
    };
    Card {
        id: id.to_owned(),
        order,
        front: text_of(txn, card, "front"),
        back: text_of(txn, card, "back"),
        image,
    }
}

/// Every card, in `(order, id)` order (two writers that inserted at the same
/// place hold the same key; the id breaks the tie the same way everywhere).
pub fn cards<T: ReadTxn>(txn: &T) -> Vec<Card> {
    let Some(root) = txn.get_map(ROOT) else {
        return Vec::new();
    };
    let mut out: Vec<Card> = root
        .iter(txn)
        .filter_map(|(id, value)| match value {
            Out::YMap(card) => {
                ydoc::steps::step(ydoc::steps::Walk::Exact);
                Some(card_of(txn, id, &card))
            }
            _ => None,
        })
        .collect();
    out.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    out
}

fn blank(card: &Card) -> bool {
    notes::questions::js_trim(&card.front).is_empty()
        && notes::questions::js_trim(&card.back).is_empty()
        && card.image.is_none()
}

/// The Plate node of one card (Go `materialdoc.cardNode`).
pub fn card_node(card: &Card) -> Value {
    let mut node = JsonMap::new();
    node.insert("type".into(), json!("flashcard"));
    node.insert("id".into(), json!(card.id));
    node.insert(
        "children".into(),
        json!([
            { "type": "flashcard_front", "children": [{ "text": card.front }] },
            { "type": "flashcard_back", "children": [{ "text": card.back }] },
        ]),
    );
    if let Some(asset) = &card.image {
        node.insert("image".into(), json!({ "assetId": asset }));
    }
    Value::Object(node)
}

/// The Plate value the set projects to. Blank cards stay out, as the card
/// save left them out (a new set's first card, an Add card nobody wrote);
/// a set with nothing written keeps its first card, or one blank card, since
/// a `flashcards` block needs a child.
pub fn value<T: ReadTxn>(txn: &T) -> Vec<Value> {
    let all = cards(txn);
    let mut kept: Vec<&Card> = all.iter().filter(|card| !blank(card)).collect();
    let placeholder = Card {
        id: "blank".into(),
        order: String::new(),
        front: String::new(),
        back: String::new(),
        image: None,
    };
    if kept.is_empty() {
        kept.push(all.first().unwrap_or(&placeholder));
    }
    vec![json!({
        "type": "flashcards",
        "id": BLOCK_ID,
        "children": kept.into_iter().map(card_node).collect::<Vec<_>>(),
    })]
}

/// Every card, blank ones included: what the room holds and what the limits
/// measure (blank cards cost bytes too).
pub fn document_value<T: ReadTxn>(txn: &T) -> Vec<Value> {
    vec![json!({
        "type": "flashcards",
        "id": BLOCK_ID,
        "children": cards(txn).iter().map(card_node).collect::<Vec<_>>(),
    })]
}

/// Only `cards` (entries only) and the contributor marker map.
pub fn assert_roots<T: ReadTxn>(txn: &T) -> Result<(), String> {
    for (name, _) in txn.root_refs() {
        if name != ROOT && name != ydoc::CONTRIBUTORS_ROOT {
            return Err(format!("unsupported collaboration document root: {name}"));
        }
    }
    if let Some(root) = yrs::branch::BranchID::get_root(txn, ROOT)
        && root.start().is_some()
    {
        return Err("invalid flashcard set root".into());
    }
    if let Some(markers) = yrs::branch::BranchID::get_root(txn, ydoc::CONTRIBUTORS_ROOT)
        && markers.start().is_some()
    {
        return Err("invalid collaboration contributor root".into());
    }
    Ok(())
}

fn leaf_text(node: &Value) -> String {
    match node.get("children") {
        Some(Value::Array(children)) => children
            .iter()
            .map(|child| match child.get("text") {
                Some(Value::String(text)) => text.clone(),
                _ => leaf_text(child),
            })
            .collect(),
        _ => String::new(),
    }
}

/// A card from its Plate node; `None` when the node is not a flashcard.
pub fn card_from_node(node: &Value) -> Option<Card> {
    if node.get("type")? != "flashcard" {
        return None;
    }
    let children = node.get("children")?.as_array()?;
    let front = children
        .iter()
        .find(|c| c.get("type").and_then(Value::as_str) == Some("flashcard_front"))?;
    let back = children
        .iter()
        .find(|c| c.get("type").and_then(Value::as_str) == Some("flashcard_back"))?;
    let image = node
        .get("image")
        .and_then(|image| image.get("assetId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some(Card {
        id: node
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        order: String::new(),
        front: leaf_text(front),
        back: leaf_text(back),
        image,
    })
}

/// The cards of a projected (or legacy) Plate value, in document order.
pub fn cards_from_value(value: &[Value]) -> Vec<Card> {
    value
        .iter()
        .filter(|node| node.get("type").and_then(Value::as_str) == Some("flashcards"))
        .flat_map(|block| {
            block
                .get("children")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(card_from_node)
        })
        .collect()
}

fn image_any(asset: &str) -> Any {
    Any::Map(Arc::new(HashMap::from([(
        "assetId".to_owned(),
        Any::String(Arc::from(asset)),
    )])))
}

fn card_prelim(card: &Card, order: &str) -> MapPrelim {
    let mut prelim = MapPrelim::from([
        ("order", yrs::In::Any(Any::String(Arc::from(order)))),
        ("front", yrs::In::from(TextPrelim::new(card.front.clone()))),
        ("back", yrs::In::from(TextPrelim::new(card.back.clone()))),
    ]);
    if let Some(asset) = &card.image {
        prelim.insert(Arc::from("image"), yrs::In::Any(image_any(asset)));
    }
    prelim
}

/// A set left without a card gets one blank card, as a new set starts (Epo
/// 2026-10-19: the canonical repair of an emptied set, on entry and at save;
/// two writers each deleting one of the last two cards leave it so). `id` is
/// the new card's, fresh (a card id is a global key). Stops at the first live
/// card. Whether it wrote one.
pub fn repair(txn: &mut TransactionMut, id: &str) -> bool {
    let root = txn.get_or_insert_map(ROOT);
    if root.iter(txn).next().is_some() {
        return false;
    }
    let card = Card {
        id: id.to_owned(),
        order: order::after(None),
        front: String::new(),
        back: String::new(),
        image: None,
    };
    root.insert(txn, card.id.clone(), card_prelim(&card, &card.order));
    true
}

/// The set document seeded from a Plate value (first open, a clone's first
/// open, a lineage rebuild): every card in order, keys `a0`, `a1`, ...
pub fn state_from_value(value: &[Value], client_id: u64) -> Vec<u8> {
    let doc = Doc::with_options(ydoc::doc_options(client_id));
    let root = doc.get_or_insert_map(ROOT);
    {
        let mut txn = doc.transact_mut();
        let mut key: Option<String> = None;
        for card in cards_from_value(value) {
            if !valid_id(&card.id) || root.get(&txn, &card.id).is_some() {
                continue;
            }
            let next = order::after(key.as_deref());
            root.insert(&mut txn, card.id.clone(), card_prelim(&card, &next));
            key = Some(next);
        }
    }
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&StateVector::default())
}

fn utf16(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

fn plain(value: &Any) -> bool {
    !matches!(value, Any::Buffer(_) | Any::BigInt(_))
}

fn refuse<T>(what: impl Into<String>) -> Result<T, String> {
    Err(format!("a flashcard set cannot hold {}", what.into()))
}

/// Checks each struct an update adds against the set's shape, and bounds
/// what it adds: the projected bytes and nodes, and the touched texts'
/// lengths against their caps (`over_cap` sends the update to the exact
/// check). Deletions never grow anything. O(update) plus one length read
/// per touched text.
pub fn admit_shapes<T: ReadTxn>(txn: &T, incoming: &Incoming) -> Result<Growth, String> {
    let state = txn.state_vector();
    let mut locator = Locator::new(txn, incoming);
    let mut growth = Growth::default();
    let mut added: HashMap<(Arc<str>, Arc<str>), u64> = HashMap::new();
    for item in incoming.items() {
        step(Walk::Content);
        let id = item.id();
        if id.clock + item.len() <= state.get(&id.client) {
            continue;
        }
        let content = item.content();
        if matches!(content, ItemContent::Deleted(_)) {
            continue;
        }
        let (path, key) = match locator.place(item) {
            Place::Gone => continue,
            Place::Unknown => return refuse("a struct outside its shape"),
            Place::At { path, key } => (path, key),
        };
        let path: Vec<&str> = path.iter().map(|k| &**k).collect();
        match (path.as_slice(), key.as_deref()) {
            ([ROOT], Some(card)) => {
                if !valid_id(card) {
                    return refuse("a card id that is not 1-128 letters, digits, - or _");
                }
                match content {
                    ItemContent::Type(branch) if matches!(branch.type_ref(), TypeRef::Map) => {
                        growth.bytes += CARD_BYTES + card.len() as u64;
                        growth.nodes += CARD_NODES;
                    }
                    _ => return refuse("a card that is not a map"),
                }
            }
            ([ROOT, _], Some("order")) => match content {
                ItemContent::Any(values)
                    if values.len() == 1
                        && matches!(&values[0], Any::String(key) if order::valid(key)) => {}
                _ => return refuse("an order that is not an order key"),
            },
            ([ROOT, _], Some("front" | "back")) => match content {
                ItemContent::Type(branch) if matches!(branch.type_ref(), TypeRef::Text) => {}
                _ => return refuse("a card face that is not a text"),
            },
            ([ROOT, _], Some("image")) => match content {
                ItemContent::Any(values) if values.len() == 1 => match &values[0] {
                    Any::Map(image)
                        if image.len() == 1
                            && matches!(image.get("assetId"),
                                Some(Any::String(asset)) if !asset.trim().is_empty() && asset.len() <= MAX_ID) =>
                    {
                        growth.bytes += IMAGE_BYTES + MAX_ID as u64;
                    }
                    Any::Null => {}
                    _ => return refuse("an image that is not {assetId}"),
                },
                _ => return refuse("an image that is not {assetId}"),
            },
            ([ROOT, card, field @ ("front" | "back")], None) => match content {
                ItemContent::String(text) => {
                    growth.bytes += notes::json::escaped_len(text.as_str()) as u64;
                    *added
                        .entry((Arc::from(*card), Arc::from(*field)))
                        .or_default() += utf16(text.as_str());
                }
                _ => return refuse("anything but plain text in a card face"),
            },
            ([ydoc::CONTRIBUTORS_ROOT], Some(_)) => match content {
                ItemContent::Any(values) if values.iter().all(plain) => {}
                _ => return refuse("a contributor marker that is not plain"),
            },
            _ => return refuse("a struct outside its shape"),
        }
    }
    if !added.is_empty() {
        let root = txn.get_map(ROOT);
        for ((card, field), units) in added {
            let current = root
                .as_ref()
                .and_then(|root| match root.get(txn, &card) {
                    Some(Out::YMap(card)) => match card.get(txn, &field) {
                        Some(Out::YText(text)) => Some(u64::from(text.len(txn))),
                        _ => None,
                    },
                    _ => None,
                })
                .unwrap_or(0);
            let cap = if &*field == "front" {
                MAX_FRONT
            } else {
                MAX_BACK
            } as u64;
            // UTF-16 units bound characters from above.
            if current + units > cap {
                growth.over_cap = true;
            }
        }
    }
    Ok(growth)
}

/// Turns `text` into `next` with the fewest changes: the common prefix and
/// suffix stay, so a writer typing elsewhere in it keeps their characters.
pub fn edit_text(txn: &mut TransactionMut, text: &TextRef, next: &str) {
    let current = text.get_string(txn);
    if current == next {
        return;
    }
    let a: Vec<char> = current.chars().collect();
    let b: Vec<char> = next.chars().collect();
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let mut end = 0;
    while end < a.len() - start
        && end < b.len() - start
        && a[a.len() - 1 - end] == b[b.len() - 1 - end]
    {
        end += 1;
    }
    let units = |chars: &[char]| chars.iter().map(|c| c.len_utf16() as u32).sum::<u32>();
    let at = units(&a[..start]);
    let removed = units(&a[start..a.len() - end]);
    if removed > 0 {
        text.remove_range(txn, at, removed);
    }
    let inserted: String = b[start..b.len() - end].iter().collect();
    if !inserted.is_empty() {
        text.insert(txn, at, &inserted);
    }
}

fn card_map<T: ReadTxn>(txn: &T, root: &MapRef, id: &str) -> Option<MapRef> {
    match root.get(txn, id) {
        Some(Out::YMap(card)) => Some(card),
        _ => None,
    }
}

fn face(txn: &mut TransactionMut, card: &MapRef, field: &str) -> TextRef {
    match card.get(txn, field) {
        Some(Out::YText(text)) => text,
        _ => card.insert(txn, field, TextPrelim::new("")),
    }
}

/// Writes a card's faces and image into an existing card map, minimally.
fn write_card(txn: &mut TransactionMut, card: &MapRef, next: &Card) {
    let front = face(txn, card, "front");
    edit_text(txn, &front, &next.front);
    let back = face(txn, card, "back");
    edit_text(txn, &back, &next.back);
    let current = card_of(txn, "", card).image;
    if current != next.image {
        match &next.image {
            Some(asset) => {
                card.insert(txn, "image", image_any(asset));
            }
            None => {
                card.remove(txn, "image");
            }
        }
    }
}

/// The set holds exactly `desired` afterwards (the card save API): kept
/// cards change only where they differ, new ones go between their
/// neighbours, missing ones go. Cards keep their keys unless the desired
/// order reorders them, which rewrites every key (an order is last write
/// wins, so edits inside the cards stay).
pub fn set_cards(txn: &mut TransactionMut, desired: &[Card]) {
    let root = txn.get_or_insert_map(ROOT);
    let current = cards(txn);
    let keys: HashMap<&str, &str> = current
        .iter()
        .map(|c| (c.id.as_str(), c.order.as_str()))
        .collect();
    let wanted: std::collections::HashSet<&str> = desired.iter().map(|c| c.id.as_str()).collect();
    for card in &current {
        if !wanted.contains(card.id.as_str()) {
            root.remove(txn, &card.id);
        }
    }
    // Kept cards in the desired order must already be in key order.
    let kept: Vec<&str> = desired
        .iter()
        .filter_map(|c| keys.get(c.id.as_str()).copied())
        .collect();
    let in_order = kept.windows(2).all(|w| w[0] < w[1]);
    let mut previous: Option<String> = None;
    for (index, card) in desired.iter().enumerate() {
        let existing = card_map(txn, &root, &card.id);
        let key = match (in_order, keys.get(card.id.as_str())) {
            (true, Some(key)) => (*key).to_owned(),
            (true, None) => {
                let next = desired[index + 1..]
                    .iter()
                    .find_map(|c| keys.get(c.id.as_str()).copied());
                order::between(previous.as_deref(), next)
                    .unwrap_or_else(|| order::after(previous.as_deref()))
            }
            (false, _) => order::after(previous.as_deref()),
        };
        match existing {
            Some(map) => {
                write_card(txn, &map, card);
                if card_of(txn, &card.id, &map).order != key {
                    map.insert(txn, "order", Any::String(Arc::from(key.as_str())));
                }
            }
            None => {
                root.insert(txn, card.id.clone(), card_prelim(card, &key));
            }
        }
        previous = Some(key);
    }
}

fn unavailable<T>(message: String) -> Result<T, EditError> {
    Err(EditError::Edit {
        code: EditErrorCode::UnavailableTarget,
        message,
        details: None,
    })
}

fn invalid<T>(code: EditErrorCode, message: impl Into<String>) -> Result<T, EditError> {
    Err(EditError::Edit {
        code,
        message: message.into(),
        details: None,
    })
}

fn parse_card(node: &Value, what: &str) -> Result<Card, EditError> {
    match card_from_node(node) {
        Some(card) => Ok(card),
        None => invalid(
            EditErrorCode::InvalidInput,
            format!("{what} needs a flashcard"),
        ),
    }
}

/// The agent's card commands (`replace_card`, and `insert_child` and
/// `remove_child` on the `flashcards` parent) on the set document.
pub fn apply_commands(
    txn: &mut TransactionMut,
    commands: &[DocumentCommand],
) -> Result<(), EditError> {
    let root = txn.get_or_insert_map(ROOT);
    for command in commands {
        let ordered = cards(txn);
        match command {
            // Read from the set as the live room holds it, so typing since
            // the agent's inspection stays in a side it leaves out (Epo
            // 2026-10-21); a side it replaces must still read as expected.
            DocumentCommand::ReplaceCard {
                card_id,
                front,
                back,
                expected_front,
                expected_back,
            } => {
                let (Some(current), Some(map)) = (
                    ordered.iter().find(|c| &c.id == card_id),
                    card_map(txn, &root, card_id),
                ) else {
                    return unavailable(format!("{card_id} no longer exists"));
                };
                // Each side is a target of its own (Epo 2026-10-22): only a
                // side the command replaces is held to its expected text.
                let stale = |side: &Option<String>, expected: &Option<String>, live: &str| {
                    side.is_some() && expected.as_ref().is_some_and(|expected| expected != live)
                };
                if stale(front, expected_front, &current.front)
                    || stale(back, expected_back, &current.back)
                {
                    return Err(EditError::Edit {
                        code: EditErrorCode::StaleTarget,
                        message: format!("card {card_id} changed"),
                        details: Some(json!({ "block": {
                            "id": card_id,
                            "text": notes::edit::card_text(&current.front, &current.back),
                            "type": "flashcard",
                        } })),
                    });
                }
                for (field, side) in [("front", front), ("back", back)] {
                    if let Some(side) = side {
                        let text = face(txn, &map, field);
                        edit_text(txn, &text, side);
                    }
                }
            }
            DocumentCommand::InsertChild {
                parent_type,
                after_node_id,
                node,
            } if parent_type == "flashcards" => {
                let mut card = parse_card(node, "insert_child")?;
                if card.id.is_empty() {
                    card.id = format!("card_{}", yrs::uuid_v4().replace('-', ""));
                }
                if !valid_id(&card.id) {
                    return invalid(EditErrorCode::InvalidInput, "invalid card id");
                }
                if ordered.iter().any(|c| c.id == card.id) {
                    return invalid(
                        EditErrorCode::StaleTarget,
                        format!("{} already exists", card.id),
                    );
                }
                let at = match after_node_id {
                    None => 0,
                    Some(after) => match ordered.iter().position(|c| &c.id == after) {
                        Some(i) => i + 1,
                        None => return unavailable(format!("{after} no longer exists")),
                    },
                };
                let before = at.checked_sub(1).map(|i| ordered[i].order.as_str());
                let after = ordered.get(at).map(|c| c.order.as_str());
                let key = order::between(before, after).unwrap_or_else(|| order::after(before));
                root.insert(txn, card.id.clone(), card_prelim(&card, &key));
            }
            DocumentCommand::RemoveChild {
                parent_type,
                node_id,
            } if parent_type == "flashcards" => {
                if !ordered.iter().any(|c| &c.id == node_id) {
                    return unavailable(format!("{node_id} no longer exists"));
                }
                if ordered.len() == 1 {
                    return invalid(
                        EditErrorCode::UnsupportedOperation,
                        "a flashcards block must keep one item",
                    );
                }
                root.remove(txn, node_id);
            }
            _ => {
                return invalid(
                    EditErrorCode::UnsupportedOperation,
                    "use the flashcard commands for this material",
                );
            }
        }
    }
    Ok(())
}
