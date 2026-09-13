"""Authorized post-hoc punctuation control; original candidate stays immutable."""

import copy
import hashlib
import json
import re
import sys
import time
from pathlib import Path

import structured_locator_eval as base


def normalize(query):
    return re.sub(r"[.!?。！？]+$", "", query.strip()).rstrip()


def freeze(root):
    assert normalize("Find section 3.1 in file.pdf.") == "Find section 3.1 in file.pdf"
    assert normalize("Section 3.1") == "Section 3.1"
    assert normalize("file.pdf") == "file.pdf"
    assert normalize("file.v2.pdf? ") == "file.v2.pdf"
    assert normalize("第2.1节。") == "第2.1节"
    paths = [
        root / name
        for name in (
            "freeze.json",
            "results.json",
            "metadata.json",
            "external-inputs-freeze.json",
        )
    ]
    paths += [
        root / arm / name
        for arm in ("current", "adjacent_atomic_boundary")
        for name in ("input.json", "external-results.json", "external-metadata.json")
    ]
    assert not (root / "punctuation-freeze.json").exists()
    base.save(
        root / "punctuation-freeze.json",
        {
            "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "wrapper_sha256": base.sha(Path(__file__).read_bytes()),
            "candidate_sha256": base.sha(Path(base.__file__).read_bytes()),
            "rule": "Strip outer whitespace, then only a final run of . ! ? 。 ！ ？ and preceding trailing whitespace. No internal punctuation, input metadata, original embedding queries, baseline lists, or semantic rules change. Authorized post-hoc mechanical diagnostic; no further tuning.",
            "inputs": {
                str(p.relative_to(root)): base.sha(p.read_bytes()) for p in paths
            },
        },
    )


def dataset(root):
    frozen = base.read(root / "freeze.json")
    inputs = frozen["inputs"]
    for item in inputs.values():
        assert base.sha(Path(item["path"]).read_bytes()) == item["sha256"]
    synthetic = base.read(Path(inputs["fixture"]["path"]))
    previous = base.read(Path(inputs["previous_prepared"]["path"]))
    jlpt = base.read(Path(inputs["jlpt"]["path"]))
    jlpt_chunks = {c["id"]: c for c in jlpt["chunks"]}
    for c in previous["chunks"]:
        if c["id"] in jlpt_chunks:
            c["text"] = jlpt_chunks[c["id"]]["text"]
    previous["sources"] = list(
        {
            c["file_id"]: {"file_id": c["file_id"], "filename": c["file_name"]}
            for c in jlpt["chunks"]
        }.values()
    )
    return {k: synthetic[k] + previous[k] for k in ("queries", "chunks", "sources")}


def run(root):
    frozen = base.read(root / "punctuation-freeze.json")
    assert frozen["wrapper_sha256"] == base.sha(Path(__file__).read_bytes())
    assert (
        frozen["candidate_sha256"]
        == base.sha(Path(base.__file__).read_bytes())
        == base.read(root / "freeze.json")["script_sha256"]
    )
    for name, expected in frozen["inputs"].items():
        assert base.sha((root / name).read_bytes()) == expected
    original = base.read(root / "results.json")
    data = dataset(root)
    # Ranking depends on the original query. Never re-embed or re-score the rewrite.
    inputs = base.read(root / "freeze.json")["inputs"]
    ranks = {
        f["id"]: base.current(f)
        for f in (
            json.loads(line)
            for line in Path(inputs["previous_features"]["path"])
            .read_text()
            .splitlines()
        )
    }
    for q in data["queries"]:
        if q["id"] not in ranks:
            ranks[q["id"]] = sorted(
                (c["id"] for c in data["chunks"] if c["scope"] == q["scope"]),
                key=lambda c, q=q: hashlib.sha256((q["id"] + c).encode()).hexdigest(),
            )
        q["original_query"] = q["q"]
        q["q"] = normalize(q["q"])
    rows, _ = base.evaluate(data, ranks)
    before = {r["id"]: r for r in original}
    queries = {q["id"]: q for q in data["queries"]}
    for row in rows:
        row["original_query"] = queries[row["id"]]["original_query"]
        assert row["before"] == before[row["id"]]["before"]
    base.save(root / "punctuation-results.json", rows)
    for arm in ("current", "adjacent_atomic_boundary"):
        part = base.read(root / arm / "input.json")
        chunks = {c["id"]: c for c in part["chunks"]}
        metadata = base.read(root / arm / "external-metadata.json")
        out = []
        for original_row in base.read(root / arm / "external-results.json"):
            row = copy.deepcopy(original_row)
            row["normalized_query"] = normalize(row["query"])
            decision = base.decide(
                {"q": row["normalized_query"]},
                part["chunks"],
                part["sources"],
                metadata,
            )
            row["decision"], row["matches"] = decision, []
            expected = row["expected"]
            for cid in decision.get("matches", []):
                c = chunks[cid]
                pages = list(range(c["page_start"], c["page_end"] + 1))
                row["matches"].append(
                    {
                        "chunk": c,
                        "evidence": metadata[cid],
                        "source_page_correct": c["file_id"] == expected.get("source_id")
                        and bool(set(pages) & set(expected.get("physical_pages", []))),
                        "anchors_present": [
                            a
                            for a in expected.get("anchors", [])
                            if base.norm(a).replace(" ", "")
                            in base.norm(c["text"]).replace(" ", "")
                        ],
                    }
                )
            row["promotion_correct"] = (
                bool(row["matches"] and row["matches"][0]["source_page_correct"])
                if decision["promote"]
                else None
            )
            out.append(row)
        base.save(root / arm / "punctuation-results.json", out)
    print(
        "punctuation replay complete",
        len(rows),
        "cached/synthetic + 28 per full-document arm",
    )


if __name__ == "__main__":
    {"freeze": freeze, "run": run}[sys.argv[1]](Path(sys.argv[2]))
