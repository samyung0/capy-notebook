"""Prepare isolated Sol workflow trials from two locally held, licensed books.

Run with the pipeline environment. Reads the live topic catalog, never writes it.
The literature case is a controlled catalog holdout, not a new source acquisition.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "lab/knowledge"))
import topics

OUT = ROOT / "bench/rag/reports/local/2026-09-21-sol-workflow"


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path: Path, value) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(out: Path) -> None:
    global OUT
    OUT = out
    load_dotenv(ROOT / ".env.local", override=False)
    OUT.mkdir(parents=True, exist_ok=False)
    template = (ROOT / "lab/knowledge/sol-assignment.txt").read_text(encoding="utf-8")
    shutil.copyfile(ROOT / "lab/knowledge/review.md", OUT / "review.md")
    shutil.copyfile(ROOT / "lab/knowledge/sol-examples.md", OUT / "sol-examples.md")
    shutil.copyfile(
        ROOT / "lab/knowledge/examples/book-review-packet.json",
        OUT / "example-packet.json",
    )
    shutil.copyfile(
        ROOT / "lab/knowledge/sol-assignment.txt", OUT / "sol-assignment.txt"
    )
    subjects = read(ROOT / "lab/knowledge/subjects.json")["subjects"]
    for book_id, splits in [
        ("literary-skills-and-the-archive", [(0, 23)]),
        ("mathematics-for-elementary-teachers", [(0, 79), (79, 158), (158, 236)]),
    ]:
        canonical = ROOT / "data/knowledge-base/runs" / book_id
        run = OUT / book_id
        (run / "books" / book_id).mkdir(parents=True)
        for name in ("manifest.json", "tags.json", "reviewed-notes.json"):
            shutil.copyfile(canonical / name, run / name)
        baseline_notes = run / "original-reviewed-notes.json"
        shutil.copyfile(run / "reviewed-notes.json", baseline_notes)
        corpus_path = run / "books" / book_id / "corpus.json"
        shutil.copyfile(canonical / "books" / book_id / "corpus.json", corpus_path)
        corpus = read(corpus_path)
        notes = read(run / "reviewed-notes.json")
        book = read(run / "manifest.json")["books"][0]
        source = ROOT / book["pdf_path"]
        assert digest(source) == book["sha256"]
        catalog = topics.library_topics(book["subject_id"])
        write(run / "live-catalog.json", catalog)
        holdout_ids = set()
        if book_id == "literary-skills-and-the-archive":
            holdout_ids = {t["id"] for t in read(canonical / "topics.json")["proposed"]}
        trial_catalog = [t for t in catalog if t["id"] not in holdout_ids]
        write(run / "trial-catalog.json", trial_catalog)
        write(
            run / "catalog-condition.json",
            {
                "condition": "controlled holdout of this book's prior proposed topics"
                if holdout_ids
                else "unchanged live catalog snapshot",
                "held_out_ids": sorted(holdout_ids),
                "live_topic_count": len(catalog),
                "trial_topic_count": len(trial_catalog),
            },
        )
        review_context = topics.reviewed_context(corpus, notes)
        context = {
            "input": topics.proposal_input(
                book, corpus_path, run / "reviewed-notes.json"
            ),
            "rules": topics.RULES,
            "schema": topics.SCHEMA,
            "subject_ids": sorted(s["id"] for s in subjects),
            "book": book,
            "existing_topics": trial_catalog,
            "table_of_contents": topics.table_of_contents(corpus),
            "reviewed_excerpts": review_context,
        }
        write(run / "topic-context-initial.json", context)
        bindings = {
            "source_pdf": {"path": str(source), "sha256": digest(source)},
            "original_reviewed_notes": {"path": str(baseline_notes), "sha256": digest(baseline_notes)},
            **{
                name: {"path": str(run / name), "sha256": digest(run / name)}
                for name in ("tags.json", "reviewed-notes.json", "trial-catalog.json")
            },
            "corpus": {"path": str(corpus_path), "sha256": digest(corpus_path)},
            "template_sha256": digest(OUT / "sol-assignment.txt"),
            "review_contract_sha256": digest(OUT / "review.md"),
            "examples_sha256": digest(OUT / "sol-examples.md"),
            "packet_example_sha256": digest(OUT / "example-packet.json"),
        }
        for number, (start, stop) in enumerate(splits, 1):
            folder = run / f"scope-{number}"
            folder.mkdir()
            assigned = corpus["excerpts"][start:stop]
            assert len(assigned) == stop - start
            ids = [e["id"] for e in assigned]
            write(
                folder / "input.json",
                {
                    "book": book,
                    "excerpts": assigned,
                    "full_reviewed_notes": {
                        eid: {
                            k: v
                            for k, v in notes["tags"][eid].items()
                            if k != "topic_ids"
                        }
                        for eid in ids
                    },
                    "existing_topics": trial_catalog,
                },
            )
            assignment = {
                "book_id": book_id,
                "run": str(run),
                "frozen_review_contract": str(OUT / "review.md"),
                "examples_path": str(OUT / "sol-examples.md"),
                "packet_example_path": str(OUT / "example-packet.json"),
                "inputs": str(folder / "input.json"),
                "bindings": bindings,
                "baseline_notes": str(baseline_notes),
                "baseline_sha256": digest(baseline_notes),
                "excerpt_ids": ids,
                "allowed_stages": [
                    "processed-source-review",
                    "retrieval-metadata",
                    "local-validation",
                    "text-packets",
                ]
                + (["topic-proposal", "final-topic-assignment"] if holdout_ids else []),
                "stopping_stage": "candidate-only; no canonical edits, DB writes, indexing, publishing, or provider API calls",
                "output_directory": str(folder),
                "split_ownership": "whole book owner"
                if holdout_ids
                else f"scope {number} of 3; parent will send all scopes to a fresh book owner for topics",
                "conditions": [
                    "This is an enrichment test on already corrected excerpts. Reuse original source review; do not claim a new complete transcription audit.",
                    "Read every assigned excerpt and its full notes. Review roles and add source-backed retrieval metadata. Preserve full notes unless documenting a supported correction.",
                    "Inspect original PDF pages for source corrections and numerical/formula/diagram claims you newly make. Also independently inspect at least three materially different numerical/diagram excerpts in a math scope. Report uninspected formulas honestly.",
                    "Read necessary context outside your scope, but edit only assigned IDs. Record context-read IDs and unresolved extraction problems.",
                    "Write review.json with book_id, source_sha256, base_tags_sha256, reviewed_excerpt_ids, tags keyed by assigned ID, inspection_records, model_provenance, context_read_ids, unresolved_items, and note_changes. Each tag keeps full synopsis, roles, topic_ids, confidence, evidence, proposed_topic, and retrieval.",
                    "For split scopes, use fitting existing topic IDs provisionally; the book owner will finalize them. Validate with lab/knowledge/enrich.py without --apply.",
                    "For the literature holdout, reason against trial-catalog.json only, ignoring this book's old topic IDs. This is a deliberate catalog replay, not claimed current-library novelty. Save full-review.json, proposal.json, merged-topics.json and final-tags.json, using topics.reviewed_context, proposal_input, import_proposal and merge with the supplied trial catalog. Do not refresh to live topics until the parent requests the separate stale-catalog test.",
                    "Read the frozen examples and packet example. Use lab/knowledge/packet.py with the assignment's --baseline-notes and --baseline-sha256 to save packet-exported.json from review.json and the trial catalog, including proposal and merged catalog for the whole-book topic owner. The packet embeds assigned source text, linked passages, full notes, tags and source bindings. Do not invent a packet schema or call Qwen. Scope-worker topic matches remain provisional pending the owner.",
                    "Save result.md with actual coverage, page inspection paths/observations, validation results and limits. Do not claim deterministic model output or invent usage counts.",
                ],
            }
            write(folder / "assignment.json", assignment)
            (folder / "dispatch.txt").write_text(
                template
                + "\n\nAssignment record:\n"
                + json.dumps(assignment, ensure_ascii=False, indent=2)
                + "\n",
                encoding="utf-8",
            )
        write(run / "bindings.json", bindings)
        print(
            json.dumps(
                {
                    "book_id": book_id,
                    "excerpts": len(corpus["excerpts"]),
                    "scopes": len(splits),
                    "catalog_topics": len(trial_catalog),
                }
            )
        )


def audit(out: Path) -> None:
    import enrich

    results = []
    for folder in sorted(out.glob("*/scope-*")):
        assignment = read(folder / "assignment.json")
        review = read(folder / "review.json")
        ids = assignment["excerpt_ids"]
        assert set(review["tags"]) == set(ids), folder
        assert len(review["reviewed_excerpt_ids"]) == len(ids)
        assert set(review["reviewed_excerpt_ids"]) == set(ids)
        for key, binding in assignment["bindings"].items():
            if isinstance(binding, dict):
                assert digest(Path(binding["path"])) == binding["sha256"], key
        original = read(folder / "input.json")["full_reviewed_notes"]
        changed_notes = [
            eid
            for eid in ids
            if review["tags"][eid]["synopsis"] != original[eid]["synopsis"]
        ]
        assert not changed_notes or review.get("note_changes"), (
            "Undocumented note changes"
        )
        for record in review["inspection_records"]:
            assert Path(record["rendered_page_path"]).is_file(), record
        receipt = None
        if assignment["split_ownership"] != "whole book owner":
            _, receipt = enrich.validate(Path(assignment["run"]), review)
        results.append(
            {
                "scope": str(folder.relative_to(out)),
                "assigned": len(ids),
                "completed": len(review["tags"]),
                "changed_notes": changed_notes,
                "inspection_records": len(review["inspection_records"]),
                "page_numbers": sorted(
                    {r["pdf_page"] for r in review["inspection_records"]}
                ),
                "validation": receipt,
                "review_sha256": digest(folder / "review.json"),
            }
        )
    write(out / "scope-audit.json", results)
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "audit"])
    parser.add_argument("--output", type=Path, default=OUT)
    args = parser.parse_args()
    if args.action == "prepare":
        prepare(args.output.resolve())
    else:
        audit(args.output.resolve())
