"""Local native-ODL improvement experiment. Never changes production helpers.

Freeze source labels before parsing, run fresh native Java, then replay candidate
repairs and the actual production packer. Raw receipts remain under reports/local.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import subprocess
import sys
import time
import unicodedata
from collections import Counter
from dataclasses import asdict
from itertools import pairwise
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "parser"), str(ROOT / "pipeline")]
import pymupdf
from odl import (
    columns,
    context,
    exponents,
    fonts,
    furniture,
    geometry,
    headings,
    hidden,
    lists,
    order,
    source_text,
    styles,
    tables,
)
from odl.adapter import odl_content_list
from odl.table_html import Table

from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks

LOCAL = ROOT / "bench/parsers/reports/local/2026-09-13-odl-native-improvements"
CORPUS = ROOT / "bench/rag/fixtures/local/2026-09-09-odl-agentic"
SELECTED = [
    "rag__zh__zh-CN",
    "rag__fr__camembert-taln",
    "rag__zh__mixed_zh_en",
    "ccl-feedback",
    "bert",
    "resnet",
    "hongkong-figures",
]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2))


def read(path):
    return json.loads(Path(path).read_text())


def normal(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(text))).casefold()


def checks():
    """Transcribed from the rendered sources before fresh candidate parsing."""
    return [
        {
            "id": "zh-dataset",
            "source": "rag__zh__zh-CN",
            "page": 7,
            "box": [308, 658, 548, 760],
            "headers": ["数据子集", "所含类别", "训练集", "测试集", "验证集"],
            "rows": [
                ["THU1", "体育、财经、房产", "15000", "3000", "1500"],
                ["THU2", "家居、教育、科技", "15000", "3000", "1500"],
                ["THU3", "时尚、时政、游戏", "15000", "3000", "1500"],
                ["THU4", "娱乐", "5000", "1000", "500"],
            ],
        },
        {
            "id": "zh-results",
            "source": "rag__zh__zh-CN",
            "page": 9,
            "box": [308, 80, 548, 296],
            "headers": ["模型", "A1", "A2", "A3", "A4", "d"],
            "rows": [
                ["MTL", "99.0", "95.3", "95.9", "95.7", "1.1"],
                ["FT", "98.9", "61.2", "37.1", "27.4", "34.5"],
                ["LwF", "98.9", "76.8", "53.0", "43.8", "23.6"],
                ["EWC", "98.9", "82.5", "54.6", "51.8", "18.5"],
                ["R-Walk", "98.9", "84.9", "81.2", "73.5", "9.3"],
                ["MAS", "98.9", "86.4", "82.3", "60.1", "14.8"],
                ["AdapterParallel", "98.7", "72.0", "71.6", "69.4", "10.2"],
                ["AdapterStack", "98.7", "55.6", "50.7", "33.3", "28.9"],
                ["AdapterFusion", "98.7", "52.7", "36.2", "26.5", "34.9"],
                ["L-SCL", "98.9", "87.9", "89.2", "86.3", "4.3"],
                ["CIL-LLM", "96.0", "94.9", "93.5", "92.6", "1.2"],
            ],
        },
        {
            "id": "fr-corpus",
            "source": "rag__fr__camembert-taln",
            "page": 4,
            "box": [47, 287, 289, 357],
            "headers": ["Corpus", "Taille", "#tokens", "#docs", "5%", "50%", "95%"],
            "rows": [
                ["Wikipedia", "4Go", "990M", "1.4M", "102", "363", "2530"],
                ["CCNet", "135Go", "31.9B", "33.1M", "128", "414", "2869"],
                ["OSCAR", "138Go", "32.7B", "59.4M", "28", "201", "1946"],
            ],
        },
        {
            "id": "fr-genres",
            "source": "rag__fr__camembert-taln",
            "page": 4,
            "box": [315, 265, 530, 380],
            "headers": ["Corpus", "#tokens", "#phrases", "Genres"],
            "rows": [
                ["GSD", "389,363", "16,342", "Blogs, News Reviews, Wiki"],
                ["Sequoia", "68,615", "3,099", "Medical, News Non-fiction, Wiki"],
                ["Spoken", "34,972", "2,786", "Spoken"],
                ["ParTUT", "27,658", "1,020", "Legal, News, Wikis"],
                ["FTB", "350,930", "27,658", "News"],
            ],
        },
        {
            "id": "fr-downstream",
            "source": "rag__fr__camembert-taln",
            "page": 6,
            "box": [47, 61, 549, 199],
            "headers": [
                "DATASET",
                "SIZE",
                "GSD / UPOS",
                "GSD / LAS",
                "SEQUOIA / UPOS",
                "SEQUOIA / LAS",
                "SPOKEN / UPOS",
                "SPOKEN / LAS",
                "PARTUT / UPOS",
                "PARTUT / LAS",
                "AVERAGE / UPOS",
                "AVERAGE / LAS",
                "NER / F1",
                "NLI / ACC.",
            ],
            "groups": ["Fine-tuning"] * 4 + ["Plongements lexicaux"] * 4,
            "rows": [
                [
                    "Wiki",
                    "4GB",
                    "98.28",
                    "93.04",
                    "98.74",
                    "92.71",
                    "96.61",
                    "79.61",
                    "96.20",
                    "89.67",
                    "97.45",
                    "88.75",
                    "89.86",
                    "78.32",
                ],
                [
                    "CCNET",
                    "4GB",
                    "98.34",
                    "93.43",
                    "98.95",
                    "93.67",
                    "96.92",
                    "82.09",
                    "96.50",
                    "90.98",
                    "97.67",
                    "90.04",
                    "90.46",
                    "82.06",
                ],
                [
                    "OSCAR",
                    "4GB",
                    "98.35",
                    "93.55",
                    "98.97",
                    "93.70",
                    "96.94",
                    "81.97",
                    "96.58",
                    "90.28",
                    "97.71",
                    "89.87",
                    "90.65",
                    "81.88",
                ],
                [
                    "OSCAR",
                    "138GB",
                    "98.39",
                    "93.80",
                    "98.99",
                    "94.00",
                    "97.17",
                    "81.18",
                    "96.63",
                    "90.56",
                    "97.79",
                    "89.88",
                    "91.55",
                    "81.55",
                ],
                [
                    "Wiki",
                    "4GB",
                    "98.09",
                    "92.31",
                    "98.74",
                    "93.55",
                    "96.24",
                    "78.91",
                    "95.78",
                    "89.79",
                    "97.21",
                    "88.64",
                    "91.23",
                    "-",
                ],
                [
                    "CCNET",
                    "4GB",
                    "98.22",
                    "92.93",
                    "99.12",
                    "94.65",
                    "97.17",
                    "82.61",
                    "96.74",
                    "89.95",
                    "97.81",
                    "90.04",
                    "92.30",
                    "-",
                ],
                [
                    "OSCAR",
                    "4GB",
                    "98.21",
                    "92.77",
                    "99.12",
                    "94.92",
                    "97.20",
                    "82.47",
                    "96.74",
                    "90.05",
                    "97.82",
                    "90.05",
                    "91.90",
                    "-",
                ],
                [
                    "OSCAR",
                    "138GB",
                    "98.18",
                    "92.77",
                    "99.14",
                    "94.24",
                    "97.26",
                    "82.44",
                    "96.52",
                    "89.89",
                    "97.77",
                    "89.84",
                    "91.83",
                    "-",
                ],
            ],
        },
        {
            "id": "fr-design",
            "source": "rag__fr__camembert-taln",
            "page": 7,
            "box": [98, 100, 498, 276],
            "headers": [
                "CORPUS",
                "MASKING",
                "ARCH.",
                "#PARAM.",
                "#STEPS",
                "UPOS",
                "LAS",
                "NER",
                "XNLI",
            ],
            "groups": ["Stratégie de masking"] * 2
            + ["Taille du modèle"] * 2
            + ["Données d’entraînement"] * 2
            + ["Nombre de steps"] * 2,
            "rows": [
                [
                    "CCNET",
                    "subword",
                    "BASE",
                    "110M",
                    "100K",
                    "97.78",
                    "89.80",
                    "91.55",
                    "81.04",
                ],
                [
                    "CCNET",
                    "whole word",
                    "BASE",
                    "110M",
                    "100K",
                    "97.79",
                    "89.88",
                    "91.44",
                    "81.55",
                ],
                [
                    "CCNET",
                    "whole word",
                    "BASE",
                    "110M",
                    "100K",
                    "97.67",
                    "89.46",
                    "90.13",
                    "82.22",
                ],
                [
                    "CCNET",
                    "whole word",
                    "LARGE",
                    "335M",
                    "100k",
                    "97.74",
                    "89.82",
                    "92.47",
                    "85.73",
                ],
                [
                    "CCNET",
                    "whole word",
                    "BASE",
                    "110M",
                    "100K",
                    "97.67",
                    "89.46",
                    "90.13",
                    "82.22",
                ],
                [
                    "OSCAR",
                    "whole word",
                    "BASE",
                    "110M",
                    "100K",
                    "97.79",
                    "89.88",
                    "91.44",
                    "81.55",
                ],
                [
                    "CCNET",
                    "whole word",
                    "BASE",
                    "110M",
                    "100k",
                    "98.04",
                    "89.85",
                    "90.13",
                    "82.20",
                ],
                [
                    "CCNET",
                    "whole word",
                    "BASE",
                    "110M",
                    "500k",
                    "97.95",
                    "90.12",
                    "91.30",
                    "83.04",
                ],
            ],
        },
    ]


def freeze():
    path = LOCAL / "frozen.json"
    if path.exists():
        raise ValueError("freeze already exists")
    inventory = read(CORPUS / "sources.json")["sources"]
    sources = []
    for identity in SELECTED:
        entry = next(x for x in inventory if x["source_id"] == identity)
        pdf = CORPUS / entry["pdf"]
        assert sha(pdf) == entry["pdf_sha256"]
        sources.append(
            {
                "id": identity,
                "pdf": str(pdf),
                "sha256": sha(pdf),
                "pages": entry["pages"],
            }
        )
    result = {
        "frozen_at": time.time(),
        "scope": "Known-source development/diagnostic candidates. No untouched holdout claim.",
        "sources": sources,
        "tables": checks(),
        "overprint_labels": [
            "香港城市大學",
            "商學院",
            "工商管理博士學位",
            "目錄",
            "文獻綜述",
        ],
        "script_sha256": sha(__file__),
    }
    save(path, result)
    for check in result["tables"]:
        p = next(x["pdf"] for x in sources if x["id"] == check["source"])
        with pymupdf.open(p) as doc:
            doc[check["page"] - 1].get_pixmap(
                clip=pymupdf.Rect(check["box"]), matrix=pymupdf.Matrix(2, 2)
            ).save(LOCAL / f"source-{check['id']}.png")
    print(
        {
            "frozen": str(path),
            "tables": len(checks()),
            "rows": sum(len(c["rows"]) for c in checks()),
        }
    )


def native_pipeline(native, pdf):
    with pymupdf.open(pdf) as doc:
        styled, _ = styles.annotate(doc, native)
        blocks = odl_content_list(
            styled, [{"width": p.rect.width, "height": p.rect.height} for p in doc]
        )
        raw = copy.deepcopy(blocks)
        blocks, reordered = order.repair(blocks)
        blocks = order.move_rotated_labels(blocks, reordered, pdf)
        blocks = order.split_continuations(blocks, reordered, pdf)
        eligible = {p.number for p in doc if hidden.source_facts(p)["eligible"]}
        blocks = hidden.recover_hidden_ocr_order(blocks, eligible)
        blocks = headings.rewrite(blocks, headings.source_headings(blocks, pdf))
        blocks = context.contextualize(blocks)
        blocks, _ = tables.mark_footer_tables(blocks, native)
        blocks, _ = lists.repair_list_geometry(blocks, native, pdf)
        before_glyphs = copy.deepcopy(blocks)
        blocks, _ = source_text.repair_text(blocks, pdf, paragraphs=True)
        blocks, _ = lists.repair_lists(blocks, pdf)
        blocks, _ = exponents.restore_exponents(blocks, pdf)
        blocks, _ = columns.repair_columns(blocks, pdf)
        repeated = furniture.repeated_across_pages(blocks)
        before_tables = copy.deepcopy(blocks)
        blocks, _ = tables.recover_tables(blocks, doc)
    return {
        "raw": raw,
        "before_glyphs": before_glyphs,
        "before_tables": before_tables,
        "baseline": blocks,
        "furniture": sorted(repeated),
    }


def pack(blocks, pdf, repeated):
    chunks = retain_headings(blocks, pdf, pack_blocks(blocks, frozenset(repeated)))
    return [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks]


def parse(args):
    frozen = read(LOCAL / args.manifest)
    output = LOCAL / args.run
    output.mkdir(exist_ok=False)
    save(
        output / "run.json",
        {
            "script_sha256": sha(__file__),
            "frozen_sha256": sha(LOCAL / args.manifest),
            "jar_sha256": sha(args.jar),
            "java": str(args.java),
            "native_sources": {
                str(p.relative_to(ROOT)): sha(p)
                for p in (ROOT / "parser/odl").glob("*.py")
            },
        },
    )
    for row in frozen["sources"]:
        if args.sources and row["id"] not in args.sources:
            continue
        assert sha(row["pdf"]) == row["sha256"]
        target = output / row["id"]
        target.mkdir()
        repaired, count = fonts.repair_fonts(Path(row["pdf"]).read_bytes())
        pdf = target / "source.pdf"
        pdf.write_bytes(repaired)
        native_dir = target / "native"
        native_dir.mkdir()
        command = [
            str(args.java),
            "-Xmx2g",
            "-Djava.awt.headless=true",
            "-jar",
            str(args.jar),
            str(pdf),
            "--output-dir",
            str(native_dir),
            "--format",
            "json,markdown",
            "--image-output",
            "external",
            "--markdown-with-html",
            "--threads",
            "1",
            "--include-header-footer",
        ]
        if args.table_method == "cluster":
            command += ["--table-method", "cluster"]
        began = time.monotonic()
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=120,
            check=False,
        )
        (target / "java.log").write_text(result.stdout)
        if result.returncode:
            raise RuntimeError(result.stdout[-2000:])
        native = read(native_dir / "source.json")
        stages = native_pipeline(native, pdf)
        for name, blocks in stages.items():
            save(target / (name + ".json"), blocks)
        chunks = pack(stages["baseline"], pdf, stages["furniture"])
        save(target / "chunks.json", chunks)
        print(
            json.dumps(
                {
                    "id": row["id"],
                    "seconds": round(time.monotonic() - began, 3),
                    "font_repairs": count,
                    "native_tables": sum(
                        b.get("type") == "table" for b in stages["raw"]
                    ),
                    "chunks": len(chunks),
                }
            ),
            flush=True,
        )


def all_rules(page, region):
    rules = []
    for drawing in page.get_drawings():
        for item in drawing["items"]:
            if item[0] == "re" and item[1].height <= 2:
                rect = item[1]
                r = [rect.x0, (rect.y0 + rect.y1) / 2, rect.x1]
                if (
                    region[0] - 2 <= r[0]
                    and r[2] <= region[2] + 2
                    and region[1] - 2 <= r[1] <= region[3] + 2
                ):
                    rules.append(r)
            if item[0] == "l":
                a, b = item[1:3]
                if abs(a.y - b.y) < 1 and abs(a.x - b.x) > 5:
                    r = [min(a.x, b.x), (a.y + b.y) / 2, max(a.x, b.x)]
                    if (
                        region[0] - 2 <= r[0]
                        and r[2] <= region[2] + 2
                        and region[1] - 2 <= r[1] <= region[3] + 2
                    ):
                        rules.append(r)
    return rules


def numeric_cell(text):
    return bool(re.fullmatch(r"[+−-]?(?:\d[\d,. ]*)(?:[A-Za-z%]+)?|[-−]", text.strip()))


def mixed_grid(page, region, lines):
    """Infer leaf columns from repeated complete mixed-text rows, then attach
    source header tiers and explicit ruled italic row groups without numeric-only stubs."""
    import statistics

    area = pymupdf.Rect(region)
    inside = [l for l in lines if tables._in_body(l, region)]
    dots = [l for l in inside if re.fullmatch(r"[.·…\s]{5,}", l["text"])]
    inside = [l for l in inside if l not in dots]
    groups = geometry.row_groups(inside)
    supported = [
        g
        for g in groups
        if len(g) >= 3
        and not numeric_cell(g[0]["text"])
        and sum(numeric_cell(l["text"]) for l in g) >= 2
    ]
    if len(supported) < 2:
        raise ValueError("fewer than two mixed data rows")
    width = Counter(len(g) for g in supported).most_common(1)[0][0]
    dense = [g for g in supported if len(g) == width]
    if len(dense) < 2:
        raise ValueError("no repeated complete row template")
    centers = [statistics.median(g[i]["x"] for g in dense) for i in range(width)]
    cuts = [area.x0]
    for i in range(width - 1):
        right = max(g[i]["bbox"][2] for g in dense)
        left = min(g[i + 1]["bbox"][0] for g in dense)
        if right >= left:
            raise ValueError("source columns overlap")
        cuts.append((right + left) / 2)
    cuts.append(area.x1)
    rules = all_rules(page, region)
    full = [r for r in rules if r[2] - r[0] > area.width * 0.9]
    first_dense = min(statistics.median(l["y"] for l in g) for g in dense)
    header_end = max((r[1] for r in full if r[1] < first_dense - 2), default=region[1])
    anchors = [
        g
        for g in supported
        if g[0]["y"] > header_end
        and cuts[0] <= g[0]["x"] <= cuts[1]
        and len(g) <= width
        and all(
            sum(cuts[i] <= l["x"] <= cuts[i + 1] for l in g) <= 1 for i in range(width)
        )
    ]
    if len(anchors) < 2:
        raise ValueError("no stable mixed rows")
    ys = [statistics.median(l["y"] for l in g) for g in anchors]
    header = [l for l in inside if l["y"] < header_end]
    if not header:
        raise ValueError("no source header above ruled body")
    header_groups = geometry.row_groups(header)
    top = header_groups[0]
    # A complete top tier owns every leaf column. Partial top tiers require
    # explicit short underline rules, otherwise only a single leaf is assigned.
    full_top = (
        len(top) > 1
        and abs(top[0]["x"] - centers[0]) < max(10, (cuts[1] - cuts[0]) * 0.5)
        and abs(top[-1]["x"] - centers[-1]) < max(10, (cuts[-1] - cuts[-2]))
    )
    parts = [[] for _ in centers]
    header_scopes = []
    for line in sorted(header, key=lambda l: (l["y"], l["x"])):
        under = [
            r
            for r in rules
            if 0 < r[1] - line["y"] < line["size"] * 1.8
            and r[0] - 2 <= line["x"] <= r[2] + 2
            and r[2] - r[0] < area.width * 0.9
        ]
        if under:
            rule = min(under, key=lambda r: r[1] - line["y"])
            selected = [
                i for i, x in enumerate(centers) if rule[0] - 2 <= x <= rule[2] + 2
            ]
        elif full_top and line in top:
            selected = [
                i
                for i, x in enumerate(centers)
                if min(range(len(top)), key=lambda j: abs(top[j]["x"] - x))
                == top.index(line)
            ]
        else:
            overlapping = [
                i
                for i, x in enumerate(centers)
                if line["bbox"][0] <= x <= line["bbox"][2]
            ]
            parent = [
                (h, s)
                for h, s in header_scopes
                if len(s) > 1 and h["y"] < line["y"] - 2 and abs(h["x"] - line["x"]) < 2
            ]
            if parent:
                selected = max(parent, key=lambda item: item[0]["y"])[1]
            else:
                if len(overlapping) > 1:
                    raise ValueError("joined header crosses unresolved leaf columns")
                selected = [
                    min(range(width), key=lambda i: abs(centers[i] - line["x"]))
                ]
        header_scopes.append((line, selected))
        for i in selected:
            parts[i].append(line["text"])
    headers = [" / ".join(dict.fromkeys(v)) for v in parts]
    if any(not h for h in headers):
        raise ValueError("unlabelled leaf column")
    if len({normal(h) for h in headers}) != len(headers):
        raise ValueError("duplicate header paths need parent scope")
    # Explicit italic group labels must follow a full-width separator. Other
    # loose text is assigned to a leaf cell only when it fits that column.
    raw = page.get_text("dict", flags=geometry.TEXT_FLAGS)
    spans = [s for b in raw["blocks"] for l in b.get("lines", []) for s in l["spans"]]

    def italic(line):
        matched = [
            s
            for s in spans
            if abs(s["origin"][1] - line["y"]) < 2
            and (pymupdf.Rect(s["bbox"]) & pymupdf.Rect(line["bbox"])).get_area() > 0
            and s["text"].strip()
        ]
        # A ruled group label may start italic and include a roman term.
        # Preserve that complete source phrase rather than splitting its scope.
        return bool(matched) and bool(
            min(matched, key=lambda s: s["bbox"][0])["flags"] & 2
        )

    group_lines = []
    for g in groups:
        if g[0]["y"] <= header_end or g in anchors or len(g) != 1:
            continue
        l = g[0]
        if (
            l["bbox"][0] < cuts[min(2, width - 1)]
            and italic(l)
            and any(0 < l["y"] - r[1] < l["size"] * 3 for r in full)
        ):
            group_lines.append(l)
    rows = [[""] * width for _ in anchors]
    assignments = []
    for line in inside:
        if line["y"] < header_end or line in group_lines:
            continue
        r = min(range(len(ys)), key=lambda i: abs(line["y"] - ys[i]))
        c = min(range(width), key=lambda i: abs(line["x"] - centers[i]))
        # Long source labels may vary within a stub, but no cell may cross the
        # inferred whitespace gutter into its neighbour.
        if line["bbox"][0] < cuts[c] - 2 or line["bbox"][2] > cuts[c + 1] + 2:
            raise ValueError("cell crosses source gutter: " + line["text"])
        rows[r][c] += (" " if rows[r][c] else "") + line["text"]
        assignments.append(
            {
                "row": r,
                "column": c,
                "text": line["text"],
                "bbox": line["bbox"],
                "bold": line["bold"],
            }
        )
    if any(any(not cell for cell in row) for row in rows):
        raise ValueError("incomplete mixed row")
    scopes = []
    for y in ys:
        preceding = [l for l in group_lines if l["y"] < y]
        scopes.append(max(preceding, key=lambda l: l["y"])["text"] if preceding else "")
    if group_lines:
        if any(not s for s in scopes):
            raise ValueError("unscoped source group")
        headers = ["Source group", *headers]
        rows = [[s, *r] for s, r in zip(scopes, rows)]
    return {
        "headers": headers,
        "rows": rows,
        "region": region,
        "assignments": assignments,
        "source_groups": scopes,
        "decorative_separators": len(dots),
    }


def block_text(block):
    if block.get("type") == "table":
        p = Table()
        p.feed(block.get("table_body", ""))
        p.close()
        h, r = p.grid()
        return " ".join(h + [x for row in r for x in row])
    return block.get("text", "\n".join(block.get("list_items", [])))


def semantic_chars(text):
    return Counter(normal(re.sub(r"[.·…]{5,}", "", text)).replace("^", ""))


def substitute_grid(blocks, grid, page):
    from odl.table_html import table_html

    region = pymupdf.Rect(grid["region"])
    area = pymupdf.Rect(
        region.x0 / page.rect.width * 1000,
        region.y0 / page.rect.height * 1000,
        region.x1 / page.rect.width * 1000,
        region.y1 / page.rect.height * 1000,
    )
    whole = []
    for i, b in enumerate(blocks):
        if b.get("page_idx") != page.number or not b.get("bbox"):
            continue
        box = pymupdf.Rect(b["bbox"])
        if (box & area).get_area() <= 0:
            continue
        if b.get("type") in {"table", "footer", "header"}:
            raise ValueError("existing native/recovered table or furniture protected")
        if not pymupdf.Rect(
            area.x0 - 6, area.y0 - 6, area.x1 + 6, area.y1 + 6
        ).contains(box):
            raise ValueError("body partial overlap")
        whole.append(i)
    if not whole:
        raise ValueError("no native body blocks")
    meaning = " ".join(grid["headers"] + [x for row in grid["rows"] for x in row])
    native = " ".join(block_text(blocks[i]) for i in whole)
    missing = semantic_chars(native) - semantic_chars(meaning)
    if missing:
        raise ValueError("native text not conserved: " + str(missing))
    source = source_text.source_text(
        page.get_text("rawdict", flags=source_text.RAW_FLAGS)["blocks"], region
    )
    missing_source = semantic_chars(source) - semantic_chars(meaning)
    if missing_source:
        raise ValueError("source text not conserved: " + str(missing_source))
    captions = []
    for b in blocks:
        if (
            b.get("page_idx") != page.number
            or b.get("type") != "text"
            or not b.get("bbox")
        ):
            continue
        if not context.CAPTION.match(b.get("text", "").strip()):
            continue
        box = pymupdf.Rect(b["bbox"])
        gap = min(abs(box.y1 - area.y0), abs(box.y0 - area.y1))
        if gap < 85 and min(box.x1, area.x1) > max(box.x0, area.x0):
            captions.append((gap, b))
    title = min(captions, key=lambda x: x[0])[1]["text"] if captions else ""
    block = {
        "type": "table",
        "page_idx": page.number,
        "bbox": list(area),
        "table_body": table_html(grid["headers"], grid["rows"]),
        "_native_table_supported": True,
        "_native_table_title": title,
        "table_caption": [title] if title else [],
        "_experiment": "mixed-source-grid",
    }
    result = [copy.deepcopy(b) for i, b in enumerate(blocks) if i not in whole]
    result.insert(min(whole), block)
    return result, {
        "native_blocks": whole,
        "source_conserved": True,
        "native_conserved": True,
        "grid": grid,
        "title": title,
    }


def experiment_tables(blocks, pdf, extractor="mixed", region_mode="rules", identity=""):
    result = copy.deepcopy(blocks)
    receipts = []
    with pymupdf.open(pdf) as d:
        for page in d:
            rules = geometry.horizontal_rules(page)
            if len(rules) < 2:
                continue
            ls = tables._Lazy(lambda page=page: geometry.text_lines(page))
            if region_mode == "model":
                prediction = (
                    ROOT
                    / "bench/parsers/reports/local/2026-09-13-odl-layout-ocr/run-r1"
                    / f"{identity}-p{page.number + 1:02}.json"
                )
                if not prediction.exists():
                    continue
                regions = [
                    [
                        r["bbox"][0] * page.rect.width / 1000,
                        r["bbox"][1] * page.rect.height / 1000,
                        r["bbox"][2] * page.rect.width / 1000,
                        r["bbox"][3] * page.rect.height / 1000,
                    ]
                    for r in read(prediction)["regions"]
                    if r["class"] == "table"
                ]
            else:
                regions = tables.select_regions(rules, ls)
            for region in regions:
                rec = {"page": page.number + 1, "region": region}
                try:
                    if extractor == "current":
                        table = tables.recover(page, region, ls())["table"]
                        grid = {**table, "region": region}
                    else:
                        grid = mixed_grid(page, region, ls())
                    rec["extracted"] = True
                    result, proof = substitute_grid(result, grid, page)
                    rec.update(accepted=True, proof=proof)
                except ValueError as e:
                    rec.update(accepted=False, reason=str(e))
                receipts.append(rec)
    return result, receipts


def double_overprints(blocks, pdf):
    revised = copy.deepcopy(blocks)
    receipts = []
    with pymupdf.open(pdf) as d:
        for i, b in enumerate(revised):
            if b.get("type") not in {"text", "list"} or not b.get("bbox"):
                continue
            text = block_text(b)
            if not re.search(r"(\S)\1", text):
                continue
            page = d[b["page_idx"]]
            area = source_text.rect_for(b, page)
            source = source_text.source_text(
                page.get_text("rawdict", flags=source_text.RAW_FLAGS)["blocks"], area
            )
            value, removed = source_text.delete_supported_repeats(
                text, source, Counter(text)
            )
            record = {"index": i, "page": page.number + 1, "accepted": False}
            if not removed:
                record["reason"] = "no exact deletion-only source correspondence"
                receipts.append(record)
                continue
            duplicates = source_text.overprints(page.get_texttrace(), area)
            if any(n > duplicates[c] for c, n in removed.items()):
                record["reason"] = "insufficient painted duplicates"
                receipts.append(record)
                continue
            if b["type"] == "list":
                try:
                    b["list_items"] = lists.restore_items(b["list_items"], value)
                except ValueError as e:
                    record["reason"] = str(e)
                    receipts.append(record)
                    continue
            else:
                b["text"] = value
            record.update(
                accepted=True, removed=dict(removed), before=text, after=value
            )
            receipts.append(record)
    return revised, receipts


def evaluate_table(blocks, chunks, check):
    result = {
        "id": check["id"],
        "row_inventory": 0,
        "associated_rows": 0,
        "grouped_rows": 0,
        "rows": len(check["rows"]),
        "columns": len(check["headers"]),
    }
    relevant = [
        c
        for c in chunks
        if c.get("page_start") is not None
        and c["page_start"] <= check["page"] <= c["page_end"]
    ]
    for row in check["rows"]:
        if any(
            normal(" ".join(row)) in normal(c["text"].replace("|", " "))
            for c in relevant
        ):
            result["row_inventory"] += 1
    for b in blocks:
        if b.get("type") != "table" or b.get("page_idx") != check["page"] - 1:
            continue
        p = Table()
        p.feed(b["table_body"])
        p.close()
        headers, rows = p.grid()
        matching = []
        for h in check["headers"]:
            indices = [
                i
                for i, x in enumerate(headers)
                if all(
                    normal(part) in [normal(tier) for tier in x.split(" / ")]
                    for part in h.split(" / ")
                )
            ]
            matching.append(indices[0] if len(indices) == 1 else None)
        if any(i is None for i in matching) or len(set(matching)) != len(matching):
            continue
        for i, expected in enumerate(check["rows"]):
            # Prefer the exact source group when two groups contain the same row.
            ordered = sorted(
                rows,
                key=lambda row: (
                    not any(
                        normal(check.get("groups", [""] * len(check["rows"]))[i])
                        in normal(v)
                        for v in row
                    )
                ),
            )
            for actual in ordered:
                if all(
                    normal(actual[j]) == normal(value)
                    for j, value in zip(matching, expected)
                ):
                    # Exact header/value row must also survive together in an actual chunk.
                    line = " | ".join(actual)
                    if not any(
                        normal(line) in normal(c["text"])
                        and all(normal(h) in normal(c["text"]) for h in headers)
                        for c in relevant
                    ):
                        continue
                    result["associated_rows"] += 1
                    if not check.get("groups") or any(
                        normal(check["groups"][i]) in normal(v) for v in actual
                    ):
                        result["grouped_rows"] += 1
                    break
    return result


def missing_retained_text(blocks, before, after):
    old = normal(" ".join(c["text"] for c in before))
    new = normal(" ".join(c["text"] for c in after))
    return [
        b
        for b in blocks
        if not b.get("_experiment")
        and b.get("type") in {"text", "list"}
        and (value := normal(block_text(b)))
        and value in old
        and value not in new
    ]


def improve(args):
    frozen = read(LOCAL / args.manifest)
    source = LOCAL / args.baseline
    dest = LOCAL / args.output
    dest.mkdir(exist_ok=False)
    Path(dest / "script-snapshot.py").write_text(Path(__file__).read_text())
    summaries = []
    for doc in frozen["sources"]:
        folder = source / doc["id"]
        if not folder.exists():
            continue
        pdf = folder / "source.pdf"
        baseline = read(folder / "baseline.json")
        repeated = read(folder / "furniture.json")
        changed, doubles = double_overprints(baseline, pdf)
        started = time.monotonic()
        result, receipts = experiment_tables(
            changed, pdf, args.extractor, args.region_mode, doc["id"]
        )
        basechunks = read(folder / "chunks.json")
        chunks = pack(result, pdf, repeated)
        if args.conserve_prose:
            while lost := missing_retained_text(result, basechunks, chunks):
                pages = {b["page_idx"] for b in lost}
                accepted = [
                    r for r in receipts if r["accepted"] and r["page"] - 1 in pages
                ]
                if not accepted:
                    raise ValueError(
                        "cannot attribute packing loss to a same-page repair"
                    )
                for receipt in accepted:
                    receipt.update(
                        accepted=False,
                        reason="final chunks lose retained prose",
                        lost_prose=[block_text(b) for b in lost],
                    )
                restored = []
                seen = set()
                for block in result:
                    page = block.get("page_idx")
                    if page not in pages:
                        restored.append(block)
                    elif page not in seen:
                        restored.extend(b for b in changed if b.get("page_idx") == page)
                        seen.add(page)
                result = restored
                chunks = pack(result, pdf, repeated)
        table_seconds = time.monotonic() - started
        output = dest / doc["id"]
        output.mkdir()
        save(output / "content_list.json", result)
        save(output / "chunks.json", chunks)
        save(output / "table-receipts.json", receipts)
        save(output / "double-receipts.json", doubles)
        gold = [c for c in frozen["tables"] if c["source"] == doc["id"]]
        summary = {
            "id": doc["id"],
            "baseline": [evaluate_table(baseline, basechunks, c) for c in gold],
            "candidate": [evaluate_table(result, chunks, c) for c in gold],
            "accepted_tables": sum(r["accepted"] for r in receipts),
            "table_rejections": dict(
                Counter(r["reason"] for r in receipts if not r["accepted"])
            ),
            "double_repairs": sum(r["accepted"] for r in doubles),
            "unchanged": baseline == result,
            "chunks_before": len(basechunks),
            "chunks_after": len(chunks),
            "table_seconds": table_seconds,
        }
        summaries.append(summary)
        print(json.dumps(summary, ensure_ascii=False), flush=True)
    save(
        dest / "summary.json",
        {
            "frozen_sha256": sha(LOCAL / args.manifest),
            "script_sha256": sha(__file__),
            "baseline": args.baseline,
            "extractor": args.extractor,
            "region_mode": args.region_mode,
            "conserve_prose": args.conserve_prose,
            "evaluation": "Exact header-tier matching; duplicate source rows prefer matching explicit group. v2",
            "sources": summaries,
        },
    )


def audit(args):
    """Check final row order and conservation independently of admission scores."""
    frozen = read(LOCAL / args.manifest)
    result = []
    for source in frozen["sources"]:
        folder = LOCAL / args.output / source["id"]
        if not folder.exists():
            continue
        baseline = read(LOCAL / args.baseline / source["id"] / "baseline.json")
        blocks = read(folder / "content_list.json")
        chunks = read(folder / "chunks.json")
        native = [b for b in blocks if not b.get("_experiment")]
        baseline_tables = [b for b in baseline if b.get("type") == "table"]
        assert [b for b in native if b.get("type") == "table"] == baseline_tables
        remaining = iter(baseline)
        assert all(any(b == original for original in remaining) for b in native)
        receipts = read(folder / "table-receipts.json")
        accepted = [r for r in receipts if r["accepted"]]
        tables_audit = []
        for receipt in accepted:
            grid = receipt["proof"]["grid"]
            page = receipt["page"]
            text = normal(
                "\n".join(
                    c["text"]
                    for c in chunks
                    if c["page_start"] <= page <= c["page_end"]
                )
            )
            positions = [text.find(normal(" | ".join(row))) for row in grid["rows"]]
            assert all(p >= 0 for p in positions)
            assert all(a < b for a, b in pairwise(positions))
            table_positions = []
            for row in range(len(grid["rows"])):
                a = [x["bbox"][1] for x in grid["assignments"] if x["row"] == row]
                table_positions.append(min(a))
            assert all(a < b for a, b in pairwise(table_positions))
            tables_audit.append(
                {
                    "page": page,
                    "rows": len(positions),
                    "source_and_chunk_row_order": True,
                }
            )
        # Every baseline block outside the replaced body boxes must survive.
        with pymupdf.open(LOCAL / args.baseline / source["id"] / "source.pdf") as pdf:
            outside = []
            for block in baseline:
                overlaps = False
                if block.get("bbox"):
                    p = pdf[block["page_idx"]]
                    box = pymupdf.Rect(block["bbox"])
                    for r in accepted:
                        if r["page"] != p.number + 1:
                            continue
                        a = r["region"]
                        area = pymupdf.Rect(
                            a[0] / p.rect.width * 1000,
                            a[1] / p.rect.height * 1000,
                            a[2] / p.rect.width * 1000,
                            a[3] / p.rect.height * 1000,
                        )
                        overlaps |= (box & area).get_area() > 0
                if not overlaps:
                    outside.append(block)
            assert not (
                Counter(json.dumps(b, sort_keys=True) for b in outside)
                - Counter(json.dumps(b, sort_keys=True) for b in native)
            )
        basechunks = read(LOCAL / args.baseline / source["id"] / "chunks.json")
        losses = semantic_chars(
            " ".join(c["text"] for c in basechunks)
        ) - semantic_chars(" ".join(c["text"] for c in chunks))
        result.append(
            {
                "source": source["id"],
                "unchanged": baseline == blocks,
                "protected_native_tables": len(baseline_tables),
                "outside_body_blocks_preserved": len(outside),
                "surviving_native_order_preserved": True,
                "tables": tables_audit,
                "normalized_chunk_character_deficit": dict(losses),
                "retained_native_text_missing_from_chunks": [
                    block_text(b)
                    for b in missing_retained_text(native, basechunks, chunks)
                ],
            }
        )
    save(LOCAL / args.output / "audit.json", result)
    print(json.dumps(result, ensure_ascii=False), flush=True)


def pack_ablation(args):
    from pipeline.config import cfg
    from pipeline.retrieval.chunking import estimate_tokens

    if not hasattr(cfg, "chunk_min_tokens"):
        raise RuntimeError(
            "The min-token ablation requires the archived v8 chunker; v9 preserves unique short prose."
        )

    destination = LOCAL / args.output
    destination.mkdir(exist_ok=False)
    frozen = read(LOCAL / args.manifest)
    original = cfg.chunk_min_tokens
    summaries = []
    try:
        for source in frozen["sources"]:
            base = LOCAL / args.baseline / source["id"]
            candidate = LOCAL / args.candidate / source["id"]
            if not candidate.exists():
                continue
            output = destination / source["id"]
            output.mkdir()
            baseline = read(base / "baseline.json")
            blocks = read(candidate / "content_list.json")
            repeated = read(base / "furniture.json")
            row = {"source": source["id"]}
            for label, content in [("baseline", baseline), ("candidate", blocks)]:
                cfg.chunk_min_tokens = original
                default = pack(content, base / "source.pdf", repeated)
                cfg.chunk_min_tokens = 0
                zero = pack(content, base / "source.pdf", repeated)
                cfg.chunk_min_tokens = original
                save(output / (label + "-min0-chunks.json"), zero)

                def stats(chunks):
                    return {
                        "chunks": len(chunks),
                        "under_original_minimum": sum(
                            estimate_tokens(c["text"]) < original for c in chunks
                        ),
                        "exact_duplicate_chunk_texts": len(chunks)
                        - len({normal(c["text"]) for c in chunks}),
                    }

                row[label] = {
                    "default": stats(default),
                    "min0": stats(zero),
                    "added_texts": [
                        c["text"]
                        for c in zero
                        if c["text"] not in {v["text"] for v in default}
                    ],
                    "source_checks": [
                        evaluate_table(content, zero, c)
                        for c in frozen["tables"]
                        if c["source"] == source["id"]
                    ],
                }
                if label == "candidate":
                    row["lost_retained_prose_min0"] = [
                        block_text(b)
                        for b in missing_retained_text(
                            blocks, read(base / "chunks.json"), zero
                        )
                    ]
            summaries.append(row)
    finally:
        cfg.chunk_min_tokens = original
    save(
        destination / "summary.json",
        {
            "original_chunk_min_tokens": original,
            "restored_chunk_min_tokens": cfg.chunk_min_tokens,
            "sources": summaries,
            "script_sha256": sha(__file__),
        },
    )
    print(json.dumps(summaries, ensure_ascii=False), flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="mode", required=True)
    sub.add_parser("freeze")
    q = sub.add_parser("parse")
    q.add_argument("--java", type=Path, required=True)
    q.add_argument("--jar", type=Path, required=True)
    q.add_argument("--run", required=True)
    q.add_argument("--table-method", choices=["cluster", "default"], default="cluster")
    q.add_argument("--sources", nargs="+")
    q.add_argument("--manifest", default="frozen.json")
    q = sub.add_parser("improve")
    q.add_argument("--baseline", required=True)
    q.add_argument("--output", required=True)
    q.add_argument("--manifest", default="frozen.json")
    q.add_argument("--extractor", choices=["mixed", "current"], default="mixed")
    q.add_argument("--region-mode", choices=["rules", "model"], default="rules")
    q.add_argument("--conserve-prose", action="store_true")
    q = sub.add_parser("audit")
    q.add_argument("--baseline", required=True)
    q.add_argument("--output", required=True)
    q.add_argument("--manifest", default="frozen.json")
    q = sub.add_parser("pack-ablation")
    q.add_argument("--baseline", required=True)
    q.add_argument("--candidate", required=True)
    q.add_argument("--output", required=True)
    q.add_argument("--manifest", default="frozen.json")
    args = p.parse_args()
    if args.mode == "freeze":
        freeze()
    elif args.mode == "parse":
        parse(args)
    elif args.mode == "improve":
        improve(args)
    elif args.mode == "audit":
        audit(args)
    elif args.mode == "pack-ablation":
        pack_ablation(args)


if __name__ == "__main__":
    main()
