"""Evaluate completed fresh paired parses, retaining source-bound comparisons.

uv run --frozen python bench/parsers/scripts/evaluate_unseen_headings.py --self-check
uv run --frozen python bench/parsers/scripts/evaluate_unseen_headings.py

Running/failed parses remain unmeasured. This never edits the frozen candidate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
from pipeline.retrieval.chunking import (
    CHUNKER_VERSION,
    _as_list,
    clean_inline,
    flatten_table,
)
from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks

LOCAL = ROOT / "bench/parsers/reports/local/2026-09-20-unseen-pdf-validation"
PAYLOAD_FIELDS = (
    "text",
    "latex",
    "list_items",
    "table_body",
    "table_caption",
    "table_footnote",
    "image_caption",
    "chart_caption",
    "image_footnote",
    "chart_footnote",
)


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1 << 20), b""):
            digest.update(data)
    return digest.hexdigest()


def canonical(text: str) -> str:
    # Case, punctuation, digits and math symbols remain meaningful.
    return "".join(unicodedata.normalize("NFKC", clean_inline(text)).split())


def payload(block: dict) -> str:
    values = {key: block[key] for key in PAYLOAD_FIELDS if key in block}
    return json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def region_key(block: dict) -> tuple:
    return block.get("page_idx", -1) + 1, tuple(block.get("bbox", []))


def identity(block: dict) -> tuple:
    return (*region_key(block), block.get("type"), payload(block))


def body_text(block: dict) -> str:
    if block.get("text_level"):
        return ""
    kind = block.get("type")
    if kind in {"text", "header", "page_footnote"}:
        return str(block.get("text") or "")
    if kind == "equation":
        return str(block.get("text") or block.get("latex") or "")
    if kind in {"list", "reference_list"}:
        return "\n".join(_as_list(block.get("list_items")))
    if kind == "table":
        return "\n".join(
            [
                " ".join(_as_list(block.get("table_caption"))),
                flatten_table(str(block.get("table_body") or "")),
                " ".join(_as_list(block.get("table_footnote"))),
            ]
        )
    if kind in {"image", "chart"}:
        return " ".join(
            _as_list(block.get("image_caption"))
            + _as_list(block.get("chart_caption"))
            + _as_list(block.get("image_footnote"))
            + _as_list(block.get("chart_footnote"))
        )
    return ""


def source_summary(block: dict) -> dict:
    return {
        "page": block.get("page_idx", -1) + 1,
        "type": block.get("type"),
        "bbox": block.get("bbox"),
        "text": body_text(block) or block.get("text", ""),
        "payload_sha256": hashlib.sha256(payload(block).encode()).hexdigest(),
    }


def review_queue(source: dict, stage: dict, reviews: dict) -> list[dict]:
    """Every candidate heading change needs source adjudication, even outside TOC."""
    result = []
    allowed = {
        "source_supported_furniture",
        "source_supported_outline_root",
        "real_heading_regression",
        "uncertain",
    }
    for change in stage["changes"]:
        before, after = change["before"], change["after"]
        key = json.dumps(
            [source["sha256"], before, after], sort_keys=True, ensure_ascii=False
        )
        review_id = hashlib.sha256(key.encode()).hexdigest()
        review = reviews.get(review_id)
        if review and (
            review.get("decision") not in allowed or not review.get("evidence")
        ):
            raise ValueError(f"Invalid source adjudication for {review_id}")
        result.append(
            {
                "review_id": review_id,
                "page": before["page_idx"] + 1,
                "bbox": before.get("bbox"),
                "text": before.get("text"),
                "before_type": before.get("type"),
                "after_type": after.get("type"),
                "before_level": before.get("text_level"),
                "after_level": after.get("text_level"),
                "proposed_source_role": after.get("_source_role"),
                "decision": review["decision"] if review else "unreviewed",
                "evidence": review["evidence"] if review else None,
            }
        )
    return result


def chunk_lookup(chunks: list) -> tuple[dict, dict, list[str]]:
    regions, pages = defaultdict(list), defaultdict(list)
    normalized = [canonical(c.text) for c in chunks]
    for index, chunk in enumerate(chunks):
        for region in chunk.regions:
            regions[region.page, tuple(region.bbox)].append(index)
        for page in {r.page for r in chunk.regions}:
            pages[page].append(index)
    return regions, pages, normalized


def covered(block: dict, lookup: tuple) -> bool:
    wanted = canonical(body_text(block))
    regions, _, texts = lookup
    indices = regions.get(region_key(block), [])
    return bool(wanted) and (
        any(wanted in texts[i] for i in indices)
        or wanted in "".join(texts[i] for i in indices)
    )


def compare_body(
    before: list[dict], after: list[dict], baseline: list, candidate: list
) -> dict:
    original = [b for b in before if canonical(body_text(b))]
    revised = [b for b in after if canonical(body_text(b))]
    old = Counter(identity(b) for b in original)
    new = Counter(identity(b) for b in revised)
    baseline_lookup, candidate_lookup = chunk_lookup(baseline), chunk_lookup(candidate)
    missing = []
    for block in original:
        if not covered(block, baseline_lookup) or covered(block, candidate_lookup):
            continue
        wanted = canonical(body_text(block))
        _, pages, texts = candidate_lookup
        page_indices = pages.get(block.get("page_idx", -1) + 1, [])
        on_page = any(wanted in texts[i] for i in page_indices)
        missing.append(
            {
                **source_summary(block),
                "candidate_has_same_payload_and_location": bool(new[identity(block)]),
                "literal_exists_elsewhere_on_cited_page": on_page,
                "classification": "citation_geometry_or_grouping_changed"
                if on_page
                else "newly_missing_source_bound_text",
            }
        )
    removed = old - new
    seen = set()
    removed_records = []
    for block in original:
        key = identity(block)
        if removed[key] and key not in seen:
            removed_records.append(
                {**source_summary(block), "count_removed": removed[key]}
            )
            seen.add(key)
    return {
        "baseline_body_units": len(original),
        "candidate_body_units": len(revised),
        "baseline_source_bound_literal_covered": sum(
            covered(b, baseline_lookup) for b in original
        ),
        "candidate_source_bound_literal_covered": sum(
            covered(b, candidate_lookup) for b in original
        ),
        "body_payloads_removed_or_reshaped": sum(removed.values()),
        "body_payloads_added_or_reshaped": sum((new - old).values()),
        "removed_or_reshaped_payloads": removed_records,
        "newly_missing_covered_units": missing,
        "newly_missing_source_bound_text_count": sum(
            x["classification"] == "newly_missing_source_bound_text" for x in missing
        ),
        "citation_geometry_or_grouping_changed_count": sum(
            x["classification"] == "citation_geometry_or_grouping_changed"
            for x in missing
        ),
    }


def heading_metrics(blocks: list[dict], chunks: list, stage: dict) -> dict:
    _, by_page, _ = chunk_lookup(chunks)
    locations = defaultdict(list)
    for index, block in enumerate(blocks):
        if len(block.get("bbox", [])) == 4:
            locations[region_key(block)].append(index)
    anchors = []
    roots = []
    for anchor in stage["anchors"]:
        matches = [
            i
            for i in locations[region_key(anchor)]
            if canonical(blocks[i].get("text", "")) == canonical(anchor["text"])
        ]
        page_chunks = by_page.get(anchor["page_idx"] + 1, [])
        readable = any(
            canonical(anchor["text"]) in canonical(chunks[i].indexed_text())
            for i in page_chunks
        )
        heading = any(blocks[i].get("text_level") for i in matches)
        root = anchor["outline_level"] == 1
        anchors.append(
            {
                "page": anchor["page_idx"] + 1,
                "bbox": anchor["bbox"],
                "text": anchor["text"],
                "outline_level": anchor["outline_level"],
                "is_heading": bool(heading),
                "readable_on_page": readable,
                "final_block_matches": len(matches),
                "final_levels": [blocks[i].get("text_level") for i in matches],
            }
        )
        if root and len(matches) == 1:
            roots.append((matches[0], canonical(anchor["text"]).casefold()))
    roots.sort()
    root_names = Counter(name for _, name in roots)
    root_positions = {name: i for i, name in roots if root_names[name] == 1}
    outline_pages = Counter(
        row[2] for row in stage["toc"] if row[0] == 1 and row[2] > 0
    )
    matched_root_pages = defaultdict(list)
    for index, name in roots:
        matched_root_pages[blocks[index]["page_idx"] + 1].append((index, name))
    measured_contexts = 0
    unmeasured_contexts = 0
    stale, unexpected = [], []
    for index, chunk in enumerate(chunks):
        positions = [
            i for r in chunk.regions for i in locations.get((r.page, tuple(r.bbox)), [])
        ]
        if not positions or not chunk.section_path:
            continue
        first_index = min(positions)
        first_page = blocks[first_index]["page_idx"] + 1
        prior_root_pages = [page for page in outline_pages if page <= first_page]
        if not prior_root_pages:
            continue
        root_page = max(prior_root_pages)
        current = matched_root_pages[root_page]
        # Never extend a matched Preface across an unmatched chapter interval.
        if (
            outline_pages[root_page] != 1
            or len(current) != 1
            or current[0][0] > first_index
        ):
            unmeasured_contexts += 1
            continue
        active_index, expected = current[0]
        measured_contexts += 1
        parts = [canonical(p).casefold() for p in chunk.section_path.split(" › ")]
        summary = {
            "chunk": index,
            "page_start": chunk.page_start,
            "section_path": chunk.section_path,
            "expected_root": blocks[active_index]["text"],
        }
        # A link-index subheading may repeat an earlier chapter title legitimately.
        ancestor_parts = parts[: parts.index(expected)] if expected in parts else parts
        if any(
            root_positions.get(part, active_index) < active_index
            for part in ancestor_parts
        ):
            stale.append(summary)
        prose = any(
            blocks[i].get("type") in {"text", "header", "page_footnote"}
            and not blocks[i].get("text_level")
            for i in positions
        )
        native_table = any(blocks[i].get("_native_table_supported") for i in positions)
        if prose and not native_table and parts[0] != expected:
            unexpected.append(summary)
    banner_changes = [
        x
        for x in stage["changes"]
        if x["after"].get("type") == "discarded" and x["before"].get("text_level")
    ]
    banner_names = {canonical(x["before"]["text"]).casefold() for x in banner_changes}
    banners = [
        i
        for i, chunk in enumerate(chunks)
        if any(
            canonical(p).casefold() in banner_names
            for p in chunk.section_path.split(" › ")
        )
    ]
    return {
        "anchors": anchors,
        "matched_anchor_count": len(anchors),
        "anchors_still_headings": sum(a["is_heading"] for a in anchors),
        "anchors_readable_on_page": sum(a["readable_on_page"] for a in anchors),
        "mapped_final_roots": len(roots),
        "measured_outline_root_context_chunks": measured_contexts,
        "unmeasured_outline_root_context_chunks": unmeasured_contexts,
        "stale_root_ancestor_chunks": len(stale),
        "stale_root_examples": stale[:20],
        "unexpected_root_prefix_prose_chunks": len(unexpected),
        "unexpected_root_examples": unexpected[:20],
        "candidate_banner_breadcrumb_chunks": len(banners),
    }


def evaluate(source: dict, attempt: Path, output: Path, code_hashes: dict) -> dict:
    pdf = ROOT / source["path"]
    stage_path = attempt / "candidate/heading-stage.json"
    paths = [pdf, attempt / "completed.json", stage_path]
    for arm in ["baseline", "candidate"]:
        paths.extend(
            attempt / arm / name
            for name in ["content_list.json", "refinement.json", "parse.json"]
        )
        if (attempt / arm / "parsed.pdf").is_file():
            paths.append(attempt / arm / "parsed.pdf")
    inputs = {str(p.relative_to(ROOT)): sha256(p) for p in paths}
    if sha256(pdf) != source["sha256"]:
        raise ValueError(f"Source changed: {source['id']}")
    fingerprint = hashlib.sha256(
        json.dumps([inputs, code_hashes], sort_keys=True).encode()
    ).hexdigest()[:16]
    output = output / f"run-{fingerprint}"
    cached = output / "metrics.json"
    if cached.is_file():
        old = read(cached)
        if old["input_sha256"] == inputs and old["code_sha256"] == code_hashes:
            return old
    stage = read(stage_path)
    blocks, chunks = {}, {}
    for arm in ["baseline", "candidate"]:
        folder = attempt / arm
        receipt = read(folder / "parse.json")
        if (
            receipt["source_sha256"] != source["sha256"]
            or sha256(folder / "content_list.json") != receipt["content_list_sha256"]
        ):
            raise ValueError(f"Parse receipt mismatch: {source['id']} {arm}")
        blocks[arm] = read(folder / "content_list.json")
        furniture = read(folder / "refinement.json")["furniture"]
        measured = folder / "parsed.pdf" if (folder / "parsed.pdf").is_file() else pdf
        if sha256(measured) != receipt["measured_pdf_sha256"]:
            raise ValueError(f"Measured PDF mismatch: {source['id']} {arm}")
        chunks[arm] = retain_headings(
            blocks[arm], measured, pack_blocks(blocks[arm], frozenset(furniture))
        )
        write(output / f"{arm}-chunks.json", [asdict(c) for c in chunks[arm]])
    body = compare_body(
        blocks["baseline"], blocks["candidate"], chunks["baseline"], chunks["candidate"]
    )
    headings = {arm: heading_metrics(blocks[arm], chunks[arm], stage) for arm in chunks}
    old_text, new_text = (
        Counter(c.text for c in chunks[arm]) for arm in ["baseline", "candidate"]
    )
    heading_loss = []
    for before, after in zip(
        headings["baseline"]["anchors"], headings["candidate"]["anchors"]
    ):
        if (
            before["is_heading"]
            and not after["is_heading"]
            or before["readable_on_page"]
            and not after["readable_on_page"]
        ):
            heading_loss.append({"baseline": before, "candidate": after})
    banner_changes = [
        x for x in stage["changes"] if x["after"].get("type") == "discarded"
    ]
    result = {
        "id": source["id"],
        "source": source,
        "status": "measured",
        "evaluation_directory": str(output.relative_to(ROOT)),
        "input_sha256": inputs,
        "code_sha256": code_hashes,
        "chunker_version": CHUNKER_VERSION,
        "page_count": read(attempt / "baseline/parse.json")["page_count"],
        "chunks": {arm: len(cs) for arm, cs in chunks.items()},
        "body": body,
        "headings": headings,
        "new_heading_losses": heading_loss,
        "outline_roots_complete": stage["roots_complete"],
        "outline_roots": stage["outline_roots"],
        "matched_roots": stage["matched_roots"],
        "banners_demoted": len(banner_changes),
        "banner_texts": sorted({x["before"]["text"] for x in banner_changes}),
        "changed_root_levels": sum(
            x["after"].get("text_level") == 1 and x["before"].get("text_level") != 1
            for x in stage["changes"]
        ),
        "canonical_chunk_texts_unchanged": sum((old_text & new_text).values()),
        "canonical_chunk_texts_removed": sum((old_text - new_text).values()),
        "canonical_chunk_texts_added": sum((new_text - old_text).values()),
        "canonical_text_sequence_equal": [c.text for c in chunks["baseline"]]
        == [c.text for c in chunks["candidate"]],
        "complete_chunk_records_equal": chunks["baseline"] == chunks["candidate"],
    }
    result["proxy_alarm"] = bool(
        body["newly_missing_covered_units"]
        or heading_loss
        or headings["candidate"]["stale_root_ancestor_chunks"]
        > headings["baseline"]["stale_root_ancestor_chunks"]
        or headings["candidate"]["unexpected_root_prefix_prose_chunks"]
        > headings["baseline"]["unexpected_root_prefix_prose_chunks"]
    )
    write(cached, result)
    return result


def self_check() -> None:
    from pipeline.retrieval.chunking import Chunk, Region

    one = {"type": "text", "page_idx": 0, "bbox": [1, 2, 3, 4], "text": "One body."}
    two = {"type": "text", "page_idx": 0, "bbox": [1, 5, 3, 8], "text": "Another body."}
    original = [
        Chunk(text=b["text"], page_start=1, page_end=1, regions=[Region(1, b["bbox"])])
        for b in [one, two]
    ]
    joined = [
        Chunk(
            text="One body.\n\nAnother body.",
            page_start=1,
            page_end=1,
            regions=[Region(1, one["bbox"]), Region(1, two["bbox"])],
        )
    ]
    comparison = compare_body([one, two], [two, one], original, joined)
    assert comparison["body_payloads_removed_or_reshaped"] == 0
    assert comparison["newly_missing_covered_units"] == []
    lost = compare_body([one, two], [one], original, original[:1])
    assert lost["newly_missing_source_bound_text_count"] == 1
    shifted = Chunk(
        text=one["text"],
        page_start=1,
        page_end=1,
        regions=[Region(1, [10, 20, 30, 40])],
    )
    rebound = compare_body(
        [one], [{**one, "bbox": [10, 20, 30, 40]}], original[:1], [shifted]
    )
    assert rebound["citation_geometry_or_grouping_changed_count"] == 1
    assert rebound["newly_missing_source_bound_text_count"] == 0
    changed_heading = {
        "before": {**one, "text_level": 2},
        "after": {**one, "type": "discarded"},
    }
    queue = review_queue({"sha256": "a" * 64}, {"changes": [changed_heading]}, {})
    assert len(queue) == 1 and queue[0]["decision"] == "unreviewed"
    preface = {**one, "text": "Preface", "text_level": 1}
    chapter_body = {**two, "page_idx": 2}
    chapter_chunk = Chunk(
        text=two["text"],
        section_path="Actual chapter",
        page_start=3,
        page_end=3,
        regions=[Region(3, two["bbox"])],
    )
    partial = heading_metrics(
        [preface, chapter_body],
        [chapter_chunk],
        {
            "anchors": [{**preface, "outline_level": 1}],
            "changes": [],
            "toc": [[1, "Preface", 1], [1, "Unmatched chapter", 3]],
        },
    )
    assert partial["unmeasured_outline_root_context_chunks"] == 1
    assert partial["unexpected_root_prefix_prose_chunks"] == 0
    links = {**preface, "page_idx": 2, "text": "Links"}
    repeated_title = heading_metrics(
        [preface, links, chapter_body],
        [
            Chunk(
                text=two["text"],
                section_path="Links › Preface",
                page_start=3,
                page_end=3,
                regions=[Region(3, two["bbox"])],
            )
        ],
        {
            "anchors": [
                {**preface, "outline_level": 1},
                {**links, "outline_level": 1},
            ],
            "changes": [],
            "toc": [[1, "Preface", 1], [1, "Links", 3]],
        },
    )
    assert repeated_title["measured_outline_root_context_chunks"] == 1
    assert repeated_title["stale_root_ancestor_chunks"] == 0
    assert canonical("Pa") != canonical("pA")
    print(
        "Self-check passed: reordered identities, regrouping, body loss, citation changes, heading review, case preservation."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=ROOT / "bench/parsers/fixtures/unseen-pdf-sources-2026-09-20.json",
    )
    parser.add_argument("--parse-root", type=Path, default=LOCAL / "parse")
    parser.add_argument("--output", type=Path, default=LOCAL / "heading-evaluation")
    parser.add_argument("--only", nargs="+")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    code = [
        Path(__file__),
        ROOT / "pipeline/pipeline/config.py",
        *[
            ROOT / "pipeline/pipeline/retrieval" / name
            for name in ["chunking.py", "packing.py", "headings.py", "lang.py"]
        ],
    ]
    code_hashes = {str(p.relative_to(ROOT)): sha256(p) for p in code}
    records = []
    for source in read(args.manifest)["sources"]:
        if args.only and source["id"] not in args.only:
            continue
        status_file = args.parse_root / source["id"] / "status.json"
        status = (
            read(status_file) if status_file.is_file() else {"status": "not_started"}
        )
        if status["status"] != "complete":
            records.append(
                {
                    "id": source["id"],
                    "status": "unmeasured",
                    "parse_status": status["status"],
                }
            )
            continue
        attempt = args.parse_root / status["attempt_directory"]
        result = evaluate(source, attempt, args.output / source["id"], code_hashes)
        reviews_path = args.output / source["id"] / "source-reviews.json"
        reviews = read(reviews_path) if reviews_path.is_file() else {}
        queue = review_queue(
            source, read(attempt / "candidate/heading-stage.json"), reviews
        )
        result["heading_review_counts"] = dict(
            Counter(item["decision"] for item in queue)
        )
        result["requires_review"] = result["proxy_alarm"] or any(
            item["decision"] in {"unreviewed", "uncertain", "real_heading_regression"}
            for item in queue
        )
        result["assessment"] = (
            "candidate_unchanged"
            if result["complete_chunk_records_equal"] and not queue
            else "candidate_changes_require_source_review"
        )
        result["source_reviews_sha256"] = (
            sha256(reviews_path) if reviews_path.is_file() else None
        )
        evaluation_output = ROOT / result["evaluation_directory"]
        write(evaluation_output / "heading-review-queue.json", queue)
        write(evaluation_output / "metrics.json", result)
        records.append(result)
        print(
            source["id"],
            result["chunks"],
            "review",
            result["requires_review"],
            flush=True,
        )
    previous_summary = args.output / "summary.json"
    if previous_summary.is_file():
        previous_hash = sha256(previous_summary)
        archive = args.output / "summary-history" / f"{previous_hash}.json"
        if not archive.is_file():
            write(archive, read(previous_summary))
    write(
        args.output / "summary.json",
        {
            "manifest_sha256": sha256(args.manifest),
            "code_sha256": code_hashes,
            "documents": records,
            "measured": sum(r["status"] == "measured" for r in records),
            "unmeasured": sum(r["status"] == "unmeasured" for r in records),
        },
    )


if __name__ == "__main__":
    main()
