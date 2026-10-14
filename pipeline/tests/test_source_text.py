from __future__ import annotations

import pytest
from PIL import Image

from pipeline.ingest import source_text
from pipeline.parse import caption_cache


def test_tabular_text_preserves_headers_values_and_formulas(tmp_path) -> None:
    source = tmp_path / "grades.csv"
    source.write_text(
        'Student,Score,Formula\nAda,98,"=B2/100"\nLin,87,"=B3/100"\n',
        encoding="utf-8",
    )

    text = source_text.tabular_text(str(source), source.name)

    assert "Columns: Student | Score | Formula" in text
    assert "Student=Ada" in text
    assert "Score=98" in text
    assert "Formula==B2/100" in text


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


def test_tabular_text_bounds_its_expanded_search_projection(
    monkeypatch, tmp_path
) -> None:
    source = tmp_path / "rows.csv"
    source.write_text("LongHeader\na\nb\nc\n", encoding="utf-8")
    monkeypatch.setattr(source_text, "_TABULAR_MAX_OUTPUT_CHARS", 30)

    with pytest.raises(source_text.TerminalError, match="searchable-text limit"):
        source_text.tabular_text(str(source), source.name)


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
