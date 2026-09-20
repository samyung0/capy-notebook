"""Bounded cached-block experiment; no Java, production writes or KB ingestion.

uv run --frozen python bench/parsers/scripts/experiment_coherent_banner_roles.py --only boj-financial2025
uv run --frozen python bench/parsers/scripts/experiment_coherent_banner_roles.py --self-check
"""

from __future__ import annotations

import argparse
import inspect
import time
from collections import defaultdict
from pathlib import Path

import evaluate_unseen_headings as evaluation
import experiment_prince_headings as frozen
import pymupdf

from pipeline.retrieval import chunking, packing

OUT = evaluation.LOCAL / "coherent-role-experiment"


def span_lines(spans: list[dict]) -> list[list[dict]]:
    lines = []
    for span in spans:
        if (
            not lines
            or abs(lines[-1][0]["origin"][1] - span["origin"][1]) > 0.3 * span["size"]
        ):
            lines.append([])
        lines[-1].append(span)
    return lines


def confirmed_roles(blocks: list[dict], document, evidence: dict) -> tuple[dict, dict]:
    """Confirm recurring bands, then require body-title evidence for variants.

    Outline-protected occurrences are never demoted. Text and boxes stay intact.
    """
    outline = {
        (page - 1, frozen._outline_title(title))
        for _, title, page in document.get_toc()
        if page > 0
    }
    protected = {
        i
        for i in evidence
        if (blocks[i]["page_idx"], frozen._outline_title(blocks[i]["text"])) in outline
    }
    bands = defaultdict(list)
    seeds = defaultdict(list)
    body_titles = defaultdict(list)
    roles, reasons = {}, {}
    for i, spans in evidence.items():
        block = blocks[i]
        box = block["bbox"]
        style = max(spans, key=lambda s: len(s["text"]))
        size = max(s["size"] for s in spans)
        if box[1] >= 75 and box[3] <= 925:
            body_titles[frozen._literal(block["text"])].append(
                (block["page_idx"], size)
            )
        if i in protected or not any(c.isalpha() for c in block["text"]):
            continue
        top = 0 <= box[1] < 65
        bottom = 935 <= box[1] < box[3] <= 1000
        lines = span_lines(spans)
        if not (bottom or top and box[3] <= 100 and len(lines) <= 2):
            continue
        band = (top, round(box[1] / 10), style["font"], round(style["size"], 1))
        bands[band].append(i)
        # A taller variant cannot establish its own running-band evidence.
        if bottom or box[3] <= 65:
            seeds[band, frozen._literal(block["text"])].append(i)
    confirmed_bands = set()
    for (band, _), group in seeds.items():
        if len({blocks[i]["page_idx"] for i in group}) >= 3:
            confirmed_bands.add(band)
            for i in group:
                roles[i] = "running-banner"
                reasons[i] = {"evidence": "repeated literal source band", "band": band}
    for band in confirmed_bands:
        for i in bands[band]:
            if i in roles:
                continue
            spans = evidence[i]
            size = max(s["size"] for s in spans)
            lines = [
                frozen._literal(" ".join(s["text"] for s in line))
                for line in span_lines(spans)
            ]
            if all(
                any(
                    page <= blocks[i]["page_idx"] and body_size > size + 0.5
                    for page, body_size in body_titles.get(line, [])
                )
                for line in lines
            ):
                roles[i] = "running-banner"
                reasons[i] = {
                    "evidence": "confirmed band; each line repeats a larger body heading",
                    "band": band,
                    "lines": lines,
                }
    return roles, reasons


def apply_roles(blocks: list[dict], roles: dict) -> list[dict]:
    result = list(blocks)
    for i, role in roles.items():
        result[i] = {**blocks[i], "_source_role": role}
        result[i].pop("text_level", None)
        if role == "running-banner":
            result[i]["type"] = "discarded"
            result[i]["_heading_boundary_level"] = blocks[i]["text_level"]
    return result


def boundary_packer():
    """Compile isolated copies with only the proposed hook; no module mutation."""
    source = inspect.getsource(chunking.chunk_content_list)
    if (
        "_heading_boundary_level" in source
        and "_heading_boundary_level" in inspect.getsource(packing.pack_blocks)
    ):
        return chunking.chunk_content_list, packing.pack_blocks
    marker = '        page = item.get("page_idx")'
    assert source.count(marker) == 1
    hook = """        boundary = item.get("_heading_boundary_level")
        if type(boundary) is int and boundary > 0:
            if stack and stack[-1][0] >= boundary:
                flush_section()
                while stack and stack[-1][0] >= boundary:
                    stack.pop()
            continue
"""
    scope = dict(vars(chunking))
    exec(  # noqa: S102 - compile an inspected repository function in an isolated scope
        compile(source.replace(marker, hook + marker), "<boundary-chunking>", "exec"),
        scope,
    )
    source = inspect.getsource(packing.pack_blocks)
    old = "prepared = contextualize([b for b in blocks if not _is_furniture(b, furniture)])"
    new = """prepared = contextualize([
        b for b in blocks
        if (type(b.get("_heading_boundary_level")) is int and b["_heading_boundary_level"] > 0)
        or not _is_furniture(b, furniture)
    ])"""
    assert source.count(old) == 1
    source = source.replace(old, new)
    marker = "    for block in prepared:\n"
    hook = """        boundary = block.get("_heading_boundary_level")
        if type(boundary) is int and boundary > 0:
            if stack and stack[-1][0] >= boundary:
                flush()
                while stack and stack[-1][0] >= boundary:
                    stack.pop()
                seed[:] = [
                    {"type": "text", "text_level": level, "text": text}
                    for level, text in stack
                ]
            continue
"""
    assert source.count(marker) == 1
    packing_scope = {**vars(packing), "chunk_content_list": scope["chunk_content_list"]}
    exec(  # noqa: S102 - compile an inspected repository function in an isolated scope
        compile(source.replace(marker, marker + hook), "<boundary-packing>", "exec"),
        packing_scope,
    )
    return scope["chunk_content_list"], packing_scope["pack_blocks"]


def compare_region_paths(old_chunks, new_chunks, removed: set[str]) -> dict:
    def path(chunk):
        return tuple(
            evaluation.canonical(s)
            for s in chunk.section_path.split(" › ")
            if evaluation.canonical(s) not in removed
        )

    old = defaultdict(set)
    for chunk in old_chunks:
        for region in chunk.regions:
            old[region.page, tuple(region.bbox)].add(path(chunk))
    added, shared = [], set()
    for index, chunk in enumerate(new_chunks):
        after = path(chunk)
        for region in chunk.regions:
            key = region.page, tuple(region.bbox)
            if key not in old:
                continue
            shared.add(key)
            if after not in old[key]:
                added.append(
                    {
                        "page": region.page,
                        "bbox": region.bbox,
                        "before": sorted(old[key]),
                        "after": after,
                        "chunk_index": index,
                    }
                )
    return {
        "shared_regions": len(shared),
        "changed_assignments": len(added),
        "changed_regions": len({(r["page"], tuple(r["bbox"])) for r in added}),
        "records": added,
    }


def self_check() -> None:
    blocks = [
        {"type": "text", "text": "Chapter", "text_level": 1},
        {"type": "text", "text": "Chart value", "text_level": 11},
        {"type": "text", "text": "First body"},
        {"type": "text", "text": "Publication", "text_level": 10},
        {"type": "text", "text": "Second body"},
    ]
    after = apply_roles(blocks, {3: "running-banner"})
    assert after[3]["text"] == blocks[3]["text"]
    assert "text_level" not in after[3] and blocks[3]["text_level"] == 10
    chunker, packer = boundary_packer()
    for fn in [chunker, packer]:
        result = fn(after, furniture=frozenset())
        assert [c.section_path for c in result] == ["Chapter › Chart value", "Chapter"]
        assert [c.text for c in result] == ["First body", "Second body"]
    print(
        "Self-check passed: neutral reset retains text and clears only prior deeper scope."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="+", default=["boj-financial2025"])
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    baseline_summary = evaluation.read(
        evaluation.LOCAL / "heading-evaluation/summary.json"
    )
    loaded_hashes = {
        "experiment_sha256": evaluation.sha256(Path(__file__)),
        "chunking_sha256": evaluation.sha256(Path(chunking.__file__)),
        "packing_sha256": evaluation.sha256(Path(packing.__file__)),
    }
    _, candidate_packer = boundary_packer()
    records = []
    for record in baseline_summary["documents"]:
        if ("all" not in args.only and record["id"] not in args.only) or record[
            "status"
        ] != "measured":
            continue
        id = record["id"]
        status = evaluation.read(evaluation.LOCAL / "parse" / id / "status.json")
        attempt = evaluation.LOCAL / "parse" / status["attempt_directory"]
        blocks = evaluation.read(attempt / "baseline/content_list.json")
        pdf = attempt / "baseline/parsed.pdf"
        if not pdf.is_file():
            pdf = evaluation.ROOT / record["source"]["path"]
        with pymupdf.open(pdf) as document:
            started = time.perf_counter()
            evidence = frozen.source_evidence(blocks, document)
            evidence_seconds = time.perf_counter() - started
            toc = document.get_toc(simple=False)
            for row in toc:
                destination = row[3]
                row[3] = {
                    "y": destination["to"].y / document[row[2] - 1].rect.height * 1000
                    if destination.get("kind") == 1
                    and destination.get("to") is not None
                    and row[2] > 0
                    else None
                }
            discarded, anchors, complete = frozen.changes(blocks, toc, evidence)
            root_corrected = frozen.candidate(
                blocks, set(), anchors, "roots_only", complete
            )
            started = time.perf_counter()
            roles, reasons = confirmed_roles(blocks, document, evidence)
            classifier_seconds = time.perf_counter() - started
            new = apply_roles(root_corrected, roles)
        furniture = evaluation.read(attempt / "baseline/refinement.json")["furniture"]
        old_chunks = frozen.pack(blocks, furniture, pdf)
        new_chunks = frozen.retain_headings(
            new, pdf, candidate_packer(new, frozenset(furniture))
        )
        scope_reference = (
            frozen.pack(root_corrected, furniture, pdf)
            if root_corrected != blocks
            else old_chunks
        )
        region_paths = compare_region_paths(
            scope_reference,
            new_chunks,
            {evaluation.canonical(blocks[i]["text"]) for i in roles},
        )
        stage = {
            "anchors": [
                {**blocks[i], "outline_level": level} for i, level in anchors.items()
            ],
            "changes": [{"before": blocks[i], "after": new[i]} for i in roles],
            "toc": toc,
        }
        result = {
            "id": id,
            "source_sha256": record["source"]["sha256"],
            "measured_pdf_sha256": evaluation.sha256(pdf),
            "baseline_blocks_sha256": evaluation.sha256(
                attempt / "baseline/content_list.json"
            ),
            **loaded_hashes,
            "source_evidence_seconds": evidence_seconds,
            "classifier_seconds": classifier_seconds,
            "scope": "cached final baseline blocks replayed through role correction and current packer; no fresh Java or upstream/downstream refinement replay",
            "roots_complete": complete,
            "matched_roots": sum(level == 1 for level in anchors.values()),
            "baseline_chunks": len(old_chunks),
            "candidate_chunks": len(new_chunks),
            "scope_comparison": {
                k: v for k, v in region_paths.items() if k != "records"
            },
            "body": evaluation.compare_body(blocks, new, old_chunks, new_chunks),
            "headings": {
                "baseline": evaluation.heading_metrics(blocks, old_chunks, stage),
                "candidate": evaluation.heading_metrics(new, new_chunks, stage),
            },
            "changes": [
                {"index": i, "before": blocks[i], "after": new[i], "reason": reasons[i]}
                for i in roles
            ],
            "new_roles_beyond_frozen": [
                {
                    "index": i,
                    "page": blocks[i]["page_idx"] + 1,
                    "text": blocks[i]["text"],
                    "role": roles[i],
                }
                for i in roles
                if i not in discarded
            ],
        }
        from dataclasses import asdict

        evaluation.write(OUT / id / "candidate-blocks.json", new)
        evaluation.write(
            OUT / id / "candidate-chunks.json", [asdict(c) for c in new_chunks]
        )
        evaluation.write(OUT / id / "metrics.json", result)
        evaluation.write(OUT / id / "new-region-paths.json", region_paths)
        records.append(
            {
                k: v
                for k, v in result.items()
                if k not in {"changes", "headings", "body"}
            }
        )
        print(
            id,
            "roles",
            len(roles),
            "new roles",
            len(result["new_roles_beyond_frozen"]),
            "chunks",
            len(old_chunks),
            "->",
            len(new_chunks),
            "region path changes",
            region_paths["changed_regions"],
            flush=True,
        )
    evaluation.write(OUT / "summary.json", records)


if __name__ == "__main__":
    main()
