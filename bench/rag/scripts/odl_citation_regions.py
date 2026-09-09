"""Annotation-only replay of citation overflow. No question/gold or provider input."""

import argparse
import copy
import hashlib
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

SPACE = "page-1000-topleft"


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def validate(regions):
    require(isinstance(regions, list), "regions_not_list")
    for r in regions:
        require(isinstance(r, dict), "region_not_object")
        b = r.get("bbox")
        require(type(r.get("page")) is int and r["page"] > 0, "invalid_page")
        require(r.get("space") == SPACE, "invalid_space")
        require(isinstance(b, list) and len(b) == 4, "invalid_bbox")
        require(
            all(type(v) in (int, float) and math.isfinite(v) for v in b),
            "invalid_coordinate",
        )
        require(b[0] < b[2] and b[1] < b[3], "empty_bbox")
        # The viewer clamps coordinates; retain raw geometry but reject invisible boxes.
        require(
            max(0, b[0]) < min(1000, b[2]) and max(0, b[1]) < min(1000, b[3]),
            "off_page_bbox",
        )


def merge(regions):
    validate(regions)
    if len(regions) <= 12:
        return copy.deepcopy(regions)
    pages = dict.fromkeys(r["page"] for r in regions)
    require(len(pages) <= 12, "more_than_12_pages")
    return [
        {
            "page": p,
            "space": SPACE,
            "bbox": [
                op(r["bbox"][i] for r in regions if r["page"] == p)
                for i, op in enumerate((min, min, max, max))
            ],
        }
        for p in pages
    ]


def coverage(full, shown):
    return [
        i
        for i, r in enumerate(full)
        if any(
            s["page"] == r["page"]
            and s["bbox"][0] <= r["bbox"][0]
            and s["bbox"][1] <= r["bbox"][1]
            and s["bbox"][2] >= r["bbox"][2]
            and s["bbox"][3] >= r["bbox"][3]
            for s in shown
        )
    ]


def replay(answer):
    results = []
    for number, citation in enumerate(answer["citations"], 1):
        matches = [
            (ci, pi, p)
            for ci, call in enumerate(answer["calls"])
            for pi, p in enumerate(call.get("passages", []))
            if (p["file_id"], p["chunk_id"])
            == (citation["fileId"], citation["chunkId"])
        ]
        original = citation.get("regions", [])
        row = {
            "citation_number": number,
            "attached": number in answer["citation_numbers"],
            "file_id": citation["fileId"],
            "chunk_id": citation["chunkId"],
            "original_regions": original,
            "candidate_regions": None,
            "passage_locators": [
                {"call_index": ci, "passage_index": pi} for ci, pi, _ in matches
            ],
        }
        try:
            require(bool(matches), "missing_passage")
            first = matches[0][2]
            full = first.get("regions", [])
            row["full_regions"] = full
            require(
                all(
                    (p.get("regions", []), p.get("page_start"), p.get("page_end"))
                    == (full, first.get("page_start"), first.get("page_end"))
                    for _, _, p in matches
                ),
                "conflicting_passages",
            )
            validate(full)
            require(original == full[:12], "original_not_expected_prefix")
            if full:
                start, end = first.get("page_start"), first.get("page_end")
                require(
                    type(start) is int and type(end) is int and 1 <= start <= end,
                    "invalid_page_span",
                )
                require(
                    all(start <= r["page"] <= end for r in full),
                    "region_outside_page_span",
                )
                require(
                    citation.get("pageStart") == start
                    and citation.get("pageEnd") == end,
                    "citation_page_mismatch",
                )
            candidate = merge(full)
            retained = coverage(full, candidate)
            require(retained == list(range(len(full))), "coverage_loss")
            row.update(
                status="merged" if len(full) > 12 else "unchanged",
                candidate_regions=candidate,
                original_retained_indices=coverage(full, original),
                candidate_retained_indices=retained,
            )
        except ValueError as exc:
            row.update(status="flagged", reason=str(exc))
            for field in ("original_regions", "full_regions"):
                if field in row:
                    try:
                        json.dumps(row[field], allow_nan=False)
                    except (TypeError, ValueError):
                        row[field + "_invalid_repr"] = repr(row.pop(field))
        results.append(row)
    return {"turn_id": answer["turn_id"], "citations": results}


def check():
    small = [{"page": 1, "space": SPACE, "bbox": [1, 2, 3, 4]}]
    assert merge(small) == small and merge(small) is not small
    full = [
        {"page": i % 2 + 1, "space": SPACE, "bbox": [i, i, i + 2, i + 3]}
        for i in range(25)
    ]
    assert len(merge(full)) == 2 and len(coverage(full, merge(full))) == 25
    p = {
        "file_id": "f",
        "chunk_id": "c",
        "regions": full,
        "page_start": 1,
        "page_end": 2,
    }
    a = {
        "turn_id": "existing",
        "citations": [
            {
                "fileId": "f",
                "chunkId": "c",
                "regions": full[:12],
                "pageStart": 1,
                "pageEnd": 2,
            }
        ],
        "calls": [{"passages": [p]}],
        "citation_numbers": [1],
    }
    before = copy.deepcopy(a)
    assert replay(a)["citations"][0]["status"] == "merged" and a == before
    for bad in (
        [{"page": i + 1, "space": SPACE, "bbox": [1, 2, 3, 4]} for i in range(13)],
        [{"page": 0, "space": SPACE, "bbox": [1, 2, 3, 4]}],
        [{"page": 1, "space": SPACE, "bbox": [1, 2, float("nan"), 4]}],
        [{"page": 1, "space": SPACE, "bbox": [3, 2, 1, 4]}],
    ):
        try:
            merge(bad)
        except ValueError:
            continue
        raise AssertionError("invalid geometry accepted")
    a["citations"][0]["pageEnd"] = 3
    assert replay(a)["citations"][0]["reason"] == "citation_page_mismatch"
    a["citations"][0]["fileId"] = "other"
    assert replay(a)["citations"][0]["reason"] == "missing_passage"
    invalid = copy.deepcopy(before)
    invalid["turn_id"] = "nonfinite"
    invalid["calls"][0]["passages"][0]["regions"][0]["bbox"][2] = float("nan")
    invalid["citations"][0]["regions"][0]["bbox"][2] = float("nan")
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "answers.jsonl"
        destination = Path(directory) / "replay.json"
        source.write_text(json.dumps(invalid) + "\n", encoding="utf-8")
        subprocess.run(
            [
                sys.executable,
                __file__,
                "--answers",
                str(source),
                "--output",
                str(destination),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(destination.read_text(encoding="utf-8"))["turns"][0]
        flagged = result["citations"][0]
        assert (
            flagged["status"] == "flagged" and flagged["reason"] == "invalid_coordinate"
        )
        assert flagged["candidate_regions"] is None
        for field in ("original_regions", "full_regions"):
            assert field not in flagged and "nan" in flagged[field + "_invalid_repr"]
        assert result["input"] == {
            "path": str(source),
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "line": 1,
        }
    print(
        "No-op, overflow, multiple pages, invalid geometry, identity, immutability "
        "and nonfinite CLI serialization passed"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--answers", nargs="+", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    if not args.answers or not args.output:
        parser.error("--answers and --output required")
    output = {
        "schema": "odl-citation-region-replay-v1",
        "evaluation_kind": "annotation_replay",
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "turns": [],
    }
    seen = set()
    for path in args.answers:
        raw = path.read_bytes()
        for line, text in enumerate(raw.decode("utf-8").splitlines(), 1):
            answer = json.loads(text)
            require(answer["turn_id"] not in seen, "duplicate_turn")
            seen.add(answer["turn_id"])
            row = replay(answer)
            row["input"] = {
                "path": str(path),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "line": line,
            }
            output["turns"].append(row)
    serialized = json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False)
    with args.output.open("x", encoding="utf-8") as f:
        f.write(serialized)


if __name__ == "__main__":
    main()
