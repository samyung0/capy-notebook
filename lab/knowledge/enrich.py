"""Validate or import a bounded retrieval review of an already processed book.

The default is validation only. --apply preserves a backup, updates annotations
and records provenance. Run index and publish afterward through the usual builder.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bench/rag/scripts"))
import knowledge_base_pilot as pilot

from pipeline.retrieval.knowledge_metadata import validate_metadata


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def assessment_ids(
    artifact: dict, corpus: dict, required: set[str] | None = None
) -> set[str]:
    """Check recorded repair outcomes; the parent supplies prior issue IDs too."""
    records = artifact.get("repair_assessment")
    if not isinstance(records, list):
        raise ValueError("source repair needs repair_assessment records")
    known = {e["id"] for e in corpus["excerpts"]}
    covered = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("repair assessment must be an object")
        ids = record.get(
            "excerpt_ids", [record["excerpt_id"]] if "excerpt_id" in record else []
        )
        pages = record.get("pdf_pages", [])
        if (
            not isinstance(ids, list)
            or not ids
            or any(not isinstance(eid, str) for eid in ids)
            or not set(ids) <= known
            or record.get("status", record.get("outcome"))
            not in {
                "repaired",
                "source_unavailable",
                "source_authored",
                "context_linked",
                "no_repair_needed",
            }
            or not isinstance(record.get("reason"), str)
            or not record["reason"].strip()
            or not isinstance(pages, list)
            or not pages
            or any(
                type(page) is not int or not 1 <= page <= corpus["book"]["pages"]
                for page in pages
            )
        ):
            raise ValueError(
                "repair assessment needs known IDs, outcome, exact pages and reason"
            )
        covered.update(ids)
    needed = {r["excerpt_id"] for r in artifact.get("source_repairs", [])} | (
        required or set()
    )
    if not needed <= covered:
        raise ValueError(f"repair assessment is incomplete: {sorted(needed - covered)}")
    return covered


def repaired_corpus(corpus: dict, artifact: dict, base_sha256: str) -> dict:
    """Project source-bound chunk repairs without changing frozen inputs."""
    repairs = artifact.get("source_repairs", [])
    if not isinstance(repairs, list):
        raise ValueError("source_repairs must be a list")
    if "source_repairs" not in artifact and "repair_assessment" not in artifact:
        return corpus
    assessment_ids(artifact, corpus)
    if artifact.get("book_id") != corpus["book"]["id"]:
        raise ValueError("source repair book does not match the corpus")
    if artifact.get("base_corpus_sha256") != base_sha256:
        raise ValueError("corpus changed since the source repair started")
    if not artifact.get("model_provenance"):
        raise ValueError("source repair needs model provenance")
    source = Path(artifact.get("source_pdf_path", ""))
    if (
        not source.is_file()
        or hashlib.sha256(source.read_bytes()).hexdigest() != corpus["book"]["sha256"]
        or artifact.get("source_sha256") != corpus["book"]["sha256"]
    ):
        raise ValueError("source repair PDF hash does not match the corpus")
    if not repairs:
        return corpus
    projected = copy.deepcopy(corpus)
    chunks = {chunk["id"]: chunk for chunk in projected["chunks"]}
    excerpts = {excerpt["id"]: excerpt for excerpt in corpus["excerpts"]}
    seen, affected, checked_pages = set(), set(), set()
    inspections = artifact.get("inspection_records", [])
    for repair in repairs:
        if not isinstance(repair, dict):
            raise ValueError("source repair must be an object")
        chunk_id, excerpt_id = repair.get("chunk_id"), repair.get("excerpt_id")
        if (
            chunk_id not in chunks
            or chunk_id in seen
            or excerpt_id not in artifact.get("tags", {})
            or excerpt_id not in excerpts
            or chunks[chunk_id]["excerpt_id"] != excerpt_id
            or chunk_id not in excerpts[excerpt_id]["chunk_ids"]
        ):
            raise ValueError("source repair must uniquely name an assigned chunk")
        chunk = chunks[chunk_id]
        before = chunk["text"]
        if hashlib.sha256(before.encode("utf-8")).hexdigest() != repair.get(
            "original_text_sha256"
        ):
            raise ValueError(f"source repair original text differs: {chunk_id}")
        text, kind, pages = (
            repair.get("text"),
            repair.get("kind"),
            repair.get("pdf_pages"),
        )
        if (
            not isinstance(text, str)
            or text == before
            or (not text.strip() and kind != "extraction_duplicate")
            or kind
            not in {"transcription", "diagram_description", "extraction_duplicate"}
            or not isinstance(repair.get("reason"), str)
            or not repair["reason"].strip()
            or not isinstance(pages, list)
            or not pages
            or any(type(page) is not int for page in pages)
            or len(pages) != len(set(pages))
        ):
            raise ValueError(f"invalid or no-op source repair: {chunk_id}")
        if kind == "diagram_description" and "[Diagram description:" not in text:
            raise ValueError("diagram descriptions must be labelled in source text")
        chunk_pages = {region["page"] for region in chunk["regions"]}
        if not set(pages) <= chunk_pages & set(excerpts[excerpt_id]["pages"]):
            raise ValueError(f"source repair page is outside its chunk: {chunk_id}")
        for page in pages:
            if page in checked_pages:
                continue
            matches = [
                record
                for record in inspections
                if isinstance(record, dict)
                and record.get("pdf_page") == page
                and isinstance(record.get("observation"), str)
                and record["observation"].strip()
                and record.get("rendered_page_sha256")
                and Path(record.get("rendered_page_path", "")).is_file()
                and hashlib.sha256(
                    Path(record["rendered_page_path"]).read_bytes()
                ).hexdigest()
                == record["rendered_page_sha256"]
            ]
            if not matches:
                raise ValueError(f"source repair needs a bound page inspection: {page}")
            checked_pages.add(page)
        chunk.setdefault("source_repairs", []).append(
            {
                **repair,
                "original_text": before,
                "model_provenance": artifact["model_provenance"],
            }
        )
        chunk["text"] = text
        seen.add(chunk_id)
        affected.add(excerpt_id)
    from transcribe import refresh

    refresh(projected)
    for excerpt in projected["excerpts"]:
        if excerpt["id"] not in affected and excerpt != excerpts[excerpt["id"]]:
            raise ValueError("source repair would change an unrelated excerpt")
        if excerpt["id"] in affected and not excerpt["text"].strip():
            raise ValueError("source repair cannot erase an entire excerpt")
    return projected


def validate(run: Path, artifact: dict) -> tuple[dict, dict]:
    book_id = artifact["book_id"]
    corpus_bytes = (run / "books" / book_id / "corpus.json").read_bytes()
    corpus = repaired_corpus(
        json.loads(corpus_bytes), artifact, hashlib.sha256(corpus_bytes).hexdigest()
    )
    if artifact["source_sha256"] != corpus["book"]["sha256"]:
        raise ValueError("review source hash does not match the corpus")
    raw = (run / "tags.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != artifact["base_tags_sha256"]:
        raise ValueError(
            "tags changed since this review started; reconcile before import"
        )
    current = json.loads(raw)
    excerpts = {e["id"]: e for e in corpus["excerpts"]}
    reviewed = artifact["tags"]
    if not reviewed or not set(reviewed) <= set(excerpts):
        raise ValueError("review must name existing excerpts in this book")
    if not artifact.get("model_provenance"):
        raise ValueError("review needs model provenance")
    inspections = artifact.get("inspection_records")
    if not isinstance(inspections, list) or not inspections:
        raise ValueError("review needs page-image inspection records")
    for record in inspections:
        if (
            not isinstance(record, dict)
            or type(record.get("pdf_page")) is not int
            or not 1 <= record["pdf_page"] <= corpus["book"]["pages"]
            or any(
                not isinstance(record.get(k), str) or not record[k].strip()
                for k in ("rendered_page_path", "observation")
            )
        ):
            raise ValueError("invalid page-image inspection record")
    reviewed_pages = {page for eid in reviewed for page in excerpts[eid]["pages"]}
    if not any(record["pdf_page"] in reviewed_pages for record in inspections):
        raise ValueError("inspection records do not cover the reviewed scope")
    for key, tag in reviewed.items():
        if (
            current["tags"].get(key, {}).get("synopsis", "").strip()
            and not tag.get("synopsis", "").strip()
        ):
            raise ValueError(f"review cannot erase full existing notes: {key}")
        validate_metadata(tag.get("retrieval"), key, set(excerpts))
    topics = {t["id"] for t in current["topics"]}
    tags, review = pilot.tag_outputs(reviewed, excerpts, topics)
    if any(not tag["evidence_verified"] for tag in tags.values()):
        raise ValueError("review evidence must occur verbatim in the corrected source")
    current["tags"].update(tags)
    current["failed_tags"] = {
        k: v for k, v in current["failed_tags"].items() if k not in tags
    }
    current["review_items"] = [
        r for r in current["review_items"] if r["excerpt_id"] not in tags
    ] + review
    receipt = {
        "book_id": book_id,
        "reviewed": len(tags),
        "non_teaching": sum(t["roles"] == ["non_teaching"] for t in tags.values()),
    }
    if "source_repairs" in artifact:
        receipt["source_repairs"] = len(artifact["source_repairs"])
        receipt["repaired_excerpts"] = sorted(
            {repair["excerpt_id"] for repair in artifact["source_repairs"]}
        )
    return current, receipt


def write(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def resume_apply(run: Path, artifact_path: Path) -> dict:
    """Finish only the exact saved write plan after verifying every current file."""
    artifact_digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    backup = run / "retrieval-review-backups" / artifact_digest
    plan = load(backup / "apply-plan.json")
    if (
        plan["artifact_sha256"] != artifact_digest
        or (backup / "review.json").read_bytes() != artifact_path.read_bytes()
    ):
        raise ValueError("apply plan does not match the review artifact")
    root = run.resolve()
    pending = []
    for entry in plan["files"]:
        target = (root / entry["target"]).resolve()
        expected = (backup / entry["expected"]).resolve()
        if not target.is_relative_to(root) or not expected.is_relative_to(
            backup.resolve()
        ):
            raise ValueError("apply plan path escapes its run")
        data = expected.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry["expected_sha256"]:
            raise ValueError("saved apply output changed")
        current = (
            hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
        )
        if current not in {entry["original_sha256"], entry["expected_sha256"]}:
            raise ValueError(f"apply target changed outside the saved plan: {target}")
        if current != entry["expected_sha256"]:
            pending.append((target, data))
    # All targets are checked before the first replacement. Repeated calls are idempotent.
    for target, data in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_bytes(data)
        temporary.replace(target)
    return plan["receipt"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Finish the existing exact-artifact apply plan",
    )
    args = parser.parse_args()
    if args.resume:
        if not args.apply:
            parser.error("--resume requires --apply")
        print(json.dumps(resume_apply(args.run, args.artifact)))
        return
    artifact = load(args.artifact)
    tags, receipt = validate(args.run, artifact)
    if args.apply:
        # The artifact digest names an immutable backup, separate from source-review backups.
        digest = hashlib.sha256(args.artifact.read_bytes()).hexdigest()
        backup = args.run / "retrieval-review-backups" / digest
        backup.mkdir(parents=True, exist_ok=False)
        (backup / "tags.json").write_bytes((args.run / "tags.json").read_bytes())
        (backup / "review.json").write_bytes(args.artifact.read_bytes())
        notes_path = args.run / "reviewed-notes.json"
        if notes_path.exists():
            notes = load(notes_path)
            (backup / "reviewed-notes.json").write_bytes(notes_path.read_bytes())
        else:
            notes = {"tags": {}}
        notes["tags"].update(artifact["tags"])
        write(backup / "expected-tags.json", tags)
        write(backup / "expected-notes.json", notes)
        if artifact.get("source_repairs"):
            corpus_path = args.run / "books" / artifact["book_id"] / "corpus.json"
            original = corpus_path.read_bytes()
            corpus = repaired_corpus(
                json.loads(original), artifact, hashlib.sha256(original).hexdigest()
            )
            (backup / "corpus.json").write_bytes(original)
            write(backup / "expected-corpus.json", corpus)
        model_dir = args.run / "models/retrieval-review"
        write(
            backup / "expected-state.json",
            {
                "status": "complete",
                "transport": "codex-subagent",
                "model": "gpt-5.6-sol",
                "model_provenance": artifact["model_provenance"],
                "review_artifact": str(args.artifact.resolve()),
                "artifact_sha256": digest,
                "counts": receipt,
                "usage": {},
            },
        )
        receipt["next"] = "index, publish and verify the new version"
        outputs = [
            (args.run / "tags.json", "expected-tags.json"),
            (notes_path, "expected-notes.json"),
            (model_dir / "state.json", "expected-state.json"),
        ]
        if artifact.get("source_repairs"):
            outputs.insert(0, (corpus_path, "expected-corpus.json"))
        plan = {"artifact_sha256": digest, "receipt": receipt, "files": []}
        for target, expected_name in outputs:
            plan["files"].append(
                {
                    "target": target.relative_to(args.run).as_posix(),
                    "expected": expected_name,
                    "original_sha256": hashlib.sha256(target.read_bytes()).hexdigest()
                    if target.exists()
                    else None,
                    "expected_sha256": hashlib.sha256(
                        (backup / expected_name).read_bytes()
                    ).hexdigest(),
                }
            )
        write(backup / "apply-plan.json", plan)
        resume_apply(args.run, args.artifact)
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
