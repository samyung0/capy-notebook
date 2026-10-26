//! The Office calls through the engine pool answer exactly what the
//! office-service crate answers in process (seeds byte-identical, effects,
//! inspect, commands, export), on the repo's small fixtures.

#![allow(clippy::unwrap_used)]

use std::path::PathBuf;
use std::time::Duration;

use office_service::{Checkpoint, Command, Format};
use serde_json::json;
use sources::engine::office::calls::On;
use sources::engine::{EnginePool, Frame, Lane, PoolConfig};

fn pool() -> EnginePool {
    EnginePool::new(PoolConfig {
        program: PathBuf::from(env!("CARGO_BIN_EXE_sources-test-engine")),
        args: Vec::new(),
        save_processes: 1,
        background_processes: 1,
        call_timeout: Duration::from_secs(120),
        replica_budget_bytes: 1 << 30,
        memory_limit_bytes: None,
    })
}

fn fixture(path: &str) -> Vec<u8> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    std::fs::read(root.join(path)).unwrap()
}

/// A command editing the first entry with text (a cell, a paragraph).
fn command(format: Format, entries: &[office_service::Entry]) -> Command {
    match format {
        Format::Xlsx => {
            let entry = entries
                .iter()
                .find(|entry| !entry.value.is_empty())
                .unwrap();
            let (sheet, cell) = entry.position.rsplit_once(':').unwrap();
            Command::SetCell {
                sheet: sheet.to_owned(),
                cell: cell.to_owned(),
                expected_value: entry.value.clone(),
                value: format!("{} edited", entry.value),
            }
        }
        _ => {
            let entry = entries.iter().find(|entry| entry.value.len() > 3).unwrap();
            Command::ReplaceText {
                target_id: entry.id.clone(),
                expected_text: entry.value.clone(),
                text: format!("{} edited", entry.value),
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_calls_through_the_pool_equal_the_crate_in_process() {
    let pool = pool();
    for (format, path) in [
        (Format::Xlsx, "e2e/fixtures/files/basic/grades.xlsx"),
        (Format::Pptx, "e2e/fixtures/files/basic/lesson.pptx"),
        (Format::Docx, "e2e/fixtures/files/basic/lesson.docx"),
    ] {
        let base = fixture(path);
        let sha = office_service::sha256_hex(&base);
        let room = format!("source:f_{}:epoch:1", format.as_str());
        let on = On {
            format,
            base: &base,
            base_sha256: &sha,
            room: Some(&room),
        };
        let seed = pool.seed(on).await.unwrap();
        assert_eq!(seed, office_service::seed(format, &base).unwrap(), "{path}");
        let checkpoint = |state| Checkpoint {
            format,
            schema_version: 1,
            base_sha256: &sha,
            state,
        };
        let entries = pool.inspect(on, &seed).await.unwrap();
        assert_eq!(
            entries,
            office_service::inspect(&base, checkpoint(&seed)).unwrap()
        );
        let edit = command(format, &entries);
        let applied = pool
            .apply_commands(on, &seed, std::slice::from_ref(&edit))
            .await
            .unwrap();
        let direct = office_service::apply_commands(&base, checkpoint(&seed), &[edit]).unwrap();
        assert_eq!(applied.notice, direct.notice, "{path}");
        if format != Format::Xlsx {
            // What the engine measured for the Undo cost crosses the pool
            // (review r2 L5): a replacement taking out text measures it.
            let entry = entries.iter().find(|entry| entry.value.len() > 3).unwrap();
            let cut = Command::ReplaceText {
                target_id: entry.id.clone(),
                expected_text: entry.value.clone(),
                text: "x".into(),
            };
            let through = pool
                .apply_commands(on, &seed, std::slice::from_ref(&cut))
                .await
                .unwrap();
            let direct = office_service::apply_commands(&base, checkpoint(&seed), &[cut]).unwrap();
            assert_eq!(through.touched, direct.touched, "{path}");
            assert!(
                through.touched[0].items > 0,
                "{path}: {:?}",
                through.touched
            );
        }
        let edited = applied.state;
        let effects = match format {
            Format::Xlsx => {
                let miss = pool.xlsx_pending_effects(on, &edited).await.unwrap();
                let hit = pool.xlsx_pending_effects(on, &edited).await.unwrap();
                assert_eq!(miss, hit);
                miss
            }
            _ => {
                let before = pool.baseline(on, &seed).await.unwrap();
                let after = pool.baseline(on, &edited).await.unwrap();
                assert_eq!(
                    after,
                    office_service::baseline(&base, checkpoint(&edited)).unwrap()
                );
                office_service::compare_baselines(&before, &after)
            }
        };
        assert!(!effects.is_empty(), "{path}: the edit shows as an effect");
        let exported = pool
            .export(on, &edited, &"a".repeat(64), "2000-01-01T00:00:00.000Z")
            .await
            .unwrap();
        assert!(!exported.is_empty());
        pool.drop_room(&room).await;
    }
    let (save, background) = pool.take_stats();
    assert_eq!((save.crashes, background.crashes), (0, 0));
    assert_eq!(save.replica_hits, 1);
}

/// A refused agent edit crosses the engine process with its details: the
/// paragraph as it reads now (Epo 2026-10-14).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_edit_keeps_its_details_through_the_pool() {
    use sources::engine::{EngineError, FailureKind};
    let pool = pool();
    let base = fixture("e2e/fixtures/files/basic/lesson.docx");
    let sha = office_service::sha256_hex(&base);
    let on = On {
        format: Format::Docx,
        base: &base,
        base_sha256: &sha,
        room: None,
    };
    let seed = pool.seed(on).await.unwrap();
    let entries = pool.inspect(on, &seed).await.unwrap();
    let entry = entries.iter().find(|entry| entry.value.len() > 3).unwrap();
    let refused = pool
        .apply_commands(
            on,
            &seed,
            &[Command::ReplaceText {
                target_id: entry.id.clone(),
                expected_text: "not in this paragraph".into(),
                text: "x".into(),
            }],
        )
        .await
        .unwrap_err();
    let EngineError::Refused(failure) = refused else {
        panic!("{refused:?}")
    };
    assert_eq!(failure.kind, FailureKind::Edit);
    assert_eq!(
        failure.details,
        Some(serde_json::json!({
            "block": { "id": entry.id, "type": "paragraph", "text": entry.value }
        }))
    );
}

/// An agent's text holding a character an Office file cannot store applies
/// without it, and the engine's note on it crosses the pool for the tool
/// result (Epo 2026-10-15); what an engine refuses about the input itself (a
/// line break inside a DOCX paragraph, a cell outside the grid) crosses it as
/// an edit refusal, `invalid_input` with the engine's sentence, so the
/// gateway answers 409 instead of an unknown outcome.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_input_a_file_cannot_hold_is_dropped_with_a_note_or_refused_as_invalid_input() {
    use sources::engine::{EngineError, FailureKind};
    let pool = pool();
    for (format, path) in [
        (Format::Xlsx, "e2e/fixtures/files/basic/grades.xlsx"),
        (Format::Pptx, "e2e/fixtures/files/basic/lesson.pptx"),
        (Format::Docx, "e2e/fixtures/files/basic/lesson.docx"),
    ] {
        let base = fixture(path);
        let sha = office_service::sha256_hex(&base);
        let on = On {
            format,
            base: &base,
            base_sha256: &sha,
            room: None,
        };
        let seed = pool.seed(on).await.unwrap();
        let entries = pool.inspect(on, &seed).await.unwrap();
        let (dropped, id, refused) = match command(format, &entries) {
            Command::SetCell {
                sheet,
                cell,
                expected_value,
                ..
            } => {
                let id = entries
                    .iter()
                    .find(|entry| entry.position == format!("{sheet}:{cell}"))
                    .unwrap()
                    .id
                    .clone();
                let refused = Command::SetCell {
                    sheet: sheet.clone(),
                    cell: "ZZZ9999999".into(),
                    expected_value: String::new(),
                    value: "x".into(),
                };
                let dropped = Command::SetCell {
                    sheet,
                    cell,
                    expected_value,
                    value: "a\u{1}b".into(),
                };
                (dropped, id, Some(refused))
            }
            Command::ReplaceText {
                target_id,
                expected_text,
                ..
            } => {
                let refused = (format == Format::Docx).then(|| Command::ReplaceText {
                    target_id: target_id.clone(),
                    expected_text: expected_text.clone(),
                    text: "a\u{2028}b".into(),
                });
                let dropped = Command::ReplaceText {
                    target_id: target_id.clone(),
                    expected_text,
                    text: "a\u{1}b".into(),
                };
                (dropped, target_id, refused)
            }
            other => unreachable!("command() makes set_cell or replace_text, not {other:?}"),
        };
        let applied = pool
            .apply_commands(on, &seed, std::slice::from_ref(&dropped))
            .await
            .unwrap();
        assert_eq!(
            applied.notice.as_deref(),
            Some("Removed 1 character Office files cannot store (U+0001)."),
            "{path}"
        );
        let after = pool.inspect(on, &applied.state).await.unwrap();
        let written = after.iter().find(|entry| entry.id == id).unwrap();
        assert_eq!(written.value, "ab", "{path}");
        let Some(refused) = refused else { continue };
        let error = pool
            .apply_commands(on, &seed, std::slice::from_ref(&refused))
            .await
            .unwrap_err();
        let EngineError::Refused(failure) = error else {
            panic!("{path}: {error:?}")
        };
        assert_eq!(failure.kind, FailureKind::Edit, "{path}: {failure:?}");
        assert!(
            failure.message.starts_with("invalid_input: "),
            "{path}: {failure:?}"
        );
    }
}

// seedCheck.test.ts: the seed check seeds each base once and reports every
// changed seed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_seed_check_seeds_each_base_once_and_reports_every_changed_seed() {
    use sources::seed_check::{SeedManifestLine, check_seeds, report};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let pool = pool();
    let bytes = fixture("e2e/fixtures/files/basic/lesson.docx");
    let seed = office_service::sha256_hex(office_service::seed(Format::Docx, &bytes).unwrap());
    let base = office_service::sha256_hex(&bytes);
    let reads = AtomicUsize::new(0);
    let read = |_: &str| {
        reads.fetch_add(1, Ordering::Relaxed);
        let bytes = bytes.clone();
        async move { Ok(bytes) }
    };
    let line = |files, state: &str| SeedManifestLine {
        base_source_sha256: base.clone(),
        files,
        format: Format::Docx,
        source_url: "u".into(),
        state_seed_sha256: state.into(),
    };
    let checks = check_seeds(&[line(2, &seed), line(1, &"0".repeat(64))], &pool, read)
        .await
        .unwrap();
    assert_eq!(reads.load(Ordering::Relaxed), 1);
    assert_eq!(
        checks
            .iter()
            .map(|check| (check.files, check.changed()))
            .collect::<Vec<_>>(),
        [(2, false), (1, true)]
    );
    let (text, window) = report(&checks);
    assert!(window);
    assert!(text.ends_with(
        "1 of 2 seeds changed (docx): run the Office maintenance window before deploying this pin\n"
    ));
    let mut other = line(1, &seed);
    other.base_source_sha256 = "1".repeat(64);
    let error = check_seeds(&[other], &pool, read).await.unwrap_err();
    assert!(
        error.to_string().contains("downloaded other bytes"),
        "{error}"
    );
}

/// The agent's by-id read (Epo 2026-10-24, Q278) answers a DOCX file's
/// pictures through the pool, bytes included, as the crate does in process.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_by_id_read_returns_pictures_through_the_pool() {
    use office_service::InspectQuery;

    let pool = pool();
    let base = fixture("vendor/betteroffice/poc/fixtures/images-10.docx");
    let sha = office_service::sha256_hex(&base);
    let on = On {
        format: Format::Docx,
        base: &base,
        base_sha256: &sha,
        room: Some("source:f_pictures:epoch:1"),
    };
    let seed = pool.seed(on).await.unwrap();
    let page = InspectQuery {
        count: Some(200),
        ..InspectQuery::default()
    };
    let read = pool.inspect_scoped(on, &seed, &page).await.unwrap();
    let ids: Vec<String> = read["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|paragraph| paragraph["objects"].as_array().cloned().unwrap_or_default())
        .filter_map(|object| object["id"].as_str().map(str::to_owned))
        .take(2)
        .collect();
    assert_eq!(ids.len(), 2, "{read}");
    let query = InspectQuery {
        ids: Some(ids),
        ..InspectQuery::default()
    };
    let answer = pool.inspect_scoped(on, &seed, &query).await.unwrap();
    assert!(answer["items"][1]["data"].is_string(), "{answer}");
    let checkpoint = Checkpoint {
        format: Format::Docx,
        schema_version: 1,
        base_sha256: &sha,
        state: &seed,
    };
    assert_eq!(
        answer,
        office_service::inspect_scoped(&base, checkpoint, &query).unwrap()
    );
}

/// Waits until `ready` holds, polling every 5 ms for at most 10 s.
async fn settle(mut ready: impl FnMut() -> bool) {
    for _ in 0..2_000 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the pool never reached the state");
}

/// `count` sleeps of `ms` queued on `room`'s background process.
fn sleeps(
    pool: &std::sync::Arc<EnginePool>,
    room: &str,
    ms: u64,
    count: usize,
) -> Vec<tokio::task::JoinHandle<()>> {
    (0..count)
        .map(|_| {
            let (pool, room) = (pool.clone(), room.to_owned());
            tokio::spawn(async move {
                let request = Frame::new(
                    "test.sleep",
                    serde_json::to_vec(&json!({ "ms": ms })).unwrap(),
                    Vec::new(),
                );
                pool.call(Lane::Background, Some(&room), request)
                    .await
                    .unwrap();
            })
        })
        .collect()
}

/// Security regression (Q240 review r1 M4): the agent's by-id read goes
/// through the pool as a bounded call, so one whose caller gave up before it
/// would start is skipped (an unbounded read would still run).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_by_id_read_whose_caller_is_gone_is_skipped() {
    use office_service::InspectQuery;

    let pool = std::sync::Arc::new(pool());
    let room = "source:f_gone:epoch:1";
    let base = fixture("vendor/betteroffice/poc/fixtures/images-10.docx");
    let sha = office_service::sha256_hex(&base);
    let on = On {
        format: Format::Docx,
        base: &base,
        base_sha256: &sha,
        room: Some(room),
    };
    let seed = pool.seed(on).await.unwrap();
    let _ = pool.take_stats();
    let long = sleeps(&pool, room, 1_500, 2);
    settle(|| pool.admit(Lane::Background, room, 1).is_err()).await;
    let query = InspectQuery {
        ids: Some(vec!["body:picture:1.1".into()]),
        ..InspectQuery::default()
    };
    let gone = tokio::time::timeout(
        Duration::from_millis(100),
        pool.inspect_scoped(on, &seed, &query),
    )
    .await;
    assert!(gone.is_err());
    for call in long {
        call.await.unwrap();
    }
    // A call behind the read: the read, had it run, finished before it.
    let echo = Frame::new("test.echo", b"{}".to_vec(), Vec::new());
    pool.call(Lane::Background, Some(room), echo).await.unwrap();
    let (_, background) = pool.take_stats();
    assert_eq!(background.calls, 3, "{background:?}");
}

/// The Go API's bootstrap of one DOCX file, for a store that never reaches
/// its download or its database.
async fn bootstrap(
    axum::extract::Path((id, _)): axum::extract::Path<(String, String)>,
) -> axum::Json<serde_json::Value> {
    axum::Json(json!({
        "access": "write",
        "baseRevision": 1,
        "baseSourceSHA256": "0".repeat(64),
        "checkpoint": 0,
        "epoch": 1,
        "fileId": id,
        "format": "docx",
        "indexedCheckpoint": 0,
        "netTokens": 0,
        "pendingEffects": [],
        "rebuildPending": false,
        "room": format!("source:{id}:epoch:1"),
        "sourceURL": "http://127.0.0.1:9/missing",
        "state": null,
        "stateSeedSHA256": null,
        "workspaceId": "ws_busy",
    }))
}

/// Security regression (Q240 review r1 M4): the store's inspect path
/// answers a by-id read busy, after the session lookup and before any
/// download, once the file's room holds 4 queued calls on its background
/// engine process.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_store_answers_a_by_id_read_busy_before_its_download() {
    let app = axum::Router::new().route(
        "/internal/collaboration/files/{id}/{endpoint}",
        axum::routing::get(bootstrap),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut db = deadpool_postgres::Config::new();
    // Never connected: the read is refused before the store reads anything.
    db.url = Some("postgres://capy:capy@127.0.0.1:9/capy".into());
    let db = db
        .create_pool(
            Some(deadpool_postgres::Runtime::Tokio1),
            tokio_postgres::NoTls,
        )
        .unwrap();
    let disk = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("busy-disk");
    let sources = std::sync::Arc::new(
        sources::Sources::new(
            sources::SourcesConfig {
                api_url,
                secret: "secret".into(),
                engine: PoolConfig {
                    program: PathBuf::from(env!("CARGO_BIN_EXE_sources-test-engine")),
                    args: Vec::new(),
                    save_processes: 1,
                    background_processes: 1,
                    call_timeout: Duration::from_secs(120),
                    replica_budget_bytes: 0,
                    memory_limit_bytes: None,
                },
                disk_dir: disk,
                disk_bytes: 1 << 20,
            },
            db,
            reqwest::Client::new(),
        )
        .unwrap(),
    );
    let room = "source:f_busy:epoch:1";
    let mut long = Vec::new();
    for _ in 0..5 {
        let (sources, room) = (sources.clone(), room.to_owned());
        long.push(tokio::spawn(async move {
            let request = Frame::new(
                "test.sleep",
                serde_json::to_vec(&json!({ "ms": 1_500 })).unwrap(),
                Vec::new(),
            );
            sources
                .engines()
                .call(Lane::Background, Some(&room), request)
                .await
                .unwrap();
        }));
    }
    settle(|| sources.engines().admit(Lane::Background, room, 4).is_err()).await;
    let refused = sources
        .inspect(
            "f_busy",
            "u_busy",
            Some(json!({ "ids": ["body:picture:1.1"] })),
            |_| Box::pin(async { None }),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(&refused, sources::SourceError::Edit { code, message, .. }
            if code == "unavailable_target" && message.contains("busy")),
        "{refused:?}"
    );
    for call in long {
        call.await.unwrap();
    }
}

/// The agent's scoped XLSX and DOCX reads and `create` answer through the
/// pool as the crate does in process; a refused read and a create of a format
/// without a starter stay edit refusals with their sentence (Epo 2026-10-20).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scoped_reads_and_creates_go_through_the_pool() {
    use office_service::InspectQuery;
    use sources::engine::{EngineError, FailureKind};

    let pool = pool();
    let base = fixture("e2e/fixtures/files/basic/grades.xlsx");
    let sha = office_service::sha256_hex(&base);
    let on = On {
        format: Format::Xlsx,
        base: &base,
        base_sha256: &sha,
        room: None,
    };
    let seed = pool.seed(on).await.unwrap();
    let checkpoint = Checkpoint {
        format: Format::Xlsx,
        schema_version: 1,
        base_sha256: &sha,
        state: &seed,
    };
    let sheets = pool
        .inspect_scoped(on, &seed, &InspectQuery::default())
        .await
        .unwrap();
    assert_eq!(
        sheets,
        office_service::inspect_scoped(&base, checkpoint, &InspectQuery::default()).unwrap()
    );
    let first = sheets["sheets"][0]["id"].as_str().unwrap().to_owned();
    let range = InspectQuery {
        sheet: Some(first.clone()),
        range: Some("A1:C3".into()),
        ..InspectQuery::default()
    };
    let cells = pool.inspect_scoped(on, &seed, &range).await.unwrap();
    assert!(!cells["cells"].as_array().unwrap().is_empty());
    let too_big = InspectQuery {
        sheet: Some(first),
        range: Some("A1:Z1000".into()),
        ..InspectQuery::default()
    };
    match pool.inspect_scoped(on, &seed, &too_big).await {
        Err(EngineError::Refused(failure)) => {
            assert!(
                failure.message.starts_with("invalid_input: "),
                "{}",
                failure.message
            )
        }
        other => panic!("a 26,000-cell read: {other:?}"),
    }

    let commands = vec![Command::SetRange {
        sheet: "Sheet1".into(),
        range: "A1:B1".into(),
        expected: vec![vec![String::new(), String::new()]],
        values: vec![vec!["Total".into(), "=1+2".into()]],
    }];
    let seed_hex = "b".repeat(64);
    let (bytes, notice) = pool
        .create(
            Format::Xlsx,
            &commands,
            &seed_hex,
            "2000-01-01T00:00:00.000Z",
        )
        .await
        .unwrap();
    let direct = office_service::create(
        Format::Xlsx,
        office_service::starter(Format::Xlsx).unwrap(),
        &commands,
        office_service::Determinism {
            seed: &seed_hex,
            now: "2000-01-01T00:00:00.000Z",
        },
    )
    .unwrap();
    assert_eq!((bytes, notice), (direct.bytes, direct.notice));

    // A Word file from its starter, read a page of paragraphs at a time.
    let commands = vec![Command::InsertParagraph {
        after_id: None,
        before_id: None,
        text: "Method".into(),
        style: Some("Heading1".into()),
        list: None,
    }];
    let (bytes, _) = pool
        .create(
            Format::Docx,
            &commands,
            &seed_hex,
            "2000-01-01T00:00:00.000Z",
        )
        .await
        .unwrap();
    let sha = office_service::sha256_hex(&bytes);
    let on = On {
        format: Format::Docx,
        base: &bytes,
        base_sha256: &sha,
        room: None,
    };
    let seed = pool.seed(on).await.unwrap();
    let page = InspectQuery {
        count: Some(10),
        ..InspectQuery::default()
    };
    let read = pool.inspect_scoped(on, &seed, &page).await.unwrap();
    assert_eq!(read["paragraphs"][0]["text"], "Method");
    assert_eq!(read["paragraphs"][0]["style"], "Heading1");
    assert_eq!(
        read,
        office_service::inspect_scoped(
            &bytes,
            Checkpoint {
                format: Format::Docx,
                schema_version: 1,
                base_sha256: &sha,
                state: &seed,
            },
            &page
        )
        .unwrap()
    );

    // PPTX has no starter: a create is refused, not retried as a fault.
    match pool
        .create(Format::Pptx, &[], &seed_hex, "2000-01-01T00:00:00.000Z")
        .await
    {
        Err(EngineError::Refused(failure)) => {
            assert_eq!(failure.kind, FailureKind::Edit);
            assert_eq!(
                failure.message,
                "unsupported_operation: pptx files cannot be created yet"
            );
        }
        other => panic!("a PPTX create: {other:?}"),
    }
}
