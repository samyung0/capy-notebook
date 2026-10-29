//! The flavours a note's blocks layout holds (todo-blocksuite-layout.md
//! "Block flavours"): the parents each one may sit under, its props and the
//! defaults BlockSuite's `addBlock` writes.
//!
//! The `affine:*` prop lists and defaults are BlockSuite's own
//! (`affine/model/src/blocks/*`, AFFiNE canary 5f192549), plus the props the
//! spec marks "ours". The seed writes every non-undefined default, as
//! `addBlock` does: a block missing one gets it written by the browser's sync
//! controller when the model loads, which would be an edit at init.

use serde_json::{Value, json};

/// A prop's stored value type, as `native2Y` writes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Str,
    Num,
    Bool,
    StrOrNull,
    NumOrNull,
    /// A plain object: a deep Y.Map.
    Map,
    /// A colour: a string, or a `{dark, light}` Y.Map.
    StrOrMap,
}

pub struct Flavour {
    pub name: &'static str,
    /// Flavours it may sit under; empty for the page root.
    pub parents: &'static [&'static str],
    pub props: &'static [(&'static str, Kind)],
    /// Table only: props are flattened to dotted keys (`isFlatData`).
    pub flat: bool,
}

pub const PAGE: &str = "affine:page";
pub const NOTE: &str = "affine:note";
pub const PARAGRAPH: &str = "affine:paragraph";
pub const LIST: &str = "affine:list";
pub const CODE: &str = "affine:code";
pub const DIVIDER: &str = "affine:divider";
pub const CALLOUT: &str = "affine:callout";
pub const LATEX: &str = "affine:latex";
pub const IMAGE: &str = "affine:image";
pub const TABLE: &str = "affine:table";
pub const MATERIAL_REF: &str = "capy:material-ref";
pub const AUDIO: &str = "capy:audio";
pub const VIDEO: &str = "capy:video";
pub const TOC: &str = "capy:toc";
pub const CHART: &str = "capy:chart";
pub const PLOT: &str = "capy:plot";
pub const GRAPH: &str = "capy:graph";
pub const HTML: &str = "capy:html-embed";
pub const MERMAID: &str = "capy:mermaid";
pub const COLUMNS: &str = "capy:columns";
pub const COLUMN: &str = "capy:column";

/// Where a content block may sit: the note, a paragraph or list it is
/// nested under (indent), or a column.
const CONTENT: &[&str] = &[NOTE, PARAGRAPH, LIST, COLUMN];
/// Text blocks may also sit in a callout (BlockSuite's callout children).
const TEXT_PARENTS: &[&str] = &[NOTE, PARAGRAPH, LIST, CALLOUT, COLUMN];
const NOTE_ONLY: &[&str] = &[NOTE];

use Kind::*;

pub const FLAVOURS: &[Flavour] = &[
    Flavour {
        name: PAGE,
        parents: &[],
        props: &[("title", Text)],
        flat: false,
    },
    Flavour {
        name: NOTE,
        parents: &[PAGE],
        props: &[
            ("xywh", Str),
            ("background", StrOrMap),
            ("index", Str),
            ("lockedBySelf", Bool),
            ("hidden", Bool),
            ("displayMode", Str),
            ("edgeless", Map),
            ("comments", Map),
        ],
        flat: false,
    },
    Flavour {
        name: PARAGRAPH,
        parents: TEXT_PARENTS,
        props: &[
            ("type", Str),
            ("text", Text),
            ("textAlign", Str),
            ("collapsed", Bool),
            ("comments", Map),
        ],
        flat: false,
    },
    Flavour {
        name: LIST,
        parents: TEXT_PARENTS,
        props: &[
            ("type", Str),
            ("text", Text),
            ("textAlign", Str),
            ("checked", Bool),
            ("collapsed", Bool),
            ("order", NumOrNull),
            ("comments", Map),
            ("listStyleType", Str),
        ],
        flat: false,
    },
    Flavour {
        name: CODE,
        parents: CONTENT,
        props: &[
            ("text", Text),
            ("language", StrOrNull),
            ("wrap", Bool),
            ("caption", Str),
            ("preview", Bool),
            ("lineNumber", Bool),
            ("collapsed", Bool),
            ("comments", Map),
        ],
        flat: false,
    },
    Flavour {
        name: DIVIDER,
        parents: CONTENT,
        props: &[],
        flat: false,
    },
    Flavour {
        name: CALLOUT,
        parents: CONTENT,
        props: &[
            ("icon", Map),
            ("text", Text),
            ("backgroundColorName", Str),
            ("variant", Str),
        ],
        flat: false,
    },
    Flavour {
        name: LATEX,
        parents: CONTENT,
        props: &[
            ("xywh", Str),
            ("index", Str),
            ("lockedBySelf", Bool),
            ("scale", Num),
            ("rotate", Num),
            ("latex", Str),
            ("comments", Map),
        ],
        flat: false,
    },
    Flavour {
        name: IMAGE,
        parents: CONTENT,
        props: &[
            ("caption", Str),
            ("sourceId", Str),
            ("width", Num),
            ("height", Num),
            ("index", Str),
            ("xywh", Str),
            ("lockedBySelf", Bool),
            ("rotate", Num),
            ("size", Num),
            ("comments", Map),
            ("textAlign", Str),
            ("name", Str),
            ("contentType", Str),
        ],
        flat: false,
    },
    Flavour {
        name: TABLE,
        parents: NOTE_ONLY,
        props: &[("comments", Map), ("textAlign", Str)],
        flat: true,
    },
    Flavour {
        name: MATERIAL_REF,
        parents: NOTE_ONLY,
        props: &[("materialId", Str), ("refKind", Str)],
        flat: false,
    },
    Flavour {
        name: AUDIO,
        parents: CONTENT,
        props: &[
            ("assetId", Str),
            ("name", Str),
            ("contentType", Str),
            ("sizeBytes", Num),
            ("caption", Str),
        ],
        flat: false,
    },
    Flavour {
        name: VIDEO,
        parents: CONTENT,
        props: &[
            ("provider", Str),
            ("videoId", Str),
            ("width", Str),
            ("caption", Str),
        ],
        flat: false,
    },
    Flavour {
        name: TOC,
        parents: CONTENT,
        props: &[],
        flat: false,
    },
    Flavour {
        name: CHART,
        parents: NOTE_ONLY,
        props: &[("block", Map), ("width", Str)],
        flat: false,
    },
    Flavour {
        name: PLOT,
        parents: NOTE_ONLY,
        props: &[("block", Map), ("width", Str)],
        flat: false,
    },
    Flavour {
        name: GRAPH,
        parents: NOTE_ONLY,
        props: &[("block", Map), ("width", Str)],
        flat: false,
    },
    Flavour {
        name: HTML,
        parents: NOTE_ONLY,
        props: &[("html", Str), ("caption", Str)],
        flat: false,
    },
    Flavour {
        name: MERMAID,
        parents: CONTENT,
        props: &[
            ("source", Text),
            ("caption", Text),
            ("width", Str),
            ("theme", Str),
        ],
        flat: false,
    },
    Flavour {
        name: COLUMNS,
        parents: NOTE_ONLY,
        props: &[],
        flat: false,
    },
    Flavour {
        name: COLUMN,
        parents: &[COLUMNS],
        props: &[("width", Str)],
        flat: false,
    },
];

/// The note column width an image's stored percentage is measured against
/// while the Plate bridge stands (D21, N8).
pub const IMAGE_REFERENCE_PX: f64 = 768.0;

/// `"<n>%"` → n, for a plain decimal n.
pub fn percent(width: &str) -> Option<f64> {
    let n = width.strip_suffix('%')?;
    let (int, frac) = n.split_once('.').unwrap_or((n, "0"));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    (digits(int) && digits(frac))
        .then(|| n.parse().ok())
        .flatten()
}

/// A stored image percentage → pixels against the reference column.
pub fn percent_to_px(percent: f64) -> i64 {
    (percent * IMAGE_REFERENCE_PX / 100.0).round() as i64
}

/// Image pixels → the stored `"<n>%"`, clamped to 20–100.
pub fn px_to_percent(px: f64) -> String {
    let percent = (px / IMAGE_REFERENCE_PX * 100.0).round().clamp(20.0, 100.0);
    format!("{percent}%")
}

pub fn flavour(name: &str) -> Option<&'static Flavour> {
    FLAVOURS.iter().find(|f| f.name == name)
}

/// Whether blocks of this flavour hold nested blocks by indent.
pub fn holds_indented(flavour: &str) -> bool {
    flavour == PARAGRAPH || flavour == LIST
}

/// The non-undefined defaults BlockSuite's schema gives a flavour, in its
/// order. Text defaults (`internal.Text()`) are written by the converter.
pub fn defaults(flavour: &str) -> Vec<(&'static str, Value)> {
    match flavour {
        NOTE => vec![
            ("xywh", json!("[0,0,498,92]")),
            // DefaultTheme.noteBackgrounColor: edgeless/note/white.
            ("background", json!({"dark": "#252525", "light": "#ffffff"})),
            ("index", json!("a0")),
            ("lockedBySelf", json!(false)),
            ("hidden", json!(false)),
            // NoteDisplayMode.DocOnly (its value is "doc").
            ("displayMode", json!("doc")),
            (
                "edgeless",
                json!({"style": {
                    "borderRadius": 8,
                    "borderSize": 4,
                    "borderStyle": "none",
                    "shadowType": "--affine-note-shadow-box",
                }}),
            ),
        ],
        PARAGRAPH => vec![("type", json!("text")), ("collapsed", json!(false))],
        LIST => vec![
            ("type", json!("bulleted")),
            ("checked", json!(false)),
            ("collapsed", json!(false)),
            ("order", Value::Null),
        ],
        CODE => vec![
            ("language", Value::Null),
            ("wrap", json!(false)),
            ("caption", json!("")),
        ],
        CALLOUT => vec![
            ("icon", json!({"type": "emoji", "unicode": "\u{1f4a1}"})),
            ("backgroundColorName", json!("grey")),
        ],
        LATEX => vec![
            ("xywh", json!("[0,0,16,16]")),
            ("index", json!("a0")),
            ("lockedBySelf", json!(false)),
            ("scale", json!(1)),
            ("rotate", json!(0)),
            ("latex", json!("")),
        ],
        IMAGE => vec![
            ("caption", json!("")),
            ("sourceId", json!("")),
            ("width", json!(0)),
            ("height", json!(0)),
            ("index", json!("a0")),
            ("xywh", json!("[0,0,0,0]")),
            ("lockedBySelf", json!(false)),
            ("rotate", json!(0)),
            ("size", json!(-1)),
        ],
        _ => Vec::new(),
    }
}

/// Text props a flavour's schema creates empty (`internal.Text()`).
pub fn text_props(flavour: &str) -> &'static [&'static str] {
    match flavour {
        PAGE => &["title"],
        PARAGRAPH | LIST | CODE | CALLOUT => &["text"],
        MERMAID => &["source", "caption"],
        _ => &[],
    }
}

/// Y.Text attributes a note's text may carry: the spec's inline formats.
pub const TEXT_ATTRIBUTES: &[&str] = &[
    "bold",
    "italic",
    "underline",
    "code",
    "strike",
    "color",
    "background",
    "subscript",
    "superscript",
    "highlight",
    "kbd",
    "fontSize",
    "fontFamily",
    "link",
    "latex",
    "mention",
];

/// Plate mark → Y.Text attribute.
pub fn attribute_of_mark(mark: &str) -> Option<&'static str> {
    Some(match mark {
        "bold" => "bold",
        "italic" => "italic",
        "underline" => "underline",
        "code" => "code",
        "strikethrough" => "strike",
        "color" => "color",
        "backgroundColor" => "background",
        "subscript" => "subscript",
        "superscript" => "superscript",
        "highlight" => "highlight",
        "kbd" => "kbd",
        "fontSize" => "fontSize",
        "fontFamily" => "fontFamily",
        _ => return None,
    })
}

/// Y.Text attribute → Plate mark (inline elements excluded).
pub fn mark_of_attribute(attribute: &str) -> Option<&'static str> {
    Some(match attribute {
        "strike" => "strikethrough",
        "background" => "backgroundColor",
        "link" | "latex" | "mention" => return None,
        other => TEXT_ATTRIBUTES.iter().find(|a| **a == other)?,
    })
}

/// Plate marks never written to the blocks layout (transient or relational).
pub fn dropped_mark(mark: &str) -> bool {
    mark == "ai" || mark == "comment" || mark.starts_with("comment_")
}
