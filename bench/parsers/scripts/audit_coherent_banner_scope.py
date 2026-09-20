"""Check banner-only ancestry changes by heading occurrence, not title strings.

uv run --frozen python bench/parsers/scripts/audit_coherent_banner_scope.py
"""

from __future__ import annotations

import argparse

import evaluate_unseen_headings as evaluation
from experiment_coherent_banner_roles import OUT


def audit(old: list[dict], new: list[dict]) -> dict:
    assert len(old) == len(new)
    removed = {i for i, b in enumerate(new) if b.get("_heading_boundary_level")}
    prior, revised = [], []
    checked, errors = 0, []
    for i, (before, after) in enumerate(zip(old, new, strict=True)):
        # Both arms receive the same independently tested root-level correction.
        original = before if i in removed else after
        level = original.get("text_level")
        if original.get("type") == "text" and type(level) is int and level > 0:
            while prior and prior[-1][1] >= level:
                prior.pop()
            prior.append((i, level))
        boundary = after.get("_heading_boundary_level")
        if type(boundary) is int and boundary > 0:
            while revised and revised[-1][1] >= boundary:
                revised.pop()
        else:
            level = after.get("text_level")
            if after.get("type") == "text" and type(level) is int and level > 0:
                while revised and revised[-1][1] >= level:
                    revised.pop()
                revised.append((i, level))
        if evaluation.canonical(evaluation.body_text(before)):
            checked += 1
            expected = [entry for entry in prior if entry[0] not in removed]
            if revised != expected:
                errors.append(
                    {"index": i, "expected": expected, "actual": list(revised)}
                )
    return {
        "body_blocks_checked": checked,
        "scope_mismatch_count": len(errors),
        "mismatches": errors,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="+")
    args = parser.parse_args()
    records = []
    for path in sorted(OUT.glob("*/metrics.json")):
        id = path.parent.name
        if args.only and id not in args.only:
            continue
        status = evaluation.read(evaluation.LOCAL / "parse" / id / "status.json")
        attempt = evaluation.LOCAL / "parse" / status["attempt_directory"]
        result = {
            "id": id,
            **audit(
                evaluation.read(attempt / "baseline/content_list.json"),
                evaluation.read(path.parent / "candidate-blocks.json"),
            ),
        }
        evaluation.write(path.parent / "scope-occurrence-audit.json", result)
        records.append(result)
    evaluation.write(OUT / "scope-occurrence-audit.json", records)
    print(
        "Documents",
        len(records),
        "body blocks",
        sum(r["body_blocks_checked"] for r in records),
        "scope mismatches",
        sum(r["scope_mismatch_count"] for r in records),
    )
    assert all(r["scope_mismatch_count"] == 0 for r in records)


if __name__ == "__main__":
    main()
