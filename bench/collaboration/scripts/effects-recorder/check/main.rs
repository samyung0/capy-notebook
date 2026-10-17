//! effects-recorder-check: the server side of a recorded Office case.
//!
//!   effects-recorder-check seed <docx|pptx|xlsx> <fixture> <out.bin>
//!     office_service::seed (what Sources::seed asks the engine pool for);
//!     prints {fixtureSha256, seedSha256, bytes}.
//!   effects-recorder-check check <case-dir> <worktree-root> [<peer>=<client-state.bin>]...
//!     Replays the case on the seed as a source room does: each update in
//!     server order through sources::admit_update, then applied. Prints the
//!     admission counts, pending structs, whether the room equals each
//!     editor replica (state vector + delete set, and every root's JSON), the
//!     engine's own save effects over the seed, and writes the engine export
//!     of the final room to <case-dir>/client/server-export.<ext>.

#![allow(clippy::print_stdout)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use office_service::{Checkpoint, Determinism, Format};
use serde_json::{Value, json};
use sources::{Admission, SourceFormat, admit_update};
use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

fn checkpoint_of<'a>(format: Format, base_sha256: &'a str, state: &'a [u8]) -> Checkpoint<'a> {
    Checkpoint {
        format,
        schema_version: 1,
        base_sha256,
        state,
    }
}

fn format_of(name: &str) -> (Format, SourceFormat) {
    match name {
        "docx" => (Format::Docx, SourceFormat::Docx),
        "pptx" => (Format::Pptx, SourceFormat::Pptx),
        "xlsx" => (Format::Xlsx, SourceFormat::Xlsx),
        other => fail(&format!("unknown format {other}")),
    }
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(2)
}

fn read(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|error| fail(&format!("{}: {error}", path.display())))
}

fn apply(doc: &Doc, bytes: &[u8]) {
    let update = Update::decode_v1(bytes).unwrap_or_else(|error| fail(&format!("decode: {error}")));
    doc.transact_mut()
        .apply_update(update)
        .unwrap_or_else(|error| fail(&format!("apply: {error}")));
}

fn roots(doc: &Doc) -> BTreeMap<String, String> {
    let txn = doc.transact();
    txn.root_refs()
        .map(|(name, out)| {
            let mut json = String::new();
            out.to_json(&txn).to_json(&mut json);
            (name.to_string(), json)
        })
        .collect()
}

fn pending(doc: &Doc) -> (usize, usize) {
    let txn = doc.transact();
    let store = txn.store();
    let structs = store
        .pending_update()
        .map(|pending| pending.update.blocks().count())
        .unwrap_or(0);
    let deletes = store
        .pending_ds()
        .map(|ds| ds.iter().count())
        .unwrap_or(0);
    (structs, deletes)
}

fn state_vector_json(doc: &Doc) -> Value {
    let txn = doc.transact();
    let mut map = serde_json::Map::new();
    let mut entries: Vec<_> = txn.state_vector().iter().map(|(c, k)| (c.get(), *k)).collect();
    entries.sort();
    for (client, clock) in entries {
        map.insert(client.to_string(), json!(clock));
    }
    Value::Object(map)
}

fn seed_cmd(format: &str, fixture: &str, out: &str) {
    let (format, _) = format_of(format);
    let base = read(Path::new(fixture));
    let state = office_service::seed(format, &base).unwrap_or_else(|error| fail(&error.to_string()));
    fs::write(out, &state).unwrap_or_else(|error| fail(&error.to_string()));
    println!(
        "{}",
        json!({
            "fixtureSha256": office_service::sha256_hex(&base),
            "seedSha256": office_service::sha256_hex(&state),
            "bytes": state.len(),
        })
    );
}

fn check_cmd(case: &str, root: &str, clients: &[String]) {
    let case = PathBuf::from(case);
    let manifest: Value = serde_json::from_slice(&read(&case.join("manifest.json")))
        .unwrap_or_else(|error| fail(&format!("manifest: {error}")));
    let format_name = manifest["format"].as_str().unwrap_or_default();
    let (format, source_format) = format_of(format_name);
    let base = read(&Path::new(root).join(manifest["fixture"]["path"].as_str().unwrap_or_default()));
    let base_sha = office_service::sha256_hex(&base);
    let seed = read(&case.join(manifest["seed"]["file"].as_str().unwrap_or_default()));

    // The room at epoch start: seed(base) in one transaction, as a NULL state loads.
    let doc = ydoc::scratch_doc();
    apply(&doc, &seed);
    let mut estimate = seed.len() as u64;
    let mut updates: Vec<&Value> = manifest["updates"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
    updates.sort_by_key(|update| update["order"].as_u64().unwrap_or(0));
    let (mut admitted, mut unheld, mut refused) = (0, 0, Vec::new());
    for update in &updates {
        let bytes = read(&case.join(update["file"].as_str().unwrap_or_default()));
        match admit_update(&doc, source_format, &bytes, &mut estimate) {
            Admission::Accept => {
                admitted += 1;
                estimate += bytes.len() as u64;
                apply(&doc, &bytes);
            }
            Admission::Unheld => {
                // The server drops it and resyncs; applied here to see the end state.
                unheld += 1;
                apply(&doc, &bytes);
            }
            Admission::Refuse(refusal) => refused.push(json!({
                "order": update["order"],
                "message": refusal.message(),
            })),
        }
    }
    let (pending_structs, pending_deletes) = pending(&doc);
    let server_snapshot = doc.transact().snapshot();
    let server_roots = roots(&doc);
    let mut client_checks = serde_json::Map::new();
    for client in clients {
        let (peer, path) = client.split_once('=').unwrap_or_else(|| fail("client is <peer>=<path>"));
        let replica = ydoc::scratch_doc();
        apply(&replica, &read(Path::new(path)));
        let same_state = replica.transact().snapshot() == server_snapshot;
        let replica_roots = roots(&replica);
        let differing: Vec<&String> = server_roots
            .keys()
            .chain(replica_roots.keys())
            .filter(|name| server_roots.get(*name) != replica_roots.get(*name))
            .collect();
        client_checks.insert(
            peer.to_string(),
            json!({
                "sameStateVectorAndDeleteSet": same_state,
                "rootsDiffering": differing,
                "replicaPending": pending(&replica).0,
            }),
        );
    }

    // The engine's view: today's save effects over the seed, and its export.
    let state = doc.transact().encode_state_as_update_v1(&StateVector::default());
    let engine_effects = match format {
        Format::Xlsx => office_service::xlsx_pending_effects(&base, checkpoint_of(format, &base_sha, &state)),
        _ => office_service::baseline(&base, checkpoint_of(format, &base_sha, &seed))
            .and_then(|indexed| office_service::save_effects(&base, &indexed, checkpoint_of(format, &base_sha, &state))),
    };
    let engine_effects = match engine_effects {
        Ok(effects) => serde_json::to_value(effects).unwrap_or(Value::Null),
        Err(error) => json!({ "error": error.to_string() }),
    };
    let export = office_service::export(
        &base,
        checkpoint_of(format, &base_sha, &state),
        Determinism {
            seed: &base_sha,
            now: "2026-10-17T00:00:00.000Z",
        },
    );
    let export_file = match export {
        Ok(bytes) => {
            let dir = case.join("client");
            let _ = fs::create_dir_all(&dir);
            let file = dir.join(format!("server-export.{format_name}"));
            fs::write(&file, bytes).unwrap_or_else(|error| fail(&error.to_string()));
            json!(format!("client/server-export.{format_name}"))
        }
        Err(error) => json!({ "error": error.to_string() }),
    };
    println!(
        "{}",
        json!({
            "admitted": admitted,
            "unheld": unheld,
            "refused": refused,
            "pendingStructs": pending_structs,
            "pendingDeletes": pending_deletes,
            "serverStateBytes": state.len(),
            "serverStateVector": state_vector_json(&doc),
            "clients": client_checks,
            "engineEffects": engine_effects,
            "serverExport": export_file,
        })
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("seed") if args.len() == 5 => seed_cmd(&args[2], &args[3], &args[4]),
        Some("check") if args.len() >= 4 => check_cmd(&args[2], &args[3], &args[4..]),
        _ => fail("usage: effects-recorder-check seed <format> <fixture> <out> | check <case-dir> <root> [<peer>=<state>]..."),
    }
}
