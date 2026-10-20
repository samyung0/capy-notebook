//! The cost of one Office source save on the Rust server path, step by step,
//! as opt-survey's `office-save.mts` measures the Node one: room-side yrs work
//! (admission, the row, the whole state for the engine, the load check and the
//! fold) in this process, effects in an engine process of the pool.
//!
//!   cargo run --release -p sources --example save_probe -- <docx|xlsx|pptx> <file> <reps> <engine-exe>
//!
//! Prints one JSON line: per step the median CPU and wall ms (engine steps:
//! the engine process's CPU and the call's wall time with the pipe), bytes.

#![allow(clippy::print_stdout, clippy::unwrap_used)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine as _;
use office_service::{BaselineEntry, Command, Entry, Format, NetEffect};
use serde_json::{Map, Value, json};
use sources::engine::office::Args;
use sources::engine::{EnginePool, Frame, Lane, PoolConfig, Reply};
use sources::{SourceFormat, admit_update};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

struct Probe {
    out: Map<String, Value>,
    reps: usize,
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

impl Probe {
    /// A room-side step in this process, `reps` times.
    fn local<T>(&mut self, name: &str, reps: usize, mut step: impl FnMut() -> T) -> T {
        let (mut cpu, mut wall) = (Vec::new(), Vec::new());
        let mut result = None;
        for _ in 0..reps {
            let started = cpu_time::ProcessTime::now();
            let at = Instant::now();
            result = Some(step());
            wall.push(at.elapsed().as_secs_f64() * 1000.0);
            cpu.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        self.out.insert(
            name.into(),
            json!({ "cpuMs": (median(cpu) * 100.0).round() / 100.0, "wallMs": (median(wall) * 100.0).round() / 100.0 }),
        );
        result.unwrap()
    }

    /// An engine call, `reps` times: the engine process's CPU, the call's wall.
    async fn engine(
        &mut self,
        pool: &EnginePool,
        name: &str,
        reps: usize,
        lane: Lane,
        room: &str,
        request: impl Fn() -> Frame,
    ) -> Reply {
        let (mut cpu, mut wall, mut run) = (Vec::new(), Vec::new(), Vec::new());
        let mut last = None;
        for _ in 0..reps {
            let at = Instant::now();
            let reply = pool.call(lane, Some(room), request()).await.unwrap();
            wall.push(at.elapsed().as_secs_f64() * 1000.0);
            cpu.push(reply.usage.cpu_ms.unwrap_or_default());
            run.push(reply.usage.run_ms);
            last = Some(reply);
        }
        let reply = last.unwrap();
        self.out.insert(
            name.into(),
            json!({
                "cpuMs": median(cpu).round(),
                "wallMs": median(wall).round(),
                "engineRunMs": median(run).round(),
                "rssMiB": reply.usage.rss.map(|rss| rss >> 20),
                "peakMiB": reply.usage.peak_rss.map(|rss| rss >> 20),
            }),
        );
        reply
    }
}

fn frame(method: &str, args: Args, blobs: Vec<Vec<u8>>) -> Frame {
    Frame::new(method, serde_json::to_vec(&args).unwrap(), blobs)
}

fn encode(doc: &Doc, since: &StateVector) -> Vec<u8> {
    doc.transact().encode_state_as_update_v1(since)
}

fn replay(doc: &Doc, updates: &[&[u8]]) {
    let mut txn = doc.transact_mut();
    for update in updates {
        txn.apply_update(Update::decode_v1(update).unwrap())
            .unwrap();
    }
    assert!(txn.store().pending_update().is_none());
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let format: Format = serde_json::from_value(json!(args[1])).unwrap();
    let file = &args[2];
    let reps: usize = args[3].parse().unwrap();
    let engine = PathBuf::from(&args[4]);
    let base = std::fs::read(file).unwrap();
    let sha = office_service::sha256_hex(&base);
    let room = "source:probe:epoch:1";
    let pool = EnginePool::new(PoolConfig {
        program: engine,
        args: Vec::new(),
        save_processes: 1,
        background_processes: 1,
        call_timeout: Duration::from_secs(600),
        replica_budget_bytes: 1 << 30,
        memory_limit_bytes: None,
    });
    let mut probe = Probe {
        out: Map::new(),
        reps,
    };
    probe.out.insert("format".into(), json!(format));
    probe.out.insert(
        "file".into(),
        json!(PathBuf::from(file).file_name().unwrap().to_string_lossy()),
    );
    probe.out.insert(
        "zipMiB".into(),
        json!((base.len() as f64 / 1048576.0 * 10.0).round() / 10.0),
    );
    let args = || Args {
        format: Some(format),
        base_sha256: Some(sha.clone()),
        ..Args::default()
    };

    // Load: seed(base) in the engine (the first call also starts the process),
    // then the room replays it.
    let spawn = Instant::now();
    pool.call(
        Lane::Save,
        Some(room),
        frame("test.echo", Args::default(), Vec::new()),
    )
    .await
    .unwrap();
    pool.call(
        Lane::Background,
        Some(room),
        frame("test.echo", Args::default(), Vec::new()),
    )
    .await
    .unwrap();
    probe
        .out
        .insert("spawnMs".into(), json!(spawn.elapsed().as_millis()));
    let mut seeded = probe
        .engine(&pool, "seed", 1, Lane::Save, room, || {
            frame("seedOffice", args(), vec![base.clone()])
        })
        .await;
    let seed = seeded.blobs.swap_remove(0);
    probe.out.insert(
        "seedStateMiB".into(),
        json!((seed.len() as f64 / 1048576.0 * 100.0).round() / 100.0),
    );
    let seed_vector = Update::decode_v1(&seed).unwrap().state_vector();
    let doc = Doc::with_client_id(1);
    probe.local("roomLoad", 1, || replay(&doc, &[&seed]));
    let durable = doc.transact().state_vector();

    // One agent-sized edit, as office-save.mts makes it.
    let inspected = probe
        .engine(&pool, "inspect", 1, Lane::Background, room, || {
            frame("inspectOffice", args(), vec![base.clone(), seed.clone()])
        })
        .await;
    let entries: Vec<Entry> = serde_json::from_value(inspected.value).unwrap();
    let command = match format {
        Format::Xlsx => {
            let cell = entries
                .iter()
                .find(|entry| entry.value.parse::<f64>().is_ok())
                .unwrap();
            let (sheet, at) = cell.position.rsplit_once(':').unwrap();
            Command::SetCell {
                sheet: sheet.into(),
                cell: at.into(),
                expected_value: cell.value.clone(),
                value: (cell.value.parse::<f64>().unwrap() + 1.0).to_string(),
            }
        }
        _ => {
            let paragraph = entries
                .iter()
                .find(|entry| entry.value.chars().count() > 20)
                .unwrap();
            Command::ReplaceText {
                target_id: paragraph.id.clone(),
                expected_text: paragraph.value.clone(),
                text: format!("{} typed", paragraph.value),
            }
        }
    };
    let mut applied = probe
        .engine(&pool, "applyCommand", 1, Lane::Background, room, || {
            let mut request = args();
            request.commands = Some(vec![command.clone()]);
            frame(
                "applyOfficeCommands",
                request,
                vec![base.clone(), seed.clone()],
            )
        })
        .await;
    let edited = applied.blobs.swap_remove(0);
    let edit_doc = Doc::new();
    replay(&edit_doc, &[&edited]);
    // The client's update: what the edit holds beyond the room.
    let update = encode(&edit_doc, &doc.transact().state_vector());
    probe.out.insert("updateBytes".into(), json!(update.len()));
    let source_format: SourceFormat = serde_json::from_value(json!(format)).unwrap();
    let mut estimate = sources::Estimate::new(seed.len() as u64);
    let admitted = probe.local("admitUpdate", reps, || {
        admit_update(
            &doc,
            source_format,
            &update,
            &mut estimate,
            sources::MAX_SOURCE_STATE_BYTES as u64,
        )
    });
    assert_eq!(admitted, sources::Admission::Accept);
    probe.local("applyUpdate", 1, || replay(&doc, &[&update]));

    // The save: the row since the durable state, the whole state the engine
    // reads effects from, the body.
    let row = probe.local("row", reps, || encode(&doc, &durable));
    let state = probe.local("wholeState", reps, || encode(&doc, &StateVector::default()));
    let row64 = probe.local("base64Row", reps, || {
        base64::engine::general_purpose::STANDARD.encode(&row)
    });
    probe.out.insert("rowBytes".into(), json!(row.len()));
    probe.out.insert(
        "stateMiB".into(),
        json!((state.len() as f64 / 1048576.0 * 100.0).round() / 100.0),
    );
    let effects: Vec<NetEffect> = match format {
        Format::Xlsx => {
            let request = || {
                let mut request = args();
                request.room = Some(room.into());
                frame(
                    "xlsxPendingEffects",
                    request,
                    vec![base.clone(), state.clone()],
                )
            };
            probe
                .engine(&pool, "effectsReplicaMiss", 1, Lane::Save, room, request)
                .await;
            let hit = probe
                .engine(&pool, "effectsReplicaHit", reps, Lane::Save, room, request)
                .await;
            probe.out.insert(
                "replica".into(),
                json!(hit.usage.replicas.replica_bytes >> 20),
            );
            serde_json::from_value(hit.value).unwrap()
        }
        _ => {
            let indexed = probe
                .engine(&pool, "baselineSeed", 1, Lane::Save, room, || {
                    frame("officeBaseline", args(), vec![base.clone(), seed.clone()])
                })
                .await;
            let indexed: Vec<BaselineEntry> = serde_json::from_value(indexed.value).unwrap();
            let current = probe
                .engine(&pool, "baselineCurrent", reps, Lane::Save, room, || {
                    frame("officeBaseline", args(), vec![base.clone(), state.clone()])
                })
                .await;
            let current: Vec<BaselineEntry> = serde_json::from_value(current.value).unwrap();
            probe.local("compareBaselines", reps, || {
                office_service::compare_baselines(&indexed, &current)
            })
        }
    };
    let effects: Vec<NetEffect> = effects
        .into_iter()
        .map(sources::effects::trim_effect)
        .collect();
    probe.out.insert("effects".into(), json!(effects.len()));
    let body = json!({
        "actorIds": ["u_1"], "baseRevision": 1, "epoch": 1, "expectedCheckpoint": 0,
        "netTokens": sources::effects::effect_tokens(&effects), "pendingEffects": effects,
        "stateSeedSHA256": sha, "update": row64,
    });
    probe
        .out
        .insert("bodyBytes".into(), json!(body.to_string().len()));

    // The load check of base + rows and the fold into a change over the seed.
    probe.local("loadCheck", reps, || replay(&Doc::new(), &[&seed, &row]));
    let change = probe.local("fold", reps, || {
        let folded = Doc::new();
        replay(&folded, &[&seed, &row]);
        encode(&folded, &seed_vector)
    });
    probe.out.insert(
        "foldedChangeKiB".into(),
        json!((change.len() as f64 / 1024.0 * 10.0).round() / 10.0),
    );
    probe
        .engine(&pool, "export", 1, Lane::Background, room, || {
            let mut request = args();
            request.seed = Some("a".repeat(64));
            request.now = Some("2026-10-06T00:00:00.000Z".into());
            frame("exportOffice", request, vec![base.clone(), state.clone()])
        })
        .await;
    let (save, background) = pool.take_stats();
    probe
        .out
        .insert("saveLaneRssMiB".into(), json!(save.rss_mib));
    probe
        .out
        .insert("backgroundLaneRssMiB".into(), json!(background.rss_mib));
    // Peak resident memory of this process and both engine processes
    // (Windows: the working set high-water; Linux reports VmHWM per call).
    let mut pids = vec![std::process::id() as u64];
    for lane in [Lane::Save, Lane::Background] {
        let echo = pool
            .call(
                lane,
                Some(room),
                frame("test.echo", Args::default(), Vec::new()),
            )
            .await
            .unwrap();
        pids.push(echo.value["pid"].as_u64().unwrap());
    }
    if cfg!(windows) {
        let ids = pids
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let peaks = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("(Get-Process -Id {ids}).PeakWorkingSet64 -join ','"),
            ])
            .output()
            .unwrap();
        let peaks: Vec<u64> = String::from_utf8_lossy(&peaks.stdout)
            .trim()
            .split(',')
            .filter_map(|peak| peak.parse().ok())
            .map(|peak: u64| peak >> 20)
            .collect();
        probe.out.insert(
            "peakMiB".into(),
            json!({ "server": peaks.first(), "save": peaks.get(1), "background": peaks.get(2) }),
        );
    }
    probe.out.insert("reps".into(), json!(probe.reps));
    println!("{}", Value::Object(probe.out));
}
