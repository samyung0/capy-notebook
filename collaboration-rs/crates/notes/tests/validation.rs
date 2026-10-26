#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Material document and question validation against the Node server on the
//! corpus: the shared Go/TS question fixtures, every fixture note, quiz and
//! flashcard set under each material kind, random structural damage to them,
//! and the bank-asset host rules. Outcomes match exactly; messages match
//! except where zod raised the error (its message is its issue list), and
//! except the rules the Rust store took from Go and the browser after the
//! Node server was frozen ([tightened]) and the rules relaxed since
//! ([loosened]).
mod common;

use notes::material;
use notes::questions::{self, Policy};
use serde_json::{Value, json};

fn policy(fixture: &Value, host: &Value) -> Policy {
    Policy {
        bank: fixture["bank"].as_bool().unwrap_or(false),
        bank_assets_url: fixture["bankAssetsUrl"].as_str().map(str::to_owned),
        snapshot: fixture["snapshot"].as_bool().unwrap_or(false),
        quiz_assets_url: host.as_str().map(str::to_owned),
    }
}

/// A case the Rust store refuses where the Node server accepted (or refused
/// for another reason), by the rules it took from Go and the browser at the
/// cutover: Go's card limits and image shape, media naming their asset
/// (Epo, 2026-10-10), `diagram`/`mindmap` no longer node types, a
/// reference never keeping an imported fence body (live-items REVIEW5), and
/// the embed catalog (Epo 2026-10-13): a type or material kind it does not
/// list, an element in a material kind it does not list it for, and Go's
/// wording for figures; `multi`, merged into `mcq` (Epo 2026-10-15); a
/// void element holding anything but one empty text leaf (Epo 2026-10-18);
/// a column width the editor never writes (2026-10-25); an indent that is
/// not a number (2026-10-26); and a style value holding `;` or a control
/// character (Epo Q380).
fn tightened(ours: &Result<(), String>, value: &Value) -> bool {
    fn has_type(node: &Value, kinds: &[&str]) -> bool {
        node["type"]
            .as_str()
            .is_some_and(|kind| kinds.contains(&kind))
            || node["children"]
                .as_array()
                .is_some_and(|children| children.iter().any(|child| has_type(child, kinds)))
    }
    fn has_fence(node: &Value) -> bool {
        (node["type"] == "material_ref" && node.get("pending").is_some())
            || node["children"]
                .as_array()
                .is_some_and(|children| children.iter().any(has_fence))
    }
    let Err(message) = ours else { return false };
    let message = message.trim_start_matches("invalid material document: ");
    (message == "answer: invalid type" && holds_multi(value))
        || message.ends_with("material reference carries an imported fence body")
        || (message.ends_with("materialId is required")
            && value
                .as_array()
                .is_some_and(|nodes| nodes.iter().any(has_fence)))
        || message.starts_with("a flashcard front holds at most")
        || message.starts_with("a flashcard back holds at most")
        || message == "flashcard image must be {assetId}"
        || message.ends_with("requires an assetId")
        || message.ends_with("cannot contain url")
        || message.ends_with("cannot contain src")
        || message.starts_with("unknown element type")
        || message.starts_with("unknown material kind")
        || message.contains(" cannot hold a ")
        || message.starts_with("chart, plot and graph embeds")
        || message.ends_with("holds one empty text leaf")
        || message.starts_with("column width must be")
        || message == "indent must be a number"
        || message.ends_with("may hold no semicolon or control character")
        || value.as_array().is_some_and(|nodes| {
            nodes
                .iter()
                .any(|node| has_type(node, &["diagram", "mindmap"]))
        })
}

/// Whether a value holds a `multi` answer, a type merged into `mcq`.
fn holds_multi(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.get("type").is_some_and(|kind| kind == "multi") || map.values().any(holds_multi)
        }
        Value::Array(items) => items.iter().any(holds_multi),
        _ => false,
    }
}

/// A case the Rust store accepts where the Node server refused, by a rule
/// relaxed after it was frozen: a figure without a description (Epo
/// 2026-10-14).
fn loosened(ours: &Result<(), String>, theirs: &Value) -> bool {
    ours.is_ok()
        && theirs["zod"] == true
        && theirs["message"]
            .as_str()
            .is_some_and(|m| m.contains("\"description\"") && m.contains("received undefined"))
}

fn compare(at: &str, ours: Result<(), String>, theirs: &Value, failures: &mut Vec<String>) {
    let ok = theirs["ok"].as_bool().unwrap();
    match ours {
        Ok(()) if ok => {}
        Err(message) if !ok => {
            let expected = theirs["message"].as_str().unwrap();
            if !theirs["zod"].as_bool().unwrap() && message != expected {
                failures.push(format!("{at}: message {message:?} != {expected:?}"));
            }
        }
        ours => failures.push(format!("{at}: {ours:?} != JS {theirs}")),
    }
}

#[test]
fn validation_matches_the_node_server() {
    let corpus = common::load("validation");
    let mut failures = Vec::new();
    for case in corpus["questions"].as_array().unwrap() {
        let at = format!("question {} (host {})", case["file"], case["host"]);
        let ours = questions::validate_question(
            &case["question"],
            &policy(&case["policy"], &case["host"]),
        )
        .map(|_| ());
        if tightened(&ours, &case["question"]) {
            continue;
        }
        compare(&at, ours, &case["outcome"], &mut failures);
        if case["host"].is_null() && case["outcome"]["ok"].as_bool() != case["valid"].as_bool() {
            failures.push(format!("{at}: the JS outcome disagrees with the fixture"));
        }
    }
    let (mut tightenings, mut loosenings) = (0, 0);
    for case in corpus["cases"].as_array().unwrap() {
        let at = format!(
            "{} as {} (host {})",
            case["name"], case["kind"], case["host"]
        );
        let policy = policy(&Value::Null, &case["host"]);
        let ours = material::assert_canonical_with(
            case["value"].as_array().unwrap(),
            case["kind"].as_str().unwrap(),
            &policy,
        )
        .map_err(|error| error.to_string());
        if tightened(&ours, &case["value"]) {
            tightenings += 1;
            continue;
        }
        if loosened(&ours, &case["outcome"]) {
            loosenings += 1;
            continue;
        }
        compare(&at, ours, &case["outcome"], &mut failures);
    }
    let cases = corpus["cases"].as_array().unwrap();
    let refused = cases.iter().filter(|c| c["outcome"]["ok"] == false).count();
    let messages = cases
        .iter()
        .filter(|c| c["outcome"]["zod"] == false)
        .count();
    eprintln!(
        "{} question fixtures, {} material cases ({refused} refused, {messages} with the message compared, {tightenings} refused by the cutover's tightenings, {loosenings} accepted by later loosenings)",
        corpus["questions"].as_array().unwrap().len(),
        cases.len()
    );
    assert!(
        failures.is_empty(),
        "{} failures: {failures:#?}",
        failures.len()
    );
}

/// Every resizable block takes one optional `width`, exactly "<n>%" with n a
/// whole number from 20 to 100 (Epo, 2026-10-08; plate-2 3a87184d's refused
/// values), on an accepted corpus node of each kind.
#[test]
fn resizable_blocks_take_only_the_widths_the_handles_write() {
    let corpus = common::load("validation");
    for kind in ["img", "video", "mermaid", "chart", "graph"] {
        let (base, material_kind) = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| case["outcome"]["ok"] == true)
            .find_map(|case| {
                let node = case["value"]
                    .as_array()?
                    .iter()
                    .find(|node| node["type"] == kind)?;
                Some((node.clone(), case["kind"].as_str()?.to_owned()))
            })
            .unwrap_or_else(|| panic!("no accepted {kind} in the corpus"));
        let with_width = |width: Value| {
            let mut node = base.clone();
            node["width"] = width;
            material::assert_canonical_with(&[node], &material_kind, &Policy::default())
        };
        material::assert_canonical_with(
            std::slice::from_ref(&base),
            &material_kind,
            &Policy::default(),
        )
        .unwrap();
        for width in ["20%", "55%", "100%"] {
            with_width(Value::from(width)).unwrap_or_else(|e| panic!("{kind} {width}: {e}"));
        }
        for width in [
            json!(50),
            Value::Null,
            json!("19%"),
            json!("101%"),
            json!("50px"),
            json!("50.5%"),
            json!("050%"),
            json!("50"),
            json!(" 50%"),
        ] {
            let refused = with_width(width.clone()).unwrap_err();
            assert_eq!(
                refused.0, "width must be a whole percentage from 20 to 100",
                "{kind} {width}"
            );
        }
    }
}

/// A column takes one optional `width`, the widths the editor writes: its
/// layout presets and Plate's normalizer's floats, a plain decimal
/// percentage above 0 and at most 100 (Go's `TestColumnsTakeOnlyTheEditorWidth`).
#[test]
fn columns_take_only_the_widths_the_editor_writes() {
    let validate = |width: Option<Value>| {
        let mut column = json!({ "type": "column", "children": [
            { "type": "p", "children": [{ "text": "a" }] },
        ] });
        if let Some(width) = width {
            column["width"] = width;
        }
        let group = json!({ "type": "column_group", "id": "g", "children": [
            column,
            { "type": "column", "children": [{ "type": "p", "children": [{ "text": "b" }] }] },
        ] });
        material::assert_canonical_with(&[group], "note", &Policy::default())
    };
    validate(None).unwrap();
    for width in [
        "50%",
        "33.333%",
        "33.334%",
        "66.667%",
        "49.9995%",
        "33.333333333333336%",
        "100%",
        "0.5%",
    ] {
        validate(Some(Value::from(width))).unwrap_or_else(|e| panic!("{width}: {e}"));
    }
    for width in [
        json!("0%"),
        json!("101%"),
        json!("100.5%"),
        json!("050%"),
        json!("50.0%"),
        json!("50.%"),
        json!(".5%"),
        json!("5e1%"),
        json!("-5%"),
        json!("50"),
        json!("50px"),
        json!(" 50%"),
        json!("50%;color:red"),
        json!(50),
        Value::Null,
    ] {
        let refused = validate(Some(width.clone())).unwrap_err();
        assert_eq!(
            refused.0, "column width must be a percentage above 0 and at most 100",
            "{width}"
        );
    }
}

/// A table stores the column sizes and left margin Plate's table resizing
/// writes, px as numbers of 0 or more, a column size possibly empty (Go's
/// `TestTablesTakeOnlyThePlateSizes`).
#[test]
fn tables_take_only_the_plate_sizes() {
    let validate = |sizes: Value| {
        let mut table = json!({ "type": "table", "id": "t", "children": [
            { "type": "tr", "children": [
                { "type": "td", "children": [{ "type": "p", "children": [{ "text": "a" }] }] },
            ] },
        ] });
        for (key, value) in sizes.as_object().unwrap() {
            table[key] = value.clone();
        }
        material::assert_canonical_with(&[table], "note", &Policy::default())
    };
    for sizes in [
        json!({}),
        json!({ "colSizes": [120, 0, 48.5, null] }),
        json!({ "colSizes": [] }),
        json!({ "marginLeft": 0 }),
        json!({ "marginLeft": 24 }),
    ] {
        validate(sizes.clone()).unwrap_or_else(|e| panic!("{sizes}: {e}"));
    }
    for sizes in [
        json!({ "colSizes": ["120"] }),
        json!({ "colSizes": ["120px;color:red"] }),
        json!({ "colSizes": [-1] }),
        json!({ "colSizes": "120" }),
        json!({ "colSizes": null }),
        json!({ "marginLeft": "24px" }),
        json!({ "marginLeft": -1 }),
        json!({ "marginLeft": null }),
    ] {
        let refused = validate(sizes.clone()).unwrap_err();
        assert!(refused.0.starts_with("table "), "{sizes}: {}", refused.0);
    }
}

/// An indent is a number, which Plate draws as a class and a margin (Go's
/// `TestIndentIsANumber`).
#[test]
fn an_indent_is_a_number() {
    let validate = |indent: Value| {
        let node =
            json!({ "type": "p", "id": "p", "indent": indent, "children": [{ "text": "a" }] });
        material::assert_canonical_with(&[node], "note", &Policy::default())
    };
    for indent in [Value::Null, json!(1), json!(1.5), json!(8)] {
        validate(indent.clone()).unwrap_or_else(|e| panic!("{indent}: {e}"));
    }
    for indent in [json!("1"), json!("1 fixed"), json!(true)] {
        let refused = validate(indent.clone()).unwrap_err();
        assert_eq!(refused.0, "indent must be a number", "{indent}");
    }
}

/// The marks Plate draws as styles live on text: an element carrying one is
/// refused, a leaf keeps it (Go's `TestTextMarksStayOnText`).
#[test]
fn text_marks_stay_on_text() {
    let marks = [
        ("color", "#c0392b"),
        ("backgroundColor", "#fdebd0"),
        ("fontSize", "20px"),
        ("fontFamily", "Georgia"),
    ];
    let mut leaf = json!({ "text": "a" });
    for (key, value) in marks {
        leaf[key] = json!(value);
    }
    let note = |node: Value| material::assert_canonical_with(&[node], "note", &Policy::default());
    note(json!({ "type": "p", "id": "p", "children": [leaf] })).unwrap();
    for (key, value) in marks {
        let refused =
            note(json!({ "type": "p", "id": "p", key: value, "children": [{ "text": "a" }] }))
                .unwrap_err();
        assert_eq!(refused.0, format!("p cannot carry {key}"));
    }
}

/// A text mark's or a list's style value holds any value a browser writes but
/// no `;` and no control character (Epo Q380; Go's
/// `TestStyleValuesHoldNoSemicolon`).
#[test]
fn style_values_hold_no_semicolon() {
    let note = |node: Value| material::assert_canonical_with(&[node], "note", &Policy::default());
    let leaf = |key: &str, value: Value| {
        let mut text = json!({ "text": "a" });
        text[key] = value;
        json!({ "type": "p", "id": "p", "children": [text] })
    };
    let list = |value: Value| json!({ "type": "p", "id": "p", "indent": 1, "listStyleType": value, "children": [{ "text": "a" }] });
    for (key, value) in [
        ("backgroundColor", "color-mix(in srgb, red 50%, blue)"),
        ("color", "var(--accent)"),
        ("fontFamily", "\"Times New Roman\", serif"),
        ("fontSize", "1.2em"),
    ] {
        note(leaf(key, json!(value))).unwrap_or_else(|e| panic!("{key}: {e}"));
        note(leaf(key, Value::Null)).unwrap_or_else(|e| panic!("{key}: {e}"));
        for bad in [
            json!(format!("{value};x:y")),
            json!(format!("{value}\u{0}")),
            json!(format!("{value}\n")),
            json!(format!("{value}\u{7f}")),
            json!(["red"]),
        ] {
            let refused = note(leaf(key, bad.clone())).unwrap_err();
            assert_eq!(
                refused.0,
                format!("{key} may hold no semicolon or control character"),
                "{bad}"
            );
        }
    }
    for value in [
        json!("decimal"),
        json!("lower-alpha"),
        json!("\"▪ \""),
        Value::Null,
    ] {
        note(list(value.clone())).unwrap_or_else(|e| panic!("{value}: {e}"));
    }
    for bad in [
        json!("decimal;x:y"),
        json!("decimal\u{1f}"),
        json!("decimal\u{7f}"),
        json!(3),
    ] {
        let refused = note(list(bad.clone())).unwrap_err();
        assert_eq!(
            refused.0, "listStyleType may hold no semicolon or control character",
            "{bad}"
        );
    }
}

/// The every-block note shared with Go (TestEveryBlockNoteFixtureIsValid)
/// and the UAT note journey: every node type a note stores is accepted. Its
/// quiz and flashcards blocks are imported fences, which a note holds only
/// once they name their rows.
#[test]
fn the_every_block_note_is_valid() {
    let path = format!(
        "{}/../../../server/internal/materialdoc/testdata/every-block-note.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut value = fixture["value"].as_array().unwrap().clone();
    for node in &mut value {
        if let Some(fence) = node
            .as_object_mut()
            .filter(|node| node.contains_key("pending"))
        {
            fence.remove("pending");
            fence.insert("materialId".into(), json!("row"));
        }
    }
    material::assert_canonical(&value, "note").unwrap();
}

fn card(front: &str, back: &str, image: Option<Value>) -> Value {
    let mut card = json!({
        "children": [
            { "children": [{ "text": front }], "type": "flashcard_front" },
            { "children": [{ "text": back }], "type": "flashcard_back" },
        ],
        "id": "c1",
        "type": "flashcard",
    });
    if let Some(image) = image {
        card["image"] = image;
    }
    card
}

fn set(card: Value) -> Result<(), String> {
    let value = [json!({ "children": [card], "id": "s1", "type": "flashcards" })];
    material::assert_canonical(&value, "flashcards").map_err(|error| error.0)
}

/// A stored set holds only what Go projects (security regression: a stored
/// set Go cannot project breaks the material for everyone): a front of at
/// most 4,000 characters and a back of at most 2,000, counted as Go counts
/// runes, and an image exactly `{assetId}` with a non-blank id of at most 128.
#[test]
fn a_card_holds_what_go_projects() {
    // Astral characters count once, as Go's runes.
    let front = "\u{1F600}".repeat(notes::catalog::CARD_FRONT_MAX);
    let back = "\u{1F600}".repeat(notes::catalog::CARD_BACK_MAX);
    set(card(
        &front,
        &back,
        Some(json!({ "assetId": "a".repeat(128) })),
    ))
    .unwrap();
    assert_eq!(
        set(card(&format!("{front}x"), "b", None)).unwrap_err(),
        "a flashcard front holds at most 200 characters"
    );
    assert_eq!(
        set(card("f", &format!("{back}x"), None)).unwrap_err(),
        "a flashcard back holds at most 1000 characters"
    );
    for image in [
        json!({ "assetId": "" }),
        json!({ "assetId": "  " }),
        json!({ "assetId": "a".repeat(129) }),
        json!({ "assetId": "a1", "url": "https://x.test/a.png" }),
        json!({ "url": "https://x.test/a.png" }),
        json!("a1"),
    ] {
        assert_eq!(
            set(card("f", "b", Some(image.clone()))).unwrap_err(),
            "flashcard image must be {assetId}",
            "{image}"
        );
    }
}

/// An image or audio block stores its asset id and no URL, as the
/// browser and Go refuse otherwise (Epo, 2026-10-10).
#[test]
fn a_media_block_names_its_asset() {
    let note = |node: Value| material::assert_canonical(&[node], "note").map_err(|error| error.0);
    for kind in material::MEDIA_TYPES {
        let node = |extra: Value| {
            let mut node = json!({ "children": [{ "text": "" }], "id": "m1", "type": kind });
            for (key, value) in extra.as_object().unwrap() {
                node[key] = value.clone();
            }
            node
        };
        note(node(json!({ "assetId": "a1" }))).unwrap();
        note(node(json!({ "assetId": "a1", "url": null }))).unwrap();
        assert_eq!(
            note(node(json!({}))).unwrap_err(),
            format!("{kind} requires an assetId")
        );
        assert_eq!(
            note(node(json!({ "assetId": "" }))).unwrap_err(),
            format!("{kind} requires an assetId")
        );
        for key in ["url", "src"] {
            let mut linked = node(json!({ "assetId": "a1" }));
            linked[key] = json!("https://x.test/a.png");
            assert_eq!(
                note(linked).unwrap_err(),
                format!("{kind} cannot contain {key}")
            );
        }
    }
}

/// `diagram` and `mindmap` are material kinds, not node types: their
/// material holds a `mermaid` block, and the catalog lists no such element.
#[test]
fn diagram_and_mindmap_are_not_node_types() {
    let block = |kind: &str| {
        json!({
            "children": [{ "children": [{ "text": "" }], "type": "mermaid_caption" }],
            "id": "d1",
            "source": "graph TD; a-->b",
            "type": kind,
        })
    };
    for kind in ["mindmap", "diagram"] {
        material::assert_canonical(&[block("mermaid")], kind).unwrap();
        assert_eq!(
            material::assert_canonical(&[block(kind)], kind)
                .unwrap_err()
                .0,
            format!("unknown element type \"{kind}\"")
        );
    }
}

/// The plot block (Go's `validatePlot` and fieldlimits' `QUESTION_PLOT_*`;
/// Node's validator never had it, Epo 2026-10-12): a valid plot goes in as a
/// block, in a quiz question's stem and as a note's embed; Go's refused
/// cases are refused, a plot past its limits among them.
#[test]
fn a_plot_validates_as_go_validates_it() {
    let plot = |edit: fn(&mut Value)| {
        let mut block = json!({
            "lines": [{ "axis": "y", "label": "threshold", "value": -55 }],
            "marks": [{ "label": "Na+ in", "x": 1, "y": 0 }],
            "series": [{ "name": "Vm", "points": [[0, -70], [1.5, 30.5]] }],
            "title": "Action potential",
            "type": "plot",
            "xTitle": "Time (ms)",
            "yTitle": "Vm (mV)",
        });
        edit(&mut block);
        block
    };
    type Edit = fn(&mut Value);
    let refused: [(&str, Edit); 10] = [
        ("five curves", |b| {
            b["series"] = (0..5)
                .map(|_| json!({ "name": "c", "points": [[0, 1], [0, 1]] }))
                .collect();
        }),
        ("61 points", |b| {
            b["series"] = json!([{ "name": "c", "points": (0..61).map(|x| json!([x, 0])).collect::<Vec<_>>() }]);
        }),
        ("nine marks", |b| {
            b["marks"] = (0..9)
                .map(|x| json!({ "label": "m", "x": x, "y": 0 }))
                .collect();
        }),
        ("one point", |b| {
            b["series"] = json!([{ "name": "c", "points": [[0, 1]] }])
        }),
        ("three numbers", |b| {
            b["series"] = json!([{ "name": "c", "points": [[0, 1], [1, 2, 3]] }])
        }),
        ("text coordinate", |b| {
            b["series"] = json!([{ "name": "c", "points": [[0, 1], ["1", 2]] }])
        }),
        ("line axis", |b| {
            b["lines"] = json!([{ "axis": "z", "value": 1 }])
        }),
        ("unlabelled mark", |b| {
            b["marks"] = json!([{ "x": 1, "y": 2 }])
        }),
        ("missing y title", |b| {
            b.as_object_mut().unwrap().remove("yTitle");
        }),
        ("unknown kind", |b| b["kind"] = json!("bar")),
    ];
    questions::block(&plot(|_| {})).unwrap();
    questions::block(&plot(|b| b["kind"] = json!("scatter"))).unwrap();
    // A scatter shows a single point; a line needs two ("one point" below).
    questions::block(&plot(|b| {
        b["kind"] = json!("scatter");
        b["series"] = json!([{ "name": "c", "points": [[0, 1]] }]);
    }))
    .unwrap();
    questions::block(&plot(|b| {
        b["series"] =
            json!([{ "name": "c", "points": (0..60).map(|x| json!([x, x])).collect::<Vec<_>>() }]);
    }))
    .unwrap();
    for (name, edit) in refused {
        assert!(questions::block(&plot(edit)).is_err(), "{name} accepted");
    }
    assert!(questions::block(&plot(|b| b["shape"] = json!("line"))).is_err());
    let question = |stem: Value| {
        json!({
            "id": "q",
            "labels": "letters",
            "layout": "paper",
            "parts": [{
                "answer": { "correct": true, "type": "boolean" },
                "blocks": [{ "text": "?", "type": "text" }],
                "id": "p",
                "marks": 1,
                "solution": [],
            }],
            "stem": [stem],
        })
    };
    questions::validate_question(&question(plot(|_| {})), &Policy::default()).unwrap();
    assert!(
        questions::validate_question(&question(plot(refused[0].1)), &Policy::default()).is_err()
    );
    let embed = |block: Value| {
        material::assert_canonical(
            &[json!({ "block": block, "children": [{ "text": "" }], "id": "pl1", "type": "plot" })],
            "note",
        )
        .map_err(|error| error.0)
    };
    embed(plot(|_| {})).unwrap();
    assert!(embed(plot(refused[0].1)).is_err());
}

/// A plot's text is bounded as a chart's (Epo 2026-10-17): the shared plot
/// fixtures at and past those bounds validate as Go and the browser validate
/// them, and a live quiz's caps (`figure_caps`) refuse a title past its bound.
#[test]
fn plot_text_stops_at_the_charts_bounds() {
    for name in [
        "plot-at-limits",
        "plot-long-title-rejected",
        "plot-long-series-name-rejected",
        "plot-long-mark-label-rejected",
    ] {
        let path = format!(
            "{}/../../../server/internal/questions/testdata/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let ours =
            questions::validate_question(&fixture["question"], &Policy::default()).map(|_| ());
        assert_eq!(
            ours.is_ok(),
            fixture["valid"] == json!(true),
            "{name}: {ours:?}"
        );
    }
    let title = |n: usize| json!({ "title": "t".repeat(n) });
    questions::figure_caps("plot", &title(questions::QUESTION_PLOT_TITLE_MAX)).unwrap();
    assert!(
        questions::figure_caps("plot", &title(questions::QUESTION_PLOT_TITLE_MAX + 1)).is_err()
    );
}

/// An image's or graph's description holds QUESTION_DESCRIPTION_MAX in a
/// quiz and a note, the bank's QUESTION_TEXT_MAX in the bank (Epo 2026-10-14).
#[test]
fn a_figure_description_holds_500_outside_the_bank() {
    let max = questions::QUESTION_DESCRIPTION_MAX;
    let question = |description: String, image: Value| {
        json!({
            "id": "q",
            "labels": "letters",
            "layout": "paper",
            "parts": [{
                "answer": { "correct": true, "type": "boolean" },
                "blocks": [{ "text": "?", "type": "text" }],
                "id": "p",
                "marks": 1,
                "solution": [{ "text": "Because.", "type": "text" }],
            }],
            "stem": [{
                "description": description,
                "height": 20,
                "image": image,
                "type": "image",
                "width": 20,
            }],
        })
    };
    let quiz = Policy::default();
    let asset = json!({ "assetId": "a1" });
    questions::validate_question(&question("d".repeat(max), asset.clone()), &quiz).unwrap();
    assert!(questions::validate_question(&question("d".repeat(max + 1), asset), &quiz).is_err());
    let bank = Policy {
        bank: true,
        bank_assets_url: Some("https://bank.example/assets".into()),
        ..Policy::default()
    };
    let hosted = json!({ "url": "https://bank.example/assets/a.png" });
    questions::validate_question(&question("d".repeat(2 * max), hosted), &bank).unwrap();

    let graph = |description: String| {
        material::assert_canonical(
            &[json!({
                "block": {
                    "board": { "axis": true, "bbox": [-5, 5, 5, -5], "grid": false },
                    "description": description,
                    "elements": [],
                    "height": 190,
                    "image": { "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" },
                    "type": "graph",
                    "width": 320,
                },
                "children": [{ "text": "" }],
                "id": "g1",
                "type": "graph",
            })],
            "note",
        )
    };
    graph("d".repeat(max)).unwrap();
    assert!(graph("d".repeat(max + 1)).is_err());
}
