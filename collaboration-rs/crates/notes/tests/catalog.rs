#![allow(clippy::unwrap_used)] // Tests panic on a broken fixture.
//! The notes crate against the embed catalog (`notes::catalog`, generated
//! from Go's `server/internal/embeds`; openwiki/embeds.md): the store's
//! validator and the room's admission apply its rules to every element it
//! lists and refuse a type it does not list (Epo 2026-10-13), and the
//! shared-text key, the media types, inspect, the reference kinds, each
//! material kind's required element, the figure messages and the index text
//! follow it. A test names what a new element or kind lacks here.

use std::collections::{BTreeMap, BTreeSet};

use notes::index_text::{self, ItemText};
use notes::limits::{self, Refusal, Validator};
use notes::{catalog, edit, material, plate, slate_yjs};
use serde_json::{Value, json};
use yrs::block::ItemContent;
use yrs::branch::BranchPtr;
use yrs::types::TypeRef;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update, Xml, XmlTextRef};

fn read_json(path: &str) -> Value {
    let path = format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn question(name: &str) -> Value {
    read_json(&format!("server/internal/questions/testdata/{name}.json"))["question"].clone()
}

fn leaf() -> Value {
    json!([{ "text": "" }])
}

/// Valid documents of every material kind that together hold every element
/// type the catalog lists (Go's `catalogDocuments`): the every-block note
/// shared with Go and the UAT journey, its imported fences named as rows,
/// plus the transient and newer elements it does not carry; a
/// quiz, a card set and a mindmap.
fn documents() -> BTreeMap<&'static str, Vec<Value>> {
    let fixture = read_json("server/internal/materialdoc/testdata/every-block-note.json");
    let mut note = fixture["value"].as_array().unwrap().clone();
    for node in &mut note {
        if let Some(fence) = node.as_object_mut().filter(|n| n.contains_key("pending")) {
            fence.remove("pending");
            let row = format!("mat_{}", fence["refKind"].as_str().unwrap());
            fence.insert("materialId".into(), json!(row));
        }
    }
    note.extend([
        json!({ "type": "plot", "id": "cat_plot", "block": question("plot")["stem"][1], "children": leaf() }),
        json!({ "type": "placeholder", "id": "cat_upload", "mediaType": "img", "children": leaf() }),
        json!({ "type": "p", "id": "cat_inputs", "children": [
            { "text": "Ask " },
            { "type": "mention_input", "trigger": "@", "children": leaf() },
            { "text": " or " },
            { "type": "slash_input", "trigger": "/", "children": leaf() },
            { "text": "" },
        ] }),
    ]);
    let rich = question("rich-blocks");
    let quiz = vec![json!({ "type": "quiz", "id": "quiz", "children": [
        { "type": "quiz_question", "id": rich["id"], "question": rich, "children": leaf() },
    ] })];
    let card = |id: &str, front: &str, back: &str| {
        json!({ "type": "flashcard", "id": id, "children": [
            { "type": "flashcard_front", "children": [{ "text": front }] },
            { "type": "flashcard_back", "children": [{ "text": back }] },
        ] })
    };
    let mut first = card("c1", "Osmosis", "Water across a membrane");
    first["image"] = json!({ "assetId": "asset_1" });
    let cards = vec![json!({ "type": "flashcards", "id": "cards", "children": [
        first, card("c2", "Diffusion", "Down a gradient"),
    ] })];
    let mindmap = vec![
        json!({ "type": "mermaid", "id": "map", "source": "mindmap\n  root((Cells))", "children": [
        { "type": "mermaid_caption", "children": [{ "text": "Cells" }] },
    ] }),
    ];
    BTreeMap::from([
        ("note", note),
        ("quiz", quiz),
        ("flashcards", cards),
        ("mindmap", mindmap.clone()),
        ("diagram", mindmap),
    ])
}

/// One element of a valid document of a material kind, by its index path
/// from the top level.
#[derive(Clone)]
struct Sample {
    kind: &'static str,
    path: Vec<usize>,
}

/// The first element of each type, the material kinds in the catalog's
/// order (a note's when a note holds one).
fn samples(docs: &BTreeMap<&'static str, Vec<Value>>) -> BTreeMap<String, Sample> {
    fn walk(
        node: &Value,
        path: &mut Vec<usize>,
        kind: &'static str,
        out: &mut BTreeMap<String, Sample>,
    ) {
        if let Some(name) = node["type"].as_str() {
            out.entry(name.to_owned()).or_insert_with(|| Sample {
                kind,
                path: path.clone(),
            });
        }
        for (index, child) in node["children"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            path.push(index);
            walk(child, path, kind, out);
            path.pop();
        }
    }
    let mut out = BTreeMap::new();
    for material in catalog::MATERIAL_KINDS {
        let Some(doc) = docs.get(material.kind) else {
            continue;
        };
        for (index, node) in doc.iter().enumerate() {
            walk(node, &mut vec![index], material.kind, &mut out);
        }
    }
    out
}

fn node_at<'a>(nodes: &'a mut [Value], path: &[usize]) -> &'a mut Value {
    let mut node = &mut nodes[path[0]];
    for &index in &path[1..] {
        node = &mut node["children"][index];
    }
    node
}

/// Every element type the catalog lists is in a fixture, and the store
/// applies the catalog's rules to each: required keys, keys it never
/// carries, a closed field set, top-level placement and the material kinds
/// that may hold it. A type it does not list is refused (decision 1).
#[test]
fn the_store_follows_the_catalog() {
    let docs = documents();
    for material in catalog::MATERIAL_KINDS {
        material::assert_canonical(&docs[material.kind], material.kind)
            .unwrap_or_else(|error| panic!("{} fixture: {error}", material.kind));
    }
    let samples = samples(&docs);
    let mut missing = Vec::new();
    for element in catalog::ELEMENTS {
        let name = element.name;
        let Some(sample) = samples.get(name) else {
            missing.push(name);
            continue;
        };
        let stored = |mutate: &dyn Fn(&mut Vec<Value>)| {
            let mut nodes = docs[sample.kind].clone();
            mutate(&mut nodes);
            material::assert_canonical(&nodes, sample.kind)
        };
        for key in element.required {
            let without = stored(&|nodes| {
                node_at(nodes, &sample.path)
                    .as_object_mut()
                    .unwrap()
                    .remove(*key);
            });
            assert!(without.is_err(), "a {name} without {key} is stored");
        }
        for key in element.forbidden {
            let carrying = stored(&|nodes| node_at(nodes, &sample.path)[*key] = json!("x"));
            assert!(carrying.is_err(), "a {name} carrying {key} is stored");
            // Null counts as absent, as admission reads it, unless a closed
            // field set leaves the key out.
            if element.fields.is_none_or(|fields| fields.contains(key)) {
                let null = stored(&|nodes| node_at(nodes, &sample.path)[*key] = Value::Null);
                assert!(
                    null.is_ok(),
                    "a {name} holding {key} at null is refused: {null:?}"
                );
            }
        }
        if element.fields.is_some() {
            let extra = stored(&|nodes| node_at(nodes, &sample.path)["extra"] = json!("x"));
            assert!(extra.is_err(), "a {name} with an unknown field is stored");
        }
        // Security regression (Epo 2026-10-18): a void element holds one
        // empty text leaf, whatever else it holds instead.
        if element.void {
            for children in [
                json!([{ "text": "hidden" }]),
                json!([{ "type": "p", "children": [{ "text": "hidden" }] }]),
                json!([{ "text": "" }, { "text": "" }]),
            ] {
                let held =
                    stored(&|nodes| node_at(nodes, &sample.path)["children"] = children.clone());
                assert!(held.is_err(), "a {name} holding {children} is stored");
            }
        }
        if element.top_level {
            let nested = stored(&|nodes| {
                let top = nodes[sample.path[0]].take();
                nodes[sample.path[0]] =
                    json!({ "type": "callout", "id": "wrap", "children": [top] });
            });
            assert!(nested.is_err(), "a nested {name} is stored");
        }
        let top = docs[sample.kind][sample.path[0]].clone();
        for material in catalog::MATERIAL_KINDS {
            if element.materials.contains(&material.kind) {
                continue;
            }
            let mut nodes = docs[material.kind].clone();
            nodes.push(top.clone());
            assert!(
                material::assert_canonical(&nodes, material.kind).is_err(),
                "a {} holding a {name} is stored",
                material.kind
            );
        }
    }
    assert!(missing.is_empty(), "no fixture holds {missing:?}");
    let unknown = [json!({ "type": "toggle", "id": "t", "children": [{ "text": "" }] })];
    assert_eq!(
        material::assert_canonical(&unknown, "note").unwrap_err().0,
        "unknown element type \"toggle\""
    );
}

/// A room holding `value`, seeded as the store seeds one.
fn room(value: &[Value]) -> Doc {
    let doc = Doc::with_options(ydoc::doc_options(1));
    doc.transact_mut()
        .apply_update(Update::decode_v1(&slate_yjs::state_from_value(value, 1)).unwrap())
        .unwrap();
    doc
}

/// What a peer's edit sends: its changes since the room's state.
fn edit(room: &Doc, client: u64, change: impl FnOnce(&Doc)) -> Vec<u8> {
    let peer = Doc::with_options(ydoc::doc_options(client));
    let state = room
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    peer.transact_mut()
        .apply_update(Update::decode_v1(&state).unwrap())
        .unwrap();
    change(&peer);
    peer.transact()
        .encode_state_as_update_v1(&room.transact().state_vector())
}

/// The element at `path` (indexes of Plate children from the top level).
fn element_at<T: ReadTxn>(txn: &T, path: &[usize]) -> BranchPtr {
    let mut branch = plate::content_root(txn).unwrap();
    for &index in path {
        branch = match &plate::insert_delta(&branch).unwrap()[index].insert {
            plate::Insert::Element(inner) => *inner,
            plate::Insert::Text(_) => panic!("{path:?} is a text"),
        };
    }
    branch
}

fn admit(room: &Doc, update: &[u8]) -> Result<limits::Admission, Refusal> {
    Validator::new("note").admit(room, &Update::decode_v1(update).unwrap())
}

/// Whether some Plate room (a note, mindmap or diagram) may hold the element.
fn plate_element(element: &catalog::Element) -> bool {
    catalog::MATERIAL_KINDS
        .iter()
        .any(|kind| !kind.item && element.materials.contains(&kind.kind))
}

fn refused_as(result: Result<limits::Admission, Refusal>, reason: &str) -> bool {
    matches!(result, Err(Refusal::Content(what)) if what == reason)
}

/// Room admission against the catalog, so that what a writer may send is
/// what the store takes (an update the store refuses would discard the
/// room's unsaved state for every co-editor): a block type the catalog does
/// not list for a note is refused, created or retyped (decision 1);
/// `OWN_KEYS` is the catalog's required keys; and each element of the
/// every-block note losing a required key or gaining a forbidden one is
/// refused, a nested mermaid's id among them. Fails if any check is
/// reverted.
#[test]
fn admission_follows_the_catalog() {
    let docs = documents();
    let note = &docs["note"];
    let room = room(note);
    let paragraph = note.iter().position(|node| node["type"] == "p").unwrap();
    let unlisted = |update: &[u8]| refused_as(admit(&room, update), limits::UNLISTED_TYPE);
    let names = catalog::ELEMENTS.iter().map(|element| element.name);
    for name in names.chain(["toggle", "image", "diagram"]) {
        let retyped = edit(&room, 2, |peer| {
            let block = XmlTextRef::from(element_at(&peer.transact(), &[paragraph]));
            block.insert_attribute(&mut peer.transact_mut(), "type", name);
        });
        assert_eq!(
            unlisted(&retyped),
            !limits::may_hold("note", name),
            "a paragraph retyped {name}"
        );
    }
    for name in ["quiz", "quiz_question", "flashcards", "flashcard", "toggle"] {
        assert!(!limits::may_hold("note", name), "{name}");
    }
    let inserted = edit(&room, 3, |peer| {
        let mut txn = peer.transact_mut();
        let root = plate::content_root(&txn).unwrap();
        slate_yjs::insert_nodes(
            &mut txn,
            root,
            0,
            &[json!({ "type": "toggle", "id": "t", "children": [{ "text": "x" }] })],
        );
    });
    assert!(unlisted(&inserted), "a new toggle block");

    let own: BTreeMap<&str, BTreeSet<&str>> = limits::OWN_KEYS
        .iter()
        .map(|(name, keys)| (*name, keys.iter().copied().collect()))
        .collect();
    let required: BTreeMap<&str, BTreeSet<&str>> = catalog::ELEMENTS
        .iter()
        .filter(|element| plate_element(element))
        .map(|element| {
            // A top-level block's id is required of every top-level block, a
            // media block's asset id by its own check.
            let keys = element.required.iter().copied().filter(|key| {
                !(element.top_level && *key == "id")
                    && !material::MEDIA_TYPES.contains(&element.name)
            });
            (element.name, keys.collect::<BTreeSet<_>>())
        })
        .filter(|(_, keys)| !keys.is_empty())
        .collect();
    assert_eq!(own, required);

    let samples = samples(&BTreeMap::from([("note", note.clone())]));
    for element in catalog::ELEMENTS
        .iter()
        .filter(|e| limits::may_hold("note", e.name))
    {
        let name = element.name;
        let sample = &samples
            .get(name)
            .unwrap_or_else(|| panic!("the note holds no {name}"))
            .path;
        for key in element.required {
            let unset = edit(&room, 4, |peer| {
                let block = XmlTextRef::from(element_at(&peer.transact(), sample));
                block.remove_attribute(&mut peer.transact_mut(), &(*key).to_owned());
            });
            assert!(
                admit(&room, &unset).is_err(),
                "a {name} without {key} is admitted"
            );
        }
        for key in element.forbidden {
            let set = edit(&room, 5, |peer| {
                let block = XmlTextRef::from(element_at(&peer.transact(), sample));
                block.insert_attribute(&mut peer.transact_mut(), *key, "x");
            });
            assert!(
                admit(&room, &set).is_err(),
                "a {name} carrying {key} is admitted"
            );
        }
    }

    // A nested mermaid keeps its id: the store refuses one without.
    let nested = [json!({ "type": "column_group", "id": "cols", "children": [
        { "type": "column", "children": [
            { "type": "mermaid", "id": "m", "source": "flowchart LR\n  A --> B", "children": [
                { "type": "mermaid_caption", "children": [{ "text": "" }] },
            ] },
        ] },
    ] })];
    let mut stored = nested.clone();
    stored[0]["children"][0]["children"][0]
        .as_object_mut()
        .unwrap()
        .remove("id");
    assert!(material::assert_canonical(&stored, "note").is_err());
    let columns = self::room(&nested);
    let unset = edit(&columns, 6, |peer| {
        let block = XmlTextRef::from(element_at(&peer.transact(), &[0, 0, 0]));
        block.remove_attribute(&mut peer.transact_mut(), &"id".to_owned());
    });
    assert!(
        matches!(admit(&columns, &unset), Err(Refusal::Content(what)) if what == limits::MISSING_KEY)
    );
}

/// A closed element (chart, plot, graph, html_embed) carries its fields and
/// nothing else, as the store requires: a key outside them is refused at
/// admission whether written on a held one or held by a block retyped to one,
/// while a field (a chart's width) goes in with no copy of the room. And a
/// room admits only the types the catalog lists for its material kind: a
/// reference goes into a note, not into a mindmap or diagram. Fails if
/// either check is reverted.
#[test]
fn admission_follows_closed_fields_and_the_material_kind() {
    let docs = documents();
    let note = &docs["note"];
    let room = room(note);
    let samples = samples(&BTreeMap::from([("note", note.clone())]));
    let set = |path: &[usize], key: &'static str, value: &'static str| {
        edit(&room, 7, |peer| {
            let block = XmlTextRef::from(element_at(&peer.transact(), path));
            block.insert_attribute(&mut peer.transact_mut(), key, value);
        })
    };
    let closed: Vec<&catalog::Element> = catalog::ELEMENTS
        .iter()
        .filter(|e| e.fields.is_some() && limits::may_hold("note", e.name))
        .collect();
    assert!(!closed.is_empty());
    for element in closed {
        let path = &samples[element.name].path;
        for key in ["extra", "indent", "width", "caption", "html", "block"] {
            if element.fields.is_some_and(|fields| fields.contains(&key)) {
                continue;
            }
            assert!(
                refused_as(admit(&room, &set(path, key, "x")), limits::UNEXPECTED_KEY),
                "a {} given {key}",
                element.name
            );
        }
    }
    let chart = &samples["chart"].path;
    let mut validator = Validator::new("note");
    let resized = set(chart, "width", "50%");
    assert!(
        validator
            .admit(&room, &Update::decode_v1(&resized).unwrap())
            .is_ok()
    );
    assert_eq!(validator.media_copies, 0, "a chart's width takes no copy");

    let block = docs["note"].iter().find(|n| n["type"] == "chart").unwrap()["block"].clone();
    let indented = self::room(&[
        json!({ "type": "p", "id": "p", "indent": 1, "block": block, "children": [{ "text": "" }] }),
    ]);
    let retyped = edit(&indented, 8, |peer| {
        let block = XmlTextRef::from(element_at(&peer.transact(), &[0]));
        block.insert_attribute(&mut peer.transact_mut(), "type", "chart");
    });
    assert!(refused_as(
        admit(&indented, &retyped),
        limits::UNEXPECTED_KEY
    ));

    let reference = json!({ "type": "material_ref", "id": "r", "materialId": "m", "refKind": "quiz", "children": [{ "text": "" }] });
    for kind in ["note", "mindmap", "diagram"] {
        let map = self::room(&docs["mindmap"]);
        let inserted = edit(&map, 9, |peer| {
            let mut txn = peer.transact_mut();
            let root = plate::content_root(&txn).unwrap();
            slate_yjs::insert_nodes(&mut txn, root, 1, std::slice::from_ref(&reference));
        });
        let answer = Validator::new(kind).admit(&map, &Update::decode_v1(&inserted).unwrap());
        assert_eq!(
            refused_as(answer, limits::UNLISTED_TYPE),
            kind != "note",
            "a reference in a {kind}"
        );
    }
}

/// Two writers race on a held plot's `type`: one sets `plot` again, the
/// other (from the state before, losing Yjs's order to the higher client)
/// sets `p` with an extra key. The result is a plot carrying the extra key,
/// which the store refuses, so admission refuses it on a copy whatever the
/// losing `type` says (review M3). Fails if a written type skips the check.
#[test]
fn a_losing_type_write_cannot_slip_an_extra_key_past_admission() {
    let docs = documents();
    let note = &docs["note"];
    let room = room(note);
    let plot = samples(&BTreeMap::from([("note", note.clone())]))["plot"]
        .path
        .clone();
    let losing = edit(&room, 10, |peer| {
        let block = XmlTextRef::from(element_at(&peer.transact(), &plot));
        let mut txn = peer.transact_mut();
        block.insert_attribute(&mut txn, "type", "p");
        block.insert_attribute(&mut txn, "extra", "x");
    });
    let winning = edit(&room, 20, |peer| {
        let block = XmlTextRef::from(element_at(&peer.transact(), &plot));
        block.insert_attribute(&mut peer.transact_mut(), "type", "plot");
    });
    assert!(admit(&room, &winning).is_ok());
    room.transact_mut()
        .apply_update(Update::decode_v1(&winning).unwrap())
        .unwrap();
    assert!(refused_as(admit(&room, &losing), limits::UNEXPECTED_KEY));
}

/// What else the store refuses, refused as the update arrives (review M4): a
/// top-level-only block (a figure, an interactive block) created below the
/// top level; an eleventh interactive block; and the values the store checks
/// beyond presence (a reference's kind, a video's provider and id, a width,
/// an interactive block's html size, a figure's block, a Mermaid source),
/// while valid ones go in. Fails if any check is reverted.
#[test]
fn admission_checks_placement_values_and_the_embed_count() {
    let docs = documents();
    let note = &docs["note"];
    let room = room(note);
    let samples = samples(&BTreeMap::from([("note", note.clone())]));
    let insert = |room: &Doc, nodes: Vec<Value>| {
        edit(room, 11, |peer| {
            let mut txn = peer.transact_mut();
            let root = plate::content_root(&txn).unwrap();
            slate_yjs::insert_nodes(&mut txn, root, 0, &nodes);
        })
    };
    let chart = note.iter().find(|n| n["type"] == "chart").unwrap().clone();
    let html = note
        .iter()
        .find(|n| n["type"] == "html_embed")
        .unwrap()
        .clone();
    for nested in [chart.clone(), html.clone()] {
        let callout = json!({ "type": "callout", "id": "wrap", "children": [nested] });
        assert!(
            refused_as(
                admit(&room, &insert(&room, vec![callout])),
                limits::NESTED_BLOCK
            ),
            "a nested {}",
            nested["type"]
        );
    }

    let embed = |n: usize| {
        let mut node = html.clone();
        node["id"] = json!(format!("h{n}"));
        node
    };
    let nine = self::room(&(0..9).map(embed).collect::<Vec<_>>());
    let tenth = insert(&nine, vec![embed(9)]);
    assert!(admit(&nine, &tenth).is_ok());
    nine.transact_mut()
        .apply_update(Update::decode_v1(&tenth).unwrap())
        .unwrap();
    assert!(refused_as(
        admit(&nine, &insert(&nine, vec![embed(10)])),
        limits::TOO_MANY_EMBEDS
    ));

    let set = |name: &str, key: &'static str, value: yrs::Any| {
        let path = samples[name].path.clone();
        edit(&room, 12, move |peer| {
            let block = XmlTextRef::from(element_at(&peer.transact(), &path));
            block.insert_attribute(&mut peer.transact_mut(), key, value);
        })
    };
    let text = |value: &str| yrs::Any::String(value.into());
    let refused = [
        ("material_ref", "refKind", text("toggle")),
        ("video", "provider", text("vimeo")),
        ("video", "videoId", text("short")),
        ("chart", "width", text("15%")),
        ("img", "width", text("100")),
        (
            "html_embed",
            "html",
            text(&"x".repeat(catalog::HTML_EMBED_MAX_BYTES + 1)),
        ),
        ("html_embed", "caption", yrs::Any::Number(1.0)),
        (
            "html_embed",
            "caption",
            text(&"c".repeat(catalog::BLOCK_CAPTION_MAX + 1)),
        ),
        ("mermaid", "source", yrs::Any::Number(1.0)),
        (
            "p",
            "indent",
            yrs::Any::Number((catalog::LIST_INDENT_MAX + 1) as f64),
        ),
    ];
    // A figure's block is its live map only, never one plain value
    // (Epo 2026-10-18).
    assert!(refused_as(
        admit(&room, &set("chart", "block", text("not a block"))),
        limits::PLAIN_BLOCK
    ));
    for (name, key, value) in refused {
        assert!(
            refused_as(
                admit(&room, &set(name, key, value.clone())),
                limits::BAD_VALUE
            ),
            "a {name}'s {key} {value:?}"
        );
    }
    let accepted = [
        ("material_ref", "refKind", text("flashcards")),
        ("video", "videoId", text("aaaaaaaaaaa")),
        ("chart", "width", text("100%")),
        ("html_embed", "caption", text("New caption")),
        (
            "html_embed",
            "caption",
            text(&"c".repeat(catalog::BLOCK_CAPTION_MAX)),
        ),
        (
            "p",
            "indent",
            yrs::Any::Number(catalog::LIST_INDENT_MAX as f64),
        ),
    ];
    for (name, key, value) in accepted {
        assert!(
            admit(&room, &set(name, key, value.clone())).is_ok(),
            "a {name}'s {key} {value:?}"
        );
    }
}

/// Any block's indent stops at the catalog's `LIST_INDENT_MAX` in the
/// store (Epo 2026-10-18), with Go's message; room admission refuses a
/// deeper one written (`admission_checks_placement_values_and_the_embed_count`).
#[test]
fn a_block_indent_stops_at_the_catalog_max() {
    let item = |indent: usize| {
        [
            json!({ "type": "p", "id": "l1", "indent": indent, "listStyleType": "disc",
            "children": [{ "text": "deep" }] }),
        ]
    };
    material::assert_canonical(&item(catalog::LIST_INDENT_MAX), "note").unwrap();
    assert_eq!(
        material::assert_canonical(&item(catalog::LIST_INDENT_MAX + 1), "note")
            .unwrap_err()
            .0,
        format!("indent is over {} levels", catalog::LIST_INDENT_MAX)
    );
}

/// The catalog's one shared-text key is the one the projection, the
/// growth bound, admission and the seed hold as a text, and the seed makes it
/// a text on that element alone; its shared maps (a figure's `block`) are
/// maps on those elements alone, their lists lists of maps.
#[test]
fn the_shared_keys_are_the_catalogs() {
    let shared: Vec<(&str, &[&str])> = catalog::ELEMENTS
        .iter()
        .filter(|element| !element.shared_text.is_empty())
        .map(|element| (element.name, element.shared_text))
        .collect();
    assert_eq!(shared, [("mermaid", &["source"][..])]);
    assert!(plate::holds_text("mermaid", "source") && !plate::holds_text("p", "source"));
    let value = [
        json!({ "type": "mermaid", "id": "m", "source": "flowchart LR", "children": [
            { "type": "mermaid_caption", "children": [{ "text": "" }] },
        ] }),
        json!({ "type": "p", "id": "p", "source": "plain", "children": [{ "text": "x" }] }),
    ];
    let doc = room(&value);
    let txn = doc.transact();
    let held = |index: usize, key: &str, kind: TypeRef| {
        element_at(&txn, &[index]).entry_item(key).is_some_and(
            |item| matches!(item.content(), ItemContent::Type(branch) if *branch.type_ref() == kind),
        )
    };
    assert!(held(0, "source", TypeRef::Text) && !held(1, "source", TypeRef::Text));
    assert_eq!(plate::value(&txn).unwrap(), value);
    drop(txn);

    let docs = documents();
    let figures: Vec<&catalog::Element> = catalog::ELEMENTS
        .iter()
        .filter(|element| !element.shared_map.is_empty())
        .collect();
    assert_eq!(
        figures
            .iter()
            .map(|element| element.name)
            .collect::<Vec<_>>(),
        ["chart", "plot", "graph"]
    );
    for element in &figures {
        assert_eq!(element.shared_map, ["block"]);
        let node = docs["note"]
            .iter()
            .find(|node| node["type"] == element.name)
            .unwrap();
        let mut paragraph = node.clone();
        paragraph["type"] = json!("p");
        let value = [node.clone(), paragraph];
        let doc = room(&value);
        let txn = doc.transact();
        assert!(map_held(&txn, 0, element.shared_lists), "{}", element.name);
        assert!(!map_held(&txn, 1, &[]), "a paragraph's block");
        assert_eq!(plate::value(&txn).unwrap(), value);
    }
    fn map_held<T: ReadTxn>(txn: &T, index: usize, lists: &[&str]) -> bool {
        let Some(item) = element_at(txn, &[index]).entry_item("block") else {
            return false;
        };
        let ItemContent::Type(map) = item.content() else {
            return false;
        };
        let map = BranchPtr::from(map.as_ref());
        *map.type_ref() == TypeRef::Map
            && lists.iter().all(|key| {
                map.entry_item(key).is_some_and(|list| {
                    matches!(list.content(), ItemContent::Type(list) if *list.type_ref() == TypeRef::Array)
                })
            })
    }
}

/// One media list: the blocks naming their file are the catalog's elements
/// requiring `assetId`, and what an agent's edit may not insert adds the
/// video, which forbids one.
#[test]
fn the_media_types_are_the_catalogs() {
    let naming: BTreeSet<&str> = catalog::ELEMENTS
        .iter()
        .filter(|element| element.required.contains(&"assetId"))
        .map(|element| element.name)
        .collect();
    assert_eq!(BTreeSet::from(material::MEDIA_TYPES), naming);
    for element in catalog::ELEMENTS {
        let asset = element.required.contains(&"assetId") || element.forbidden.contains(&"assetId");
        assert_eq!(edit::media_type(element.name), asset, "{}", element.name);
    }
}

/// `inspect_document` prints what each embed kind holds (a figure's block,
/// the mermaid source, the interactive caption, a reference's row and kind):
/// a plot's block was missing.
#[test]
fn inspect_prints_every_embed_kind() {
    let docs = documents();
    let note = &docs["note"];
    let doc = room(note);
    let inspected = edit::inspect_material(&doc.transact()).unwrap();
    for embed in catalog::EMBEDS {
        let at = note
            .iter()
            .position(|node| {
                node["type"] == embed.element
                    && (embed.class != "item" || node["refKind"] == embed.kind)
            })
            .unwrap_or_else(|| panic!("the note holds no {}", embed.kind));
        let printed = inspected[at]
            .properties
            .as_ref()
            .is_some_and(|properties| properties.keys().any(|key| key != "media"));
        assert!(printed, "inspect prints nothing of a {}", embed.kind);
    }
}

/// A reference names one of the catalog's item kinds.
#[test]
fn reference_kinds_are_the_catalogs_items() {
    for kind in catalog::MATERIAL_KINDS
        .iter()
        .map(|k| k.kind)
        .chain(["toggle"])
    {
        let reference = json!({ "type": "material_ref", "id": "r", "materialId": "m", "refKind": kind, "children": leaf() });
        let stored = material::assert_canonical(&[reference], "note");
        let item = catalog::material_kind(kind).is_some_and(|k| k.item);
        assert_eq!(stored.is_ok(), item, "{kind}: {stored:?}");
    }
}

/// Each material kind holds the element the catalog requires of it (a
/// mermaid for a mindmap or diagram); a kind it does not list is refused.
#[test]
fn each_material_kind_holds_what_the_catalog_requires() {
    let paragraph = [json!({ "type": "p", "id": "p", "children": [{ "text": "x" }] })];
    for material in catalog::MATERIAL_KINDS {
        let stored = material::assert_canonical(&paragraph, material.kind);
        match material.requires {
            Some(_) => assert_eq!(
                stored.unwrap_err().0,
                format!("{} element is required", material.kind)
            ),
            None => stored.unwrap(),
        }
    }
    assert_eq!(
        material::assert_canonical(&paragraph, "x").unwrap_err().0,
        "unknown material kind \"x\""
    );
}

/// The store's figure messages are Go's word for word ("chart, plot and
/// graph"): agents read both.
#[test]
fn figure_messages_are_gos() {
    let go = std::fs::read_to_string(format!(
        "{}/../../../server/internal/materialdoc/document.go",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let docs = documents();
    let chart = docs["note"]
        .iter()
        .find(|node| node["type"] == "chart")
        .unwrap()
        .clone();
    let mut texted = chart.clone();
    texted["children"] = json!([{ "text": "x" }]);
    let nested = json!({ "type": "callout", "id": "wrap", "children": [chart] });
    for document in [nested, texted] {
        let message = material::assert_canonical(&[document], "note")
            .unwrap_err()
            .0;
        assert!(
            go.contains(&format!("\"{message}\"")),
            "Go never says {message:?}"
        );
    }
}

/// What every catalog element gives the index text is its catalog rule
/// (`index_text`, Go's `TestIndexTextFollowsTheCatalog`): a probe carrying
/// a marker wherever a rule reads (its children, a figure's block, the
/// Mermaid source, a question, a referenced item) shows it unless the rule
/// is `none`. A type the catalog does not list gives its text, as the View
/// shows an unsupported block's. The rule itself is a generated enum, so an
/// element without one, or with one `index_text` does not handle, does not
/// build.
#[test]
fn index_text_follows_the_catalog() {
    struct Marked;
    impl ItemText for Marked {
        fn item_text(&self, _: &str) -> Option<String> {
            Some("marker".into())
        }
    }
    let probe = |name: &str| {
        let note = json!({ "schemaVersion": 1, "value": [{
            "type": name, "id": "probe", "materialId": "m", "source": "marker",
            "block": { "type": name, "title": "marker", "description": "marker" },
            "question": { "stem": [{ "type": "text", "text": "marker" }] },
            "children": [{ "type": "p", "children": [{ "text": "marker" }] }],
        }] });
        index_text::join(&index_text::from_content(&note, &Marked))
    };
    for element in catalog::ELEMENTS {
        let text = probe(element.name);
        assert_eq!(
            text.contains("marker"),
            element.index != catalog::Index::None,
            "a {} ({:?}) gives {text:?}",
            element.name,
            element.index
        );
    }
    assert_eq!(probe("toggle"), "marker");
}
