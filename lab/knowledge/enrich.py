"""Validate or import a bounded retrieval review of an already processed book.

The default is validation only. --apply preserves a backup, updates annotations
and records provenance. Run index and publish afterward through the usual builder.
"""

from __future__ import annotations

import argparse
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


def validate(run: Path, artifact: dict) -> tuple[dict, dict]:
    book_id = artifact["book_id"]
    corpus = load(run / "books" / book_id / "corpus.json")
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
    return current, {
        "book_id": book_id,
        "reviewed": len(tags),
        "non_teaching": sum(t["roles"] == ["non_teaching"] for t in tags.values()),
    }


def write(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    artifact = load(args.artifact)
    tags, receipt = validate(args.run, artifact)
    if args.apply:
        # The artifact digest names an immutable backup, separate from source-review backups.
        digest = hashlib.sha256(args.artifact.read_bytes()).hexdigest()
        backup = args.run / "retrieval-review-backups" / digest
        backup.mkdir(parents=True, exist_ok=False)
        (backup / "tags.json").write_bytes((args.run / "tags.json").read_bytes())
        (backup / "review.json").write_bytes(args.artifact.read_bytes())
        write(args.run / "tags.json", tags)
        notes_path = args.run / "reviewed-notes.json"
        if notes_path.exists():
            notes = load(notes_path)
            (backup / "reviewed-notes.json").write_bytes(notes_path.read_bytes())
        else:
            notes = {"tags": {}}
        notes["tags"].update(artifact["tags"])
        write(notes_path, notes)
        model_dir = args.run / "models/retrieval-review"
        model_dir.mkdir(parents=True, exist_ok=True)
        write(
            model_dir / "state.json",
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
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
