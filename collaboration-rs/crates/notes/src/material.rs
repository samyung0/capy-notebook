//! Canonical material document validation (`collaboration/src/materialDocument.ts`,
//! kept in sync with Go `server/internal/materialdoc/document.go`): the store
//! runs it before writing authoritative state so Go can always project it.
//! The checks and their order, and the messages, are the TS ones.

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::questions::{self, Policy, js_trim};

pub const DEPTH_CEILING: usize = 1024;
/// The interactive HTML block: a top-level void with one snippet.
pub const HTML_EMBED_TYPE: &str = "html_embed";
pub const HTML_EMBED_MAX_BYTES: usize = 64 * 1024;
pub const HTML_EMBED_MAX_COUNT: usize = 10;
/// The void block a note stores for an embedded quiz or flashcard set.
pub const MATERIAL_REF_TYPE: &str = "material_ref";
/// A card's front and back, in characters as Go counts them (runes): Go's
/// `fieldlimits.CardFront` and `CardBack`, which a Go test reads here.
pub const CARD_FRONT_MAX: usize = 4_000;
pub const CARD_BACK_MAX: usize = 2_000;
/// Media blocks name their file: an asset id, never a URL (Epo, 2026-10-10).
pub const MEDIA_TYPES: [&str; 4] = ["img", "image", "audio", "file"];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid material document: {0}")]
pub struct ValidationError(pub String);

type Node = Map<String, Value>;
type Check = Result<(), ValidationError>;

fn fail<T>(message: impl Into<String>) -> Result<T, ValidationError> {
    Err(ValidationError(message.into()))
}

/// `JSON.stringify(value)`; `undefined` (an absent value) prints as such.
fn stringify(value: Option<&Value>) -> String {
    value.map_or("undefined".into(), crate::json::stringify)
}

fn children(node: &Node) -> Vec<&Node> {
    match node.get("children") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    }
}

fn require_id(node: &Node) -> Check {
    match node.get("id").and_then(Value::as_str) {
        Some(id) if !js_trim(id).is_empty() => Ok(()),
        _ => fail("id is required"),
    }
}

fn reject_opaque(node: &Node) -> Check {
    for key in ["questions", "cards", "code"] {
        if node.contains_key(key) {
            return fail(format!("opaque {key} property is not canonical"));
        }
    }
    Ok(())
}

fn has_text_descendant(node: &Node) -> bool {
    node.get("text").is_some_and(Value::is_string)
        || children(node).into_iter().any(has_text_descendant)
}

/// One child: `{"text":""}` exactly.
fn empty_leaf(leaves: &[&Node]) -> bool {
    leaves.len() == 1
        && leaves[0].len() == 1
        && leaves[0].get("text") == Some(&Value::String(String::new()))
}

/// JS `Set` membership for ids of any JSON type: primitives by value, objects
/// never equal another.
#[derive(Default)]
struct IdSet {
    seen: HashSet<String>,
}

impl IdSet {
    /// Whether `id` was already added; adds it.
    fn repeat(&mut self, id: Option<&Value>) -> bool {
        let key = match id {
            None => "u".to_owned(),
            Some(Value::Object(_) | Value::Array(_)) => return false,
            Some(value) => format!("v{}", crate::json::stringify(value)),
        };
        !self.seen.insert(key)
    }
}

fn validate_text_element(node: &Node) -> Check {
    for (index, child) in children(node).into_iter().enumerate() {
        if !child.get("text").is_some_and(Value::is_string) {
            return fail(format!("children[{index}] must be a text leaf"));
        }
    }
    Ok(())
}

fn validate_quiz(node: &Node) -> Check {
    reject_opaque(node)?;
    require_id(node)?;
    let list = children(node);
    let mut ids = IdSet::default();
    if !empty_leaf(&list) {
        for (index, question) in list.iter().enumerate() {
            if question.get("type").and_then(Value::as_str) != Some("quiz_question") {
                return fail(format!("children[{index}] must be a quiz_question"));
            }
            let id = question.get("id");
            if ids.repeat(id) {
                return fail(format!("duplicate question id {}", stringify(id)));
            }
        }
    }
    if node.contains_key("timeLimitMin") {
        return fail("quiz time limits are no longer supported");
    }
    Ok(())
}

fn validate_quiz_question(node: &Node, policy: &Policy) -> Check {
    reject_opaque(node)?;
    require_id(node)?;
    let question = node.get("question").unwrap_or(&Value::Null);
    questions::validate_question(question, policy).map_err(ValidationError)?;
    if node.get("id") != question.get("id") {
        return fail("question id must match wrapper id");
    }
    for key in [
        "questionType",
        "level",
        "points",
        "rubrics",
        "pairs",
        "acceptedAnswers",
        "hints",
        "correctOptionIds",
        "correctBoolean",
    ] {
        if node.contains_key(key) {
            return fail(format!("obsolete quiz property {key}"));
        }
    }
    if !empty_leaf(&children(node)) {
        return fail("quiz_question requires one void text child");
    }
    Ok(())
}

fn validate_flashcards(node: &Node) -> Check {
    reject_opaque(node)?;
    require_id(node)?;
    let mut ids = IdSet::default();
    for (index, card) in children(node).into_iter().enumerate() {
        if card.get("type").and_then(Value::as_str) != Some("flashcard") {
            return fail(format!("children[{index}] must be a flashcard"));
        }
        let id = card.get("id");
        if ids.repeat(id) {
            return fail(format!("duplicate card id {}", stringify(id)));
        }
    }
    Ok(())
}

fn validate_flashcard(node: &Node) -> Check {
    reject_opaque(node)?;
    require_id(node)?;
    let cards = children(node);
    if cards.len() != 2 {
        return fail("flashcard requires front and back children");
    }
    let kind = |n: &Node| n.get("type").and_then(Value::as_str).map(str::to_owned);
    if kind(cards[0]).as_deref() != Some("flashcard_front")
        || kind(cards[1]).as_deref() != Some("flashcard_back")
    {
        return fail("flashcard children must be front then back");
    }
    // Go's limits and image shape (validateFlashcard): a set Go cannot
    // project breaks the material for everyone.
    if text_chars(cards[0]) > CARD_FRONT_MAX {
        return fail(format!(
            "a flashcard front holds at most {CARD_FRONT_MAX} characters"
        ));
    }
    if text_chars(cards[1]) > CARD_BACK_MAX {
        return fail(format!(
            "a flashcard back holds at most {CARD_BACK_MAX} characters"
        ));
    }
    if let Some(image) = node.get("image") {
        let valid = image.as_object().is_some_and(|image| {
            image.len() == 1
                && image
                    .get("assetId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.trim().is_empty() && id.len() <= 128)
        });
        if !valid {
            return fail("flashcard image must be {assetId}");
        }
    }
    Ok(())
}

/// The characters of a node's text, counted as Go counts runes.
fn text_chars(node: &Node) -> usize {
    match node.get("text").and_then(Value::as_str) {
        Some(text) => text.chars().count(),
        None => children(node).into_iter().map(text_chars).sum(),
    }
}

/// An image, audio or file block carries its asset id and no URL
/// (`validateMediaElement`).
fn validate_media(node: &Node, kind: &str) -> Check {
    if !node
        .get("assetId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
    {
        return fail(format!("{kind} requires an assetId"));
    }
    for key in ["url", "src"] {
        if node.get(key).is_some_and(|value| !value.is_null()) {
            return fail(format!("{kind} cannot contain {key}"));
        }
    }
    Ok(())
}

fn validate_diagram(node: &Node) -> Check {
    reject_opaque(node)?;
    require_id(node)?;
    if !node.get("source").is_some_and(Value::is_string) {
        return fail("source must be a string");
    }
    validate_width(node)?;
    let list = children(node);
    if list.len() != 1 || list[0].get("type").and_then(Value::as_str) != Some("mermaid_caption") {
        return fail("diagram requires one mermaid_caption child");
    }
    Ok(())
}

/// `validateMediaWidth` (plate-2 3a87184d): the one optional `width` of a
/// resizable block (image, YouTube video, Mermaid, chart, graph), exactly
/// what the resize handles write, `^(?:[2-9][0-9]|100)%$` (Epo, 2026-10-08).
fn validate_width(node: &Node) -> Check {
    let valid = match node.get("width") {
        None => true,
        Some(Value::String(width)) => width.strip_suffix('%').is_some_and(|n| {
            !n.starts_with('0')
                && n.bytes().all(|b| b.is_ascii_digit())
                && n.parse::<u32>().is_ok_and(|n| (20..=100).contains(&n))
        }),
        Some(_) => false,
    };
    if valid {
        Ok(())
    } else {
        fail("width must be a whole percentage from 20 to 100")
    }
}

fn validate_embed(node: &Node, kind: &str, depth: usize) -> Check {
    if depth != 0 {
        return fail("chart and graph embeds must be top-level blocks");
    }
    require_id(node)?;
    if !empty_leaf(&children(node)) {
        return fail("chart and graph embeds require one empty text leaf");
    }
    let block = node.get("block");
    let typed = block
        .and_then(Value::as_object)
        .is_some_and(|b| b.get("type").and_then(Value::as_str) == Some(kind));
    if !typed {
        return fail("embed block type must match node type");
    }
    if node
        .keys()
        .any(|k| !matches!(k.as_str(), "id" | "type" | "block" | "children" | "width"))
    {
        return fail("unexpected embed field");
    }
    validate_width(node)?;
    let parsed = questions::block(block.unwrap_or(&Value::Null)).map_err(ValidationError)?;
    if parsed.kind == "graph" && matches!(parsed.image, Some(("url", _))) {
        // The TS raises this inside its try and re-wraps the message.
        return fail("invalid material document: note graphs require inline SVG");
    }
    Ok(())
}

fn validate_html_embed(node: &Node, depth: usize) -> Check {
    if depth != 0 {
        return fail("interactive blocks must be top-level blocks");
    }
    require_id(node)?;
    if !empty_leaf(&children(node)) {
        return fail("interactive blocks require one empty text leaf");
    }
    let Some(html) = node.get("html").and_then(Value::as_str) else {
        return fail("interactive html must be a string");
    };
    if html.len() > HTML_EMBED_MAX_BYTES {
        return fail(format!(
            "interactive html is {} bytes, over {HTML_EMBED_MAX_BYTES}",
            html.len()
        ));
    }
    if node.get("caption").is_some_and(|t| !t.is_string()) {
        return fail("interactive caption must be a string");
    }
    for key in node.keys() {
        if !matches!(
            key.as_str(),
            "id" | "type" | "html" | "caption" | "children"
        ) {
            return fail(format!("unexpected interactive field {key}"));
        }
    }
    Ok(())
}

fn validate_material_ref(node: &Node) -> Check {
    require_id(node)?;
    // A fence imported as markdown is a pending reference until the editor
    // creates its row: no material id yet, the fence body in `pending`.
    let Some(material_id) = node.get("materialId").and_then(Value::as_str) else {
        return fail("materialId is required");
    };
    let pending = node
        .get("pending")
        .and_then(Value::as_str)
        .is_some_and(|p| !p.is_empty());
    if js_trim(material_id).is_empty() && !pending {
        return fail("materialId is required");
    }
    if !matches!(
        node.get("refKind").and_then(Value::as_str),
        Some("quiz" | "flashcards")
    ) {
        return fail("refKind must be quiz or flashcards");
    }
    let leaves = children(node);
    if leaves.len() != 1 || leaves[0].get("text") != Some(&Value::String(String::new())) {
        return fail("material reference carries one empty text leaf");
    }
    Ok(())
}

fn validate_node(node: &Node, depth: usize, policy: &Policy) -> Check {
    if depth > DEPTH_CEILING {
        return fail("document nesting is too deep to decode");
    }
    for key in node.keys() {
        if key == "suggestion" || key.starts_with("suggestion_") {
            return fail(format!(
                "obsolete suggestion property {} is not allowed",
                crate::json::stringify(&Value::String(key.clone()))
            ));
        }
    }
    if node.contains_key("text") {
        if !node["text"].is_string() {
            return fail("text leaf must contain a string");
        }
        if node.contains_key("children") {
            return fail("text leaf cannot contain children");
        }
        return Ok(());
    }
    let kind = match node.get("type").and_then(Value::as_str) {
        Some(kind) if !js_trim(kind).is_empty() => kind,
        _ => return fail("element type is required"),
    };
    let list = match node.get("children") {
        Some(Value::Array(list)) if !list.is_empty() => list,
        _ => return fail("element children must be a non-empty array"),
    };
    for (index, child) in list.iter().enumerate() {
        let Some(child) = child.as_object() else {
            return fail(format!("children[{index}] must be an object"));
        };
        validate_node(child, depth + 1, policy)?;
    }
    if !has_text_descendant(node) {
        return fail("element must contain a text descendant");
    }
    match kind {
        "quiz" => validate_quiz(node),
        "chart" | "plot" | "graph" => validate_embed(node, kind, depth),
        "quiz_question" => validate_quiz_question(node, policy),
        HTML_EMBED_TYPE => validate_html_embed(node, depth),
        "flashcard_front" | "flashcard_back" | "mermaid_caption" => validate_text_element(node),
        "quiz_prompt" | "quiz_option" | "quiz_explanation" => fail("obsolete quiz child node"),
        "flashcards" => validate_flashcards(node),
        "flashcard" => validate_flashcard(node),
        "mermaid" => validate_diagram(node),
        "img" => {
            validate_media(node, kind)?;
            validate_width(node)
        }
        "image" | "audio" | "file" => validate_media(node, kind),
        MATERIAL_REF_TYPE => validate_material_ref(node),
        "video" => {
            if node.get("provider").and_then(Value::as_str) != Some("youtube") {
                return fail("video provider must be youtube");
            }
            let valid = node
                .get("videoId")
                .and_then(Value::as_str)
                .is_some_and(|id| {
                    id.len() == 11
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                });
            if !valid {
                return fail("videoId must be a valid YouTube video ID");
            }
            for key in ["assetId", "url", "src"] {
                if node.contains_key(key) {
                    return fail(format!("YouTube video cannot contain {key}"));
                }
            }
            validate_width(node)
        }
        _ => Ok(()),
    }
}

fn contains_type(nodes: &[&Node], kind: &str) -> bool {
    nodes.iter().any(|n| {
        n.get("type").and_then(Value::as_str) == Some(kind) || contains_type(&children(n), kind)
    })
}

/// Notes keep study blocks in their own rows: no inline quiz/flashcards, and a
/// reference only as a top-level block.
fn validate_note_references(nodes: &[&Node]) -> Check {
    for inline in ["quiz", "flashcards"] {
        if contains_type(nodes, inline) {
            return fail(format!("note cannot contain an inline {inline} block"));
        }
    }
    for (index, node) in nodes.iter().enumerate() {
        if contains_type(&children(node), MATERIAL_REF_TYPE) {
            return fail(format!(
                "value[{index}]: material reference must be a top-level block"
            ));
        }
    }
    Ok(())
}

/// `assertCanonicalMaterialValue(value, kind)`.
pub fn assert_canonical(value: &[Value], kind: &str) -> Check {
    assert_canonical_with(value, kind, &Policy::quiz())
}

/// [assert_canonical] with the quiz figure host given.
pub fn assert_canonical_with(value: &[Value], kind: &str, policy: &Policy) -> Check {
    if value.is_empty() {
        return fail("value must be a non-empty array");
    }
    let mut nodes = Vec::with_capacity(value.len());
    for (index, node) in value.iter().enumerate() {
        let Some(node) = node.as_object() else {
            return fail(format!("value[{index}] must be an object"));
        };
        validate_node(node, 0, policy)?;
        nodes.push(node);
    }
    let embeds = nodes
        .iter()
        .filter(|n| n.get("type").and_then(Value::as_str) == Some(HTML_EMBED_TYPE))
        .count();
    if embeds > HTML_EMBED_MAX_COUNT {
        return fail(format!(
            "{embeds} interactive blocks over {HTML_EMBED_MAX_COUNT}"
        ));
    }

    let mut found: Vec<&Map<String, Value>> = Vec::new();
    fn collect<'a>(node: &'a Node, out: &mut Vec<&'a Map<String, Value>>) {
        if node.get("type").and_then(Value::as_str) == Some("quiz_question")
            && let Some(question) = node.get("question").and_then(Value::as_object)
        {
            out.push(question);
        }
        for child in children(node) {
            collect(child, out);
        }
    }
    for node in &nodes {
        collect(node, &mut found);
    }
    // Every quiz_question passed validateQuestion above: parts are objects
    // with an answer object each.
    let parts: Vec<&Map<String, Value>> = found
        .iter()
        .flat_map(|q| {
            q.get("parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(Value::as_object)
        .collect();
    let open = parts
        .iter()
        .filter(|p| {
            p.get("answer")
                .and_then(|a| a.get("type"))
                .and_then(Value::as_str)
                == Some("open")
        })
        .count();
    questions::assert_quiz_bounds(parts.len(), open).map_err(ValidationError)?;
    let mut question_ids = IdSet::default();
    let mut part_ids = IdSet::default();
    for question in &found {
        if question_ids.repeat(question.get("id")) {
            return fail("duplicate question id");
        }
        for part in question
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if part_ids.repeat(part.get("id")) {
                return fail("duplicate part id");
            }
        }
    }

    let mut top_level = HashSet::new();
    for (index, node) in nodes.iter().enumerate() {
        let id = match node.get("id").and_then(Value::as_str) {
            Some(id) if !js_trim(id).is_empty() => js_trim(id),
            _ => return fail(format!("value[{index}].id is required")),
        };
        if !top_level.insert(id) {
            return fail(format!(
                "value[{index}].id {} is duplicated",
                crate::json::stringify(&Value::String(id.into()))
            ));
        }
    }

    let required: &[&str] = match kind {
        "quiz" => &["quiz"],
        "flashcards" => &["flashcards"],
        "mindmap" | "diagram" => &["mermaid"],
        "note" => return validate_note_references(&nodes),
        _ => return Ok(()),
    };
    if !required.iter().any(|t| contains_type(&nodes, t)) {
        return fail(format!("{kind} element is required"));
    }
    if contains_type(&nodes, MATERIAL_REF_TYPE) {
        return fail(format!("{kind} cannot contain a material reference"));
    }
    Ok(())
}
