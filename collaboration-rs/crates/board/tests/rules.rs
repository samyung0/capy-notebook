#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! The entity rules (RULES.md, Epo 2026-11-22), through the room's
//! admission: every element type and block flavour fits as the editor writes
//! it, then the refusals that matter, each naming its rule.
mod common;

use common::*;
use yrs::{Any, ReadTxn, Text, Transact, any};

/// `edit`'s update on a tab of `room`, admitted or the reason.
fn verdict(room: &yrs::Doc, edit: impl FnOnce(&yrs::Doc)) -> Result<(), String> {
    send(room, &update(&tab(room, 7), edit))
}

/// Element `e1` of `kind` as the editor writes it, with `change` made to its
/// fields first.
fn element_with(kind: &str, change: impl FnOnce(&mut Fields)) -> Result<(), String> {
    let (_, mut fields) = editor_elements("e1")
        .into_iter()
        .find(|(name, _)| *name == kind)
        .unwrap();
    change(&mut fields);
    verdict(&room(), |doc| add_element(doc, "e1", &fields))
}

fn set(fields: &mut Fields, key: &str, field: F) {
    fields.retain(|(own, _)| own != key);
    fields.push((key.to_owned(), field));
}

fn without(fields: &mut Fields, key: &str) {
    fields.retain(|(own, _)| own != key);
}

#[track_caller]
fn refused(verdict: Result<(), String>, reason: &str) {
    match verdict {
        Err(got) => assert!(got.contains(reason), "{got:?} names no {reason:?}"),
        Ok(()) => panic!("admitted; expected a refusal naming {reason:?}"),
    }
}

#[test]
fn every_element_type_fits_as_the_editor_writes_it() {
    for (kind, fields) in editor_elements("e1") {
        let room = room();
        assert_eq!(
            verdict(&room, |doc| add_element(doc, "e1", &fields)),
            Ok(()),
            "{kind}"
        );
        // And once held, a move as the editor makes one.
        let moved = if matches!(kind, "connector" | "group" | "mindmap") {
            fields_of(&[("seed", a(any!(9)))])
        } else {
            fields_of(&[("xywh", a(any!("[1e3,-20.5,200,100]")))])
        };
        assert_eq!(
            verdict(&room, |doc| set_element(doc, "e1", &moved)),
            Ok(()),
            "{kind} moved"
        );
    }
}

fn fields_of(entries: &[(&str, F)]) -> Fields {
    fields(entries)
}

#[test]
fn every_block_flavour_fits_as_the_editor_writes_it() {
    for (flavour, parent, props) in editor_blocks() {
        let room = room_with_note();
        assert_eq!(
            verdict(&room, |doc| add_block(
                doc,
                "b1",
                flavour,
                Some(parent),
                &props
            )),
            Ok(()),
            "{flavour}"
        );
    }
    // A KLIPY GIF, and a link that is no video.
    let room = room();
    let gif = fields(&[
        ("prop:rotate", a(any!(0))),
        ("prop:xywh", place()),
        ("prop:kind", a(any!("klipy"))),
        (
            "prop:ref",
            a(any!("https://static.klipy.com/ii/abc/def.gif")),
        ),
        ("prop:label", a(any!("Dancing"))),
    ]);
    let link = fields(&[
        ("prop:rotate", a(any!(15))),
        ("prop:xywh", place()),
        ("prop:url", a(any!("http://example.com/a?b=c"))),
        ("prop:videoId", a(any!(""))),
    ]);
    assert_eq!(
        verdict(&room, |doc| {
            add_block(
                doc,
                "g1",
                "affine:embed-capy-picture",
                Some("surface"),
                &gif,
            );
            add_block(doc, "l1", "affine:embed-capy-link", Some("surface"), &link);
        }),
        Ok(())
    );
}

/// Typing into a held text, formatting it (an object-valued format too, as
/// a footnote's) and deleting from it.
#[test]
fn typing_formats_and_deletions_fit() {
    let room = room_with_note();
    let writer = tab(&room, 7);
    let paragraph = fields(&[("prop:type", a(any!("text"))), ("prop:text", t("hello"))]);
    send(
        &room,
        &update(&writer, |doc| {
            add_block(doc, "p1", "affine:paragraph", Some("note"), &paragraph)
        }),
    )
    .unwrap();
    let text = {
        let txn = writer.transact();
        let blocks = txn.get_map(board::ROOT).unwrap();
        let block = map_at(&txn, &blocks, "p1");
        match yrs::Map::get(&block, &txn, "prop:text") {
            Some(yrs::Out::YText(text)) => text,
            other => panic!("{other:?}"),
        }
    };
    let bold: yrs::types::Attrs = [(std::sync::Arc::from("bold"), any!(true))].into();
    // An object-valued format, as pasted markdown with a footnote writes it.
    let footnote: yrs::types::Attrs = [(
        std::sync::Arc::from("footnote"),
        any!({ "label": "1", "reference": { "type": "url", "url": "https://example.com" } }),
    )]
    .into();
    for edit in [
        update(&writer, |doc| {
            text.insert(&mut doc.transact_mut(), 5, " world")
        }),
        update(&writer, |doc| {
            text.format(&mut doc.transact_mut(), 0, 5, bold.clone())
        }),
        update(&writer, |doc| {
            text.format(&mut doc.transact_mut(), 6, 5, footnote.clone())
        }),
        update(&writer, |doc| {
            text.remove_range(&mut doc.transact_mut(), 1, 3)
        }),
    ] {
        assert_eq!(send(&room, &edit), Ok(()));
    }
}

#[test]
fn a_wrong_value_of_each_kind_is_refused() {
    let cases: Vec<(&str, &str, F)> = vec![
        ("shape", "fillColor", a(any!(5))),
        ("shape", "strokeColor", a(any!({ "dark": "#000" }))),
        ("brush", "points", a(any!([[1]]))),
        ("brush", "lineWidth", a(any!("4"))),
        ("shape", "padding", a(any!([10]))),
        (
            "shape",
            "shadow",
            a(any!({ "blur": 1, "offsetX": 0, "offsetY": 0 })),
        ),
        ("shape", "shapeType", a(any!("star"))),
        ("shape", "textResizing", a(any!(2))),
        ("shape", "maxWidth", a(any!(true))),
        ("shape", "xywh", a(any!("[0,0,10]"))),
        ("shape", "xywh", a(any!("not json"))),
        ("shape", "xywh", a(any!([0, 0, 10, 10]))),
        ("shape", "seed", a(any!("1"))),
        ("shape", "hidden", a(any!("yes"))),
        ("shape", "comments", a(any!({ "c1": 1 }))),
        ("connector", "source", a(any!("e2"))),
        ("connector", "mode", a(any!(3))),
        (
            "connector",
            "labelOffset",
            a(any!({ "distance": 0.5, "anchor": "left" })),
        ),
        ("connector", "labelXYWH", a(any!([1, 2, 3]))),
        (
            "connector",
            "labelStyle",
            a(
                any!({ "color": "#000", "fontFamily": "x", "fontSize": 16, "fontWeight": "400", "textAlign": "left" }),
            ),
        ),
        (
            "connector",
            "labelConstraints",
            a(any!({ "hasMaxWidth": 1, "maxWidth": 2 })),
        ),
        ("text", "fontWeight", a(any!(400))),
        ("mindmap", "style", a(any!(5))),
        ("plane", "ppu", a(any!(0))),
        ("chart", "axisMax", a(any!(1_000_000_001.0))),
        ("chart", "axisStep", a(any!(-1))),
        ("chart", "kind", a(any!("line"))),
        (
            "formula",
            "latex",
            a(Any::from("x".repeat(board::catalog::LATEX_MAX + 1))),
        ),
    ];
    for (kind, key, value) in cases {
        let verdict = element_with(kind, |fields| set(fields, key, value.clone()));
        refused(verdict, &format!("canvas element {kind}: {key}"));
    }
}

#[test]
fn a_missing_required_key_is_refused() {
    for (kind, key) in [
        ("connector", "mode"),
        ("connector", "source"),
        ("text", "text"),
        ("plane", "elements"),
        ("chart", "spokes"),
        ("group", "title"),
        ("mindmap", "children"),
        ("shape", "xywh"),
        // The renderer and the hit test index by it.
        ("shape", "shapeType"),
    ] {
        refused(
            element_with(kind, |fields| without(fields, key)),
            &format!("{key} is required"),
        );
    }
    // `undefined` is not given.
    refused(
        element_with("formula", |fields| set(fields, "latex", a(Any::Undefined))),
        "latex is required",
    );
    refused(
        verdict(&room(), |doc| {
            add_block(doc, "n1", "affine:note", Some("page"), &fields(&[]))
        }),
        "prop:xywh is required",
    );
}

/// BlockSuite's paste into an indented line and Tab nest an image under a
/// paragraph, a list or another image.
#[test]
fn an_image_nests_under_a_list_a_paragraph_or_an_image() {
    let block = |flavour: &str| {
        editor_blocks()
            .into_iter()
            .find(|(own, _, _)| *own == flavour)
            .unwrap()
            .2
    };
    let room = room_with_note();
    let nested = verdict(&room, |doc| {
        add_block(
            doc,
            "l1",
            "affine:list",
            Some("note"),
            &block("affine:list"),
        );
        add_block(
            doc,
            "p1",
            "affine:paragraph",
            Some("note"),
            &block("affine:paragraph"),
        );
        for (id, parent) in [("i1", "l1"), ("i2", "p1"), ("i3", "i1")] {
            add_block(
                doc,
                id,
                "affine:image",
                Some(parent),
                &block("affine:image"),
            );
        }
    });
    assert_eq!(nested, Ok(()));
}

/// A colour object with both `dark` and `light` is read by them (BlockSuite's
/// `resolveColor`), so both are strings; any other holds a string `normal`.
#[test]
fn a_colour_with_dark_and_light_holds_strings_in_both() {
    let colour = |value: Any| element_with("shape", |fields| set(fields, "strokeColor", a(value)));
    for fits in [
        any!("#000"),
        any!({ "normal": "#000" }),
        any!({ "dark": "#000", "light": "#fff" }),
        any!({ "dark": "#000", "normal": "#111" }),
    ] {
        assert_eq!(colour(fits.clone()), Ok(()), "{fits:?}");
    }
    for misfit in [
        any!({ "dark": 1, "light": 1, "normal": "#000" }),
        any!({ "dark": "#000" }),
        any!({}),
    ] {
        refused(
            colour(misfit),
            "canvas element shape: strokeColor is not what it holds",
        );
    }
}

/// A bar may carry its own fill colour.
#[test]
fn a_bar_takes_a_fill_colour() {
    let room = room();
    let (_, fields) = editor_elements("e1")
        .into_iter()
        .find(|(name, _)| *name == "chart")
        .unwrap();
    verdict(&room, |doc| add_element(doc, "e1", &fields)).unwrap();
    let bar = |id: &str, fill: Any| {
        verdict(&room, |doc| {
            let value = elements(doc, &doc.transact());
            let element = map_at(&doc.transact(), &value, "e1");
            let bars = map_at(&doc.transact(), &element, "bars");
            let entry = keyed(
                "a5",
                any!({ "id": id, "value": 1, "label": "x", "fill": fill }),
            );
            yrs::Map::insert(&bars, &mut doc.transact_mut(), id, entry);
        })
    };
    assert_eq!(bar("b8", any!({ "normal": "#f00" })), Ok(()));
    refused(bar("b9", any!(3)), "canvas element chart: an entry of bars");
}

/// Loading fills only absent props, so a prop holds `undefined` only where
/// its BlockSuite default is (`textAlign`, `comments`, the `meta:*` four,
/// which paragraphs, lists and images take).
#[test]
fn a_block_prop_holds_undefined_only_where_its_default_is() {
    let room = room_with_note();
    let paragraph = |props: &[(&str, F)]| {
        let mut all = vec![("prop:type", a(any!("text"))), ("prop:text", t("x"))];
        all.extend(props.iter().cloned());
        verdict(&room, |doc| {
            add_block(doc, "p1", "affine:paragraph", Some("note"), &fields(&all))
        })
    };
    assert_eq!(
        paragraph(&[
            ("prop:textAlign", a(Any::Undefined)),
            ("prop:comments", a(Any::Undefined)),
            ("prop:meta:createdAt", a(any!(1_763_800_000_000.0))),
            ("prop:meta:createdBy", a(any!("user_1"))),
            ("prop:meta:updatedAt", a(Any::Undefined)),
            ("prop:meta:updatedBy", a(Any::Undefined)),
        ]),
        Ok(())
    );
    refused(
        paragraph(&[("prop:meta:createdAt", a(any!("today")))]),
        "block affine:paragraph: prop:meta:createdAt is not what it holds",
    );
    refused(
        paragraph(&[("prop:collapsed", a(Any::Undefined))]),
        "block affine:paragraph: prop:collapsed holds undefined",
    );
    let mut note = note();
    note.retain(|(key, _)| key != "prop:edgeless");
    note.push(("prop:edgeless".into(), a(Any::Undefined)));
    refused(
        verdict(&room, |doc| {
            add_block(doc, "n2", "affine:note", Some("page"), &note)
        }),
        "block affine:note: prop:edgeless holds undefined",
    );
}

/// A note's `edgeless` holds its `style`.
#[test]
fn a_note_edgeless_holds_its_style() {
    let room = room_with_note();
    let mut bare = note();
    bare.retain(|(key, _)| key != "prop:edgeless");
    bare.push(("prop:edgeless".into(), m(&[("collapse", a(any!(false)))])));
    refused(
        verdict(&room, |doc| {
            add_block(doc, "n2", "affine:note", Some("page"), &bare)
        }),
        "block affine:note: prop:edgeless.style is required",
    );
    // Taken out of a held note.
    let cut = verdict(&room, |doc| {
        let txn = doc.transact();
        let note = map_at(&txn, &txn.get_map(board::ROOT).unwrap(), "note");
        let edgeless = map_at(&txn, &note, "prop:edgeless");
        drop(txn);
        yrs::Map::remove(&edgeless, &mut doc.transact_mut(), "style");
    });
    refused(cut, "block affine:note: prop:edgeless.style is required");
}

/// A plain object of `entries`, for values `any!` cannot write.
fn object(entries: Vec<(&str, Any)>) -> Any {
    Any::Map(std::sync::Arc::new(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    ))
}

/// Bytes and bigints are never plain, even where no rule reads (the
/// browser reads them as a Uint8Array or a bigint); Yjs's integers read as
/// numbers.
#[test]
fn bytes_and_bigints_never_fit_at_any_depth() {
    let bytes = || Any::Buffer(vec![1u8, 2].into());
    refused(
        element_with("shape", |fields| {
            set(fields, "strokeWidth", a(Any::BigInt(4)))
        }),
        "canvas element shape: strokeWidth is not what it holds",
    );
    refused(
        element_with("connector", |fields| {
            set(
                fields,
                "source",
                a(object(vec![("id", any!("s1")), ("note", bytes())])),
            )
        }),
        "canvas element connector: source is not what it holds",
    );
    let shadow = object(vec![
        ("blur", any!(1)),
        ("offsetX", any!(0)),
        ("offsetY", any!(0)),
        ("color", any!("#000")),
        ("spread", Any::Array(vec![Any::BigInt(2)].into())),
    ]);
    refused(
        element_with("shape", |fields| set(fields, "shadow", a(shadow))),
        "canvas element shape: shadow is not what it holds",
    );
    // Entries of a chart's bars and of a mind map's nodes.
    for (kind, key, entry) in [
        (
            "chart",
            "bars",
            keyed(
                "a5",
                object(vec![
                    ("id", any!("p9")),
                    ("value", any!(1)),
                    ("label", any!("x")),
                    ("note", bytes()),
                ]),
            ),
        ),
        (
            "mindmap",
            "children",
            object(vec![("index", any!("a0")), ("weight", Any::BigInt(3))]),
        ),
    ] {
        let room = room();
        let (_, fields) = editor_elements("e1")
            .into_iter()
            .find(|(name, _)| *name == kind)
            .unwrap();
        verdict(&room, |doc| add_element(doc, "e1", &fields)).unwrap();
        let verdict = verdict(&room, |doc| {
            let value = elements(doc, &doc.transact());
            let element = map_at(&doc.transact(), &value, "e1");
            let list = map_at(&doc.transact(), &element, key);
            yrs::Map::insert(&list, &mut doc.transact_mut(), "p9", entry.clone());
        });
        refused(
            verdict,
            &format!("canvas element {kind}: an entry of {key} that is not plain"),
        );
    }
}

/// A plane element holds `undefined` only at a key its type may leave
/// unset (zod's `strictObject` refuses any other key, `undefined` or not).
#[test]
fn a_plane_element_holds_undefined_only_at_an_optional_key() {
    let room = room();
    let (_, fields) = editor_elements("e1")
        .into_iter()
        .find(|(name, _)| *name == "plane")
        .unwrap();
    verdict(&room, |doc| add_element(doc, "e1", &fields)).unwrap();
    let point = |id: &str, key: &str| {
        let element = object(vec![
            ("id", Any::from(id)),
            ("type", any!("point")),
            ("coords", any!([1, 2])),
            (key, Any::Undefined),
        ]);
        verdict(&room, |doc| {
            let value = elements(doc, &doc.transact());
            let plane = map_at(&doc.transact(), &value, "e1");
            let list = map_at(&doc.transact(), &plane, "elements");
            yrs::Map::insert(&list, &mut doc.transact_mut(), id, keyed("a7", element));
        })
    };
    assert_eq!(point("p7", "name"), Ok(()));
    refused(
        point("p8", "extra"),
        "canvas element plane: an entry of elements that does not fit",
    );
}

/// A note's background map is a colour: `dark` and `light` both when both
/// are set, else `normal`.
#[test]
fn a_note_background_map_is_a_colour() {
    let room = room_with_note();
    let with_background = |background: F| {
        let mut note = note();
        note.retain(|(key, _)| key != "prop:background");
        note.push(("prop:background".into(), background));
        verdict(&room, |doc| {
            add_block(doc, "n2", "affine:note", Some("page"), &note)
        })
    };
    assert_eq!(with_background(m(&[("normal", a(any!("#fff")))])), Ok(()));
    refused(
        with_background(m(&[("dark", a(any!("#000")))])),
        "block affine:note: prop:background is not what it holds",
    );
    // `light` taken out of a held note's, leaving `dark` alone.
    let cut = verdict(&room, |doc| {
        let txn = doc.transact();
        let note = map_at(&txn, &txn.get_map(board::ROOT).unwrap(), "note");
        let background = map_at(&txn, &note, "prop:background");
        drop(txn);
        yrs::Map::remove(&background, &mut doc.transact_mut(), "light");
    });
    refused(
        cut,
        "block affine:note: prop:background is not what it holds",
    );
}

#[test]
fn an_unknown_key_is_refused() {
    refused(
        element_with("shape", |fields| set(fields, "marks", a(any!(1)))),
        "unknown key marks",
    );
    // A connector stores no place.
    refused(
        element_with("connector", |fields| set(fields, "xywh", place())),
        "unknown key xywh",
    );
    let mut props = note();
    props.push(("prop:text".into(), t("x")));
    refused(
        verdict(&room(), |doc| {
            add_block(doc, "n1", "affine:note", Some("page"), &props)
        }),
        "unknown key prop:text",
    );
}

#[test]
fn a_string_where_text_belongs_is_refused() {
    refused(
        element_with("text", |fields| set(fields, "text", a(any!("words")))),
        "canvas element text: text",
    );
    refused(
        element_with("group", |fields| set(fields, "title", a(any!("Group")))),
        "canvas element group: title",
    );
    let paragraph = fields(&[("prop:text", a(any!("plain")))]);
    let room = room_with_note();
    refused(
        verdict(&room, |doc| {
            add_block(doc, "p1", "affine:paragraph", Some("note"), &paragraph)
        }),
        "block affine:paragraph: prop:text",
    );
}

#[test]
fn a_type_or_flavour_the_board_does_not_hold_is_refused() {
    refused(
        element_with("shape", |fields| set(fields, "type", a(any!("sticker")))),
        "type sticker the board does not hold",
    );
    refused(
        verdict(&room(), |doc| {
            add_block(doc, "c1", "affine:code", Some("page"), &fields(&[]))
        }),
        "flavour affine:code the board does not hold",
    );
    refused(
        element_with("shape", |fields| set(fields, "id", a(any!("other")))),
        "its id is not its key",
    );
}

#[test]
fn keyed_entries_and_children_are_checked_each() {
    let bad_entries: Vec<(&str, &str, Any)> = vec![
        (
            "plane",
            "elements",
            keyed("a0", any!({ "id": "p9", "type": "point", "coords": [1] })),
        ),
        (
            "plane",
            "elements",
            keyed(
                "a0",
                any!({ "id": "p9", "type": "point", "coords": [1, 2], "extra": 1 }),
            ),
        ),
        // The element's id is not its key.
        (
            "plane",
            "elements",
            keyed(
                "a0",
                any!({ "id": "other", "type": "point", "coords": [1, 2] }),
            ),
        ),
        (
            "plane",
            "elements",
            any!({ "element": { "id": "p9", "type": "point", "coords": [1, 2] } }),
        ),
        (
            "chart",
            "bars",
            keyed(
                "a0",
                any!({ "id": "p9", "value": 1, "label": "x".repeat(25) }),
            ),
        ),
        (
            "chart",
            "bars",
            keyed("a0", any!({ "id": "p9", "value": "1", "label": "x" })),
        ),
        (
            "chart",
            "labels",
            keyed(
                "a0",
                any!({ "id": "p9", "text": "x", "angle": 0, "reach": 1, "size": 7 }),
            ),
        ),
        (
            "chart",
            "labels",
            keyed(
                "a0",
                any!({ "id": "p9", "text": "x", "angle": 0, "reach": 1, "size": 12.5 }),
            ),
        ),
        (
            "chart",
            "spokes",
            keyed("a0", any!({ "id": "p9", "angle": 0, "fill": 3 })),
        ),
        ("group", "children", any!(false)),
        ("mindmap", "children", any!({ "parent": "root" })),
    ];
    for (kind, key, entry) in bad_entries {
        let room = room();
        let (_, fields) = editor_elements("e1")
            .into_iter()
            .find(|(name, _)| *name == kind)
            .unwrap();
        verdict(&room, |doc| add_element(doc, "e1", &fields)).unwrap();
        let verdict = verdict(&room, |doc| {
            let value = elements(doc, &doc.transact());
            let element = map_at(&doc.transact(), &value, "e1");
            let list = map_at(&doc.transact(), &element, key);
            yrs::Map::insert(&list, &mut doc.transact_mut(), "p9", entry.clone());
        });
        refused(
            verdict,
            &format!("canvas element {kind}: an entry of {key}"),
        );
    }
}

/// A keyed list holds twice its tools' cap and no more.
#[test]
fn a_keyed_list_past_twice_its_cap_is_refused() {
    let bars = |count: usize| {
        let entries: Vec<(String, F)> = (0..count)
            .map(|n| {
                let id = format!("b{n}");
                let bar = keyed(
                    &format!("a{n}"),
                    any!({ "id": id.clone(), "value": 1, "label": "x" }),
                );
                (id, a(bar))
            })
            .collect();
        F::M(entries)
    };
    let cap = board::rules::merged_cap(board::catalog::BARS_MAX);
    for (count, fits) in [(cap, true), (cap + 1, false)] {
        let verdict = element_with("chart", |fields| set(fields, "bars", bars(count)));
        if fits {
            assert_eq!(verdict, Ok(()), "{count} bars");
        } else {
            refused(
                verdict,
                "canvas element chart: bars holds more than 48 entries",
            );
        }
    }
}

#[test]
fn a_card_whose_fields_disagree_is_refused() {
    let picture = |kind: &str, reference: &str| {
        fields(&[
            ("prop:rotate", a(any!(0))),
            ("prop:xywh", place()),
            ("prop:kind", a(Any::from(kind))),
            ("prop:ref", a(Any::from(reference))),
            ("prop:label", a(any!("x"))),
        ])
    };
    let link = |url: &str, video: &str| {
        fields(&[
            ("prop:rotate", a(any!(0))),
            ("prop:xywh", place()),
            ("prop:url", a(Any::from(url))),
            ("prop:videoId", a(Any::from(video))),
        ])
    };
    let cards = [
        ("affine:embed-capy-picture", picture("klipy", "1f600")),
        ("affine:embed-capy-picture", picture("emoji", "1f4a9")),
        (
            "affine:embed-capy-picture",
            picture("klipy", "http://media.klipy.com/a.gif"),
        ),
        (
            "affine:embed-capy-picture",
            picture("klipy", "https://klipy.com.evil.example/a.gif"),
        ),
        ("affine:embed-capy-link", link("ftp://example.com", "")),
        ("affine:embed-capy-link", link("not a url", "")),
    ];
    for (flavour, props) in cards {
        refused(
            verdict(&room(), |doc| {
                add_block(doc, "c1", flavour, Some("surface"), &props)
            }),
            &format!("block {flavour}"),
        );
    }
    refused(
        verdict(&room(), |doc| {
            add_block(
                doc,
                "c1",
                "affine:embed-capy-link",
                Some("surface"),
                &link("https://a.b", "short"),
            )
        }),
        "prop:videoId",
    );
    let mut material = editor_blocks()
        .into_iter()
        .find(|(flavour, _, _)| *flavour == "affine:embed-capy-material")
        .unwrap()
        .2;
    set(&mut material, "prop:kind", a(any!("note")));
    refused(
        verdict(&room(), |doc| {
            add_block(
                doc,
                "c1",
                "affine:embed-capy-material",
                Some("surface"),
                &material,
            )
        }),
        "prop:kind",
    );
}

#[test]
fn a_note_nested_entry_is_checked_each() {
    let room = room_with_note();
    let cases: [(&[&str], &str, Any); 5] = [
        (&["prop:edgeless", "style"][..], "borderStyle", any!("wavy")),
        (
            &["prop:edgeless", "style"][..],
            "shadowType",
            any!("--affine-note-shadow-none"),
        ),
        (&["prop:edgeless"][..], "scale", any!("2")),
        (&["prop:background"][..], "dark", any!(1)),
        (&["prop:background"][..], "accent", any!("#fff")),
    ];
    for (path, key, value) in cases {
        let verdict = verdict(&room, |doc| {
            let txn = doc.transact();
            let blocks = txn.get_map(board::ROOT).unwrap();
            let mut map = map_at(&txn, &blocks, "note");
            for key in path {
                map = map_at(&txn, &map, key);
            }
            drop(txn);
            yrs::Map::insert(&map, &mut doc.transact_mut(), key, value.clone());
        });
        assert!(verdict.is_err(), "{path:?} {key}");
    }
}

#[test]
fn an_embed_or_a_type_in_a_text_is_refused() {
    let room = room();
    let writer = tab(&room, 7);
    let (_, fields) = editor_elements("e1")
        .into_iter()
        .find(|(name, _)| *name == "text")
        .unwrap();
    send(
        &room,
        &update(&writer, |doc| add_element(doc, "e1", &fields)),
    )
    .unwrap();
    let text_of = |writer: &yrs::Doc| {
        let txn = writer.transact();
        let element = map_at(&txn, &elements(writer, &txn), "e1");
        match yrs::Map::get(&element, &txn, "text") {
            Some(yrs::Out::YText(text)) => text,
            other => panic!("{other:?}"),
        }
    };
    let text = text_of(&writer);
    let embedded = update(&writer, |doc| {
        text.insert_embed(&mut doc.transact_mut(), 0, any!({ "image": "x" }));
    });
    refused(
        send(&room, &embedded),
        "a text holds something other than text",
    );
    // A format may be any plain value but one hiding a `__proto__` key.
    let writer = tab(&room, 8);
    let text = text_of(&writer);
    let proto: yrs::types::Attrs = [(
        std::sync::Arc::from("link"),
        any!({ "__proto__": { "x": 1 } }),
    )]
    .into();
    let hidden = update(&writer, |doc| {
        text.format(&mut doc.transact_mut(), 0, 2, proto.clone());
    });
    refused(
        send(&room, &hidden),
        "a text holds something other than text",
    );
}

#[test]
fn a_proto_key_anywhere_in_a_value_is_refused() {
    refused(
        element_with("shape", |fields| {
            set(
                fields,
                "shadow",
                a(
                    any!({ "blur": 1, "offsetX": 0, "offsetY": 0, "color": "#000", "__proto__": { "x": 1 } }),
                ),
            )
        }),
        "canvas element shape: shadow",
    );
    refused(
        verdict(&room(), |doc| {
            let (_, fields) = editor_elements("__proto__").remove(0);
            add_element(doc, "__proto__", &fields);
        }),
        "canvas element brush: its key is not an id",
    );
}
