"""Export a self-contained text packet. No credentials, network or model calls."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from topics import RULES

from pipeline.retrieval.knowledge_metadata import validate_metadata


def build_packet(
    *,
    run: Path,
    review: Path,
    catalog: Path,
    case_id: str,
    baseline_notes: Path,
    baseline_sha256: str,
    proposal: Path | None = None,
    merged_topics: Path | None = None,
    source_review: Path | None = None,
) -> dict:
    snapshots: dict[Path, bytes] = {}

    def load(path: Path):
        snapshots[path] = path.read_bytes()
        return json.loads(snapshots[path])

    manifest_path = run / "manifest.json"
    books = load(manifest_path)["books"]
    if len(books) != 1:
        raise ValueError("Packet export requires a one-book run")
    book = books[0]
    corpus_path = run / "books" / book["id"] / "corpus.json"
    notes_path = baseline_notes
    corpus, before, candidate = load(corpus_path), load(notes_path), load(review)
    repair_review = None
    if candidate.get("source_repairs") or source_review:
        from enrich import repaired_corpus

        repair_review = load(source_review) if source_review else candidate
        if "source_repairs" not in repair_review:
            raise ValueError(
                "source review must explicitly declare source_repairs, including an empty list"
            )
        corpus = repaired_corpus(
            corpus, repair_review, hashlib.sha256(snapshots[corpus_path]).hexdigest()
        )
    if hashlib.sha256(snapshots[notes_path]).hexdigest() != baseline_sha256.lower():
        raise ValueError("Original-note baseline hash differs from the assignment")
    excerpts = {e["id"]: e for e in corpus["excerpts"]}
    if len(excerpts) != len(corpus["excerpts"]):
        raise ValueError("Corpus contains duplicate excerpt IDs")
    tags = candidate["tags"]
    if not tags or not set(tags) <= set(excerpts):
        raise ValueError("Candidate must contain known excerpt IDs")
    if not set(tags) <= set(before["tags"]):
        raise ValueError("Full reviewed notes are missing for assigned excerpts")
    if candidate.get("source_sha256") != book["sha256"]:
        raise ValueError("Candidate source hash differs from the book")
    if corpus["book"]["id"] != book["id"] or corpus["book"]["sha256"] != book["sha256"]:
        raise ValueError("Corpus source hash differs from the book")
    assigned = [eid for eid in excerpts if eid in tags]
    if "reviewed_excerpt_ids" in candidate and (
        set(candidate["reviewed_excerpt_ids"]) != set(assigned)
        or len(candidate["reviewed_excerpt_ids"]) != len(assigned)
    ):
        raise ValueError("Declared review coverage differs from candidate tags")
    needed = set(assigned)
    for eid, tag in tags.items():
        validate_metadata(tag.get("retrieval"), eid, set(excerpts))
        needed.update(tag["retrieval"]["context_excerpt_ids"])
    existing = load(catalog)
    if not isinstance(existing, list):
        existing = existing["topics"]
    proposed = load(proposal) if proposal else None
    merged = load(merged_topics) if merged_topics else None
    topic_ids = {t["id"] for t in (merged["topics"] if merged else existing)}
    if any(not set(tag["topic_ids"]) <= topic_ids for tag in tags.values()):
        raise ValueError("Candidate topic IDs are absent from the supplied catalog")
    paths = {
        "manifest": manifest_path,
        "corpus": corpus_path,
        "full_reviewed_notes": notes_path,
        "candidate": review,
        "catalog": catalog,
    }
    if proposal:
        paths["proposal"] = proposal
    if merged_topics:
        paths["merged_topics"] = merged_topics
    if source_review:
        paths["source_review"] = source_review
    repair_provenance = {}
    if repair_review is not None:
        repairs = [
            r
            for r in repair_review.get("source_repairs", [])
            if r["excerpt_id"] in needed
        ]
        pages = {page for repair in repairs for page in repair["pdf_pages"]}
        assessments = []
        for record in repair_review.get("repair_assessment", []):
            ids = record.get(
                "excerpt_ids", [record["excerpt_id"]] if "excerpt_id" in record else []
            )
            if set(ids) & needed:
                assessments.append(
                    {**record, "excerpt_ids": [eid for eid in ids if eid in needed]}
                )
        repair_provenance["source_repair"] = {
            "model_provenance": repair_review.get("model_provenance"),
            "corrections": [
                {k: v for k, v in repair.items() if k != "text"} for repair in repairs
            ],
            "assessments": assessments,
            "inspection_records": [
                r
                for r in repair_review.get("inspection_records", [])
                if r.get("pdf_page") in pages
            ],
            "validation_receipts": repair_review.get("validation_receipts", []),
        }
    return {
        "case_id": case_id,
        "provenance": {
            "book": book,
            "model_provenance": candidate.get("model_provenance"),
            **repair_provenance,
            "bindings": {
                name: {
                    "path": str(path.resolve()),
                    "sha256": hashlib.sha256(snapshots[path]).hexdigest(),
                }
                for name, path in paths.items()
            },
        },
        "source": {
            "source_id": book["id"],
            "title": book["title"],
            "sha256": book["sha256"],
            "excerpts": [
                {
                    "excerpt_id": eid,
                    **{k: e[k] for k in ("text", "pages", "section_path")},
                }
                for eid, e in excerpts.items()
                if eid in needed
            ],
        },
        "assignment": {
            "scope": "whole book"
            if len(assigned) == len(excerpts)
            else "bounded excerpt review; no whole-book topic-completeness claim",
            "target_ids": assigned,
            "completed_ids": assigned,
            "outside_assignment_ids": [eid for eid in excerpts if eid not in tags],
            "fields": ["roles", "notes", "scope", "topics", "context_links"],
            "metadata_coverage": "Retrieval metadata is supplied for every target. Source extraction limits remain recorded separately.",
        },
        "role_definitions": {
            "introduction": "Explains a concept; objectives alone do not teach it.",
            "formal": "States or develops a definition, method, theorem or derivation.",
            "worked_example": "Demonstrates a method with an application or solution.",
            "exercise": "Gives the learner an actual task or question.",
            "summary": "Reviews content already taught.",
            "reference": "Substantive lookup material, such as a formula table or glossary, not a bibliography.",
            "non_teaching": "Contents, objectives, bibliography, credits or administration alone; stands alone with no topics.",
        },
        "topic_rules": RULES,
        "existing_topics": existing,
        "proposed_topics": proposed["proposed"] if proposed else [],
        "topic_proposal": proposed,
        "topic_merge": merged,
        "final_topic_ids": sorted(
            {topic for tag in tags.values() for topic in tag["topic_ids"]}
        ),
        "full_reviewed_notes": {
            eid: before["tags"][eid]["synopsis"] for eid in assigned
        },
        "final_tags": [{**tags[eid], "excerpt_id": eid} for eid in assigned],
        "inspection_records": candidate.get("inspection_records", []),
        "validation_receipts": candidate.get("validation_receipts", []),
        "unresolved_items": candidate.get("unresolved_items", []),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("run", "review", "catalog", "baseline-notes", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--baseline-sha256", required=True)
    parser.add_argument("--case-id", required=True)
    parser.add_argument("--proposal", type=Path)
    parser.add_argument("--merged-topics", type=Path)
    parser.add_argument("--source-review", type=Path)
    args = vars(parser.parse_args())
    output = args.pop("output")
    packet = build_packet(**args)
    with output.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(packet, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps(
            {
                "packet": str(output),
                "targets": len(packet["assignment"]["target_ids"]),
                "source_excerpts": len(packet["source"]["excerpts"]),
            }
        )
    )
