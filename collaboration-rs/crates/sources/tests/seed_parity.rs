//! The engines' seed(base) is the same bytes the browser's engines seed: the
//! fork's golden tables (`shared/docx-pptx-storage.test.ts` for DOCX and PPTX,
//! `crates/betteroffice-xlsx/tests/storage.rs` for XLSX), which the frontend CI
//! runs against the fork's own build. View mode re-seeds a stored change's base
//! in the browser (`src/office-runtime/exportCheckpoint.worker.ts`) and refuses
//! it when the seed hash differs, and this workspace builds the engines with
//! serde_json features the wasm build lacks (`preserve_order`).

#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};

use office_service::Format;

fn fork() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../vendor/betteroffice")
}

/// Rows read `["name.docx", "<sha256>", budget],`.
fn docx_pptx_goldens(table: &str) -> Vec<(String, String)> {
    table
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.trim().strip_prefix("[\"")?.split_once("\", \"")?;
            let (hash, _) = rest.split_once('"')?;
            (hash.len() == 64).then(|| (name.to_owned(), hash.to_owned()))
        })
        .collect()
}

/// A row's fixture line, `include_bytes!("fixtures/storage/name.xlsx"),`, is
/// followed by its hash line, `"<sha256>",`.
fn xlsx_goldens(table: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = table.lines().map(str::trim).collect();
    lines
        .windows(2)
        .filter_map(|pair| {
            let name = pair[0].strip_prefix("include_bytes!(\"fixtures/storage/")?;
            let (name, _) = name.split_once('"')?;
            let hash = pair[1].strip_prefix('"')?.strip_suffix("\",")?;
            (hash.len() == 64).then(|| (name.to_owned(), hash.to_owned()))
        })
        .collect()
}

fn mismatched(format: Format, folder: &Path, goldens: Vec<(String, String)>) -> Vec<String> {
    goldens
        .into_iter()
        .filter_map(|(name, golden)| {
            let base = std::fs::read(folder.join(&name)).unwrap();
            let seed = office_service::sha256_hex(office_service::seed(format, &base).unwrap());
            (seed != golden).then(|| format!("{name}: engine {seed}, golden {golden}"))
        })
        .collect()
}

#[test]
fn engine_seeds_equal_the_browser_golden_seeds() {
    let table = std::fs::read_to_string(fork().join("shared/docx-pptx-storage.test.ts")).unwrap();
    let goldens = docx_pptx_goldens(&table);
    assert_eq!(goldens.len(), 7, "DOCX and PPTX golden table rows");
    let (pptx, docx): (Vec<_>, Vec<_>) = goldens
        .into_iter()
        .partition(|(name, _)| name.ends_with(".pptx"));
    let fixtures = fork().join("poc/fixtures");
    let mut wrong = mismatched(Format::Docx, &fixtures, docx);
    wrong.extend(mismatched(Format::Pptx, &fixtures, pptx));

    let table =
        std::fs::read_to_string(fork().join("crates/betteroffice-xlsx/tests/storage.rs")).unwrap();
    let goldens = xlsx_goldens(&table);
    assert_eq!(goldens.len(), 4, "XLSX golden table rows");
    let fixtures = fork().join("crates/betteroffice-xlsx/tests/fixtures/storage");
    wrong.extend(mismatched(Format::Xlsx, &fixtures, goldens));

    assert!(wrong.is_empty(), "{wrong:#?}");
}
