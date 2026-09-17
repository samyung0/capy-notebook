"""Isolated furniture/heading replay. No parser, provider, or database calls.

freeze records exact sources and existing source-reviewed witnesses before run.
run refuses an existing output directory and retains every candidate decision.
Saved content lists are post-table-recovery: this tests downstream behavior,
not a fresh execution of the production pre-table furniture freeze.
"""

from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import re
import sys
import time
import unicodedata
from collections import defaultdict
from dataclasses import asdict
from itertools import pairwise
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "pipeline"), str(ROOT / "parser")]
from pipeline.retrieval import packing
from pipeline.retrieval.chunking import Chunk, Region, clean_inline, estimate_tokens
from pipeline.retrieval.headings import retain_headings

BASE = ROOT / "bench/parsers/reports/local/2026-09-16-odl-textbook-recovery"
FIXTURE = ROOT / "bench/parsers/fixtures/textbook-recovery.json"
FIELDS = ("text", "section_path", "page_start", "page_end")


def read(path):
    if str(path).endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            return json.load(stream)
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write(path, value):
    Path(path).write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def normal(text):
    return " ".join(unicodedata.normalize("NFKC", text).split()).casefold()


def compact(text):
    return normal(text).replace(" ", "")


def title(text):
    return compact(
        re.sub(r"^(?:chapter\s+)?\d+(?:\.\d+)*[.\s]+", "", text, flags=re.IGNORECASE)
    )


def source_spans(page):
    return [
        s
        for g in page.get_text(
            "dict", flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
        )["blocks"]
        for line in g.get("lines", [])
        if abs(line["dir"][0] - 1) < 0.01
        for s in line["spans"]
        if s["text"].strip()
    ]


def inside_spans(block, page, spans):
    box = block.get("bbox", [])
    if len(box) != 4 or page.rotation:
        return []
    area = pymupdf.Rect(
        box[0] * page.rect.width / 1000,
        box[1] * page.rect.height / 1000,
        box[2] * page.rect.width / 1000,
        box[3] * page.rect.height / 1000,
    )
    return [
        s
        for s in spans
        if area.contains(
            pymupdf.Point(
                (s["bbox"][0] + s["bbox"][2]) / 2, (s["bbox"][1] + s["bbox"][3]) / 2
            )
        )
    ]


def exact_source(block, spans):
    return bool(spans) and compact(block.get("text", "")) == compact(
        " ".join(s["text"] for s in spans)
    )


def folio_title(text, page):
    """Only an isolated edge decimal; infer ordinal offset across pages later."""
    match = re.fullmatch(r"(\d{1,4})\s+(.+)", normal(text))
    if match and any(c.isalpha() for c in match[2]):
        return match[2], int(match[1]) - page
    match = re.fullmatch(r"(.+?)\s+(\d{1,4})", normal(text))
    if match and any(c.isalpha() for c in match[1]):
        return match[1], int(match[2]) - page
    return None


def disconnected_labels(block, spans):
    """Proposed diagram role, separated unbold labels on one source baseline.

    It does not name documents, phrases, fonts or expected output labels.
    Numbered sections and unmatched source regions abstain.
    """
    if (
        not exact_source(block, spans)
        or len(spans) < 2
        or re.match(r"^\s*\d+[.\s]", block["text"])
    ):
        return False
    if any(s["flags"] & 16 for s in spans):
        return False
    size = max(s["size"] for s in spans)
    if (
        max(s["origin"][1] for s in spans) - min(s["origin"][1] for s in spans)
        > 0.3 * size
    ):
        return False
    ordered = sorted(spans, key=lambda s: s["bbox"][0])
    return any(b["bbox"][0] - a["bbox"][2] >= 4 * size for a, b in pairwise(ordered))


def classify(blocks, furniture, document):
    """Return decisions only. The run arms choose which decisions to apply."""
    pages = {}
    repeated = defaultdict(list)
    banners = defaultdict(list)
    roles, rejected, protected = [], [], []
    outline = {
        (page - 1, title(text)) for _, text, page in document.get_toc() if page > 0
    }
    for i, block in enumerate(blocks):
        box, page_idx = block.get("bbox", []), block.get("page_idx")
        heading = bool(block.get("text_level"))
        old_drop = packing._is_furniture(block, furniture)
        if not (heading or old_drop) or len(box) != 4 or not isinstance(page_idx, int):
            continue
        page = document[page_idx]
        if page_idx not in pages:
            pages[page_idx] = source_spans(page)
        spans = inside_spans(block, page, pages[page_idx])
        exact = exact_source(block, spans)
        margin = 0 <= box[1] < box[3] <= 65 or 935 <= box[1] < box[3] <= 1000
        if old_drop and margin and exact:
            style = max(spans, key=lambda s: len(s["text"]))
            key = (
                normal(clean_inline(block["text"])),
                box[3] <= 65,
                round(box[1] / 10),
                style["font"],
                round(style["size"]),
            )
            repeated[key].append((i, page_idx))
        if not heading:
            continue
        if (page_idx, title(block.get("text", ""))) in outline:
            protected.append(i)
            continue
        folio = folio_title(block.get("text", ""), page_idx)
        if margin and folio and exact:
            style = max(spans, key=lambda s: len(s["text"]))
            key = (
                *folio,
                box[3] <= 65,
                round(box[1] / 10),
                style["font"],
                round(style["size"]),
            )
            banners[key].append((i, page_idx))
        if margin:
            continue
        if exact and re.match(
            r"^(?:figure|fig\.|table)\s+\d+(?:[.\-]\d+)*(?:[.:\s])",
            normal(block.get("text", "")),
        ):
            roles.append((i, "source-matched-numbered-caption"))
        elif disconnected_labels(block, spans):
            roles.append((i, "source-disconnected-unbold-labels"))
        elif not exact:
            rejected.append({"index": i, "reason": "source-region-text-mismatch"})

    def supported(groups):
        return {
            i
            for group in groups.values()
            if len({page for _, page in group}) >= 3
            for i, _ in group
        }

    return {
        "furniture": sorted(supported(repeated)),
        "banners": sorted(supported(banners)),
        "body_roles": [{"index": i, "reason": reason} for i, reason in roles],
        "source_mismatch_abstentions": rejected,
        "outline_protected": protected,
    }


def apply_arm(blocks, furniture, decisions, arm):
    result = copy.deepcopy(blocks)
    demote = (
        set(decisions["banners"])
        if arm in {"headers", "roles", "combined", "interior_combined"}
        else set()
    )
    if arm in {"roles", "combined", "interior_combined"}:
        demote |= {v["index"] for v in decisions["body_roles"]}
    for i in demote:
        result[i].pop("text_level", None)
    if arm in {"interior_furniture", "interior_combined"}:
        dropped = {
            i
            for i, b in enumerate(blocks)
            if packing._is_furniture(b, furniture) and not interior(b)
        }
        if arm == "interior_combined":
            dropped |= set(decisions["banners"])
    elif arm in {"furniture", "combined"}:
        dropped = set(decisions["furniture"]) | set(
            decisions["banners"] if arm == "combined" else []
        )
    else:
        dropped = {
            i for i, b in enumerate(blocks) if packing._is_furniture(b, furniture)
        }
        if arm in {"headers", "roles"}:
            dropped |= set(decisions["banners"])
    return [b for i, b in enumerate(result) if i not in dropped], dropped, demote


def interior(block):
    box = block.get("bbox", [])
    return (
        len(box) == 4 and 50 <= box[0] < box[2] <= 950 and 100 <= box[1] < box[3] <= 900
    )


def chunks_for(blocks, source):
    return retain_headings(blocks, source, packing.pack_blocks(blocks, frozenset()))


def encode(chunks):
    return [asdict(c) for c in chunks]


def same_saved(chunks, saved):
    return [{k: c[k] for k in FIELDS} for c in chunks] == [
        {k: c[k] for k in FIELDS} for c in saved
    ]


def page_has(chunks, page, text):
    return any(
        c["page_start"]
        and c["page_start"] <= page <= (c["page_end"] or c["page_start"])
        and compact(text) in compact(c["text"])
        for c in chunks
    )


def score(blocks, chunks, baseline, source_checks, decisions, dropped, demoted):
    by_page = defaultdict(list)
    for c in chunks:
        if c["page_start"]:
            for p in range(c["page_start"], (c["page_end"] or c["page_start"]) + 1):
                by_page[p].append(c)
    omissions = []
    for i, b in enumerate(blocks):
        text = b.get("text", "")
        if i in dropped or b.get("text_level") or not text:
            continue
        page = b["page_idx"] + 1
        if page_has(baseline, page, text) and not page_has(chunks, page, text):
            omissions.append(i)
    known_regions = {
        (b["page_idx"] + 1, tuple(b["bbox"]))
        for b in blocks
        if len(b.get("bbox", [])) == 4
    }
    invalid_regions = [
        r
        for c in chunks
        for r in c["regions"]
        if (r["page"], tuple(r["bbox"])) not in known_regions
    ]
    checks = []
    for check in source_checks:
        text, page = check["text"], check["page"]
        paths = [
            c
            for c in chunks
            if normal(text) in [normal(v) for v in c["section_path"].split(" › ")]
        ]
        checks.append(
            {
                **check,
                "literal_body_survives": page_has(chunks, page, text),
                "path_chunks": len(paths),
            }
        )
    heading_labels = {normal(blocks[i]["text"]) for i in decisions["banners"]}
    return {
        "chunks": len(chunks),
        "estimated_body_tokens": sum(estimate_tokens(c["text"]) for c in chunks),
        "removed_blocks": len(dropped),
        "demoted_blocks": len(demoted),
        "remaining_banner_path_chunks": sum(
            bool(
                heading_labels.intersection(
                    normal(v) for v in c["section_path"].split(" › ")
                )
            )
            for c in chunks
        ),
        "previously_visible_body_block_omissions": omissions,
        "invalid_source_regions": invalid_regions,
        "witnesses": checks,
        "outline_protected_unchanged": not bool(
            set(decisions["outline_protected"]) & (dropped | demoted)
        ),
    }


def historical_checks(case, chunks, checks):
    # Preserve the historical rubric, including its alphanumeric root matching.
    # Math/source-fragment checks elsewhere intentionally retain punctuation.
    from experiment_odl_heading_context import judge

    objects = [
        Chunk(
            text=c["text"],
            section_path=c["section_path"],
            page_start=c["page_start"],
            page_end=c["page_end"],
            regions=[Region(r["page"], r["bbox"]) for r in c["regions"]],
        )
        for c in chunks
    ]
    results = []
    for check in checks:
        if check["case"] != case:
            continue
        value = judge(objects, check)
        results.append(
            {
                "id": check["id"],
                "pass": value["pass"],
                "matched_chunks": len(value["hits"]),
            }
        )
    return results


def freeze():
    if FIXTURE.exists():
        raise FileExistsError(FIXTURE)
    manifest = read(ROOT / "bench/rag/fixtures/knowledge-base-pilot-books.json")
    witnesses = read(ROOT / "bench/parsers/fixtures/textbook-structure-witnesses.json")[
        "witnesses"
    ]
    cases = []
    for book in manifest["books"]:
        if sha(ROOT / book["pdf_path"]) != book["sha256"]:
            raise ValueError(f"Source manifest mismatch: {book['id']}")
        directory = ROOT / "data/knowledge-base-pilot/run/books" / book["id"]
        cases.append(
            {
                "id": book["id"],
                "role": "known-textbook-development",
                "source": book["pdf_path"],
                "blocks": str(
                    (directory / "parsed/content_list.json").relative_to(ROOT)
                ),
                "refinement": str(
                    (directory / "parsed/refinement.json").relative_to(ROOT)
                ),
                "saved": str((directory / "corpus.json").relative_to(ROOT)),
                "witnesses": [w for w in witnesses if w["book"] == book["id"]],
            }
        )
    for name in [
        "german-education",
        "attention",
        "japan-migration",
        "taln-complexity",
        "hongkong-figures",
        "nist-shot",
    ]:
        directory = (
            ROOT
            / "bench/parsers/reports/local/2026-09-09-odl-third-pass/refined-final-r1"
            / name
        )
        source = (
            ROOT
            / "bench/rag/fixtures/local/2026-09-09-odl-agentic/pdfs"
            / f"{name}.pdf"
        )
        if not (directory / "content_list.json").exists() or not source.exists():
            raise FileNotFoundError(name)
        if sha(source) != read(directory / "result.json")["parsed_pdf_sha256"]:
            raise ValueError(f"Historical parsed source mismatch: {name}")
        cases.append(
            {
                "id": name,
                "role": "historical-regression-not-new-holdout",
                "source": str(source.relative_to(ROOT)),
                "blocks": str((directory / "content_list.json").relative_to(ROOT)),
                "refinement": str((directory / "refinement.json").relative_to(ROOT)),
                "saved": str((directory / "chunks.json").relative_to(ROOT)),
                "witnesses": [],
            }
        )
    for c in cases:
        c["hashes"] = {
            k: sha(ROOT / c[k]) for k in ["source", "blocks", "refinement", "saved"]
        }
    cases[0]["witnesses"] += [
        {"page": 54, "text": "√", "source_role": "math-fragment"},
        {"page": 193, "text": "SEpˆ =", "source_role": "math-fragment"},
        {"page": 193, "text": "p(1 − p) n", "source_role": "math-fragment"},
        {"page": 193, "text": "= 0.010", "source_role": "math-fragment"},
    ]
    cases[2]["witnesses"] += [
        {"page": 243, "text": "𝑡 =", "source_role": "math-fragment"}
    ]
    write(
        FIXTURE,
        {
            "frozen_before_candidate_run": True,
            "rules": "margin/style recurrence; source-matched folio banners; source-matched numbered captions; unbold same-baseline labels separated by four em; PDF outline protects real headings",
            "cases": cases,
            "historical_checks": read(
                ROOT
                / "bench/parsers/reports/local/2026-09-09-odl-heading-context/checks-v2.json"
            )["checks"],
        },
    )
    print(FIXTURE)


def run(output, arms):
    fixture = read(FIXTURE)
    output.mkdir(parents=True, exist_ok=False)
    write(output / "fixture.json", fixture)
    write(
        output / "run-spec.json",
        {
            "arms": arms,
            "r2_rule": "Original frozen-key deletion stays except whole block boxes inside x50..950 and y100..900. This rule was proposed after r1 exposed reintroduced rotated German side tabs; textbook/historical sources and witnesses remain the original frozen fixture.",
        },
    )
    (output / "runner.py.snapshot").write_bytes(Path(__file__).read_bytes())
    results = []
    for case in fixture["cases"]:
        for key, expected in case["hashes"].items():
            if sha(ROOT / case[key]) != expected:
                raise ValueError(f"Changed {case['id']} {key}")
        blocks = read(ROOT / case["blocks"])
        frozen = frozenset(read(ROOT / case["refinement"])["furniture"])
        saved = read(ROOT / case["saved"])
        if isinstance(saved, dict):
            saved = saved["chunks"]
        source = ROOT / case["source"]
        started = time.perf_counter()
        baseline = encode(
            retain_headings(blocks, source, packing.pack_blocks(blocks, frozen))
        )
        baseline_s = time.perf_counter() - started
        if case["role"] == "known-textbook-development" and not same_saved(
            baseline, saved
        ):
            raise AssertionError(f"Textbook baseline mismatch: {case['id']}")
        started = time.perf_counter()
        with pymupdf.open(source) as document:
            decisions = classify(blocks, frozen, document)
        classify_s = time.perf_counter() - started
        dest = output / case["id"]
        dest.mkdir()
        write(
            dest / "decisions.json",
            {
                **decisions,
                "changed_block_details": [
                    {"index": i, **blocks[i]}
                    for i in sorted(
                        set(decisions["banners"])
                        | {r["index"] for r in decisions["body_roles"]}
                    )
                ],
            },
        )
        arm_results = {}
        for arm in arms:
            started = time.perf_counter()
            revised, dropped, demoted = apply_arm(blocks, frozen, decisions, arm)
            chunks = (
                baseline if arm == "baseline" else encode(chunks_for(revised, source))
            )
            # No surviving block's raw fields, source text, or citation box changes.
            assert [
                {k: v for k, v in b.items() if k != "text_level"} for b in revised
            ] == [
                {k: v for k, v in b.items() if k != "text_level"}
                for i, b in enumerate(blocks)
                if i not in dropped
            ]
            arm_results[arm] = score(
                blocks, chunks, baseline, case["witnesses"], decisions, dropped, demoted
            )
            arm_results[arm].update(
                seconds=time.perf_counter() - started,
                historical_heading_checks=historical_checks(
                    case["id"], chunks, fixture["historical_checks"]
                ),
                exact_current_baseline=chunks == baseline,
            )
            write(dest / f"{arm}-chunks.json", chunks)
        entry = {
            "id": case["id"],
            "role": case["role"],
            "pages": max(b["page_idx"] for b in blocks) + 1,
            "baseline_reproduces_saved_text_paths_pages": same_saved(baseline, saved),
            "baseline_seconds": baseline_s,
            "classification_seconds": classify_s,
            "outline_protected": len(decisions["outline_protected"]),
            "source_mismatch_abstentions": len(
                decisions["source_mismatch_abstentions"]
            ),
            "arms": arm_results,
        }
        results.append(entry)
        write(
            output / "results.json",
            {
                "fixture_sha256": sha(FIXTURE),
                "runner_sha256": sha(__file__),
                "cases": results,
            },
        )
        print(
            json.dumps(
                {
                    "case": case["id"],
                    "baseline_reproduces": entry[
                        "baseline_reproduces_saved_text_paths_pages"
                    ],
                    "classify_s": round(classify_s, 3),
                    "arms": {
                        k: {
                            m: v[m]
                            for m in [
                                "chunks",
                                "demoted_blocks",
                                "removed_blocks",
                                "remaining_banner_path_chunks",
                                "previously_visible_body_block_omissions",
                            ]
                        }
                        for k, v in arm_results.items()
                    },
                },
                ensure_ascii=False,
            ),
            flush=True,
        )


def self_check():
    assert folio_title("50 Chapter 2 Data", 49) == ("chapter 2 data", 1)
    assert folio_title("2.1 Data 42", 49) == ("2.1 data", -7)
    assert folio_title("2.1 Data", 49) is None
    assert folio_title("50", 49) is None
    # Identical body/footer strings must remain independently selectable.
    blocks = [
        {"type": "text", "text": "x = y", "bbox": [20, 950, 50, 970]},
        {"type": "text", "text": "x = y", "bbox": [20, 450, 50, 470]},
    ]
    revised, dropped, _ = apply_arm(
        blocks,
        frozenset({"x = y"}),
        {"furniture": [0], "banners": [], "body_roles": []},
        "furniture",
    )
    assert dropped == {0} and revised == [blocks[1]]
    assert interior({"bbox": [100, 450, 900, 470]})
    assert not interior({"bbox": [967, 119, 993, 366]})
    assert not interior({"bbox": [100, 90, 900, 110]})
    assert not interior({})
    assert compact("x < y") != compact("x > y")
    probe = encode(
        [Chunk(text="probe", section_path="Chapter title ●", page_start=1, page_end=1)]
    )
    check = {
        "case": "probe",
        "id": "bullet-root",
        "page": 1,
        "anchor": "probe",
        "require": ["Chapter title"],
        "forbid": [],
        "root": "Chapter title",
        "role": "control",
    }
    assert historical_checks("probe", probe, [check])[0]["pass"]
    print("11 focused controls passed")


def validate(output):
    """Score citation/excerpt contracts on retained runs; no generation calls."""
    sys.path.insert(0, str(ROOT / "bench/rag/scripts"))
    from knowledge_base_pilot import build_excerpts
    from pipeline.retrieval.citation_regions import resolve
    from pipeline.retrieval.search import Passage

    dest = output / "validation.json"
    if dest.exists():
        raise FileExistsError(dest)
    fixture = read(output / "fixture.json")
    results = []
    for case in fixture["cases"]:
        blocks = read(ROOT / case["blocks"])
        decisions = read(output / case["id"] / "decisions.json")
        arms = {}
        for path in sorted((output / case["id"]).glob("*-chunks.json")):
            arm = path.name.removesuffix("-chunks.json")
            chunks = read(path)
            for i, c in enumerate(chunks):
                c["id"] = f"experiment-{i}"
                for r in c["regions"]:
                    r["space"] = "page-1000-topleft"
            excerpts = build_excerpts(copy.deepcopy(chunks), case["id"], [])
            assert [i for e in excerpts for i in e["chunk_ids"]] == [
                c["id"] for c in chunks
            ]
            assert "\n\n".join(e["text"] for e in excerpts) == "\n\n".join(
                c["text"] for c in chunks
            )
            assert [r for e in excerpts for r in e["regions"]] == [
                r for c in chunks for r in c["regions"]
            ]
            witnesses = []
            selected = set()
            for w in case["witnesses"]:
                indices = [
                    i
                    for i, b in enumerate(blocks)
                    if b.get("page_idx") == w["page"] - 1
                    and normal(b.get("text", "")) == normal(w["text"])
                ]
                hits = [
                    i
                    for i, c in enumerate(chunks)
                    if compact(w["text"]) in compact(c["text"])
                    and any(
                        r["page"] == w["page"] and r["bbox"] == blocks[j]["bbox"]
                        for r in c["regions"]
                        for j in indices
                    )
                ]
                selected.update(hits)
                witnesses.append(
                    {
                        **w,
                        "source_block_indices": indices,
                        "body_and_exact_source_region_survive": bool(hits),
                        "chunk_indices": hits,
                    }
                )
            for check in fixture["historical_checks"]:
                if check["case"] == case["id"]:
                    selected.update(
                        i
                        for i, c in enumerate(chunks)
                        if c["page_start"]
                        and c["page_start"]
                        <= check["page"]
                        <= (c["page_end"] or c["page_start"])
                        and compact(check["anchor"]) in compact(c["text"])
                    )
            passages = [
                Passage(
                    chunk_id=chunks[i]["id"],
                    file_id=case["id"],
                    file_name=Path(case["source"]).name,
                    chunk_idx=i,
                    section_path=chunks[i]["section_path"],
                    text=chunks[i]["text"],
                    page_start=chunks[i]["page_start"],
                    page_end=chunks[i]["page_end"],
                    regions=chunks[i]["regions"],
                )
                for i in sorted(selected)
            ]
            resolved = resolve(ROOT / case["source"], passages)
            citation_checks = []
            for p, regions in zip(passages, resolved):
                citation = p.as_citation()
                valid = bool(regions) and all(
                    r["space"] == "page-1000-topleft"
                    and p.page_start <= r["page"] <= p.page_end
                    and all(0 <= v <= 1000 for v in r["bbox"])
                    for r in regions
                )
                assert (
                    citation["snippet"] == p.text[:400]
                    and citation["chunkId"] == p.chunk_id
                    and valid
                )
                citation_checks.append(
                    {
                        "chunk_index": p.chunk_idx,
                        "region_changed": regions != p.regions,
                        "valid": valid,
                    }
                )
            indexed = lambda b, chunks=chunks: any(
                c["page_start"]
                and c["page_start"]
                <= b["page_idx"] + 1
                <= (c["page_end"] or c["page_start"])
                and compact(b["text"]) in compact(c["text"] + " " + c["section_path"])
                for c in chunks
            )
            arms[arm] = {
                "excerpts": len(excerpts),
                "exact_excerpt_membership_text_regions": True,
                "source_occurrence_witnesses": witnesses,
                "citations": citation_checks,
                "outline_headings_visible": [
                    i for i in decisions["outline_protected"] if indexed(blocks[i])
                ],
            }
        results.append({"id": case["id"], "arms": arms})
        print(
            case["id"],
            "excerpt and source-occurrence/citation checks complete",
            flush=True,
        )
    write(
        dest,
        {
            "validator_sha256": sha(__file__),
            "scope": "Actual build_excerpts with no figure records; actual Passage/resolve with full chosen chunk text. Bounding/page integrity and literal evidence, not mathematical correctness, semantic header accuracy or model quality.",
            "cases": results,
        },
    )


def heading_controls(output):
    """Replay a second historical bundle as a separate retention lane.

    Selected after investigating the historical scorer's punctuation mismatch.
    Frozen furniture from each source's third-pass bundle stays constant in both
    arms; no recurrence is recomputed on the saved post-table block list.
    """
    output.mkdir(parents=True, exist_ok=False)
    lane = ROOT / "bench/parsers/reports/local/2026-09-09-odl-heading-context"
    sources = read(lane / "sources.json")
    fixture = read(FIXTURE)
    cases = []
    for original in fixture["cases"]:
        name = original["id"]
        if name not in sources:
            continue
        source = Path(sources[name]["pdf"])
        blocks = lane / "run-final" / name / "structure/content_list.json"
        if (
            sha(source) != sources[name]["pdf_sha256"]
            or sha(source) != original["hashes"]["source"]
        ):
            raise ValueError(name)
        cases.append(
            {
                "id": name,
                "source": str(source),
                "blocks": str(blocks),
                "refinement": str(ROOT / original["refinement"]),
                "hashes": {
                    "source": sha(source),
                    "blocks": sha(blocks),
                    "refinement": original["hashes"]["refinement"],
                },
            }
        )
    write(
        output / "frozen-inputs.json",
        {
            "cases": cases,
            "rules_already_frozen_in": str(BASE / "r2/runner.py.snapshot"),
            "selection": "Historical source-reviewed structure arm; selection after r2, no candidate rule changes.",
        },
    )
    results = []
    for case in cases:
        blocks = read(case["blocks"])
        furniture = frozenset(read(case["refinement"])["furniture"])
        with pymupdf.open(case["source"]) as document:
            decisions = classify(blocks, furniture, document)
        arms = {}
        baseline = encode(
            retain_headings(
                blocks, Path(case["source"]), packing.pack_blocks(blocks, furniture)
            )
        )
        for arm in ["baseline", "roles", "interior_combined"]:
            revised, _, _ = apply_arm(blocks, furniture, decisions, arm)
            chunks = (
                baseline
                if arm == "baseline"
                else encode(chunks_for(revised, Path(case["source"])))
            )
            arms[arm] = {
                "chunks": len(chunks),
                "checks": historical_checks(
                    case["id"], chunks, fixture["historical_checks"]
                ),
                "exact_current_baseline": chunks == baseline,
            }
            write(output / f"{case['id']}-{arm}-chunks.json", chunks)
        results.append({"id": case["id"], "arms": arms, "decisions": decisions})
    write(output / "results.json", {"runner_sha256": sha(__file__), "cases": results})
    print(
        json.dumps(
            [{"id": c["id"], "arms": c["arms"]} for c in results], ensure_ascii=False
        ),
        flush=True,
    )


def rescore(output):
    """Retain original run receipts; correct only historical rubric reuse."""
    dest = output / "historical-rescore.json"
    if dest.exists():
        raise FileExistsError(dest)
    fixture = read(FIXTURE)
    results = []
    for case in fixture["cases"]:
        directory = output / case["id"]
        paths = (
            directory.glob("*-chunks.json")
            if directory.exists()
            else output.glob(f"{case['id']}-*-chunks.json")
        )
        arms = {}
        for path in sorted(paths):
            arms[path.name] = historical_checks(
                case["id"], read(path), fixture["historical_checks"]
            )
        if arms:
            results.append({"id": case["id"], "arms": arms})
    write(
        dest,
        {
            "correction": "R1/R2 original historical-only root comparator retained punctuation whereas the historical judge strips punctuation. German chapter roots ending in a printed bullet were falsely marked failures. Call the original judge, preserving its full all-overlap-copies checks. Candidate decisions, all chunks and punctuation-preserving math/body-role scores are unchanged.",
            "historical_judge_sha256": sha(
                ROOT / "bench/parsers/scripts/experiment_odl_heading_context.py"
            ),
            "cases": results,
        },
    )
    print(
        json.dumps(
            [
                {
                    "id": c["id"],
                    "pass_counts": {
                        a: [sum(v["pass"] for v in rows), len(rows)]
                        for a, rows in c["arms"].items()
                    },
                }
                for c in results
            ]
        )
    )


def occurrences(output):
    """Verify restored literal text against its own input occurrence geometry."""
    rows = []
    for case in read(FIXTURE)["cases"]:
        blocks = read(ROOT / case["blocks"])
        furniture = frozenset(read(ROOT / case["refinement"])["furniture"])
        old = {i for i, b in enumerate(blocks) if packing._is_furniture(b, furniture)}
        eligible = {i for i in old if interior(blocks[i])}
        chunks = read(output / case["id"] / "interior_combined-chunks.json")
        locations = defaultdict(list)
        for c in chunks:
            for r in c["regions"]:
                locations[(r["page"], tuple(r["bbox"]))].append(c)
        survived = {
            i
            for i in eligible
            if any(
                compact(clean_inline(blocks[i]["text"])) in compact(c["text"])
                for c in locations[
                    (blocks[i]["page_idx"] + 1, tuple(blocks[i]["bbox"]))
                ]
            )
        }
        rows.append(
            {
                "id": case["id"],
                "original_drops": len(old),
                "restoration_eligible_occurrences": len(eligible),
                "eligible_with_literal_and_region": len(survived),
                "eligible_not_literal_visible": sorted(eligible - survived),
            }
        )
    dest = output / "restoration-occurrence-check.json"
    if dest.exists():
        raise FileExistsError(dest)
    write(
        dest,
        {
            "method": "Punctuation-preserving NFKC whitespace-free cleaned literal block text plus that occurrence's own original page/bbox; not semantic accuracy.",
            "cases": rows,
        },
    )
    print(json.dumps(rows))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode",
        choices=[
            "freeze",
            "run",
            "check",
            "validate",
            "heading-controls",
            "rescore",
            "occurrences",
        ],
    )
    parser.add_argument("--output", type=Path, default=BASE / "r1")
    parser.add_argument(
        "--arms",
        nargs="+",
        default=["baseline", "furniture", "headers", "roles", "combined"],
    )
    args = parser.parse_args()
    if args.mode == "freeze":
        freeze()
    elif args.mode == "check":
        self_check()
    elif args.mode == "validate":
        validate(args.output)
    elif args.mode == "heading-controls":
        heading_controls(args.output)
    elif args.mode == "rescore":
        rescore(args.output)
    elif args.mode == "occurrences":
        occurrences(args.output)
    else:
        run(args.output, args.arms)
