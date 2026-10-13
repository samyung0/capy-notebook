#![allow(clippy::unwrap_used)] // Tests panic on a broken corpus.
//! Corpus loading for the parity tests (tests/corpus, made by generate.sh).
#![allow(dead_code)]

use std::io::Read;
use std::path::PathBuf;

use base64::Engine;
use notes::limits::{Admission, Metrics, Refusal, Validator};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use yrs::updates::decoder::Decode;
use yrs::{ReadTxn, Transact};

/// `Validator::admit` on update bytes, decoded as the server decodes them.
pub trait AdmitBytes {
    fn admit_bytes(&mut self, doc: &yrs::Doc, update: &[u8]) -> Result<Admission, Refusal>;
}

impl AdmitBytes for Validator {
    fn admit_bytes(&mut self, doc: &yrs::Doc, update: &[u8]) -> Result<Admission, Refusal> {
        let update = ydoc::decode(update)?;
        self.admit(doc, &update)
    }
}

pub fn corpus_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/corpus")
        .join(name)
}

/// A corpus file, gzipped (`.json.gz`) or plain (`.json`).
pub fn load(name: &str) -> Value {
    let gz = corpus_path(&format!("{name}.json.gz"));
    let text = if gz.exists() {
        let mut text = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(gz).unwrap())
            .read_to_string(&mut text)
            .unwrap();
        text
    } else {
        std::fs::read_to_string(corpus_path(&format!("{name}.json"))).unwrap()
    };
    serde_json::from_str(&text).unwrap()
}

pub fn bytes(value: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(value.as_str().unwrap())
        .unwrap()
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The corpus hash: SHA-256 of the sorted-key JSON.
pub fn hash(value: &Value) -> String {
    let digest = Sha256::digest(notes::json::canonical(value).as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// A document holding `state`, as the room or a client.
pub fn doc(state: &[u8], client: u64) -> yrs::Doc {
    let doc = yrs::Doc::with_options(ydoc::doc_options(client));
    apply(&doc, state);
    doc
}

pub fn apply(doc: &yrs::Doc, bytes: &[u8]) {
    doc.transact_mut()
        .apply_update(yrs::Update::decode_v1(bytes).unwrap())
        .unwrap();
}

pub fn state(doc: &yrs::Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&yrs::StateVector::default())
}

pub fn metrics_json(metrics: &Metrics) -> Value {
    serde_json::to_value(metrics).unwrap()
}

fn exceeds(growth: &Metrics, previous: &Metrics, next: &Metrics) -> bool {
    next.content_bytes > previous.content_bytes + growth.content_bytes
        || next.node_count > previous.node_count + growth.node_count
        || next.max_depth > previous.max_depth.max(growth.max_depth)
}

/// A room fed recorded updates, checked as the Node server checked them.
pub struct Room {
    pub doc: yrs::Doc,
    pub validator: Validator,
    previous: Metrics,
    pub checked: usize,
    pub same_growth: usize,
    pub exact_differs: usize,
    /// Updates Node took and the key rules refuse (REVIEW5 R2): the corpus's
    /// synthetic writers insert blocks without ids, and move references
    /// below the top level, which the store refuses (live-items REVIEW5 R2).
    pub tightened: usize,
}

impl Room {
    pub fn new(initial: &[u8], client: u64) -> Self {
        let doc = doc(initial, client);
        let previous = notes::limits::measure(&doc.transact()).unwrap();
        Room {
            doc,
            validator: Validator::new("note"),
            previous,
            checked: 0,
            same_growth: 0,
            exact_differs: 0,
            tightened: 0,
        }
    }

    /// One recorded update: the growth bound against the JS bound and the
    /// exact growth, `admit` against the outcome of `validateUpdate`, then
    /// the room after it.
    pub fn deliver(&mut self, record: &Value, update: &[u8], at: &str, failures: &mut Vec<String>) {
        self.checked += 1;
        let growth = notes::bound::update_growth(&self.doc.transact(), update);
        let js_growth: Option<Metrics> = serde_json::from_value(record["growth"].clone()).unwrap();
        match (&growth, &js_growth) {
            (None, None) => self.same_growth += 1,
            (Some(ours), Some(theirs)) if ours == theirs => self.same_growth += 1,
            _ => failures.push(format!("{at}: growth {growth:?}, JS {js_growth:?}")),
        }
        let exact_before = self.validator.exact_checks;
        let admitted = self.validator.admit_bytes(&self.doc, update);
        let outcome = &record["outcome"];
        if (self.validator.exact_checks > exact_before) != outcome["exact"].as_bool().unwrap() {
            self.exact_differs += 1;
        }
        let ours = match &admitted {
            Ok(Admission::Accepted) => json!({ "accepted": true }),
            Ok(Admission::Unheld) => json!({ "unheld": true }),
            Err(Refusal::Limit { code, metrics }) => {
                json!({ "code": code.as_str(), "metrics": metrics, "refused": true })
            }
            Err(other) => json!({ "error": other.to_string(), "refused": true }),
        };
        let mut theirs = outcome.clone();
        theirs.as_object_mut().unwrap().remove("exact");
        // Counted, and the update still goes in as Node took it, so later
        // deliveries compare; the room re-measures exactly, as after any
        // content the validator did not admit.
        let tightened = outcome["accepted"].as_bool() == Some(true)
            && matches!(&admitted, Err(Refusal::Content(what))
                if *what == notes::limits::MISSING_KEY || *what == notes::limits::NESTED_BLOCK);
        if tightened {
            self.tightened += 1;
            self.validator.invalidate();
        } else if ours != theirs {
            failures.push(format!("{at}: outcome {ours} != JS {theirs}"));
        }
        if outcome["accepted"].as_bool() == Some(true)
            && (tightened || matches!(admitted, Ok(Admission::Accepted)))
        {
            apply(&self.doc, update);
            for cleanup in record["roomCleanup"].as_array().unwrap() {
                apply(&self.doc, &bytes(cleanup));
            }
            let txn = self.doc.transact();
            let metrics = notes::limits::measure(&txn).unwrap();
            if metrics_json(&metrics) != record["roomMetrics"] {
                failures.push(format!(
                    "{at}: room metrics {metrics:?} != {}",
                    record["roomMetrics"]
                ));
            }
            if let Some(growth) = &growth
                && exceeds(growth, &self.previous, &metrics)
            {
                failures.push(format!(
                    "{at}: bound {growth:?} below the exact growth {:?} -> {metrics:?}",
                    self.previous
                ));
            }
            let value = Value::Array(notes::plate::value(&txn).unwrap());
            if hash(&value) != record["roomHash"].as_str().unwrap() {
                failures.push(format!("{at}: room value differs"));
            }
            self.previous = metrics;
        } else if let (Some(growth), Some(code)) = (&growth, outcome["code"].as_str()) {
            let candidate: Metrics = serde_json::from_value(outcome["metrics"].clone()).unwrap();
            if exceeds(growth, &self.previous, &candidate) {
                failures.push(format!(
                    "{at}: bound {growth:?} below the refused growth ({code})"
                ));
            }
        }
    }

    pub fn summary(&self) -> String {
        format!(
            "{} room checks, growth equal to JS {}, exact path differs {}, tightened {}",
            self.checked, self.same_growth, self.exact_differs, self.tightened
        )
    }
}

/// An update's content in a fixed order: its structs by client and clock
/// (each as yrs prints it: id, length, origins, parent, content) and its
/// deleted ranges. Two encoders that order clients differently give the same
/// form for the same items.
/// Structs as (client, clock, form) and deleted ranges per client.
pub type UpdateForm = (Vec<(u64, u32, String)>, Vec<(u64, Vec<(u32, u32)>)>);

pub fn update_form(bytes: &[u8]) -> UpdateForm {
    let update = yrs::Update::decode_v1(bytes).unwrap();
    let mut structs: Vec<(u64, u32, String)> = update
        .blocks()
        .map(|block| match block {
            yrs::UpdateBlock::Item(item) => {
                (item.id().client.get(), item.id().clock, item_form(item))
            }
            yrs::UpdateBlock::Gc(range) => {
                (range.client.get(), range.clock, format!("gc {}", range.len))
            }
            yrs::UpdateBlock::Skip(range) => (
                range.client.get(),
                range.clock,
                format!("skip {}", range.len),
            ),
        })
        .collect();
    structs.sort();
    let mut deletes: Vec<(u64, Vec<(u32, u32)>)> = update
        .delete_set()
        .iter()
        .map(|(client, ranges)| {
            (
                client.get(),
                ranges.iter().map(|r| (r.start, r.end)).collect(),
            )
        })
        .collect();
    deletes.sort();
    (structs, deletes)
}

/// One decoded item: where it goes and what it holds, maps with sorted keys.
fn item_form(item: &yrs::block::Item) -> String {
    use yrs::block::ItemContent;
    let any = |value: &yrs::Any| {
        notes::json::any_to_value(value)
            .map_or_else(|_| format!("{value:?}"), |v| notes::json::canonical(&v))
    };
    let content = match item.content() {
        ItemContent::Any(values) => format!("any {:?}", values.iter().map(any).collect::<Vec<_>>()),
        ItemContent::Format(key, value) => format!("format {key}={}", any(value)),
        ItemContent::Embed(value) => format!("embed {}", any(value)),
        ItemContent::String(text) => format!("string {:?}", text.as_str()),
        ItemContent::Type(branch) => format!("type {:?}", branch.type_ref()),
        ItemContent::Deleted(len) => format!("deleted {len}"),
        other => format!("{other:?}"),
    };
    format!(
        "{:?} len {} origin {:?} right {:?} parent {:?} key {:?} {content}",
        item.id(),
        item.len(),
        item.origin(),
        item.right_origin(),
        item.update_parent(),
        item.parent_sub()
    )
}

/// The same items and deletions, whatever the client order of the encoding.
pub fn same_update(a: &[u8], b: &[u8]) -> bool {
    update_form(a) == update_form(b)
}
