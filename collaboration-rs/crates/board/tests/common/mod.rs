//! A canvas room and tabs over it, and the board's content as BlockSuite's
//! own model code writes it (blocksuite-fields.md beside the branch's notes,
//! read from vendor/blocksuite), for the board crate's tests.
#![allow(clippy::unwrap_used, dead_code)] // Tests panic on a broken case; each file uses a part.

use yrs::updates::decoder::Decode;
use yrs::{
    Any, Array, ArrayPrelim, Doc, Map, MapPrelim, MapRef, Out, ReadTxn, StateVector, TextPrelim,
    Transact, TransactionMut, Update, any,
};

/// The board's first state, as every canvas starts (the server's fixture,
/// pinned by the editor's `boardFirstState.test.ts`).
pub const FIRST_STATE: &[u8] = include_bytes!("../../../server/fixtures/board-first-state.bin");

/// A canvas room as it loads a fresh canvas.
pub fn room() -> Doc {
    let room = Doc::with_options(ydoc::doc_options(900));
    ydoc::replay(&room, FIRST_STATE, &[] as &[Vec<u8>]).unwrap();
    room
}

/// A tab's document holding the room's state, writing under `client`.
pub fn tab(room: &Doc, client: u64) -> Doc {
    let tab = Doc::with_options(ydoc::doc_options(client));
    ydoc::replay(&tab, &whole(room), &[] as &[Vec<u8>]).unwrap();
    tab
}

pub fn whole(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// The update of `edit` on `tab`.
pub fn update(tab: &Doc, edit: impl FnOnce(&Doc)) -> Vec<u8> {
    let before = tab.transact().state_vector();
    edit(tab);
    tab.transact().encode_state_as_update_v1(&before)
}

/// The board's checks of `bytes` as the room runs them: placed within its
/// work budget and depth, then [board::admit_shapes] with the copy the
/// placement tried past a small edit. Unheld updates are a test's mistake.
pub fn admit(room: &Doc, bytes: &[u8]) -> Result<(), String> {
    let update = ydoc::decode(bytes).unwrap();
    let txn = room.transact();
    let incoming = ydoc::Incoming::new(&update);
    let bounds = ydoc::Bounds {
        depth: board::DEPTH,
    };
    let inspection = ydoc::inspect_bounded(&txn, &incoming, bounds).map_err(|e| e.to_string())?;
    assert!(!inspection.unheld, "the room cannot place the update yet");
    board::admit_shapes(&txn, &incoming, inspection.trial.as_ref())
}

/// [admit], applied to the room when admitted, as the room does.
pub fn send(room: &Doc, bytes: &[u8]) -> Result<(), String> {
    admit(room, bytes)?;
    room.transact_mut()
        .apply_update(Update::decode_v1(bytes).unwrap())
        .unwrap();
    Ok(())
}

/// A value as BlockSuite stores it under a key: plain, a Y.Text, a Y.Map of
/// such values, a Y.Array of plain values.
#[derive(Clone, Debug)]
pub enum F {
    A(Any),
    T(String),
    M(Vec<(String, F)>),
    L(Vec<Any>),
}

pub fn a(value: Any) -> F {
    F::A(value)
}

pub fn t(text: &str) -> F {
    F::T(text.to_owned())
}

pub fn m(entries: &[(&str, F)]) -> F {
    F::M(
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect(),
    )
}

/// The fields of an entity, by key.
pub type Fields = Vec<(String, F)>;

pub fn fields(entries: &[(&str, F)]) -> Fields {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

/// Writes `field` under `key` of `map`.
pub fn put(txn: &mut TransactionMut, map: &MapRef, key: &str, field: &F) {
    match field {
        F::A(value) => {
            map.insert(txn, key, value.clone());
        }
        F::T(text) => {
            map.insert(txn, key, TextPrelim::new(text.as_str()));
        }
        F::M(entries) => {
            let inner = map.insert(txn, key, MapPrelim::default());
            for (key, value) in entries {
                put(txn, &inner, key, value);
            }
        }
        F::L(values) => {
            let list = map.insert(txn, key, ArrayPrelim::default());
            for value in values {
                list.push_back(txn, value.clone());
            }
        }
    }
}

pub fn map_at<T: ReadTxn>(txn: &T, map: &MapRef, key: &str) -> MapRef {
    match map.get(txn, key) {
        Some(Out::YMap(inner)) => inner,
        other => panic!("{key} is no map: {other:?}"),
    }
}

/// The canvas's map of elements by id.
pub fn elements<T: ReadTxn>(doc: &Doc, txn: &T) -> MapRef {
    let blocks = txn.get_map(board::ROOT).unwrap();
    let _ = doc;
    let surface = map_at(txn, &blocks, "surface");
    let holder = map_at(txn, &surface, "prop:elements");
    map_at(txn, &holder, "value")
}

/// Adds element `id` as `surface.addElement` does: a map under its id.
pub fn add_element(doc: &Doc, id: &str, fields: &Fields) {
    let value = elements(doc, &doc.transact());
    let mut txn = doc.transact_mut();
    let element = value.insert(&mut txn, id, MapPrelim::default());
    for (key, field) in fields {
        put(&mut txn, &element, key, field);
    }
}

/// Writes `fields` over element `id`'s keys.
pub fn set_element(doc: &Doc, id: &str, fields: &Fields) {
    let value = elements(doc, &doc.transact());
    let element = map_at(&doc.transact(), &value, id);
    let mut txn = doc.transact_mut();
    for (key, field) in fields {
        put(&mut txn, &element, key, field);
    }
}

pub fn remove_element(doc: &Doc, id: &str) {
    let value = elements(doc, &doc.transact());
    value.remove(&mut doc.transact_mut(), id);
}

/// Adds block `id` as the store's `addBlock` does: its map (flavour,
/// children, props) under its id, and its id at the end of `parent`'s
/// children.
pub fn add_block(doc: &Doc, id: &str, flavour: &str, parent: Option<&str>, props: &Fields) {
    let blocks = doc.get_or_insert_map(board::ROOT);
    let mut txn = doc.transact_mut();
    let block = blocks.insert(&mut txn, id, MapPrelim::default());
    block.insert(&mut txn, "sys:flavour", flavour);
    block.insert(&mut txn, "sys:children", ArrayPrelim::default());
    for (key, field) in props {
        put(&mut txn, &block, key, field);
    }
    if let Some(parent) = parent {
        let parent = map_at(&txn, &blocks, parent);
        let Some(Out::YArray(children)) = parent.get(&txn, "sys:children") else {
            panic!("no children");
        };
        children.push_back(&mut txn, id);
    }
}

/// Writes `props` over block `id`'s keys.
pub fn set_block(doc: &Doc, id: &str, props: &Fields) {
    let blocks = doc.get_or_insert_map(board::ROOT);
    let block = map_at(&doc.transact(), &blocks, id);
    let mut txn = doc.transact_mut();
    for (key, field) in props {
        put(&mut txn, &block, key, field);
    }
}

pub fn place() -> F {
    a(any!("[10,20,200,100]"))
}

/// The base fields `surface.addElement` writes on every element.
fn base(kind: &str, id: &str) -> Vec<(&'static str, F)> {
    vec![
        ("type", a(Any::from(kind))),
        ("id", a(Any::from(id))),
        ("index", a(any!("a0"))),
        ("seed", a(any!(1_234_567))),
    ]
}

fn element(kind: &str, id: &str, own: &[(&'static str, F)]) -> Fields {
    let mut all = base(kind, id);
    all.extend(own.iter().cloned());
    fields(&all)
}

/// A keyed list's entry: `{order, element}` under the element's id.
pub fn keyed(order: &str, element: Any) -> Any {
    any!({ "order": order, "element": element })
}

/// Every element type as BlockSuite's model code (and Capy's for the plane,
/// chart and formula cards) writes it under `id`, `undefined` included where
/// a field has no initializer.
pub fn editor_elements(id: &str) -> Vec<(&'static str, Fields)> {
    let undefined = || a(Any::Undefined);
    vec![
        (
            "brush",
            element(
                "brush",
                id,
                &[
                    ("color", a(any!({ "dark": "#ffffff", "light": "#000000" }))),
                    ("lineWidth", a(any!(4))),
                    ("points", a(any!([[0, 0], [1.5, 2.25, 0.5], [3, 4]]))),
                    ("rotate", a(any!(0))),
                    ("xywh", place()),
                ],
            ),
        ),
        (
            "highlighter",
            element(
                "highlighter",
                id,
                &[
                    ("color", a(any!("#84cfff4d"))),
                    ("lineWidth", a(any!(18))),
                    ("points", a(any!([[0, 0], [10, 10]]))),
                    ("rotate", a(any!(0))),
                    ("xywh", place()),
                ],
            ),
        ),
        (
            "shape",
            element(
                "shape",
                id,
                &[
                    ("color", undefined()),
                    ("fillColor", a(any!("--affine-palette-shape-yellow"))),
                    ("filled", a(any!(true))),
                    ("fontFamily", undefined()),
                    ("fontSize", undefined()),
                    ("fontStyle", undefined()),
                    ("fontWeight", undefined()),
                    ("maxWidth", a(any!(false))),
                    ("padding", a(any!([10, 20]))),
                    ("radius", a(any!(0))),
                    ("rotate", a(any!(0))),
                    ("roughness", a(any!(1.4))),
                    ("shadow", a(Any::Null)),
                    ("shapeStyle", a(any!("General"))),
                    ("shapeType", a(any!("hexagon"))),
                    ("strokeColor", a(any!({ "normal": "#1e96eb" }))),
                    ("strokeStyle", a(any!("solid"))),
                    ("strokeWidth", a(any!(4))),
                    ("text", t("Hi")),
                    ("textAlign", undefined()),
                    ("textHorizontalAlign", undefined()),
                    ("textResizing", a(any!(1))),
                    ("textVerticalAlign", undefined()),
                    ("xywh", place()),
                ],
            ),
        ),
        (
            "connector",
            element(
                "connector",
                id,
                &[
                    ("frontEndpointStyle", a(any!("None"))),
                    ("rearEndpointStyle", a(any!("Arrow"))),
                    (
                        "labelConstraints",
                        a(any!({ "hasMaxWidth": true, "maxWidth": 280 })),
                    ),
                    ("labelDisplay", a(any!(true))),
                    (
                        "labelOffset",
                        a(any!({ "distance": 0.5, "anchor": "center" })),
                    ),
                    (
                        "labelStyle",
                        a(any!({
                            "color": { "dark": "#fff", "light": "#000" },
                            "fontFamily": "blocksuite:surface:Inter",
                            "fontSize": 16, "fontStyle": "normal", "fontWeight": "400",
                            "textAlign": "center"
                        })),
                    ),
                    ("labelXYWH", a(any!([10, 10, 40, 20]))),
                    ("mode", a(any!(2))),
                    ("rough", undefined()),
                    ("roughness", a(any!(1.4))),
                    ("source", a(any!({ "position": [0, 0] }))),
                    ("target", a(any!({ "id": "elsewhere" }))),
                    ("stroke", a(any!("--affine-palette-line-grey"))),
                    ("strokeStyle", a(any!("solid"))),
                    ("strokeWidth", a(any!(4))),
                    ("text", t("label")),
                ],
            ),
        ),
        (
            "text",
            element(
                "text",
                id,
                &[
                    ("color", a(any!("#000"))),
                    ("fontFamily", a(any!("blocksuite:surface:Inter"))),
                    ("fontSize", a(any!(24.5))),
                    ("fontStyle", a(any!("normal"))),
                    ("fontWeight", a(any!("400"))),
                    ("hasMaxWidth", a(any!(false))),
                    ("rotate", a(any!(0))),
                    ("text", t("words")),
                    ("textAlign", a(any!("center"))),
                    ("xywh", place()),
                ],
            ),
        ),
        (
            "group",
            element(
                "group",
                id,
                &[
                    (
                        "children",
                        m(&[("one", a(any!(true))), ("two", a(any!(true)))]),
                    ),
                    ("title", t("Group 1")),
                ],
            ),
        ),
        (
            "mindmap",
            element(
                "mindmap",
                id,
                &[
                    (
                        "children",
                        m(&[
                            ("root", a(any!({ "index": "a0", "parent": Any::Undefined }))),
                            (
                                "leaf",
                                a(any!({ "index": "a1", "parent": "root", "collapsed": false })),
                            ),
                        ]),
                    ),
                    ("layoutType", a(any!(0))),
                    ("style", a(any!(1))),
                ],
            ),
        ),
        (
            "plane",
            element(
                "plane",
                id,
                &[
                    ("fit", a(any!(true))),
                    (
                        "elements",
                        m(&[
                            (
                                "p1",
                                a(keyed(
                                    "a0",
                                    any!({ "id": "p1", "type": "point", "coords": [1, 2] }),
                                )),
                            ),
                            (
                                "p2",
                                a(keyed(
                                    "a1",
                                    any!({ "id": "p2", "type": "point", "coords": [3, -1], "name": "B" }),
                                )),
                            ),
                            (
                                "s1",
                                a(keyed(
                                    "a2",
                                    any!({ "id": "s1", "type": "segment", "points": ["p1", "p2"] }),
                                )),
                            ),
                        ]),
                    ),
                    ("polar", a(any!(false))),
                    ("ppu", a(any!(40))),
                    ("rotate", a(any!(0))),
                    ("x0", a(any!(0))),
                    ("y0", a(any!(0))),
                    ("xywh", place()),
                ],
            ),
        ),
        (
            "chart",
            element(
                "chart",
                id,
                &[
                    ("axisMax", a(any!(10))),
                    ("axisStep", a(any!(2))),
                    (
                        "bars",
                        m(&[(
                            "b1",
                            a(keyed(
                                "a0",
                                any!({ "id": "b1", "value": 3, "label": "Apples", "fill": "#f00" }),
                            )),
                        )]),
                    ),
                    ("kind", a(any!("bar"))),
                    (
                        "labels",
                        m(&[(
                            "l1",
                            a(keyed(
                                "a0",
                                any!({ "id": "l1", "text": "Half", "angle": 90, "reach": 0.5, "size": 14 }),
                            )),
                        )]),
                    ),
                    ("rotate", a(any!(0))),
                    (
                        "spokes",
                        m(&[(
                            "k1",
                            a(keyed(
                                "a0",
                                any!({ "id": "k1", "angle": 0, "fill": { "normal": "#0f0" } }),
                            )),
                        )]),
                    ),
                    ("xywh", place()),
                ],
            ),
        ),
        (
            "formula",
            element(
                "formula",
                id,
                &[
                    ("latex", a(any!("\\frac{1}{2}"))),
                    ("rotate", a(any!(0))),
                    ("xywh", place()),
                ],
            ),
        ),
    ]
}

/// A note as the edgeless note tool adds one: its props with their defaults.
pub fn note() -> Fields {
    fields(&[
        ("prop:xywh", a(any!("[0,0,498,92]"))),
        ("prop:rotate", a(any!(0))),
        (
            "prop:background",
            m(&[("dark", a(any!("#252525"))), ("light", a(any!("#ffffff")))]),
        ),
        ("prop:index", a(any!("a0"))),
        ("prop:lockedBySelf", a(any!(false))),
        ("prop:hidden", a(any!(false))),
        ("prop:displayMode", a(any!("edgeless"))),
        (
            "prop:edgeless",
            m(&[(
                "style",
                m(&[
                    ("borderRadius", a(any!(8))),
                    ("borderSize", a(any!(4))),
                    ("borderStyle", a(any!("none"))),
                    ("shadowType", a(any!("--affine-note-shadow-sticker"))),
                ]),
            )]),
        ),
    ])
}

/// Every block flavour as the store writes it: (flavour, parent, props).
pub fn editor_blocks() -> Vec<(&'static str, &'static str, Fields)> {
    vec![
        ("affine:note", "page", note()),
        (
            "affine:paragraph",
            "note",
            fields(&[
                ("prop:type", a(any!("h2"))),
                ("prop:text", t("A heading")),
                ("prop:collapsed", a(any!(false))),
            ]),
        ),
        (
            "affine:list",
            "note",
            fields(&[
                ("prop:type", a(any!("todo"))),
                ("prop:text", t("Buy milk")),
                ("prop:checked", a(any!(false))),
                ("prop:collapsed", a(any!(false))),
                ("prop:order", a(Any::Null)),
            ]),
        ),
        (
            "affine:image",
            "surface",
            fields(&[
                ("prop:caption", a(any!(""))),
                ("prop:sourceId", a(any!("asset_1"))),
                ("prop:width", a(any!(0))),
                ("prop:height", a(any!(0))),
                ("prop:size", a(any!(-1))),
                ("prop:index", a(any!("a0"))),
                ("prop:xywh", place()),
                ("prop:lockedBySelf", a(any!(false))),
                ("prop:rotate", a(any!(0))),
            ]),
        ),
        (
            "affine:embed-capy-picture",
            "surface",
            fields(&[
                ("prop:index", a(any!("a1"))),
                ("prop:lockedBySelf", a(any!(false))),
                ("prop:rotate", a(any!(0))),
                ("prop:xywh", place()),
                ("prop:kind", a(any!("emoji"))),
                ("prop:ref", a(any!("2764_fe0f"))),
                ("prop:label", a(any!("\u{2764}\u{fe0f}"))),
            ]),
        ),
        (
            "affine:embed-capy-link",
            "surface",
            fields(&[
                ("prop:index", a(any!("a2"))),
                ("prop:lockedBySelf", a(any!(false))),
                ("prop:rotate", a(any!(0))),
                ("prop:xywh", place()),
                (
                    "prop:url",
                    a(any!("https://www.youtube.com/watch?v=dQw4w9WgXcQ")),
                ),
                ("prop:videoId", a(any!("dQw4w9WgXcQ"))),
            ]),
        ),
        (
            "affine:embed-capy-material",
            "surface",
            fields(&[
                ("prop:index", a(any!("a3"))),
                ("prop:lockedBySelf", a(any!(false))),
                ("prop:rotate", a(any!(0))),
                ("prop:xywh", place()),
                ("prop:kind", a(any!("quiz"))),
                ("prop:materialId", a(any!("mat_1"))),
                ("prop:title", a(any!("Week 3 quiz"))),
            ]),
        ),
    ]
}

/// A room holding a note under the page, for blocks that sit in one.
pub fn room_with_note() -> Doc {
    let room = room();
    let bytes = update(&tab(&room, 50), |doc| {
        add_block(doc, "note", "affine:note", Some("page"), &note());
    });
    send(&room, &bytes).unwrap();
    room
}
