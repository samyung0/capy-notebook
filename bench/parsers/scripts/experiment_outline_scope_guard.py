"""Bounded root-promotion guard over cached blocks and literal PDF outlines.

uv run --frozen python bench/parsers/scripts/experiment_outline_scope_guard.py --self-check
uv run --frozen python bench/parsers/scripts/experiment_outline_scope_guard.py --only all
"""

from __future__ import annotations

import argparse
import copy
import time
from dataclasses import asdict

import evaluate_unseen_headings as evaluation
import experiment_coherent_banner_roles as coherent
import pymupdf
from compare_parser_repair_regressions import chunks, raw_payloads
from odl import headings

from pipeline.retrieval.chunking import _heading_boundary_level

OUT = coherent.OUT / "outline-scope-guard"
FRESH = evaluation.ROOT / "bench/parsers/reports/local/2026-09-20-parser-repairs"
BASELINE_NEW = (
    evaluation.ROOT
    / "bench/parsers/reports/local/2026-09-20-heading-release/baseline-new-sources"
)


def match_row(blocks: list[dict], evidence: dict, document, row) -> int | None:
    _, title, page, destination = row
    if not 1 <= page <= len(document):
        return None
    choices = []
    for index in evidence:
        block = blocks[index]
        if block.get("type") != "text" or block["page_idx"] != page - 1:
            continue
        texts = [block["text"]]
        if (
            index + 1 in evidence
            and blocks[index + 1].get("type") == "text"
            and blocks[index + 1]["page_idx"] == page - 1
        ):
            texts.append(block["text"] + " " + blocks[index + 1]["text"])
        if any(
            headings._outline_title(text) == headings._outline_title(title)
            for text in texts
        ):
            choices.append(
                (
                    index,
                    any(
                        headings._literal(text) == headings._literal(title)
                        for text in texts
                    ),
                )
            )
    if any(exact for _, exact in choices):
        choices = [(index, exact) for index, exact in choices if exact]
    if (
        len(choices) > 1
        and destination.get("kind") == pymupdf.LINK_GOTO
        and "to" in destination
        and "nameddest" not in destination
    ):
        y = destination["to"].y / document[page - 1].rect.height * 1000
        choices = [
            item for item in choices if abs(blocks[item[0]]["bbox"][1] - y) <= 65
        ]
    return choices[0][0] if len(choices) == 1 else None


def unsafe_boundaries(
    blocks: list[dict],
    roots: list[int],
    descendants: dict[int, set[int]],
    fragments: dict[int, set[int]] | None = None,
) -> list[dict]:
    failures = []
    for position, root in enumerate(roots):
        prior_level = blocks[root]["text_level"]
        if prior_level <= 1:
            continue
        scope_level = prior_level
        end = roots[position + 1] if position + 1 < len(roots) else len(blocks)
        for index in range(root + 1, end):
            block = blocks[index]
            boundary = _heading_boundary_level(block)
            if boundary == 1:
                break
            if boundary is not None:
                if boundary <= scope_level:
                    failures.append(
                        {
                            "root_index": root,
                            "root": blocks[root]["text"],
                            "root_original_level": prior_level,
                            "boundary_index": index,
                            "boundary_page": block["page_idx"] + 1,
                            "boundary": block.get("text", ""),
                            "boundary_level": boundary,
                            "boundary_type": "neutral-running-banner",
                        }
                    )
                    break
                continue
            level = block.get("text_level")
            if block.get("type") != "text" or type(level) is not int or level <= 0:
                continue
            if level == 1:
                break
            if level <= scope_level:
                if index in descendants[root] or index in (fragments or {}).get(
                    root, set()
                ):
                    scope_level = level
                    continue
                failures.append(
                    {
                        "root_index": root,
                        "root": blocks[root]["text"],
                        "root_original_level": prior_level,
                        "boundary_index": index,
                        "boundary_page": block["page_idx"] + 1,
                        "boundary": block["text"],
                        "boundary_level": level,
                    }
                )
                break
    return failures


def guarded_roots(
    blocks: list[dict], document, evidence: dict
) -> tuple[list[dict], dict]:
    toc = document.get_toc(simple=False)
    roots, descendants, fragments = [], {}, {}
    active = None
    matches = [match_row(blocks, evidence, document, row) for row in toc]
    for row, match in zip(toc, matches, strict=True):
        if row[0] == 1:
            if match is None or match in roots:
                return blocks, {"complete": False, "unsafe_boundaries": []}
            roots.append(match)
            descendants[match] = set()
            fragments[match] = set()
            if (
                match + 1 in evidence
                and blocks[match + 1].get("type") == "text"
                and blocks[match + 1]["page_idx"] == row[2] - 1
                and headings._outline_title(blocks[match]["text"])
                != headings._outline_title(row[1])
                and headings._outline_title(
                    blocks[match]["text"] + " " + blocks[match + 1]["text"]
                )
                == headings._outline_title(row[1])
            ):
                fragments[match].add(match + 1)
            active = match
        elif active is not None and match is not None and matches.count(match) == 1:
            descendants[active].add(match)
    if not roots or roots != sorted(roots):
        return blocks, {"complete": False, "unsafe_boundaries": []}
    failures = unsafe_boundaries(blocks, roots, descendants, fragments)
    result = (
        blocks
        if failures
        else [{**b, "text_level": 1} if i in roots else b for i, b in enumerate(blocks)]
    )
    return result, {
        "complete": True,
        "unsafe_boundaries": failures,
        "roots": roots,
        "proven_descendants": {str(k): sorted(v) for k, v in descendants.items()},
        "root_fragments": {str(k): sorted(v) for k, v in fragments.items()},
    }


def self_check() -> None:
    blocks = [
        {"type": "text", "text": "Rights", "text_level": 6, "page_idx": 1},
        {"type": "text", "text": "Overview", "text_level": 6, "page_idx": 2},
        {"type": "text", "text": "Chapter", "text_level": 2, "page_idx": 3},
    ]
    assert len(unsafe_boundaries(blocks, [0, 2], {0: set(), 2: set()})) == 1
    assert unsafe_boundaries(blocks, [0, 2], {0: {1}, 2: set()}) == []
    assert unsafe_boundaries(blocks, [0, 1, 2], {0: set(), 1: set(), 2: set()}) == []
    level_one = copy.deepcopy(blocks)
    level_one[1]["text_level"] = 1
    assert unsafe_boundaries(level_one, [0, 2], {0: set(), 2: set()}) == []
    nested = copy.deepcopy(blocks)
    nested[1]["text_level"], nested[2]["text_level"] = 2, 3
    assert unsafe_boundaries(nested, [0], {0: {1}}) == []
    nested[2]["text_level"] = 2
    assert len(unsafe_boundaries(nested, [0], {0: {1}})) == 1
    split = copy.deepcopy(blocks)
    split[1]["text_level"], split[2]["text_level"] = 4, 5
    assert unsafe_boundaries(split, [0], {0: set()}, {0: {1}}) == []
    neutral = [
        blocks[0],
        {
            "type": "discarded",
            "_source_role": "running-banner",
            "_heading_boundary_level": 2,
            "text": "Banner",
            "page_idx": 2,
        },
    ]
    assert len(unsafe_boundaries(neutral, [0], {0: set()})) == 1
    neutral[1]["_heading_boundary_level"] = 1
    assert unsafe_boundaries(neutral, [0], {0: set()}) == []
    neutral[1]["_heading_boundary_level"] = 7
    assert unsafe_boundaries(neutral, [0], {0: set()}) == []
    neutral[1]["_heading_boundary_level"] = True
    assert unsafe_boundaries(neutral, [0], {0: set()}) == []
    neutral[1]["_heading_boundary_level"] = 2
    neutral[1]["_source_role"] = "unconfirmed"
    assert unsafe_boundaries(neutral, [0], {0: set()}) == []
    print(
        "Self-check passed: unmatched peer blocks promotion; uniquely proven descendant permits it."
    )


def evaluate_saved() -> None:
    records = []
    sources = {
        s["id"]: s
        for s in evaluation.read(
            evaluation.ROOT
            / "bench/parsers/fixtures/heading-release-sources-2026-09-20.json"
        )["sources"]
    }
    for diagnostic in evaluation.read(OUT / "summary.json"):
        id = diagnostic["id"]
        saved = OUT / id
        guarded = evaluation.read(saved / "guarded-blocks.json")
        candidate_dir = saved / "pre-guard-fresh"
        if not candidate_dir.exists():
            candidate_dir = (
                FRESH / id if id.startswith("heading-") else coherent.OUT / id
            )
        candidate_name = (
            "content_list.json"
            if id.startswith("heading-")
            else "candidate-blocks.json"
        )
        prior = evaluation.read(candidate_dir / candidate_name)
        record = {
            "id": id,
            "unchanged_vs_pre_guard_candidate": guarded == prior,
            "old_root_changes": diagnostic["old_root_changes"],
            "guarded_root_changes": diagnostic["guarded_root_changes"],
        }
        if guarded != prior:
            baseline_dir = BASELINE_NEW / id
            baseline = evaluation.read(baseline_dir / "content_list.json")
            original_chunks = chunks(evaluation.read(baseline_dir / "chunks.json"))
            furniture = evaluation.read(candidate_dir / "refinement.json")["furniture"]
            pdf = evaluation.ROOT / sources[id]["path"]
            new_chunks = coherent.frozen.pack(guarded, furniture, pdf)
            removed_names = {
                evaluation.canonical(after.get("text", ""))
                for before, after in zip(baseline, guarded, strict=True)
                if before.get("text_level") and after.get("_heading_boundary_level")
            }
            paths = coherent.compare_region_paths(
                original_chunks, new_chunks, removed_names
            )
            old_payloads, new_payloads = raw_payloads(baseline), raw_payloads(guarded)
            record.update(
                body=evaluation.compare_body(
                    baseline, guarded, original_chunks, new_chunks
                ),
                baseline_chunks=len(original_chunks),
                guarded_chunks=len(new_chunks),
                raw_payloads_removed=sum((old_payloads - new_payloads).values()),
                raw_payloads_added=sum((new_payloads - old_payloads).values()),
                baseline_region_comparison={
                    k: v for k, v in paths.items() if k != "records"
                },
                roots_still_headings=sum(
                    bool(guarded[i].get("text_level")) for i in diagnostic["roots"]
                ),
                expected_root_count=len(diagnostic["roots"]),
                banner_boundaries=sum(
                    bool(_heading_boundary_level(b)) for b in guarded
                ),
            )
            evaluation.write(
                saved / "guarded-chunks.json", [asdict(c) for c in new_chunks]
            )
            evaluation.write(saved / "baseline-region-comparison.json", paths)
        evaluation.write(saved / "evaluation.json", record)
        records.append(record)
    evaluation.write(OUT / "evaluation-summary.json", records)
    changed = [r for r in records if not r["unchanged_vs_pre_guard_candidate"]]
    print("Compared", len(records), "documents; changed", [r["id"] for r in changed])
    for record in changed:
        print(
            record["id"],
            "body misses",
            record["body"]["newly_missing_source_bound_text_count"],
            "region changes",
            record["baseline_region_comparison"]["changed_regions"],
            "roots retained",
            record["roots_still_headings"],
        )
    assert all(
        r["body"]["newly_missing_source_bound_text_count"] == 0
        and r["raw_payloads_removed"] == r["raw_payloads_added"] == 0
        and r["baseline_region_comparison"]["changed_regions"] == 0
        for r in changed
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--only",
        nargs="+",
        default=[
            "heading-libreoffice",
            "heading-oecd",
            "openstax-chemistry-2e",
            "bccampus-accessibility",
        ],
    )
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument(
        "--evaluate",
        action="store_true",
        help="Evaluate saved guard outputs against the pre-guard candidates and original baselines",
    )
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    if args.evaluate:
        evaluate_saved()
        return
    original = evaluation.read(evaluation.LOCAL / "heading-evaluation/summary.json")[
        "documents"
    ]
    new_sources = evaluation.read(
        evaluation.ROOT
        / "bench/parsers/fixtures/heading-release-sources-2026-09-20.json"
    )["sources"]
    records = []
    for record in [
        *[r for r in original if r["status"] == "measured"],
        *[{"id": s["id"], "source": s} for s in new_sources],
    ]:
        id = record["id"]
        if "all" not in args.only and id not in args.only:
            continue
        if id.startswith("heading-"):
            baseline_dir, candidate_dir = BASELINE_NEW / id, FRESH / id
            baseline = evaluation.read(baseline_dir / "content_list.json")
            candidate = evaluation.read(candidate_dir / "content_list.json")
        else:
            status = evaluation.read(evaluation.LOCAL / "parse" / id / "status.json")
            baseline_dir = (
                evaluation.LOCAL / "parse" / status["attempt_directory"] / "baseline"
            )
            baseline = evaluation.read(baseline_dir / "content_list.json")
            candidate = evaluation.read(coherent.OUT / id / "candidate-blocks.json")
        assert len(baseline) == len(candidate)
        inputs = copy.deepcopy(candidate)
        for before, after in zip(baseline, inputs, strict=True):
            if (
                before.get("type") == after.get("type") == "text"
                and before.get("text_level")
                and after.get("text_level")
            ):
                after["text_level"] = before["text_level"]
        pdf = baseline_dir / "parsed.pdf"
        if not pdf.exists():
            pdf = evaluation.ROOT / record["source"]["path"]
        with pymupdf.open(pdf) as document:
            started = time.perf_counter()
            evidence = headings._source_spans(inputs, document)
            guarded, diagnostics = guarded_roots(inputs, document, evidence)
            # Retain the unguarded matching baseline after production integrates
            # the guard, so later experiment reruns still measure its effect.
            old = (
                [
                    {**b, "text_level": 1} if i in diagnostics["roots"] else b
                    for i, b in enumerate(inputs)
                ]
                if diagnostics["complete"]
                else inputs
            )
            seconds = time.perf_counter() - started
        old_changes = sum(a != b for a, b in zip(inputs, old, strict=True))
        result = {
            "id": id,
            "source_sha256": evaluation.sha256(pdf),
            "old_root_changes": old_changes,
            "guarded_root_changes": sum(
                a != b for a, b in zip(inputs, guarded, strict=True)
            ),
            "guard_seconds_including_source_spans": seconds,
            "changed_vs_current_candidate": old != guarded,
            **diagnostics,
        }
        evaluation.write(OUT / id / "diagnostic.json", result)
        evaluation.write(OUT / id / "guarded-blocks.json", guarded)
        records.append(result)
        print(
            id,
            "roots",
            old_changes,
            "->",
            result["guarded_root_changes"],
            "unsafe boundaries",
            len(diagnostics["unsafe_boundaries"]),
            flush=True,
        )
    evaluation.write(OUT / "summary.json", records)


if __name__ == "__main__":
    main()
