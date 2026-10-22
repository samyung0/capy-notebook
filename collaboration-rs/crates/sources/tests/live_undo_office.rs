//! The live Undo of an agent's Office edit (`ydoc::undo`, Epo 2026-10-20):
//! the engine's change, merged on a copy of the room as `sources::edit`
//! merges it, lands in the room keeping what it deleted, and reverting it
//! there restores the content. An XLSX formula reading the edited cell
//! computes from the restored value, as an editor's engine recalculates it;
//! structural XLSX commands (a row delete, a sheet delete), DOCX and PPTX
//! paragraph inserts and deletes and PPTX slide deletes and moves undo the
//! same way.

#![allow(clippy::unwrap_used)]

use std::path::PathBuf;

use betteroffice_xlsx::{CalculationOptions, CellRef, CellValue, Workbook};
use office_service::{Checkpoint, Command, Determinism, Format, InspectQuery};
use ydoc::undo::{Captured, Change};
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, MapRef, ReadTxn, StateVector, Transact, Update, WriteTxn};

struct File {
    format: Format,
    base: Vec<u8>,
    sha: String,
}

impl File {
    fn open(format: Format, path: &str) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        Self::of(format, std::fs::read(root.join(path)).unwrap())
    }

    fn of(format: Format, base: Vec<u8>) -> Self {
        let sha = office_service::sha256_hex(&base);
        File { format, base, sha }
    }

    fn checkpoint<'a>(&'a self, state: &'a [u8]) -> Checkpoint<'a> {
        Checkpoint {
            format: self.format,
            schema_version: 1,
            base_sha256: &self.sha,
            state,
        }
    }

    /// A room holding the seed.
    fn room(&self) -> Doc {
        doc_of(&office_service::seed(self.format, &self.base).unwrap())
    }

    /// The agent's commands on the room: the engine runs them on the room's
    /// state, a copy merges the engine's result (the edit's own items), and
    /// the room applies the copy's change keeping what it deleted.
    fn agent_edit(&self, room: &Doc, commands: &[Command]) -> Change {
        self.costed_edit(room, commands).1
    }

    /// [`Self::agent_edit`] with the edit's Undo cost, as `sources::edit`
    /// sums it: each applied command's rule with what the engine measured
    /// of its target (`touched`).
    fn costed_edit(&self, room: &Doc, commands: &[Command]) -> (usize, Change) {
        let state = state(room);
        let applied =
            office_service::apply_commands(&self.base, self.checkpoint(&state), commands).unwrap();
        let cost = commands
            .iter()
            .zip(&applied.touched)
            .map(|(command, touched)| sources::undo_cost::office(command, *touched))
            .fold(0, usize::saturating_add);
        let (content, items) = applied.touched.iter().fold((0, 0), |(content, items), t| {
            (content + t.content, items + t.items)
        });
        eprintln!("touched: {items} items, {content} bytes");
        let copy = doc_of(&state);
        let captured = {
            let mut txn = copy.transact_mut();
            txn.apply_update(Update::decode_v1(&applied.state).unwrap())
                .unwrap();
            Captured::of(&mut txn)
        };
        let update = copy
            .transact()
            .encode_state_as_update_v1(&room.transact().state_vector());
        ydoc::undo::apply_kept(room, Update::decode_v1(&update).unwrap()).unwrap();
        (cost, captured.change(room))
    }

    /// A person's edit: the engine's commands merged into the room as an
    /// update the room keeps no Undo for.
    fn person_edit(&self, room: &Doc, commands: &[Command]) {
        let state = state(room);
        let applied =
            office_service::apply_commands(&self.base, self.checkpoint(&state), commands).unwrap();
        let copy = doc_of(&state);
        copy.transact_mut()
            .apply_update(Update::decode_v1(&applied.state).unwrap())
            .unwrap();
        let update = copy
            .transact()
            .encode_state_as_update_v1(&room.transact().state_vector());
        ydoc::apply(room, Update::decode_v1(&update).unwrap()).unwrap();
    }

    /// Every paragraph a DOCX read lists, page by page.
    fn paragraphs(&self, room: &Doc) -> Vec<serde_json::Value> {
        let state = state(room);
        let mut all = Vec::new();
        let mut start = Some(0);
        while let Some(at) = start {
            let page = office_service::inspect_scoped(
                &self.base,
                self.checkpoint(&state),
                &InspectQuery {
                    start: Some(at),
                    count: Some(200),
                    ..InspectQuery::default()
                },
            )
            .unwrap();
            all.extend(page["paragraphs"].as_array().unwrap().iter().cloned());
            start = page["nextStart"].as_u64().map(|next| next as u32);
        }
        all
    }

    /// Each table the read marks, by its id: its cells' text as rows, a
    /// cell's paragraphs joined by line breaks (delete_table's expected).
    fn tables(&self, room: &Doc) -> Vec<(String, Vec<Vec<String>>)> {
        let mut tables: Vec<(String, Vec<Vec<String>>)> = Vec::new();
        for paragraph in self.paragraphs(room) {
            let Some(cell) = paragraph.get("table") else {
                continue;
            };
            let id = cell["id"].as_str().unwrap();
            if tables.last().is_none_or(|(last, _)| last != id) {
                tables.push((id.to_owned(), Vec::new()));
            }
            let grid = &mut tables.last_mut().unwrap().1;
            let (row, column) = (
                cell["row"].as_u64().unwrap() as usize,
                cell["column"].as_u64().unwrap() as usize,
            );
            if grid.len() <= row {
                grid.resize(row + 1, Vec::new());
            }
            let text = paragraph["text"].as_str().unwrap();
            let cells = &mut grid[row];
            if cells.len() <= column {
                cells.resize(column + 1, String::new());
                cells[column] = text.to_owned();
            } else {
                cells[column] = format!("{}\n{text}", cells[column]);
            }
        }
        tables
    }

    fn entries(&self, room: &Doc) -> Vec<office_service::Entry> {
        office_service::inspect(&self.base, self.checkpoint(&state(room))).unwrap()
    }

    /// The file the room saves.
    fn export(&self, room: &Doc) -> Vec<u8> {
        let determinism = Determinism {
            seed: &"0".repeat(64),
            now: "2026-10-21T00:00:00.000Z",
        };
        office_service::export(&self.base, self.checkpoint(&state(room)), determinism).unwrap()
    }

    /// Whether `commands` land on the room's state (the room unchanged).
    fn lands(&self, room: &Doc, commands: &[Command]) -> bool {
        office_service::apply_commands(&self.base, self.checkpoint(&state(room)), commands).is_ok()
    }

    /// The agent's scoped XLSX read: the sheet list, or a range's cells.
    fn read(&self, room: &Doc, sheet: Option<&str>, range: Option<&str>) -> serde_json::Value {
        let query = InspectQuery {
            sheet: sheet.map(str::to_owned),
            range: range.map(str::to_owned),
            ..InspectQuery::default()
        };
        office_service::inspect_scoped(&self.base, self.checkpoint(&state(room)), &query).unwrap()
    }

    /// The agent's scoped PPTX read: the slide list, or slide `number`'s
    /// shapes and paragraphs (200 a page, more than the fixtures hold).
    fn deck(&self, room: &Doc, number: Option<u32>) -> serde_json::Value {
        let query = InspectQuery {
            slide: number,
            start: Some(0),
            count: Some(200),
            ..InspectQuery::default()
        };
        office_service::inspect_scoped(&self.base, self.checkpoint(&state(room)), &query).unwrap()
    }

    /// The slides' ids, in order.
    fn slides(&self, room: &Doc) -> Vec<String> {
        self.deck(room, None)["slides"]
            .as_array()
            .unwrap()
            .iter()
            .map(|slide| slide["id"].as_str().unwrap().to_owned())
            .collect()
    }

    /// Slide `number`'s text, a line a paragraph, then its notes as the
    /// read shows them (delete_slide's expected).
    fn slide_text(&self, room: &Doc, number: u32) -> String {
        let read = self.deck(room, Some(number));
        let mut lines: Vec<&str> = read["paragraphs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|paragraph| paragraph["text"].as_str().unwrap())
            .collect();
        lines.extend(read["slide"]["notes"].as_str());
        lines.join("\n")
    }

    /// The sheets' (id, name), in order.
    fn sheets(&self, room: &Doc) -> Vec<(String, String)> {
        let text = |value: &serde_json::Value| value.as_str().unwrap().to_owned();
        self.read(room, None, None)["sheets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|sheet| (text(&sheet["id"]), text(&sheet["name"])))
            .collect()
    }

    /// `address=input→value` for each non-empty cell of `range`.
    fn cells(&self, room: &Doc, sheet: &str, range: &str) -> Vec<String> {
        self.read(room, Some(sheet), Some(range))["cells"]
            .as_array()
            .unwrap()
            .iter()
            .map(|cell| {
                let text = |key: &str| cell[key].as_str().unwrap().to_owned();
                format!("{}={}→{}", text("address"), text("input"), text("value"))
            })
            .collect()
    }
}

const GRADES: &str = "e2e/fixtures/files/basic/grades.xlsx";
const LESSON_DOCX: &str = "e2e/fixtures/files/basic/lesson.docx";
const LESSON_PPTX: &str = "e2e/fixtures/files/basic/lesson.pptx";
/// Eight classes of 2,000 rows and a summary (`bench/editor`).
const GRADEBOOK: &str = "bench/editor/fixtures/office/large-gradebook.xlsx";

/// lesson.docx with its first paragraph ending a section, its second a
/// bulleted list item and, after its table, a paragraph and a closing one,
/// the body's last (a paragraph right after a table is not one the agent
/// edits).
fn lesson_docx() -> File {
    let lesson = File::open(Format::Docx, LESSON_DOCX);
    let parts: Vec<(String, Vec<u8>)> = ooxml_opc::unzip_parts(&lesson.base)
        .unwrap()
        .into_iter()
        .map(|(name, bytes)| {
            if name != "word/document.xml" {
                return (name, bytes);
            }
            let xml = String::from_utf8(bytes)
                .unwrap()
                .replacen(
                    "<w:p><w:r><w:t>Owner sentence",
                    r#"<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr><w:r><w:t>Owner sentence"#,
                    1,
                )
                .replacen(
                    "<w:p><w:r><w:t>Collaborator sentence",
                    r#"<w:p><w:pPr><w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Collaborator sentence"#,
                    1,
                )
                .replacen(
                    "</w:tbl><w:sectPr",
                    "</w:tbl><w:p><w:r><w:t>After the table.</w:t></w:r></w:p><w:p><w:r><w:t>Closing line.</w:t></w:r></w:p><w:sectPr",
                    1,
                );
            (name, xml.into_bytes())
        })
        .collect();
    File::of(Format::Docx, ooxml_opc::rezip_parts(&parts).unwrap())
}

/// lesson.docx with `body` before its own paragraphs.
fn lesson_docx_with(body: &str) -> File {
    let lesson = File::open(Format::Docx, LESSON_DOCX);
    let parts: Vec<(String, Vec<u8>)> = ooxml_opc::unzip_parts(&lesson.base)
        .unwrap()
        .into_iter()
        .map(|(name, bytes)| {
            if name != "word/document.xml" {
                return (name, bytes);
            }
            let xml = String::from_utf8(bytes).unwrap().replacen(
                "<w:body>",
                &format!("<w:body>{body}"),
                1,
            );
            (name, xml.into_bytes())
        })
        .collect();
    File::of(Format::Docx, ooxml_opc::rezip_parts(&parts).unwrap())
}

/// Review H1's fixtures: a paragraph of 5-character runs in turn bold,
/// italic, red, 14 pt and Georgia, and one of mixed Chinese and Latin
/// letters a run each (as PDF-converted and CJK files hold them), each
/// formatted, replaced and deleted whole.
const FIVE_RUNS: usize = 60;
const ONE_CHARACTER_RUNS: usize = 200;

fn many_runs_docx() -> (File, String, String) {
    let props = [
        "<w:b/>",
        "<w:i/>",
        r#"<w:color w:val="FF0000"/>"#,
        r#"<w:sz w:val="28"/>"#,
        r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>"#,
    ];
    let mut five = String::new();
    let mut five_text = String::new();
    for n in 0..FIVE_RUNS {
        let text = format!("w{:03}x", n);
        five.push_str(&format!(
            "<w:r><w:rPr>{}</w:rPr><w:t>{text}</w:t></w:r>",
            props[n % props.len()]
        ));
        five_text.push_str(&text);
    }
    let (mixed, mixed_text) = one_character_runs(ONE_CHARACTER_RUNS);
    (
        lesson_docx_with(&format!("<w:p>{five}</w:p><w:p>{mixed}</w:p>")),
        five_text,
        mixed_text,
    )
}

/// `count` runs of one Chinese or Latin letter in turn, each with its
/// fonts and language: the XML and its text.
fn one_character_runs(count: usize) -> (String, String) {
    let mut xml = String::new();
    let mut text = String::new();
    for n in 0..count {
        let (letter, props) = if n % 2 == 0 {
            (
                ['中', '文', '字', '体'][n / 2 % 4],
                r#"<w:rFonts w:eastAsia="SimSun" w:hint="eastAsia"/><w:lang w:eastAsia="zh-CN"/>"#,
            )
        } else {
            (
                ['a', 'b', 'c', 'd'][n / 2 % 4],
                r#"<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:lang w:val="en-US"/>"#,
            )
        };
        xml.push_str(&format!(
            "<w:r><w:rPr>{props}</w:rPr><w:t>{letter}</w:t></w:r>"
        ));
        text.push(letter);
    }
    (xml, text)
}

/// The fork's stories.docx with its header's and its footnote's text each
/// [`ONE_CHARACTER_RUNS`] runs (review r2 H1): the file and that text.
fn stories_docx() -> (File, String) {
    let stories = File::open(
        Format::Docx,
        "vendor/betteroffice/crates/office-service/tests/fixtures/stories.docx",
    );
    let (runs, text) = one_character_runs(ONE_CHARACTER_RUNS);
    let parts: Vec<(String, Vec<u8>)> = ooxml_opc::unzip_parts(&stories.base)
        .unwrap()
        .into_iter()
        .map(|(name, bytes)| {
            let old = match name.as_str() {
                "word/header1.xml" => "Header",
                "word/footnotes.xml" => "A note",
                _ => return (name, bytes),
            };
            let xml = String::from_utf8(bytes).unwrap().replacen(
                &format!(r#"<w:r><w:t xml:space="preserve">{old}</w:t></w:r>"#),
                &runs,
                1,
            );
            (name, xml.into_bytes())
        })
        .collect();
    (
        File::of(Format::Docx, ooxml_opc::rezip_parts(&parts).unwrap()),
        text,
    )
}

/// lesson.pptx with a paragraph of 5-character runs, in turn bold, italic
/// and red, before the owner sentence in its shape.
fn many_runs_pptx() -> (File, String) {
    let lesson = File::open(Format::Pptx, LESSON_PPTX);
    let props = [r#"b="1""#, r#"i="1""#, r#"sz="2400""#];
    let mut runs = String::new();
    let mut text = String::new();
    for n in 0..FIVE_RUNS {
        let piece = format!("p{:03}y", n);
        runs.push_str(&format!(
            r#"<a:r><a:rPr lang="en-US" {}/><a:t>{piece}</a:t></a:r>"#,
            props[n % props.len()]
        ));
        text.push_str(&piece);
    }
    let owner = "<a:p><a:r><a:t>Owner sentence: The launch code is LARCH-17.</a:t></a:r></a:p>";
    let parts: Vec<(String, Vec<u8>)> = ooxml_opc::unzip_parts(&lesson.base)
        .unwrap()
        .into_iter()
        .map(|(name, bytes)| {
            if name != "ppt/slides/slide1.xml" {
                return (name, bytes);
            }
            let xml = String::from_utf8(bytes).unwrap();
            assert!(xml.contains(owner));
            let xml = xml.replacen(owner, &format!("<a:p>{runs}</a:p>{owner}"), 1);
            (name, xml.into_bytes())
        })
        .collect();
    (
        File::of(Format::Pptx, ooxml_opc::rezip_parts(&parts).unwrap()),
        text,
    )
}

/// lesson.pptx with its Comparison layout grown to nine text placeholders
/// whose names run 200 characters (review H1), and its owner sentence one
/// run of six formats (review M3).
fn rich_pptx() -> File {
    let lesson = File::open(Format::Pptx, LESSON_PPTX);
    let extra: String = (0..4)
        .map(|n| {
            format!(
                r#"<p:sp><p:nvSpPr><p:cNvPr id="{}" name="{}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="{}"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="{}"/><a:ext cx="4000000" cy="300000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>"#,
                100 + n,
                format!("Extra body placeholder {n} ").repeat(8)[..200].to_owned(),
                40 + n,
                5_000_000 + 320_000 * n
            )
        })
        .collect();
    let owner = "<a:p><a:r><a:t>Owner sentence: The launch code is LARCH-17.</a:t></a:r></a:p>";
    let rich = r#"<a:p><a:r><a:rPr lang="en-US" b="1" i="1" u="sng" strike="sngStrike" sz="2800"><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill><a:latin typeface="Georgia"/></a:rPr><a:t>Owner sentence: The launch code is LARCH-17.</a:t></a:r></a:p>"#;
    let parts: Vec<(String, Vec<u8>)> = ooxml_opc::unzip_parts(&lesson.base)
        .unwrap()
        .into_iter()
        .map(|(name, bytes)| {
            let xml = String::from_utf8_lossy(&bytes).into_owned();
            match name.as_str() {
                "ppt/slideLayouts/slideLayout5.xml" => {
                    let xml = xml.replacen("</p:spTree>", &format!("{extra}</p:spTree>"), 1);
                    (name, xml.into_bytes())
                }
                "ppt/slides/slide1.xml" => {
                    assert!(xml.contains(owner));
                    (name, xml.replacen(owner, rich, 1).into_bytes())
                }
                _ => (name, bytes),
            }
        })
        .collect();
    File::of(Format::Pptx, ooxml_opc::rezip_parts(&parts).unwrap())
}

/// Review M1's tables: a plain 1x1, a 10x10 of shaded cells holding three
/// formatted paragraphs each, a 3x3 whose cells hold 20 list items, and a
/// 50x10 of short cells (delete_table counts tables, Epo 2026-10-22).
fn tables_docx() -> File {
    let table = |rows: usize, columns: usize, cell: &dyn Fn(usize, usize) -> String| {
        let grid: String = (0..columns).map(|_| r#"<w:gridCol w:w="900"/>"#).collect();
        let rows: String = (0..rows)
            .map(|r| {
                let cells: String = (0..columns)
                    .map(|c| {
                        format!(
                            r#"<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="900"/><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr>{}</w:tc>"#,
                            cell(r, c)
                        )
                    })
                    .collect();
                format!("<w:tr>{cells}</w:tr>")
            })
            .collect();
        format!(
            r#"<w:tbl><w:tblPr><w:tblW w:type="auto" w:w="0"/></w:tblPr><w:tblGrid>{grid}</w:tblGrid>{rows}</w:tbl>"#
        )
    };
    let gap = |n: usize| format!("<w:p><w:r><w:t>Gap {n}</w:t></w:r></w:p>");
    let formatted = |r: usize, c: usize| -> String {
        (0..3)
            .map(|p| {
                format!(
                    r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">R{r}C{c} </w:t></w:r><w:r><w:rPr><w:i/><w:color w:val="1F4E79"/></w:rPr><w:t>line {p}</w:t></w:r></w:p>"#
                )
            })
            .collect()
    };
    let listed = |r: usize, c: usize| -> String {
        (0..20)
            .map(|item| {
                format!(
                    r#"<w:p><w:pPr><w:pStyle w:val="ListBullet"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Item {r}.{c}.{item}</w:t></w:r></w:p>"#
                )
            })
            .collect()
    };
    lesson_docx_with(&format!(
        "{}{}{}{}{}{}{}{}",
        table(1, 1, &|_, _| "<w:p><w:r><w:t>Only</w:t></w:r></w:p>"
            .to_owned()),
        gap(1),
        table(10, 10, &formatted),
        gap(2),
        table(3, 3, &listed),
        gap(3),
        table(50, 10, &|r, c| format!(
            "<w:p><w:r><w:t>Cell {r}.{c}</w:t></w:r></w:p>"
        )),
        gap(4),
    ))
}

/// An insert_paragraph naming its anchor by `key` (`afterId` or `beforeId`).
fn insert(key: &str, anchor: &str, text: &str, style: Option<&str>) -> Command {
    let mut value = serde_json::json!({ "type": "insert_paragraph", "text": text });
    value[key] = anchor.into();
    if let Some(style) = style {
        value["style"] = style.into();
    }
    command(value)
}

fn set_range(sheet: &str, range: &str, expected: &[&[&str]], values: &[&[&str]]) -> Command {
    let grid = |rows: &[&[&str]]| {
        rows.iter()
            .map(|row| row.iter().map(|cell| (*cell).to_owned()).collect())
            .collect()
    };
    Command::SetRange {
        sheet: sheet.to_owned(),
        range: range.to_owned(),
        expected: grid(expected),
        values: grid(values),
    }
}

fn doc_of(state: &[u8]) -> Doc {
    let doc = ydoc::scratch_doc();
    ydoc::apply(&doc, Update::decode_v1(state).unwrap()).unwrap();
    doc
}

fn state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

/// DOCX and PPTX `replace_text`: Undo puts the paragraph's text back, Redo
/// the agent's.
#[test]
fn undo_restores_a_docx_and_a_pptx_paragraph() {
    for (format, path) in [
        (Format::Docx, "e2e/fixtures/files/basic/lesson.docx"),
        (Format::Pptx, "e2e/fixtures/files/basic/lesson.pptx"),
    ] {
        let file = File::open(format, path);
        let room = file.room();
        let entry = file
            .entries(&room)
            .into_iter()
            .find(|entry| entry.value.len() > 3)
            .unwrap();
        let edited = format!("{} edited", entry.value);
        let change = file.agent_edit(
            &room,
            &[Command::ReplaceText {
                target_id: entry.id.clone(),
                expected_text: entry.value.clone(),
                text: edited.clone(),
            }],
        );
        let text = |room: &Doc| {
            file.entries(room)
                .into_iter()
                .find(|now| now.id == entry.id)
                .unwrap()
                .value
        };
        assert_eq!(text(&room), edited, "{path}");
        let redo = ydoc::undo::revert(&room, change).unwrap().next.unwrap();
        assert_eq!(text(&room), entry.value, "{path}");
        ydoc::undo::revert(&room, redo).unwrap();
        assert_eq!(text(&room), edited, "{path}");
    }
}

/// PPTX `delete_slide` and `move_slide`: Undo puts the slide back in its
/// place with its shapes, text and speaker notes (a person wrote them before
/// the agent's read; Epo 2026-10-22), and the room saves the file it saved
/// before the edit.
#[test]
fn undo_restores_a_deleted_and_a_moved_slide() {
    let file = File::open(Format::Pptx, LESSON_PPTX);
    let room = file.room();
    let first = file.slides(&room).remove(0);
    {
        let mut txn = room.transact_mut();
        let slides = txn.get_or_insert_map("pptx:slides");
        let slide: MapRef = slides.get(&txn, &first).unwrap().cast().unwrap();
        slide.insert(&mut txn, "notes", "Greet the room.\nThen the demo.");
    }
    let before = file.export(&room);
    let slides = file.slides(&room);
    let texts = [file.slide_text(&room, 1), file.slide_text(&room, 2)];
    assert!(texts[0].ends_with("Greet the room.\nThen the demo."));
    for command in [
        Command::DeleteSlide {
            slide_id: slides[0].clone(),
            expected_text: texts[0].clone(),
        },
        Command::MoveSlide {
            slide_id: slides[0].clone(),
            after_slide: Some(slides[1].clone()),
            before_slide: None,
        },
    ] {
        let change = file.agent_edit(&room, std::slice::from_ref(&command));
        assert_ne!(file.slides(&room), slides, "{command:?}");
        ydoc::undo::revert(&room, change).unwrap();
        assert_eq!(file.slides(&room), slides, "{command:?}");
        let now = [file.slide_text(&room, 1), file.slide_text(&room, 2)];
        assert_eq!(now, texts, "{command:?}");
        assert!(file.export(&room) == before, "{command:?}");
    }
}

/// XLSX `set_cell`: Undo puts the cell's input back, and a formula reading
/// it computes from the restored value once an engine applies the room's
/// state (Yjs holds inputs; values are the engine's).
#[test]
fn undo_restores_an_xlsx_cell_and_its_dependent_formula() {
    let file = File::open(Format::Xlsx, GRADES);
    let room = file.room();
    let entries = file.entries(&room);
    let (sheet, _) = entries[0].position.rsplit_once(':').unwrap();
    let set = |cell: &str, expected: &str, value: &str| Command::SetCell {
        sheet: sheet.to_owned(),
        cell: cell.to_owned(),
        expected_value: expected.to_owned(),
        value: value.to_owned(),
    };
    // Someone's earlier edits: an input and a formula reading it.
    file.agent_edit(&room, &[set("Z2", "", "3"), set("Z1", "", "=Z2*2")]);
    let change = file.agent_edit(&room, &[set("Z2", "3", "5")]);
    let computed = |room: &Doc, at: &str| {
        let options = CalculationOptions { now_serial: None };
        let mut workbook =
            Workbook::open_collaborative_recalculated(&file.base, 99, options).unwrap();
        workbook
            .apply_update_v1(&state(room), CalculationOptions { now_serial: None })
            .unwrap();
        workbook.model().sheets[0]
            .cell(CellRef::parse_a1(at).unwrap())
            .map(|cell| cell.value.clone())
    };
    let number = |value: f64| Some(CellValue::Number { value });
    assert_eq!(computed(&room, "Z2"), number(5.0));
    assert_eq!(computed(&room, "Z1"), number(10.0));
    ydoc::undo::revert(&room, change).unwrap();
    assert_eq!(computed(&room, "Z2"), number(3.0));
    assert_eq!(computed(&room, "Z1"), number(6.0));
}

/// XLSX `delete_rows` (structural commands get the live Undo, Epo
/// 2026-10-20): Undo brings the band's cells back, and a formula above it
/// that the delete broke reads them again.
#[test]
fn undo_restores_a_deleted_row_band_and_the_formula_reading_it() {
    let file = File::open(Format::Xlsx, GRADES);
    let room = file.room();
    let (sheet, _) = file.sheets(&room).remove(0);
    file.agent_edit(
        &room,
        &[
            set_range(&sheet, "A100:A101", &[&[""], &[""]], &[&["3"], &["4"]]),
            set_range(&sheet, "Z1", &[&[""]], &[&["=A100+A101"]]),
        ],
    );
    let read = |room: &Doc| {
        (
            file.cells(room, &sheet, "Z1"),
            file.cells(room, &sheet, "A100:A101"),
        )
    };
    let before = read(&room);
    assert_eq!(before.0, ["Z1==A100+A101→7"]);
    let change = file.agent_edit(
        &room,
        &[Command::DeleteRows {
            sheet: sheet.clone(),
            at: 100,
            count: 2,
            expected: vec![vec!["3".into()], vec!["4".into()]],
        }],
    );
    let (formula, band) = read(&room);
    assert!(
        band.is_empty() && formula[0].contains("#REF!"),
        "{formula:?}"
    );
    ydoc::undo::revert(&room, change).unwrap();
    assert_eq!(read(&room), before);
}

/// XLSX `delete_sheet`: Undo brings the sheet back in its place with its
/// cells, and a formula on another sheet reading it computes again.
#[test]
fn undo_restores_a_deleted_sheet_and_the_formula_reading_it() {
    let file = File::open(Format::Xlsx, GRADES);
    let room = file.room();
    let (sheet, _) = file.sheets(&room).remove(0);
    file.agent_edit(
        &room,
        &[
            Command::AddSheet {
                name: "Data".into(),
                after: None,
            },
            set_range("Data", "A1", &[&[""]], &[&["5"]]),
            set_range(&sheet, "Z1", &[&[""]], &[&["=Data!A1*2"]]),
        ],
    );
    let read = |room: &Doc| {
        (
            file.sheets(room),
            file.cells(room, &sheet, "Z1"),
            file.cells(room, "Data", "A1"),
        )
    };
    let before = read(&room);
    assert_eq!(before.1, ["Z1==Data!A1*2→10"]);
    let change = file.agent_edit(
        &room,
        &[Command::DeleteSheet {
            sheet: "Data".into(),
            expected_name: "Data".into(),
        }],
    );
    assert!(file.sheets(&room).iter().all(|(_, name)| name != "Data"));
    assert!(file.cells(&room, &sheet, "Z1")[0].contains("#REF!"));
    ydoc::undo::revert(&room, change).unwrap();
    assert_eq!(read(&room), before);
}

/// DOCX and PPTX `insert_paragraph` and `delete_paragraph` (Epo
/// 2026-10-21): Undo takes an inserted paragraph out and puts a deleted one
/// back, the file saving as it did before the edit. That holds for the
/// inserts the engine gives no inverse too: one at a section's end, whose
/// split moves the section mark to the new paragraph as Enter does, and an
/// append.
#[test]
fn undo_reverts_paragraph_inserts_and_deletes() {
    for file in [lesson_docx(), File::open(Format::Pptx, LESSON_PPTX)] {
        let room = file.room();
        let saved = file.export(&room);
        let entries = file.entries(&room);
        let id = |text: &str| {
            entries
                .iter()
                .find(|entry| entry.value.starts_with(text))
                .unwrap_or_else(|| panic!("no paragraph reads {text:?}"))
                .id
                .clone()
        };
        let owner = id("Owner sentence");
        let text = |id: &str| {
            let entry = entries.iter().find(|entry| entry.id == id).unwrap();
            entry.value.clone()
        };
        let mut cases = vec![
            // DOCX: the section's end; PPTX: its shape's last paragraph.
            vec![insert("afterId", &owner, "Coda", None)],
            vec![insert("beforeId", &owner, "Preface", None)],
            // A delete of the paragraph an insert made not its story's last.
            vec![
                insert("afterId", &owner, "Extra", None),
                Command::DeleteParagraph {
                    target_id: owner.clone(),
                    expected_text: text(&owner),
                },
            ],
        ];
        if file.format == Format::Docx {
            // The list goes on.
            let item = id("Collaborator sentence");
            cases.push(vec![insert("afterId", &item, "Next item", None)]);
            cases.push(vec![insert(
                "afterId",
                &id("Closing line."),
                "Appendix",
                None,
            )]);
            cases.push(vec![insert("beforeId", &owner, "Title", Some("Heading1"))]);
            let collaborator = id("Collaborator sentence");
            cases.push(vec![Command::DeleteParagraph {
                expected_text: text(&collaborator),
                target_id: collaborator,
            }]);
        }
        for case in cases {
            let change = file.agent_edit(&room, &case);
            assert_ne!(file.export(&room), saved, "{case:?}");
            ydoc::undo::revert(&room, change).unwrap();
            assert!(file.export(&room) == saved, "{case:?} undoes");
        }
    }
}

/// Epo's question (2026-10-22): what the agent's Undo does to text a
/// person typed, after the agent's edit, into a paragraph and a table the
/// edit inserted. The Undo removes exactly the agent's own items: the
/// paragraph's text and mark and the table go. The person's words in the
/// paragraph stay, joining the anchor paragraph the agent's split was made
/// at (its mark was the agent's); the words in the cell leave the document
/// with the table, whose cell stories nothing reaches any more.
#[test]
fn undo_of_an_agent_insert_after_a_person_typed_into_it() {
    let file = lesson_docx();
    let room = file.room();
    let owner = file
        .paragraphs(&room)
        .into_iter()
        .find(|p| p["text"].as_str().unwrap().starts_with("Owner sentence"))
        .unwrap();
    let anchor = owner["id"].as_str().unwrap().to_owned();
    let change = file.agent_edit(
        &room,
        &[
            insert("afterId", &anchor, "Agent line", None),
            command(serde_json::json!({
                "type": "insert_table", "afterId": anchor, "rows": [["Agent cell"]],
            })),
        ],
    );
    let read = file.paragraphs(&room);
    let id_of = |text: &str| {
        read.iter()
            .find(|p| p["text"] == text)
            .map(|p| p["id"].as_str().unwrap().to_owned())
            .unwrap()
    };
    let replace = |id: String, expected: &str, text: &str| Command::ReplaceText {
        target_id: id,
        expected_text: expected.into(),
        text: text.into(),
    };
    file.person_edit(
        &room,
        &[
            replace(
                id_of("Agent line"),
                "Agent line",
                "Agent line, then the person",
            ),
            replace(
                id_of("Agent cell"),
                "Agent cell",
                "Agent cell and the person",
            ),
        ],
    );
    ydoc::undo::revert(&room, change).unwrap();
    let texts: Vec<String> = file
        .paragraphs(&room)
        .into_iter()
        .map(|p| p["text"].as_str().unwrap().to_owned())
        .collect();
    eprintln!("after the Undo: {texts:?}");
    assert!(
        !texts.iter().any(|text| text.contains("Agent")),
        "{texts:?}"
    );
    // The agent's split put its own mark between the anchor's text and
    // the new paragraph's: without it the person's words end the anchor.
    assert!(
        texts.contains(&"Owner sentence: The launch code is LARCH-17., then the person".to_owned()),
        "{texts:?}"
    );
    assert!(
        !texts.iter().any(|text| text.contains("and the person")),
        "{texts:?}"
    );
}

/// What an edit's Undo and its Redo send, measured on copies of the room
/// (`ydoc::undo::revert_len`), the room left undone.
fn undo_and_redo(room: &Doc, change: Change) -> (usize, usize) {
    let undo = ydoc::undo::revert_len(room, &change);
    let redo = ydoc::undo::revert(room, change)
        .and_then(|reverted| reverted.next)
        .map_or(0, |back| ydoc::undo::revert_len(room, &back));
    (undo, redo)
}

/// Prints the ratio of `cost` to what the Undo and Redo sent (STATE.md
/// keeps them) and notes a cost that does not cover both.
fn covers(short: &mut Vec<String>, name: &str, cost: usize, (undo, redo): (usize, usize)) {
    let sent = undo.max(redo);
    eprintln!(
        "undo_cost {name}: cost {cost} B, Undo {undo} B, Redo {redo} B, ratio {:.1}",
        cost as f64 / sent.max(1) as f64
    );
    if cost < sent {
        short.push(format!("{name}: cost {cost} < Undo {undo} / Redo {redo}"));
    }
}

/// How far a DOCX or PPTX estimate may sit above what its Undo or Redo
/// sends (the Editor 2026-10-22): within it an ordinary 50-command call
/// keeps its Undo.
const CEILING: f64 = 10.0;

/// [`covers`], and notes a DOCX or PPTX estimate past [`CEILING`] times
/// what was sent.
fn covers_closely(short: &mut Vec<String>, name: &str, cost: usize, sent: (usize, usize)) {
    covers(short, name, cost, sent);
    let most = sent.0.max(sent.1).max(1);
    if cost as f64 > CEILING * most as f64 {
        short.push(format!(
            "{name}: cost {cost} over {CEILING}x Undo {} / Redo {}",
            sent.0, sent.1
        ));
    }
}

fn command(value: serde_json::Value) -> Command {
    serde_json::from_value(value).unwrap()
}

/// The DOCX-only commands on lesson.docx: a list, an alignment and every
/// format over body paragraphs, a table of long cells inserted, and the
/// file's table deleted.
fn docx_cases(file: &File, room: &Doc) -> Vec<(&'static str, Command)> {
    let paragraphs = file.paragraphs(room);
    let body: Vec<&serde_json::Value> = paragraphs
        .iter()
        .filter(|p| {
            p["id"].as_str().unwrap().starts_with("body:paragraph:")
                && p.get("locked").is_none()
                && !p["text"].as_str().unwrap().is_empty()
        })
        .take(3)
        .collect();
    let first = &body[0];
    let (table_id, table) = file.tables(room).remove(0);
    let long = "a longer cell of the agent's table, ".repeat(4);
    vec![
        (
            "set_list",
            command(serde_json::json!({
                "type": "set_list", "list": "numbered",
                "ids": body.iter().map(|p| p["id"].clone()).collect::<Vec<_>>(),
            })),
        ),
        (
            "set_alignment",
            command(serde_json::json!({
                "type": "set_alignment", "targetId": first["id"], "alignment": "justify",
            })),
        ),
        (
            "format_text",
            command(serde_json::json!({
                "type": "format_text", "targetId": first["id"], "expectedText": first["text"],
                "bold": true, "italic": true, "underline": true, "strikethrough": true,
                "color": "#1F4E79", "highlight": "yellow", "fontSize": 14, "fontFamily": "Georgia",
            })),
        ),
        (
            "insert_table",
            command(serde_json::json!({
                "type": "insert_table", "afterId": first["id"],
                "rows": (0..5).map(|r| (0..4).map(|c| format!("{long}{r}.{c}")).collect::<Vec<_>>()).collect::<Vec<_>>(),
            })),
        ),
        (
            "insert_table (empty cells)",
            command(serde_json::json!({
                "type": "insert_table", "afterId": first["id"],
                "rows": vec![vec![""; 4]; 5],
            })),
        ),
        (
            "delete_table",
            command(serde_json::json!({
                "type": "delete_table", "id": table_id, "expected": table,
            })),
        ),
    ]
}

/// The PPTX shape and slide commands on lesson.pptx: a shape's text
/// rewritten longer and emptied, a span given every format, an alignment, a
/// slide added after the first on its layout, a text box of 19 long
/// paragraphs (4,864 characters, near a box's 5,000), a slide moved and one
/// deleted.
fn pptx_cases(file: &File, room: &Doc) -> Vec<(&'static str, Command)> {
    let slides = file.slides(room);
    let read = file.deck(room, Some(1));
    let paragraphs = read["paragraphs"].as_array().unwrap();
    let shape_text = |shape: &serde_json::Value| {
        paragraphs
            .iter()
            .filter(|p| p["shape"] == shape["id"])
            .map(|p| p["text"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let shapes = read["shapes"].as_array().unwrap();
    let owner = paragraphs
        .iter()
        .find(|p| p["text"].as_str().unwrap().starts_with("Owner sentence"))
        .unwrap();
    let long = "a new paragraph from the agent, ".repeat(8);
    vec![
        (
            "set_shape_text (longer)",
            command(serde_json::json!({
                "type": "set_shape_text", "shapeId": shapes[0]["id"],
                "expectedText": shape_text(&shapes[0]), "paragraphs": [long, long, long],
            })),
        ),
        (
            "set_shape_text (emptied)",
            command(serde_json::json!({
                "type": "set_shape_text", "shapeId": shapes[1]["id"],
                "expectedText": shape_text(&shapes[1]), "paragraphs": [""],
            })),
        ),
        (
            "format_text",
            command(serde_json::json!({
                "type": "format_text", "targetId": owner["id"], "expectedText": "launch code",
                "bold": true, "italic": true, "underline": true, "strikethrough": true,
                "color": "#1F4E79", "fontSize": 28, "fontFamily": "Georgia",
            })),
        ),
        (
            "set_alignment",
            command(serde_json::json!({
                "type": "set_alignment", "targetId": owner["id"], "alignment": "center",
            })),
        ),
        (
            "add_slide",
            command(serde_json::json!({ "type": "add_slide", "afterSlide": slides[0] })),
        ),
        (
            "add_text_box",
            command(serde_json::json!({
                "type": "add_text_box", "slideId": slides[0], "paragraphs": vec![long.clone(); 19],
                "x": 36, "y": 36, "w": 400, "h": 300,
            })),
        ),
        (
            "move_slide",
            command(serde_json::json!({
                "type": "move_slide", "slideId": slides[0], "afterSlide": slides[1],
            })),
        ),
        (
            "delete_slide",
            command(serde_json::json!({
                "type": "delete_slide", "slideId": slides[0],
                "expectedText": file.slide_text(room, 1),
            })),
        ),
    ]
}

/// Epo 2026-10-21: an agent edit's Undo is sized from its commands
/// (`sources::undo_cost`), never by reverting on a copy. On the fixtures every
/// Office command type's rule, and the text source's, is at least what the
/// edit's Undo and its Redo send. Fails if a rule under-estimates.
#[test]
fn every_command_costs_at_least_what_its_undo_and_redo_send() {
    let mut short = Vec::new();
    let xlsx = File::open(Format::Xlsx, GRADES);
    let room = xlsx.room();
    let (sheet, name) = xlsx.sheets(&room).remove(0);
    let long = "a longer cell value, ".repeat(10);
    let grid = |rows: usize, cols: usize, text: &str| -> Vec<Vec<String>> {
        (0..rows)
            .map(|r| (0..cols).map(|c| format!("{text}{r}.{c}")).collect())
            .collect()
    };
    let empty = |rows: usize, cols: usize| vec![vec![String::new(); cols]; rows];
    // Filled cells for the cases to overwrite, format and delete.
    xlsx.agent_edit(
        &room,
        &[Command::SetRange {
            sheet: sheet.clone(),
            range: "AA1:AD40".into(),
            expected: empty(40, 4),
            values: grid(40, 4, &long),
        }],
    );
    let cases = vec![
        (
            "set_cell (new)",
            vec![command(serde_json::json!({
                "type": "set_cell", "sheet": sheet, "cell": "Z5",
                "expectedValue": "", "value": long,
            }))],
        ),
        (
            "set_cell (overwrite)",
            vec![command(serde_json::json!({
                "type": "set_cell", "sheet": sheet, "cell": "AA1",
                "expectedValue": format!("{long}0.0"), "value": "short",
            }))],
        ),
        (
            "set_range (new)",
            vec![Command::SetRange {
                sheet: sheet.clone(),
                range: "AF1:AH30".into(),
                expected: empty(30, 3),
                values: grid(30, 3, "v"),
            }],
        ),
        (
            "set_range (overwrite)",
            vec![Command::SetRange {
                sheet: sheet.clone(),
                range: "AA2:AD40".into(),
                expected: grid(40, 4, &long)[1..].to_vec(),
                values: grid(39, 4, "x"),
            }],
        ),
        (
            "format_cells",
            vec![command(serde_json::json!({
                "type": "format_cells", "sheet": sheet, "range": "AA1:AD40",
                "style": {
                    "bold": true, "italic": true, "fillColor": "#ffcc00",
                    "textColor": "#123456", "fontSize": 14, "fontFamily": "Georgia",
                },
            }))],
        ),
        (
            "add_sheet",
            vec![command(
                serde_json::json!({ "type": "add_sheet", "name": "Calibration" }),
            )],
        ),
        (
            "rename_sheet",
            vec![command(serde_json::json!({
                "type": "rename_sheet", "sheet": sheet,
                "expectedName": name, "name": "Renamed for calibration",
            }))],
        ),
        (
            "insert_rows",
            vec![command(serde_json::json!({
                "type": "insert_rows", "sheet": sheet, "at": 5, "count": 50,
            }))],
        ),
        (
            "insert_columns",
            vec![command(serde_json::json!({
                "type": "insert_columns", "sheet": sheet, "at": "B", "count": 20,
            }))],
        ),
    ];
    for (case, commands) in cases {
        let (cost, change) = xlsx.costed_edit(&room, &commands);
        covers(&mut short, case, cost, undo_and_redo(&room, change));
    }
    // Bands and a sheet to delete, filled first.
    xlsx.agent_edit(
        &room,
        &[
            command(serde_json::json!({ "type": "add_sheet", "name": "Data" })),
            Command::SetRange {
                sheet: "Data".into(),
                range: "A1:C30".into(),
                expected: empty(30, 3),
                values: grid(30, 3, &long),
            },
        ],
    );
    for (case, removal) in [
        (
            "delete_rows",
            command(serde_json::json!({
                "type": "delete_rows", "sheet": "Data", "at": 1, "count": 10,
                "expected": grid(10, 3, &long),
            })),
        ),
        (
            "delete_columns",
            command(serde_json::json!({
                "type": "delete_columns", "sheet": "Data", "at": "A", "count": 1,
                "expected": grid(30, 3, &long).iter().map(|row| vec![row[0].clone()]).collect::<Vec<_>>(),
            })),
        ),
        (
            "delete_sheet",
            command(serde_json::json!({
                "type": "delete_sheet", "sheet": "Data", "expectedName": "Data",
            })),
        ),
    ] {
        // Each case leaves the room undone, so the next finds its band.
        let (cost, change) = xlsx.costed_edit(&room, &[removal]);
        covers(&mut short, case, cost, undo_and_redo(&room, change));
    }

    // Large sheets (the Editor's design 2026-10-22): a sheet of 10,000
    // written cells, half its rows or columns deleted and the sheet deleted,
    // and the large gradebook's first sheet (16,000 cells of the base)
    // deleted.
    let written = grid(1_000, 10, "a written cell ");
    xlsx.agent_edit(
        &room,
        &[
            command(serde_json::json!({ "type": "add_sheet", "name": "Big" })),
            Command::SetRange {
                sheet: "Big".into(),
                range: "A1:J1000".into(),
                expected: empty(1_000, 10),
                values: written.clone(),
            },
        ],
    );
    for (case, removal) in [
        (
            "delete_rows (500 rows of a 10,000-cell sheet)",
            command(serde_json::json!({
                "type": "delete_rows", "sheet": "Big", "at": 1, "count": 500,
                "expected": written[..500],
            })),
        ),
        (
            "delete_columns (5 columns of a 10,000-cell sheet)",
            command(serde_json::json!({
                "type": "delete_columns", "sheet": "Big", "at": "A", "count": 5,
                "expected": written.iter().map(|row| row[..5].to_vec()).collect::<Vec<_>>(),
            })),
        ),
        (
            "delete_sheet (10,000 written cells)",
            command(serde_json::json!({
                "type": "delete_sheet", "sheet": "Big", "expectedName": "Big",
            })),
        ),
    ] {
        let (cost, change) = xlsx.costed_edit(&room, &[removal]);
        covers(&mut short, case, cost, undo_and_redo(&room, change));
    }
    let book = File::open(Format::Xlsx, GRADEBOOK);
    let room = book.room();
    let (sheet, name) = book.sheets(&room).remove(0);
    let (cost, change) = book.costed_edit(
        &room,
        &[Command::DeleteSheet {
            sheet,
            expected_name: name,
        }],
    );
    covers(
        &mut short,
        "delete_sheet (the large gradebook's first)",
        cost,
        undo_and_redo(&room, change),
    );

    for (file, path) in [
        (lesson_docx(), LESSON_DOCX),
        (File::open(Format::Pptx, LESSON_PPTX), LESSON_PPTX),
    ] {
        let format = file.format;
        let room = file.room();
        for entry in file
            .entries(&room)
            .into_iter()
            .filter(|entry| !entry.value.is_empty())
            .take(6)
        {
            let replace = Command::ReplaceText {
                target_id: entry.id.clone(),
                expected_text: entry.value.clone(),
                text: format!("{} {}", entry.value, "and a longer replacement".repeat(3)),
            };
            let (cost, change) = file.costed_edit(&room, &[replace]);
            covers_closely(
                &mut short,
                &format!("{path} replace_text"),
                cost,
                undo_and_redo(&room, change),
            );
        }
        let long = "a new paragraph from the agent, ".repeat(8);
        let style = (format == Format::Docx).then_some("Heading1");
        for entry in file
            .entries(&room)
            .into_iter()
            .filter(|entry| format == Format::Pptx || entry.id.starts_with("body:"))
            .take(4)
        {
            let mut cases = vec![
                (
                    "insert_paragraph",
                    insert("afterId", &entry.id, &long, None),
                ),
                ("insert_paragraph", insert("afterId", &entry.id, "", None)),
                ("insert_paragraph", insert("beforeId", &entry.id, "", style)),
            ];
            let delete = Command::DeleteParagraph {
                target_id: entry.id.clone(),
                expected_text: entry.value.clone(),
            };
            if !file.lands(&room, std::slice::from_ref(&delete)) {
                // Its story's last paragraph: one more after it, kept.
                file.agent_edit(&room, &[insert("afterId", &entry.id, "kept", None)]);
            }
            cases.push(("delete_paragraph", delete));
            for (name, case) in cases {
                let (cost, change) = file.costed_edit(&room, &[case]);
                covers_closely(
                    &mut short,
                    &format!("{path} {name}"),
                    cost,
                    undo_and_redo(&room, change),
                );
            }
        }
        let cases = match format {
            Format::Docx => docx_cases(&file, &room),
            _ => pptx_cases(&file, &room),
        };
        for (name, case) in cases {
            let (cost, change) = file.costed_edit(&room, &[case]);
            covers_closely(
                &mut short,
                &format!("{path} {name}"),
                cost,
                undo_and_redo(&room, change),
            );
        }
        if format == Format::Pptx {
            // A slide on each of the deck's layouts: Blank's has no text
            // placeholder, Comparison's the most (five).
            for layout in file.deck(&room, None)["layouts"].as_array().unwrap() {
                let (cost, change) = file.costed_edit(
                    &room,
                    &[command(
                        serde_json::json!({ "type": "add_slide", "layout": layout["id"] }),
                    )],
                );
                covers_closely(
                    &mut short,
                    &format!("{path} add_slide ({})", layout["name"].as_str().unwrap()),
                    cost,
                    undo_and_redo(&room, change),
                );
            }
        }
    }

    // Many runs a paragraph (review H1): every format on the whole text, the
    // whole text replaced, the paragraph deleted.
    let (docx, five, mixed) = many_runs_docx();
    let (pptx, pptx_five) = many_runs_pptx();
    for (file, name, text) in [
        (&docx, "docx 5-character runs", &five),
        (&docx, "docx one-character CJK/Latin runs", &mixed),
        (&pptx, "pptx 5-character runs", &pptx_five),
    ] {
        let room = file.room();
        let id = file
            .entries(&room)
            .into_iter()
            .find(|entry| entry.value == *text)
            .map(|entry| entry.id)
            .unwrap_or_else(|| panic!("{name}: no paragraph reads its text"));
        let mut cases = vec![
            (
                "replace_text",
                Command::ReplaceText {
                    target_id: id.clone(),
                    expected_text: text.clone(),
                    text: "short".into(),
                },
            ),
            (
                "delete_paragraph",
                Command::DeleteParagraph {
                    target_id: id.clone(),
                    expected_text: text.clone(),
                },
            ),
        ];
        let mut format = serde_json::json!({
            "type": "format_text", "targetId": id, "expectedText": text,
            "bold": true, "italic": true, "underline": true, "strikethrough": true,
            "color": "#1F4E79", "fontSize": 14, "fontFamily": "Georgia",
        });
        if file.format == Format::Docx {
            format["highlight"] = "yellow".into();
        } else {
            // The shape's whole text rewritten: its many-run paragraph and
            // the owner sentence.
            let read = file.deck(&room, Some(1));
            let paragraphs = read["paragraphs"].as_array().unwrap();
            let shape = &paragraphs.iter().find(|p| p["text"] == **text).unwrap()["shape"];
            let lines: Vec<&str> = paragraphs
                .iter()
                .filter(|p| p["shape"] == *shape)
                .map(|p| p["text"].as_str().unwrap())
                .collect();
            cases.push((
                "set_shape_text",
                command(serde_json::json!({
                    "type": "set_shape_text", "shapeId": shape,
                    "expectedText": lines.join("\n"), "paragraphs": ["short"],
                })),
            ));
        }
        cases.push(("format_text", command(format)));
        for (case, command) in cases {
            let (cost, change) = file.costed_edit(&room, &[command]);
            covers_closely(
                &mut short,
                &format!("{name} {case}"),
                cost,
                undo_and_redo(&room, change),
            );
        }
    }

    // Review H1 and M3 (PPTX): a slide on a layout of nine text placeholders
    // with 200-character names, on Blank, and 50 short paragraphs over a run
    // of six formats.
    let rich = rich_pptx();
    let room = rich.room();
    let read = rich.deck(&room, Some(1));
    let owner = read["paragraphs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["text"] == "Owner sentence: The launch code is LARCH-17.")
        .unwrap()["shape"]
        .clone();
    for (name, case) in [
        (
            "add_slide (nine placeholders, long names)",
            command(serde_json::json!({
                "type": "add_slide", "layout": "ppt/slideLayouts/slideLayout5.xml",
            })),
        ),
        (
            "add_slide (Blank)",
            command(serde_json::json!({
                "type": "add_slide", "layout": "ppt/slideLayouts/slideLayout7.xml",
            })),
        ),
        (
            "set_shape_text (50 short paragraphs on a run of six formats)",
            command(serde_json::json!({
                "type": "set_shape_text", "shapeId": owner,
                "expectedText": "Owner sentence: The launch code is LARCH-17.",
                "paragraphs": (0..50).map(|n| format!("p{n}")).collect::<Vec<_>>(),
            })),
        ),
    ] {
        let (cost, change) = rich.costed_edit(&room, &[case]);
        covers_closely(&mut short, name, cost, undo_and_redo(&room, change));
    }

    // Review r2 H1: a header's and a footnote's text replaced whole, each
    // one run a character (apply finds them outside the body).
    let (stories, text) = stories_docx();
    let room = stories.room();
    for part in ["header", "footnote"] {
        let id = stories
            .paragraphs(&room)
            .into_iter()
            .find(|p| {
                p["part"]
                    .as_str()
                    .is_some_and(|label| label.starts_with(part))
            })
            .map(|p| p["id"].as_str().unwrap().to_owned())
            .unwrap();
        let (cost, change) = stories.costed_edit(
            &room,
            &[Command::ReplaceText {
                target_id: id,
                expected_text: text.clone(),
                text: "x".into(),
            }],
        );
        covers_closely(
            &mut short,
            &format!("{part} replace_text, one-character runs"),
            cost,
            undo_and_redo(&room, change),
        );
    }

    // Review r2 M1: every format on a 2-character paragraph of a file with
    // no default run properties, so the span holds no markers to measure:
    // the Redo is a start and an end marker a key.
    let file = File::of(
        Format::Docx,
        ooxml_opc::rezip_parts(&[(
            "word/document.xml".to_owned(),
            br#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ab</w:t></w:r></w:p><w:p><w:r><w:t>End</w:t></w:r></w:p></w:body></w:document>"#.to_vec(),
        )])
        .unwrap(),
    );
    let room = file.room();
    let id = file
        .paragraphs(&room)
        .into_iter()
        .find(|p| p["text"] == "ab")
        .map(|p| p["id"].clone())
        .unwrap();
    let (cost, change) = file.costed_edit(
        &room,
        &[command(serde_json::json!({
            "type": "format_text", "targetId": id, "expectedText": "ab",
            "bold": true, "italic": true, "underline": true, "strikethrough": true,
            "color": "#1F4E79", "highlight": "yellow", "fontSize": 14, "fontFamily": "Georgia",
        }))],
    );
    covers_closely(
        &mut short,
        "format_text, every format on 2 characters",
        cost,
        undo_and_redo(&room, change),
    );

    // Tables of several sizes (review M1): 1x1, 10x10 of three formatted
    // paragraphs a cell, 3x3 of 20 list items a cell, 50x10, deleted.
    let file = tables_docx();
    let room = file.room();
    for (id, grid) in file.tables(&room) {
        let name = format!("delete_table {}x{}", grid.len(), grid[0].len());
        let (cost, change) =
            file.costed_edit(&room, &[Command::DeleteTable { id, expected: grid }]);
        covers_closely(&mut short, &name, cost, undo_and_redo(&room, change));
    }

    // A text source: `replace_text` on its text.
    use yrs::{Text, WriteTxn};
    let text = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../e2e/fixtures/files/basic/notes.txt"),
    )
    .unwrap();
    let room = ydoc::scratch_doc();
    room.get_or_insert_text(sources::text::TEXT_ROOT).insert(
        &mut room.transact_mut(),
        0,
        &format!("{text}\n{}", "filler line\n".repeat(200)),
    );
    for (expected, replacement) in [
        (
            "Wetland plants absorb carbon",
            "Marsh plants hold carbon".to_owned(),
        ),
        ("LARCH-17", "a much longer code ".repeat(40)),
    ] {
        let replace = notes::edit::DocumentCommand::ReplaceText {
            block_id: None,
            expected_text: expected.into(),
            text: replacement,
        };
        let cost = sources::undo_cost::document(&replace, |_| 0);
        let scratch = doc_of(&state(&room));
        let captured = {
            let mut txn = scratch.transact_mut();
            let root = txn.get_or_insert_text(sources::text::TEXT_ROOT);
            notes::edit::apply_text_commands(&mut txn, &root, &[replace]).unwrap();
            Captured::of(&mut txn)
        };
        let update = scratch
            .transact()
            .encode_state_as_update_v1(&room.transact().state_vector());
        ydoc::undo::apply_kept(&room, Update::decode_v1(&update).unwrap()).unwrap();
        covers(
            &mut short,
            "text replace_text",
            cost,
            undo_and_redo(&room, captured.change(&room)),
        );
    }
    assert!(short.is_empty(), "{short:#?}");
}
