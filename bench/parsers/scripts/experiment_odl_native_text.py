"""Source-confirmed overprint deletion and paragraph-role experiment, offline only."""

from __future__ import annotations

import argparse
import copy
import hashlib
import itertools
import json
import re
import time
from collections import Counter
from dataclasses import asdict
from pathlib import Path

import pymupdf
from experiment_odl_native_tables import chunk_native_bounded


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def compact(text):
    return "".join(text.split())


def runs(text):
    return [
        (char, len(list(group))) for char, group in itertools.groupby(compact(text))
    ]


def rect_for(block, page):
    box = block["bbox"]
    return pymupdf.Rect(
        box[0] * page.rect.width / 1000,
        box[1] * page.rect.height / 1000,
        box[2] * page.rect.width / 1000,
        box[3] * page.rect.height / 1000,
    )


def center_inside(box, area):
    return area.contains(pymupdf.Point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2))


def disjoint(box, area):
    return box[0] > area.x1 or box[2] < area.x0 or box[1] > area.y1 or box[3] < area.y0


def source_text(groups, area):
    return "\n".join(
        "".join(
            char["c"]
            for span in line["spans"]
            if not disjoint(span["bbox"], area)
            for char in span["chars"]
            if center_inside(char["bbox"], area)
        )
        for group in groups
        if not disjoint(group["bbox"], area)
        for line in group.get("lines", [])
        if abs(line["dir"][0] - 1) < 0.01 and abs(line["dir"][1]) < 0.01
    )


def overprints(traces, area):
    """Count only identical source glyphs painted within six percent of an em."""
    clusters = []
    for span in traces:
        if span["opacity"] < 0.99 or span["type"] == 3:
            continue
        if abs(span["dir"][0] - 1) > 0.01 or abs(span["dir"][1]) > 0.01:
            continue
        for code, glyph, origin, box in span["chars"]:
            if not center_inside(box, area):
                continue
            key = (code, glyph, span["font"], round(span["size"], 3))
            match = next(
                (
                    c
                    for c in reversed(clusters[-8:])
                    if c["key"] == key
                    and max(abs(a - b) for a, b in zip(c["origin"], origin))
                    <= span["size"] * 0.06
                ),
                None,
            )
            if match is None:
                clusters.append({"key": key, "origin": origin, "count": 1})
            else:
                match["count"] += 1
    duplicates = Counter()
    for cluster in clusters:
        if cluster["count"] > 1:
            duplicates[chr(cluster["key"][0])] += cluster["count"] - 1
    return duplicates, [c for c in clusters if c["count"] > 1]


def delete_supported_repeats(text, source, duplicates):
    before, after = runs(text), runs(source)
    if len(before) != len(after) or not before:
        return text, {}
    removed = Counter()
    for (char, count), (other, target) in zip(before, after):
        if char != other or target > count:
            return text, {}
        removed[char] += count - target
    removed += Counter()  # Drop zero-count entries.
    if not removed or any(removed[c] > duplicates[c] for c in removed):
        return text, {}
    output, run_index, seen = [], -1, 0
    last, separated = None, False
    for char in text:
        if char.isspace():
            output.append(char)
            separated = True
            continue
        if char != last:
            run_index += 1
            seen = 0
            last = char
        elif separated and after[run_index][1] < before[run_index][1]:
            # A compact run spanning words cannot safely allocate deleted copies.
            return text, {}
        separated = False
        seen += 1
        if seen <= after[run_index][1]:
            output.append(char)
    result = "".join(output)
    assert compact(result) == compact(source)
    return result, dict(removed)


def same_source_paragraph(first, following, groups, page):
    text = first["text"].strip()
    tail = following.get("text", "").lstrip()
    if len(text) < 35 or text[-1] in ".!?。！？:：;；" or not tail[:1].islower():
        return None
    if following.get("type") != "text" or following.get("text_level"):
        return None
    a, b = rect_for(first, page), rect_for(following, page)
    if not 0 <= b.y0 - a.y1 <= a.height or abs(a.x1 - b.x1) > a.height:
        return None
    for group_index, group in enumerate(groups):
        lines = group.get("lines", [])
        for line_index, (line, next_line) in enumerate(itertools.pairwise(lines)):
            if any(abs(item["dir"][0] - 1) > 0.01 for item in [line, next_line]):
                continue
            line_text = "".join(c["c"] for s in line["spans"] for c in s["chars"])
            next_text = "".join(c["c"] for s in next_line["spans"] for c in s["chars"])
            prefix = compact(next_text).rstrip("-‐‑")
            if compact(text) != compact(line_text) or len(prefix) < 12:
                continue
            if not compact(tail).startswith(prefix):
                continue
            if not center_inside(line["bbox"], a) or not center_inside(
                next_line["bbox"], b
            ):
                continue
            return {
                "source_group": group_index,
                "source_line": line_index,
                "next_source_line": next_text,
            }
    return None


def repair_text(blocks, pdf, *, paragraphs=False):
    """Return rewritten copies and source evidence; all geometry stays unchanged."""
    revised, decisions, cache, traces = copy.deepcopy(blocks), [], {}, {}
    with pymupdf.open(pdf) as document:
        for index, block in enumerate(revised):
            if block.get("type") != "text" or len(block.get("bbox", [])) != 4:
                continue
            repeat = re.search(r"(\S)\1{2,}", block.get("text", ""))
            heading = (
                paragraphs and block.get("text_level") and index + 1 < len(revised)
            )
            if heading:
                following = revised[index + 1]
                text = block["text"].strip()
                heading = (
                    len(text) >= 35
                    and text[-1] not in ".!?。！？:：;；"
                    and following.get("text", "").lstrip()[:1].islower()
                    and following.get("page_idx") == block["page_idx"]
                    and not following.get("text_level")
                )
            if not repeat and not heading:
                continue
            page_index = block["page_idx"]
            page = document[page_index]
            if page.rotation:
                continue
            if page_index not in cache:
                cache[page_index] = page.get_text(
                    "rawdict",
                    flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES,
                )["blocks"]
            groups = cache[page_index]
            if repeat:
                area = rect_for(block, page)
                source = source_text(groups, area)
                changed, removed = delete_supported_repeats(
                    block["text"], source, Counter(block["text"])
                )
                if removed:
                    if page_index not in traces:
                        traces[page_index] = page.get_texttrace()
                    duplicates, clusters = overprints(traces[page_index], area)
                    if any(count > duplicates[char] for char, count in removed.items()):
                        continue
                    decisions.append(
                        {
                            "index": index,
                            "page": page_index + 1,
                            "kind": "overprint",
                            "before": block["text"],
                            "after": changed,
                            "removed": removed,
                            "source_text": source,
                            "clusters": clusters,
                        }
                    )
                    block["text"] = changed
            if heading:
                following = revised[index + 1]
                if (
                    following.get("page_idx") != page_index
                    or len(following.get("bbox", [])) != 4
                ):
                    continue
                proof = same_source_paragraph(block, following, groups, page)
                if proof:
                    decisions.append(
                        {
                            "index": index,
                            "page": page_index + 1,
                            "kind": "paragraph",
                            "before": block["text"],
                            "level": block["text_level"],
                            **proof,
                        }
                    )
                    del block["text_level"]
    assert len(revised) == len(blocks)
    for before, after in zip(blocks, revised):
        assert {k: v for k, v in before.items() if k not in {"text", "text_level"}} == {
            k: v for k, v in after.items() if k not in {"text", "text_level"}
        }
    return revised, decisions


def judge(chunks, check):
    candidates = [
        c
        for c in chunks
        if c.page_start is not None and c.page_start <= check["page"] <= c.page_end
    ]
    if check.get("kind") == "continuation":
        hits = [
            i
            for i, c in enumerate(candidates)
            if compact(check["end"]) in compact(c.text) and check["start"] in c.text
        ]
        passed = bool(hits) and all(
            check["start"] not in c.section_path for c in candidates
        )
    else:
        expected = compact(check["expected"])
        pattern = re.compile(
            r"(?<!"
            + re.escape(expected[0])
            + ")"
            + re.escape(expected)
            + r"(?!"
            + re.escape(expected[-1])
            + ")"
        )
        hits = [
            i
            for i, c in enumerate(candidates)
            if any(
                pattern.search(compact(value)) for value in (c.text, c.indexed_text())
            )
        ]
        passed = bool(hits)
    return {"id": check["id"], "pass": passed, "page_chunk_indices": hits}


def check():
    from pipeline.retrieval.chunking import Chunk

    label = {"id": "body-after-equal-ancestor", "page": 1, "expected": "A.1 label"}
    assert judge(
        [Chunk(text="A.1 label", section_path="A", page_start=1, page_end=1)], label
    )["pass"]
    assert not judge(
        [Chunk(text="AAA.1 label", section_path="A", page_start=1, page_end=1)], label
    )["pass"]
    assert (
        delete_supported_repeats("AAABBB book 1000", "AB book 1000", Counter(A=2, B=2))[
            0
        ]
        == "AB book 1000"
    )
    assert delete_supported_repeats("AAABBB", "AB", Counter())[0] == "AAABBB"
    assert delete_supported_repeats("book", "bok", Counter())[0] == "book"
    assert delete_supported_repeats("AAABBB", "AX", Counter(A=2, B=2))[0] == "AAABBB"
    for original, source in [
        ("100000 0", "1000 0"),
        ("100000\n00", "1000\n00"),
        ("AAABBB B", "AB B"),
    ]:
        assert delete_supported_repeats(original, source, Counter(original)) == (
            original,
            {},
        )
    assert delete_supported_repeats("AAA 1000 0", "A 1000 0", Counter(A=2))[0] == (
        "A 1000 0"
    )
    trace = {
        "opacity": 1,
        "type": 0,
        "dir": (1, 0),
        "font": "Test",
        "size": 10,
        "chars": [(65, 1, (x, 10), (x, 0, x + 10, 10)) for x in [0, 0.15, 0.3, 15, 30]],
    }
    assert overprints([trace], pymupdf.Rect(0, 0, 50, 20))[0] == Counter(A=2)
    trace["opacity"] = 0
    assert not overprints([trace], pymupdf.Rect(0, 0, 50, 20))[0]
    print(
        "Source-count correspondence and protected legitimate repetition checks passed"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--checks", type=Path)
    parser.add_argument(
        "--manifest",
        type=Path,
        help="canonical source/parsed-copy/native-output manifest",
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not args.root or not args.output or not args.checks:
        parser.error("root, output and --checks required")
    args.output.mkdir(parents=True, exist_ok=False)
    sources, frozen = read(args.root / "sources.json"), read(args.checks)
    assert sha(args.root / "sources.json") == frozen["sources_sha256"]
    if args.manifest:
        entries = read(args.manifest)["entries"]
        assert {e["id"] for e in entries} == set(sources)
        for entry in entries:
            name = entry["id"]
            assert entry["source_pdf_sha256"] == sources[name]["pdf_sha256"]
            for path, digest in [
                ("source_pdf", "source_pdf_sha256"),
                ("parsed_pdf", "parsed_pdf_sha256"),
                ("content_list", "content_sha256"),
            ]:
                assert sha(entry[path]) == entry[digest]
            sources[name] = {
                "pdf": entry["parsed_pdf"],
                "pdf_sha256": entry["parsed_pdf_sha256"],
                "content": entry["content_list"],
                "content_sha256": entry["content_sha256"],
                "pages": entry["pages"],
            }
        save(
            args.output / "manifest.json",
            {
                "path": str(args.manifest.resolve()),
                "sha256": sha(args.manifest),
                "sources": sources,
            },
        )
    results = []
    for name, source in sources.items():
        assert sha(source["pdf"]) == source["pdf_sha256"]
        assert sha(source["content"]) == source["content_sha256"]
        blocks = read(source["content"])
        for arm in ["baseline", "overprint", "paragraph"]:
            started = time.perf_counter()
            revised, decisions = (
                (blocks, [])
                if arm == "baseline"
                else repair_text(blocks, source["pdf"], paragraphs=arm == "paragraph")
            )
            seconds = time.perf_counter() - started
            _, chunks, _ = chunk_native_bounded(revised)
            target = args.output / name / arm
            save(target / "content_list.json", revised)
            save(
                target / "chunks.json",
                [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks],
            )
            save(target / "decisions.json", decisions)
            scored = [judge(chunks, c) for c in frozen["checks"] if c["case"] == name]
            results.append(
                {
                    "case": name,
                    "arm": arm,
                    "pages": source["pages"],
                    "seconds": seconds,
                    "changes": len(decisions),
                    "chunks": len(chunks),
                    "checks": scored,
                }
            )
    save(
        args.output / "summary.json",
        {
            "script_sha256": sha(__file__),
            "checks_sha256": sha(args.checks),
            "records": results,
        },
    )
    for arm in ["baseline", "overprint", "paragraph"]:
        rows = [r for r in results if r["arm"] == arm]
        print(
            arm,
            "changes",
            sum(r["changes"] for r in rows),
            "checks",
            sum(c["pass"] for r in rows for c in r["checks"]),
            "seconds",
            round(sum(r["seconds"] for r in rows), 3),
        )


if __name__ == "__main__":
    main()
