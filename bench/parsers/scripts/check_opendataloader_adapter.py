"""Small offline check for parser adaptation, page geometry and source probes."""

import argparse
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from compare_opendataloader import convert_odl_slices, odl_content_list
from evaluate_opendataloader import evaluate, geometry, in_order, matches

from pipeline.retrieval.chunking import chunk_content_list


def main() -> None:
    document = {
        "kids": [
            {
                "type": "heading",
                "page number": 1,
                "bounding box": [10, 180, 190, 195],
                "content": "Scores",
                "heading level": 1,
            },
            {
                "type": "table",
                "page number": 1,
                "bounding box": [10, 20, 190, 160],
                "rows": [
                    {
                        "cells": [
                            {"kids": [{"content": "Biology"}]},
                            {"kids": [{"content": "92"}]},
                        ]
                    },
                    {
                        "cells": [
                            {"kids": [{"content": "History"}]},
                            {"kids": [{"content": "88"}]},
                        ]
                    },
                ],
            },
            {
                "type": "image",
                "page number": 2,
                "bounding box": [-10, 0, 210, 200],
                "source": "images/figure.png",
            },
            {
                "type": "list",
                "page number": 1,
                "bounding box": [10, 0, 190, 20],
                "list items": [
                    {
                        "type": "list item",
                        "content": "EVO-PPTX-CANARY-5932",
                        "kids": [
                            {"type": "paragraph", "content": "Introduction"},
                            {
                                "type": "list",
                                "list items": [{"content": "Nested topic"}],
                            },
                        ],
                    }
                ],
            },
        ]
    }
    blocks = odl_content_list(document, [{"width": 200, "height": 200}] * 2)
    assert blocks[1]["bbox"] == [50, 200, 950, 900]
    assert geometry(blocks[1], 2) == "valid"
    assert geometry(blocks[2], 2) == "out_of_bounds"
    chunks = chunk_content_list(blocks)
    assert len(chunks) == 1 and chunks[0].section_path == "Scores"
    assert chunks[0].page_start == 1 and chunks[0].regions[0].page == 1
    assert "Biology | 92\nHistory | 88" in chunks[0].text
    assert "EVO-PPTX-CANARY-5932" in chunks[0].text
    assert "Introduction Nested topic" in chunks[0].text
    toc = odl_content_list(
        {
            "kids": [
                {
                    "type": "toc",
                    "toc items": [
                        {
                            "type": "toc item",
                            "page number": 1,
                            "bounding box": [10, 20, 190, 40],
                            "content": "Chapter one ........ 3",
                        }
                    ],
                }
            ]
        },
        [{"width": 200, "height": 200}],
    )
    assert len(toc) == 1 and toc[0]["text"] == "Chapter one ........ 3"
    assert toc[0]["page_idx"] == 0 and geometry(toc[0], 1) == "valid"
    assert matches("研究結果は４.０４％", ["4.04%"])
    assert in_order(
        "cerebellum\nconvergent evolution\nDNA",
        ["cerebellum", "convergent evolution", "DNA"],
    )
    assert not in_order(
        "cerebellum\nDNA\nconvergent evolution",
        ["cerebellum", "convergent evolution", "DNA"],
    )
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        entry = {
            "id": "probe",
            "kind": "native_or_mixed",
            "lang": "en",
            "pages": 1,
            "source_pages": [0],
            "pdf_sha256": "fixture-hash",
        }
        check = {
            "id": "row",
            "source": "probe",
            "page": 0,
            "row": ["North", "Q1", "12500"],
        }
        record = {
            "config": "mineru-auto",
            "state": "ok",
            "input_sha256": "fixture-hash",
        }
        (root / "result.json").write_text(json.dumps(record))
        (root / "content_list.json").write_text(
            json.dumps(
                [
                    {
                        "type": "text",
                        "text": "North Q1 12500",
                        "page_idx": 0,
                        "bbox": [0, 0, 1000, 1000],
                    }
                ]
            )
        )
        probe = evaluate(root, entry, [{"native_text": "North Q1 12500"}], [check])[
            "probes"
        ][0]
        assert (
            probe["chunk_anchor_presence"]
            and not probe["raw_pass"]
            and not probe["chunk_pass"]
        )
        record["state"] = "error"
        (root / "result.json").write_text(json.dumps(record))
        failed = evaluate(root, entry, [], [check])["probes"]
        assert len(failed) == 1 and not failed[0]["raw_pass"]
        record["state"] = "ok"
        (root / "result.json").write_text(json.dumps(record))
        (root / "content_list.json").write_text(
            json.dumps(
                [
                    {
                        "type": "text",
                        "text": "This page has unrelated content. " * 8,
                        "page_idx": 0,
                        "bbox": [0, 0, 1000, 400],
                    },
                    {
                        "type": "text",
                        "text": "Neighbor-only answer. " * 8,
                        "page_idx": 1,
                        "bbox": [0, 0, 1000, 400],
                    },
                ]
            )
        )
        two_pages = entry | {"pages": 2, "source_pages": [0, 1]}
        page_check = {
            "id": "page",
            "source": "probe",
            "page": 0,
            "anchors": ["Neighbor-only answer"],
        }
        neighbor = evaluate(root, two_pages, [{"native_text": ""}] * 2, [page_check])[
            "probes"
        ][0]
        assert (
            neighbor["chunk_anchor_presence"]
            and not neighbor["raw_pass"]
            and not neighbor["chunk_pass"]
        )
    with tempfile.TemporaryDirectory() as temporary:
        from PIL import Image
        from pypdf import PdfWriter

        root = Path(temporary)
        source = root / "book.pdf"
        writer = PdfWriter()
        for _ in range(27):
            writer.add_blank_page(width=200, height=200)
        with source.open("wb") as stream:
            writer.write(stream)
        target = root / "output"
        target.mkdir()

        def fake_convert(root, part, folder, config, args):
            relative = f"{part['id']}_images/imageFile1.png"
            (folder / relative).parent.mkdir()
            Image.new("RGB", (2, 2), "white").save(folder / relative)
            native = {
                "number of pages": part["pages"],
                "kids": [
                    {
                        "type": "image",
                        "page number": 1,
                        "bounding box": [10, 20, 190, 160],
                        "source": relative,
                    }
                ],
            }
            (folder / f"{part['id']}.json").write_text(json.dumps(native))
            (folder / "output.md").write_text(f"![]({relative})")
            return {}

        with patch("compare_opendataloader.convert", side_effect=fake_convert):
            convert_odl_slices(
                root,
                {"id": "book", "pdf": "book.pdf", "pages": 27},
                target,
                {"engine": "odl"},
                argparse.Namespace(odl_slice_pages=26, slice_workers=4, timeout=600),
                [{"width": 200, "height": 200}] * 27,
            )
        merged = json.loads((target / "content_list.json").read_text())
        assert [block["page_idx"] for block in merged] == [0, 26]
        assert len({block["img_path"] for block in merged}) == 2
        assert all((target / block["img_path"]).is_file() for block in merged)
        assert all(
            block["img_path"] in (target / "output.md").read_text() for block in merged
        )
    print("Adapter, citation geometry, table chunking and probe checks passed.")


if __name__ == "__main__":
    main()
