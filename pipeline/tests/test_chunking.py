"""Offline unit tests for the chunker (no network, no database).

The chunker is where citation precision is decided: if page and bbox are lost
here, no amount of retrieval quality downstream can put them back.
"""

from __future__ import annotations

from pipeline.retrieval.chunking import (
    BBOX_SPACE,
    chunk_content_list,
    chunk_markdown,
    clip_to_tokens,
    estimate_tokens,
    outline_from_chunks,
    search_query_terms,
    tokenize_for_search,
)


def _block(text: str, page: int, *, level: int | None = None, bbox=None) -> dict:
    item = {"type": "text", "text": text, "page_idx": page}
    if level:
        item["text_level"] = level
    if bbox:
        item["bbox"] = bbox
    return item


def test_content_list_keeps_heading_breadcrumb_and_pages():
    chunks = chunk_content_list(
        [
            _block("Photosynthesis", 0, level=1),
            _block("Light reactions", 0, level=2),
            _block("Chlorophyll absorbs red and blue light." * 8, 0, bbox=[1, 2, 3, 4]),
            _block("The Calvin cycle follows." * 8, 1, bbox=[5, 6, 7, 8]),
        ]
    )

    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.section_path == "Photosynthesis › Light reactions"
    # page_idx is 0-based on the wire, 1-based everywhere the user can see it.
    assert (chunk.page_start, chunk.page_end) == (1, 2)
    assert [r.page for r in chunk.regions] == [1, 2]
    assert chunk.regions[0].as_dict() == {
        "page": 1,
        "bbox": [1.0, 2.0, 3.0, 4.0],
        "space": BBOX_SPACE,
    }


def test_a_malformed_bbox_is_dropped_rather_than_crashing_the_job():
    chunks = chunk_content_list(
        [
            _block("Photosynthesis", 0, level=1),
            _block("Bad coords " * 20, 0, bbox=["x", "y", "w", "h"]),
            _block("Good coords " * 20, 0, bbox=[1, 2, 3, 4]),
        ]
    )

    assert len(chunks) == 1
    assert [r.bbox for r in chunks[0].regions] == [[1.0, 2.0, 3.0, 4.0]]


def test_heading_change_starts_a_new_chunk():
    chunks = chunk_content_list(
        [
            _block("Alpha", 0, level=1),
            _block("Body of alpha." * 20, 0),
            _block("Beta", 1, level=1),
            _block("Body of beta." * 20, 1),
        ]
    )

    assert [c.section_path for c in chunks] == ["Alpha", "Beta"]


def test_tables_equations_and_captioned_images_are_indexed():
    chunks = chunk_content_list(
        [
            _block("Results", 0, level=1),
            {
                "type": "table",
                "table_caption": ["Table 1"],
                "table_body": "<table><tr><td>a</td></tr></table>",
                "page_idx": 0,
            },
            {"type": "equation", "text": "$$e=mc^2$$", "page_idx": 0},
            {"type": "image", "image_caption": ["Fig 1"], "page_idx": 0},
            # No caption and no VLM description: nothing to retrieve on.
            {"type": "image", "img_path": "images/blank.png", "page_idx": 0},
        ]
    )

    text = "\n".join(c.text for c in chunks)
    assert "Table 1" in text and "e=mc^2" in text and "[Figure] Fig 1" in text
    assert "blank.png" not in text


def test_markdown_has_no_page_model():
    chunks = chunk_markdown("# Title\n\n" + "Body sentence. " * 40)

    assert chunks and chunks[0].section_path == "Title"
    assert chunks[0].page_start is None and chunks[0].regions == []


def test_markdown_keeps_fenced_code_intact():
    chunks = chunk_markdown("# Code\n\n```py\n# not a heading\nx = 1\n```\n")

    assert len(chunks) == 1
    assert chunks[0].section_path == "Code"
    assert "# not a heading" in chunks[0].text


def test_oversized_block_is_split_at_a_sentence_boundary():
    chunks = chunk_markdown("# Long\n\n" + "A sentence about mitochondria. " * 400)

    assert len(chunks) > 1
    assert all(c.section_path == "Long" for c in chunks)
    assert chunks[0].text.rstrip().endswith(".")


def test_indexed_text_prefixes_section_without_logical_file_name():
    chunk = chunk_markdown("# Cells\n\n" + "Mitochondria make ATP. " * 20)[0]

    assert chunk.indexed_text().startswith("Cells\n\n")


def test_outline_lists_distinct_sections_in_order():
    chunks = chunk_content_list(
        [
            _block("One", 0, level=1),
            _block("Body one." * 30, 0),
            _block("Two", 1, level=1),
            _block("Body two." * 30, 1),
        ]
    )

    assert outline_from_chunks(chunks) == [
        {"title": "One", "pageStart": 1},
        {"title": "Two", "pageStart": 2},
    ]


# ------------------------------------------------------------- CJK tokenizer


def test_cjk_runs_become_bigrams():
    assert tokenize_for_search("光合作用") == "光合 合作 作用"


def test_latin_text_passes_through_untouched():
    assert tokenize_for_search("photosynthesis in plants") == "photosynthesis in plants"


def test_mixed_script_keeps_latin_words_whole():
    tokens = tokenize_for_search("ATP 合成酶").split()

    assert "ATP" in "".join(tokens)
    assert "合成" in tokens and "成酶" in tokens


def test_query_terms_are_or_joined_for_websearch_tsquery():
    terms = search_query_terms("光合作用")

    assert terms == "光合 or 合作 or 作用"
    # Same tokenizer on both sides, or the index and the query never meet.
    assert set(terms.split(" or ")) == set(tokenize_for_search("光合作用").split())


def test_estimate_tokens_counts_cjk_per_character():
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("光合作用") == 4
    assert estimate_tokens("ATP 合成") == estimate_tokens("ATP ") + estimate_tokens(
        "合成"
    )
    assert clip_to_tokens("光合作用ATP", 4) == "光合作用"
