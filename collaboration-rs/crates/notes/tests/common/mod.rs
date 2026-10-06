//! Corpus loading for the parity tests (tests/corpus, made by generate.sh).
#![allow(dead_code)]

use std::io::Read;
use std::path::PathBuf;

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

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
    use yrs::Transact;
    use yrs::updates::decoder::Decode;
    let doc = yrs::Doc::with_options(notes::doc_options(client));
    doc.transact_mut()
        .apply_update(yrs::Update::decode_v1(state).unwrap())
        .unwrap();
    doc
}

pub fn metrics_json(metrics: &notes::limits::Metrics) -> Value {
    serde_json::to_value(metrics).unwrap()
}
