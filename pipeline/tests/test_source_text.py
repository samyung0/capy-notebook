from __future__ import annotations

import pytest
from PIL import Image

from pipeline.ingest import source_text
from pipeline.parse import caption_cache
from pipeline.retrieval import chunking


def test_tabular_text_preserves_headers_values_and_formulas(tmp_path) -> None:
    source = tmp_path / "grades.csv"
    source.write_text(
        'Student," Final \t score ",Formula\nAda,98,"=B2/100"\nLin,87,"=B3/100"\n',
        encoding="utf-8",
    )

    text = source_text.tabular_text(str(source), source.name)

    # Whitespace runs in a header collapse like a cell's.
    assert text.split("\n\n") == [
        "Columns: Student | Final score | Formula",
        "Row 2: Student=Ada | Final score=98 | Formula==B2/100",
        "Row 3: Student=Lin | Final score=87 | Formula==B3/100",
    ]

    # A line break inside a quoted cell must not split its row.
    notes = tmp_path / "notes.csv"
    notes.write_text('a,"two\n\n  lines"\n', encoding="utf-8")
    assert source_text.tabular_text(str(notes), notes.name).split("\n\n")[1:] == [
        "Row 1: Column 1=a | Column 2=two lines"
    ]


def test_tabular_rows_are_packed_whole_with_one_block_per_row(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(chunking.cfg, "chunk_tokens", 80)
    monkeypatch.setattr(chunking.cfg, "chunk_overlap_tokens", 0)
    source = tmp_path / "scores.csv"
    # Every row renders to 29 characters (8 tokens): the padding shrinks as the
    # row number grows.
    source.write_text(
        "Score,Note\n"
        + "".join(f"1,{'x' * (8 - len(str(n)))}\n" for n in range(2, 1002)),
        encoding="utf-8",
    )

    text = source_text.tabular_text(str(source), source.name)
    blocks = text.split("\n\n")
    chunks = chunking.chunk_markdown(text)

    assert len(blocks) == 1001
    assert blocks[1] == "Row 2: Score=1 | Note=xxxxxxx"
    # The 6-token column line and 9 rows fill the first chunk, then 10 rows each.
    assert len(chunks) == 101
    assert [b for chunk in chunks for b in chunk.text.split("\n\n")] == blocks


def test_tabular_text_caps_columns_per_row_not_cells(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(source_text, "_TABULAR_MAX_COLUMNS", 4)
    tall = tmp_path / "tall.csv"
    tall.write_text("a,b,c,d\n" + "1,2,3,4\n" * 500, encoding="utf-8")
    assert "Row 501: a=1 | b=2 | c=3 | d=4" in source_text.tabular_text(
        str(tall), tall.name
    )

    # Quoted newlines split this five-column row over lines of two delimiters.
    wide = tmp_path / "wide.csv"
    wide.write_text('a,b,c,d\n1,"x\ny",2,"z\nw",3\n', encoding="utf-8")
    with pytest.raises(source_text.TerminalError, match="column limit") as error:
        source_text.tabular_text(str(wide), wide.name)
    assert error.value.code == "tabular_column_limit"


def test_tabular_text_caps_the_estimated_tokens_of_its_projection(
    monkeypatch, tmp_path
) -> None:
    source = tmp_path / "rows.csv"
    source.write_text("LongHeader\na\nb\nc\n", encoding="utf-8")
    monkeypatch.setattr(source_text, "_TABULAR_MAX_TOKENS", 12)

    with pytest.raises(
        source_text.TerminalError, match="searchable-text limit"
    ) as error:
        source_text.tabular_text(str(source), source.name)
    assert error.value.code == "tabular_text_limit"


def test_tabular_text_refuses_a_line_whose_length_passes_the_cap_unestimated(
    monkeypatch, tmp_path
) -> None:
    source = tmp_path / "wide.csv"
    source.write_text("Student,Notes\nAda," + "x" * 400 + "\n", encoding="utf-8")
    monkeypatch.setattr(source_text, "_TABULAR_MAX_TOKENS", 50)
    estimated: list[str] = []
    estimate = source_text.estimate_tokens
    monkeypatch.setattr(
        source_text,
        "estimate_tokens",
        lambda line: estimated.append(line) or estimate(line),
    )

    with pytest.raises(source_text.TerminalError, match="searchable-text limit"):
        source_text.tabular_text(str(source), source.name)
    assert estimated
    assert all("x" * 400 not in line for line in estimated)


@pytest.mark.asyncio
async def test_image_source_routes_authoritative_file_and_sha_to_caption_cache(
    monkeypatch, tmp_path
):
    source = tmp_path / "diagram.png"
    Image.new("RGB", (32, 32), "white").save(source)
    seen = {}

    async def caption(**kwargs):
        seen.update(kwargs)
        assert (await kwargs["data_url"]()).startswith("data:image/jpeg;base64,")
        return "A diagram.", "shared-caption", 42, True

    monkeypatch.setattr(caption_cache, "caption", caption)
    result = await source_text.caption_image_source(
        local_path=str(source),
        name=source.name,
        source_sha256="ab" * 32,
        file_id="file-1",
    )
    assert seen["file_id"] == "file-1" and seen["image_sha256"] == "ab" * 32
    assert result == ("A diagram.", "shared-caption", 42, True)
