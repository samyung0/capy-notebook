"""One frozen locator candidate. Local, cached retrieval; no provider or DB calls.

Synthetic rankings are deterministic stress inputs, not embedding measurements.
The known 629-query comparison reconstructs current RRF from uncensored scores.
"""

import collections
import hashlib
import json
import math
import re
import sys
import time
import unicodedata
from pathlib import Path

LABELS = {
    "question": "questions?|problems?|exercises?|preguntas?|ejercicios?|exercices?|問題|问题|문제|문항|問|题|題",
    "section": "sections?|chapters?|cap[ií]tulos?|secci[oó]n(?:es)?|chapitres?|parties?|章|節|节|절|장",
    "table": "tables?|tablas?|tableaux?|표|表",
    "page": "pages?|p[aá]ginas?|p[aá]g[.]?|페이지|ページ|쪽|頁|页",
}
NUMBER = r"(?:[0-9]+(?:[.][0-9]+)*|[零〇一二三四五六七八九十百千两兩]+|[ivxlcdm]+)"
AFTER = r"(?![0-9A-Za-z.])"
PREFIX = r"(?<![A-Za-z])"
PATTERNS = [
    (
        kind,
        re.compile(
            PREFIX + "(?:" + labels + r")\s*(?:第\s*)?(?P<n>" + NUMBER + ")" + AFTER
        ),
    )
    for kind, labels in LABELS.items()
] + [
    (
        kind,
        re.compile(
            r"第?\s*(?P<n>"
            + NUMBER
            + r")\s*(?:번\s*)?(?:"
            + labels
            + ")"
            + r"(?![A-Za-z])"
        ),
    )
    for kind, labels in {
        "question": "問|题|題|문제|문항",
        "section": "章|節|节|절|장",
        "page": "頁|页|ページ|쪽|페이지",
    }.items()
]
EXTRA_NUMBER = re.compile(
    r"^\s*(?:[-–—~〜,、]|and\b|or\b|et\b|y\b|e\b|と|及|和|및|와|과)\s*" + NUMBER,
    re.IGNORECASE,
)


def read(path):
    return json.loads(path.read_text())


def sha(value):
    return hashlib.sha256(value).hexdigest()


def save(path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


def norm(text):
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def number(text):
    value = norm(text)
    if re.fullmatch(r"[0-9]+(?:[.][0-9]+)*", value):
        return ".".join(str(int(part)) for part in value.split("."))
    digits = {c: i for i, c in enumerate("零一二三四五六七八九")}
    digits.update({"〇": 0, "两": 2, "兩": 2})
    if all(c in digits for c in value):
        return str(int("".join(str(digits[c]) for c in value)))
    if all(c in digits or c in "十百千" for c in value):
        total, pending = 0, 0
        for c in value:
            if c in digits:
                pending = digits[c]
            else:
                total += (pending or 1) * {"十": 10, "百": 100, "千": 1000}[c]
                pending = 0
        return str(total + pending)
    roman = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
    if re.fullmatch(
        r"m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})", value
    ):
        return str(
            sum(
                -roman[c]
                if i + 1 < len(value) and roman[c] < roman[value[i + 1]]
                else roman[c]
                for i, c in enumerate(value)
            )
        )
    return None


def parse(text, anchored=False):
    text = norm(text)
    found, multiple = set(), False
    for kind, pattern in PATTERNS:
        for match in pattern.finditer(text):
            if anchored and match.start() != 0:
                continue
            n = number(match["n"])
            if n is not None:
                found.add((kind, n))
                multiple |= bool(EXTRA_NUMBER.match(text[match.end() :]))
    return found, multiple


def extract(chunk):
    """No inferred ancestry, section_path, physical pages, or gold labels."""
    evidence = []
    for index, line in enumerate(chunk["text"].splitlines()):
        labels, _ = parse(line, anchored=True)
        for kind, n in sorted(labels):
            evidence.append(
                {
                    "kind": kind,
                    "number": n,
                    "provenance": "body_line",
                    "line": index,
                    "text": line,
                }
            )
    for block in chunk.get("native_blocks", []):
        if block["kind"] not in ("heading", "table", "question", "item"):
            continue
        labels, _ = parse(block.get("label", block["text"]), anchored=True)
        if not labels:
            inferred = (
                "section"
                if block["kind"] == "heading"
                else block.get("item_type", block["kind"])
            )
            match = re.match(
                r"^\s*(" + NUMBER + r")(?:[.)、]\s*|\s+|$)",
                norm(block.get("label", block["text"])),
            )
            if match and inferred in LABELS and number(match[1]) is not None:
                labels.add((inferred, number(match[1])))
        for kind, n in sorted(labels):
            evidence.append(
                {
                    "kind": kind,
                    "number": n,
                    "provenance": "native_" + block["kind"],
                    "block_id": block["id"],
                    "text": block["text"],
                }
            )
    for page in chunk.get("printed_pages", []):
        n = number(page["label"])
        if n is not None:
            evidence.append(
                {
                    "kind": "page",
                    "number": n,
                    "provenance": page["provenance"],
                    "text": page["label"],
                }
            )
    return evidence


def decide(query, chunks, sources, metadata):
    labels, multiple = parse(query["q"])
    if not labels:
        return {"status": "no_locator", "promote": []}
    if multiple or len(labels) != 1:
        return {"status": "multiple_locators", "promote": [], "parsed": sorted(labels)}
    # Exact visible reference text only. A fixture's file_id is never query input.
    text = norm(query["q"])
    named = {
        s["file_id"]
        for s in sources
        if s["file_id"] in {c["file_id"] for c in chunks}
        and any(
            re.search(
                r"(?<![A-Za-z0-9_.-])" + re.escape(norm(s[k])) + r"(?![A-Za-z0-9_.-])",
                text,
            )
            for k in ("filename", "source_ref")
            if s.get(k)
        )
    }
    if not named and re.search(r"\S+[.](?:pdf|docx?|pptx?|xlsx?|txt)\b", text):
        return {"status": "unknown_source", "promote": [], "parsed": sorted(labels)}
    if len(named) > 1:
        return {
            "status": "ambiguous_source",
            "promote": [],
            "parsed": sorted(labels),
            "resolved_sources": sorted(named),
        }
    kind, n = next(iter(labels))
    matched = sorted(
        c["id"]
        for c in chunks
        if (not named or c["file_id"] in named)
        and any(e["kind"] == kind and e["number"] == n for e in metadata[c["id"]])
    )
    if len(matched) != 1:
        return {
            "status": "missing" if not matched else "ambiguous_locator",
            "promote": [],
            "parsed": sorted(labels),
            "matches": matched,
            "resolved_sources": sorted(named),
        }
    return {
        "status": "promote",
        "promote": matched,
        "parsed": sorted(labels),
        "matches": matched,
        "resolved_sources": sorted(named),
    }


def capped(ids, chunks):
    counts, kept, overflow = collections.Counter(), [], []
    for cid in ids:
        fid = chunks[cid]["file_id"]
        if counts[fid] < 4:
            kept.append(cid)
            counts[fid] += 1
        else:
            overflow.append(cid)
    return (kept + overflow)[:5]


def current(features):
    rows = {r["id"]: r for r in features["rows"]}
    dense = sorted(rows, key=lambda c: (-rows[c]["cosine"], c))[:40]
    lexical = sorted(
        (c for c in rows if rows[c]["pg_match"]),
        key=lambda c: (
            -rows[c]["all_match"],
            -rows[c]["pg_score"],
            rows[c]["pg_tie"],
            c,
        ),
    )[:40]
    scores = {c: 1 / (60 + i) for i, c in enumerate(dense, 1)}
    for i, c in enumerate(lexical, 1):
        scores[c] = scores.get(c, 0) + (1 if rows[c]["exact"] else 0.5) / (60 + i)
    return sorted(scores, key=lambda c: (-scores[c], c))[:40]


def metrics(ids, query, chunks):
    def key(c):
        return (
            c if query.get("label_unit", "chunk") == "chunk" else chunks[c]["file_id"]
        )

    relevant = {c for c, grade in query["qrels"].items() if grade > 0}
    seen, grades = set(), []
    for cid in ids:
        label = key(cid)
        grades.append(query["qrels"].get(label, 0) if label not in seen else 0)
        seen.add(label)
    ideal = sum(
        (2**g - 1) / math.log2(i + 2)
        for i, g in enumerate(sorted(query["qrels"].values(), reverse=True)[:5])
    )
    return {
        "hit5": int(bool(seen & relevant)),
        "recall5": len(seen & relevant) / len(relevant) if relevant else None,
        "ndcg5": sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(grades))
        / ideal
        if ideal
        else None,
    }


def freeze(root, fixture, previous):
    assert not (root / "freeze.json").exists()
    root.mkdir(parents=True, exist_ok=True)
    files = {
        "fixture": fixture,
        "previous_prepared": previous / "prepared.json",
        "previous_features": previous / "features.jsonl",
        "jlpt": previous.parent / "2026-09-13-jlpt-lookup/snapshot.json",
        "real_controls": fixture.parent / "full-document-controls.json",
    }
    save(
        root / "freeze.json",
        {
            "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "script_sha256": sha(Path(__file__).read_bytes()),
            "inputs": {
                k: {"path": str(p.resolve()), "sha256": sha(p.read_bytes())}
                for k, p in files.items()
            },
            "candidate": "All-language typed numeric label grammar, NFKC/casefold, direct line-start/native label extraction; no inherited heading or physical page. Exact source filename/ref substring; exactly one locator and one matching chunk in authorized scope -> prepend to current40, retain ordinary candidates and existing cap4/fill5. Ambiguity/missing/multiple labels -> unchanged. No tuning.",
            "synthetic_ranking": "SHA256(query_id + chunk_id) order, fixed independently of qrels; precision and abstention stress test, not model quality.",
            "known_cohort": "624 inspected multilingual questions and 5 inspected JLPT diagnostics. Cached current RRF scores; no provider calls.",
        },
    )
    print("frozen", root)


def evaluate(data, rankings):
    chunks = {c["id"]: c for c in data["chunks"]}
    assert len(chunks) == len(data["chunks"])
    metadata = {cid: extract(c) for cid, c in chunks.items()}
    rows = []
    for q in data["queries"]:
        scoped = [c for c in chunks.values() if c["scope"] == q["scope"]]
        before = rankings[q["id"]]
        assert len(before) == len(set(before)) and set(before) <= {
            c["id"] for c in scoped
        }
        decision = decide(q, scoped, data["sources"], metadata)
        after = decision["promote"] + [
            c for c in before if c not in decision["promote"]
        ]
        old, new = capped(before, chunks), capped(after[:40], chunks)
        if "expected" in q:
            assert old == q["expected"], q["id"]
        correct = all(
            q["qrels"].get(
                c if q.get("label_unit", "chunk") == "chunk" else chunks[c]["file_id"],
                0,
            )
            > 0
            for c in decision["promote"]
        )
        rows.append(
            {
                "id": q["id"],
                "locale": q["locale"],
                "kind": q["kind"],
                "cohort": q.get("cohort", "synthetic"),
                "split": q.get("split", "control"),
                "query": q["q"],
                "decision": decision,
                "promotion_correct": correct if decision["promote"] else None,
                "before": old,
                "after": new,
                "before_metrics": metrics(old, q, chunks),
                "after_metrics": metrics(new, q, chunks),
                "candidate_added": [c for c in decision["promote"] if c not in before],
                "should_promote": q.get("should_promote"),
                "evidence": {c: metadata[c] for c in decision.get("matches", [])},
            }
        )
    return rows, metadata


def run(root):
    manifest = read(root / "freeze.json")
    assert manifest["script_sha256"] == sha(Path(__file__).read_bytes())
    inputs = manifest["inputs"]
    for item in inputs.values():
        assert sha(Path(item["path"]).read_bytes()) == item["sha256"]
    synthetic = read(Path(inputs["fixture"]["path"]))
    ranks = {
        q["id"]: sorted(
            (c["id"] for c in synthetic["chunks"] if c["scope"] == q["scope"]),
            key=lambda c: sha((q["id"] + c).encode()),
        )
        for q in synthetic["queries"]
    }
    rows, meta = evaluate(synthetic, ranks)
    previous = read(Path(inputs["previous_prepared"]["path"]))
    jlpt = read(Path(inputs["jlpt"]["path"]))
    by_id = {c["id"]: c for c in jlpt["chunks"]}
    for c in previous["chunks"]:
        if c["id"] in by_id:
            c["text"] = by_id[c["id"]]["text"]
    previous["sources"] = list(
        {
            c["file_id"]: {"file_id": c["file_id"], "filename": c["file_name"]}
            for c in jlpt["chunks"]
        }.values()
    )
    features = [
        json.loads(line)
        for line in Path(inputs["previous_features"]["path"]).read_text().splitlines()
    ]
    known_rows, known_meta = evaluate(previous, {f["id"]: current(f) for f in features})
    rows += known_rows
    meta.update(known_meta)
    save(root / "results.json", rows)
    save(root / "metadata.json", meta)
    groups = collections.defaultdict(list)
    for row in rows:
        for key in (
            row["cohort"],
            row["cohort"] + ":" + row["locale"],
            row["cohort"] + ":" + row["kind"],
            row["cohort"] + ":" + row["split"],
        ):
            groups[key].append(row)
    summary = {}
    for name, part in groups.items():
        promoted = [r for r in part if r["decision"]["promote"]]
        summary[name] = {
            "n": len(part),
            "statuses": dict(
                collections.Counter(r["decision"]["status"] for r in part)
            ),
            "promotions": len(promoted),
            "correct_promotions": sum(r["promotion_correct"] for r in promoted),
            "false_promotions": [
                r["id"] for r in promoted if not r["promotion_correct"]
            ],
            "changed": sum(r["before"] != r["after"] for r in part),
            "hit_gains": [
                r["id"]
                for r in part
                if r["after_metrics"]["hit5"] > r["before_metrics"]["hit5"]
            ],
            "hit_losses": [
                r["id"]
                for r in part
                if r["after_metrics"]["hit5"] < r["before_metrics"]["hit5"]
            ],
            "before_hits": sum(r["before_metrics"]["hit5"] for r in part),
            "after_hits": sum(r["after_metrics"]["hit5"] for r in part),
        }
    save(root / "summary.json", summary)
    print(
        json.dumps(
            {k: v for k, v in summary.items() if ":" not in k},
            ensure_ascii=False,
            indent=2,
        )
    )


def external(root, path):
    """Score later full-document metadata with the same frozen candidate."""
    frozen = read(root / "freeze.json")
    assert frozen["script_sha256"] == sha(Path(__file__).read_bytes())
    controls = frozen["inputs"]["real_controls"]
    assert sha(Path(controls["path"]).read_bytes()) == controls["sha256"]
    assert not (root / "external-freeze.json").exists()
    save(
        root / "external-freeze.json",
        {
            "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "candidate_freeze_sha256": sha((root / "freeze.json").read_bytes()),
            "input": {"path": str(path.resolve()), "sha256": sha(path.read_bytes())},
            "evaluation": "Root-authored locator-unit labels; source/page correctness and anchor presence reported separately. No gold fields enter candidate extraction or source resolution. No retrieval baseline unless supplied in input.",
        },
    )
    data, fixture = read(path), read(Path(controls["path"]))
    chunks = {c["id"]: c for c in data["chunks"]}
    assert len(chunks) == len(data["chunks"])
    metadata = {cid: extract(c) for cid, c in chunks.items()}
    rows = []
    for case in fixture["cases"]:
        decision = decide(
            {"q": case["query"]}, data["chunks"], data["sources"], metadata
        )
        expected = case["expected"]
        matches = []
        for cid in decision.get("matches", []):
            c = chunks[cid]
            pages = c.get(
                "physical_pages",
                list(
                    range(
                        c.get("page_start", 0),
                        c.get("page_end", c.get("page_start", 0)) + 1,
                    )
                ),
            )
            matches.append(
                {
                    "chunk": c,
                    "evidence": metadata[cid],
                    "source_page_correct": c["file_id"] == expected.get("source_id")
                    and bool(set(pages) & set(expected.get("physical_pages", []))),
                    "anchors_present": [
                        a
                        for a in expected.get("anchors", [])
                        if norm(a).replace(" ", "") in norm(c["text"]).replace(" ", "")
                    ],
                }
            )
        row = {
            "id": case["id"],
            "locale": case["locale"],
            "query": case["query"],
            "expected": expected,
            "decision": decision,
            "matches": matches,
            "promotion_correct": bool(matches and matches[0]["source_page_correct"])
            if decision["promote"]
            else None,
        }
        if case["id"] in data.get("rankings", {}):
            before = data["rankings"][case["id"]]
            after = decision["promote"] + [
                c for c in before if c not in decision["promote"]
            ]
            row.update(before=capped(before, chunks), after=capped(after[:40], chunks))
        rows.append(row)
    save(root / "external-results.json", rows)
    save(root / "external-metadata.json", metadata)
    print(
        json.dumps(
            {
                "cases": len(rows),
                "statuses": dict(
                    collections.Counter(r["decision"]["status"] for r in rows)
                ),
                "promotions": sum(bool(r["decision"]["promote"]) for r in rows),
                "correct_source_page_promotions": sum(
                    r["promotion_correct"] is True for r in rows
                ),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def check():
    assert (
        number("１２.０３") == "12.3"
        and number("十二") == "12"
        and number("XIV") == "14"
    )
    assert parse("Translate 問題 10")[0] == {("question", "10")}
    assert parse("第十二题")[0] == {("question", "12")}
    assert parse("3번 문제")[0] == {("question", "3")}
    assert parse("Question 2 and 3")[1]
    assert not extract(
        {
            "text": "There were 12 participants.",
            "section_path": "Question 12",
            "page_start": 12,
        }
    )
    print("locator self-check passed")


if __name__ == "__main__":
    if sys.argv[1] == "check":
        check()
    elif sys.argv[1] == "freeze":
        freeze(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
    elif sys.argv[1] == "run":
        run(Path(sys.argv[2]))
    elif sys.argv[1] == "external":
        external(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        raise SystemExit("check | freeze OUTPUT FIXTURE BM25_RAW | run OUTPUT")
