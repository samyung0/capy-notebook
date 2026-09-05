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
            _block("NaN coords " * 20, 0, bbox=[0, 0, float("nan"), 20]),
            _block("Infinite coords " * 20, 0, bbox=[0, 0, float("inf"), 20]),
            _block("Reversed coords " * 20, 0, bbox=[20, 20, 10, 30]),
            _block("Empty coords " * 20, 0, bbox=[10, 10, 10, 20]),
            _block("Good coords " * 20, 0, bbox=[1, 2, 3, 4]),
        ]
    )

    assert len(chunks) == 1
    assert [r.bbox for r in chunks[0].regions] == [[1.0, 2.0, 3.0, 4.0]]

    # Canonical identity must remain serializable even when parser geometry is
    # malformed; bad regions are advisory and must not fail the whole ingest.
    from pipeline.retrieval.indexing import content_hash

    assert len(content_hash(chunks)) == 64


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


def test_tables_are_flattened_to_pipe_rows():
    """The parser's table HTML is a fifth of a textbook's indexed characters
    once every cell carries rowspan/colspan attributes. Cells keep their text
    and order; the markup goes."""
    chunks = chunk_content_list(
        [
            {
                "type": "table",
                "table_caption": ["Table 2"],
                "table_body": (
                    "<html><body><table><tr><td rowspan=1 colspan=1>Trial</td>"
                    "<td rowspan=1 colspan=1>Rate<br>(s<sup>-1</sup>)</td></tr>"
                    "<tr><td rowspan=1 colspan=1>1</td>"
                    "<td rowspan=1 colspan=1><img src='x.png'/>0.5</td></tr>"
                    "</table></body></html>"
                ),
                "page_idx": 0,
            }
        ]
    )

    assert chunks[0].text == "Table 2\nTrial | Rate (s-1)\n1 | 0.5"


def test_sub_sup_tags_are_stripped_and_inline_latex_is_compacted():
    chunks = chunk_content_list(
        [
            _block(
                "Water is H<sub>2</sub>O and area is 3 m<sup>2</sup>, "
                "i.e. $\\mathsf { m } ^ { 2 }$ per $\\mathrm { s }$.",
                0,
            )
        ]
    )

    assert chunks[0].text == (
        "Water is H2O and area is 3 m2, i.e. $\\mathsf{m}^{2}$ per $\\mathrm{s}$."
    )


def test_affiliation_markers_are_dropped_but_exponents_stay():
    """'Mayor-Rocher<sup>1</sup>' indexed as 'rocher1', which no query types.
    A digits-only superscript after a word, a CJK name or at a line start is a
    marker; after a unit, a number or a variable it is an exponent."""
    chunks = chunk_content_list(
        [
            _block(
                "Marina Mayor-Rocher<sup>1</sup>, Louis Martin∗<sup>1,2,3</sup>, "
                "LI Xin<sup>1,2+</sup>, 王晓宇<sup>1</sup>\n"
                "<sup>1</sup>Universidad Autónoma de Madrid\n"
                "1 petaFLOP is 10<sup>15</sup> FLOPS at 3 mmol dm<sup>-3</sup> "
                "over 2 m<sup>2</sup>, Ca<sup>2+</sup>",
                0,
            )
        ]
    )

    assert chunks[0].text == (
        "Marina Mayor-Rocher, Louis Martin, LI Xin, 王晓宇\n"
        "Universidad Autónoma de Madrid\n"
        "1 petaFLOP is 1015 FLOPS at 3 mmol dm-3 over 2 m2, Ca2+"
    )


def test_text_repeated_on_three_pages_is_furniture_whatever_its_label():
    """A journal's running title arrived as ``header`` on 22 of 25 pages and
    opened 28 of 75 chunks; a deck's licence line arrived as ``text`` on 40.
    Two pages is a real repeat (a heading restated after a figure); three is
    furniture. Headings are exempt: they set the section path, not the body."""
    title = "El Sesgo Lingüístico Digital en la IA: implicaciones"
    licence = "Licensed under CC BY 4.0"
    blocks = []
    for page in range(3):
        blocks.append({"type": "header", "text": title, "page_idx": page})
        blocks.append({"type": "text", "text": licence, "page_idx": page})
        blocks.append(_block("Methods", page, level=2))
        blocks.append(_block(f"Body of page {page}. " * 20, page))
    blocks.append({"type": "text", "text": "Twice only", "page_idx": 0})
    blocks.append({"type": "text", "text": "Twice only", "page_idx": 2})

    chunks = chunk_content_list(blocks)
    text = "\n".join(c.text for c in chunks)

    assert title not in text and licence not in text
    assert text.count("Twice only") == 2
    assert "Body of page 2" in text
    assert {c.section_path for c in chunks} == {"Methods"}


def test_reference_list_is_marked_but_a_citing_body_list_is_not():
    """A bibliography is one ``list`` block of citation-shaped items; it stays
    embedded and readable but is flagged so indexing leaves it out of the
    lexical leg. A body list that cites one paper is content."""
    refs = [
        f"[{i}] Author {i}, et al. Title of paper {i}. Journal, 2019." for i in range(6)
    ]
    body = [
        "Collect samples",
        "See Smith et al. (2020)",
        "Weigh them",
        "Plot",
        "Report",
    ]
    blocks = [
        _block("References", 0, level=2),
        {"type": "list", "list_items": refs, "page_idx": 0},
        _block("Method", 1, level=2),
        {"type": "list", "list_items": body, "page_idx": 1},
        _block("A paragraph of the method section that runs on. " * 4, 1),
    ]

    chunks = chunk_content_list(blocks)
    by_section = {c.section_path: c for c in chunks}
    assert by_section["References"].reference is True
    assert by_section["Method"].reference is False


def test_packing_is_bounded_by_estimated_tokens_not_characters():
    """A CJK character is roughly a token, so by characters a Chinese chunk
    carried four times the tokens of an English one and five hits alone filled
    the tool-output cap."""
    from pipeline.config import cfg

    latin_block = "Chlorophyll absorbs red and blue light. Yes"
    cjk_block = "叶绿素吸收红光和蓝光。"
    assert estimate_tokens(latin_block) == estimate_tokens(cjk_block) == 11

    latin = chunk_content_list([_block(latin_block, 0)] * 60)
    cjk = chunk_content_list([_block(cjk_block, 0)] * 60)

    assert len(latin) > 1
    # The bound is on block text; the "\n\n" joiners add a token per ~2 blocks.
    assert all(estimate_tokens(c.text) <= cfg.chunk_tokens + 20 for c in latin + cjk)
    # Same tokens per block, so the same packing: the CJK text is not 4x denser.
    assert len(latin) == len(cjk)


def test_chart_blocks_are_indexed_like_images():
    """A ``chart`` is a picture block under a different label.

    Some parser routes label recognised data graphics ``chart`` rather than
    ``image``, with the caption under ``chart_caption``. Treating that as an
    unknown type dropped the single most retrievable thing on a lecture slide.
    """
    chunks = chunk_content_list(
        [
            {
                "type": "chart",
                "img_path": "images/plot.jpg",
                "chart_caption": ["Glucose uptake over time"],
                "description": "Line chart, uptake rises then plateaus.",
                "page_idx": 2,
                "bbox": [71, 468, 383, 836],
            }
        ]
    )

    text = "\n".join(c.text for c in chunks)
    assert "[Figure] Glucose uptake over time" in text
    assert "uptake rises then plateaus" in text
    assert chunks[0].regions[0].page == 3
    assert chunks[0].regions[0].bbox == [71.0, 468.0, 383.0, 836.0]


def test_list_blocks_carry_their_items():
    """A ``list`` holds its text in ``list_items``, not ``text``.

    On a paper this block *is* the references section, so reading only ``text``
    silently drops every citation in the document.
    """
    chunks = chunk_content_list(
        [
            _block("References", 0, level=1),
            {
                "type": "list",
                "sub_type": "ref_text",
                "list_items": [
                    "[1] Ba, Kiros, Hinton. Layer normalization. 2016.",
                    "[2] Bahdanau, Cho, Bengio. Neural machine translation. 2014.",
                ],
                "page_idx": 9,
            },
        ]
    )

    text = "\n".join(c.text for c in chunks)
    assert "Layer normalization" in text
    assert "Neural machine translation" in text


def test_header_and_footnote_are_body_text_not_headings():
    """``header`` is the slide title on a deck, so it must not be dropped.

    It must also not become a heading. The parser gives it no ``text_level``, and a
    genuine running header would then overwrite the section path on every page.
    """
    chunks = chunk_content_list(
        [
            _block("Glycolysis", 0, level=1),
            {"type": "header", "text": "Energy Metabolism", "page_idx": 1},
            {
                "type": "page_footnote",
                "text": "Work done at Google Brain.",
                "page_idx": 1,
            },
        ]
    )

    assert [c.section_path for c in chunks] == ["Glycolysis"]
    text = "\n".join(c.text for c in chunks)
    assert "Energy Metabolism" in text
    assert "Work done at Google Brain." in text


def test_page_furniture_is_dropped_but_unknown_types_are_logged(caplog):
    """Silence is the bug: furniture stays silent, novel types must not."""
    with caplog.at_level("WARNING"):
        chunks = chunk_content_list(
            [
                {"type": "page_number", "text": "47", "page_idx": 0},
                {"type": "footer", "text": "31st Conference on NeurIPS", "page_idx": 0},
                {"type": "aside_text", "text": "r00[:0:::02", "page_idx": 0},
                {"type": "sparkline", "text": "something new upstream", "page_idx": 0},
            ]
        )

    assert chunks == []
    assert "NeurIPS" not in caplog.text
    assert "sparkline" in caplog.text


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

    assert "ATP" in tokens
    assert "合成" in tokens and "成酶" in tokens


def test_a_stray_cjk_character_does_not_shatter_the_latin_text():
    """OCR reads a table dash as '一'. That one character used to turn every
    other word of the chunk into single letters in the lexical index."""
    tokens = tokenize_for_search(
        "coral off the island of Hoga.\n15 | 11 | 一\n"
    ).split()

    assert "Hoga." in tokens and "coral" in tokens and "一" in tokens
    assert "H" not in tokens


def test_query_terms_are_or_joined_for_websearch_tsquery():
    terms = search_query_terms("光合作用")

    assert terms.any_of == "光合 or 合作 or 作用"
    assert terms.all_of == "光合 合作 作用"
    # Same tokenizer on both sides, or the index and the query never meet.
    assert set(terms.any_of.split(" or ")) == set(
        tokenize_for_search("光合作用").split()
    )


def test_query_terms_count_a_cjk_run_once_and_keep_latin_apart():
    """The exact tier counts words as typed. '标准差' is one term however many
    bigrams it becomes; the Latin words are handed to Postgres separately so
    it can tell whether any of them is a function word of the chunk's
    language."""
    terms = search_query_terms("the 标准差 of Hoga 计算")

    assert terms.cjk_runs == 2
    assert terms.latin == "the of Hoga"
    assert terms.terms == 5


def test_estimate_tokens_counts_cjk_per_character():
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("光合作用") == 4
    assert estimate_tokens("ATP 合成") == estimate_tokens("ATP ") + estimate_tokens(
        "合成"
    )
    assert clip_to_tokens("光合作用ATP", 4) == "光合作用"
