//! The Office calls through the engine pool answer exactly what the
//! office-service crate answers in process (seeds byte-identical, effects,
//! inspect, commands, export), on the repo's small fixtures.

#![allow(clippy::unwrap_used)]

use std::path::PathBuf;
use std::time::Duration;

use office_service::{Checkpoint, Command, Format};
use sources::engine::office::calls::On;
use sources::engine::{EnginePool, PoolConfig};

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
        let (edited, inverse, targets) = pool
            .apply_commands(on, &seed, std::slice::from_ref(&edit))
            .await
            .unwrap();
        let direct = office_service::apply_commands(&base, checkpoint(&seed), &[edit]).unwrap();
        assert_eq!(
            (inverse, targets),
            (direct.inverse, direct.targets),
            "{path}"
        );
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
