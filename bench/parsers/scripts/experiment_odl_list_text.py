"""Apply the frozen source overprint proof to lists without losing item boundaries."""

from __future__ import annotations

import argparse
import copy
import re
import time
from dataclasses import asdict
from pathlib import Path

from experiment_odl_heading_retention import load_chunks, retain_headings
from experiment_odl_native_tables import chunk_native_bounded
from experiment_odl_native_text import judge, read, repair_text, runs, save, sha


def restore_items(items, repaired):
    cursor, restored = 0, []
    for index, item in enumerate(items):
        output = []
        for char in item:
            if cursor < len(repaired) and char == repaired[cursor]:
                output.append(char)
                cursor += 1
            elif char.isspace():
                raise ValueError("whitespace changed")
        value = "".join(output)
        before, after = re.split(r"(\s+)", item), re.split(r"(\s+)", value)
        if len(before) != len(after) or any(
            a != b
            if a.isspace()
            else [c for c, _ in runs(a)] != [c for c, _ in runs(b)]
            for a, b in zip(before, after)
        ):
            raise ValueError("deletion crosses an item or whitespace boundary")
        restored.append(value)
        if index + 1 < len(items):
            if repaired[cursor : cursor + 1] != "\n":
                raise ValueError("item separator changed")
            cursor += 1
    if cursor != len(repaired):
        raise ValueError("unmatched repaired suffix")
    assert "\n".join(restored) == repaired
    return restored


def repair_lists(blocks, pdf):
    indices, proxies = [], []
    for index, block in enumerate(blocks):
        items = block.get("list_items")
        if (
            block.get("type") != "list"
            or not isinstance(items, list)
            or not all(isinstance(x, str) for x in items)
        ):
            continue
        if not re.search(r"(\S)\1{2,}", "\n".join(items)):
            continue
        indices.append(index)
        proxies.append(
            {**copy.deepcopy(block), "type": "text", "text": "\n".join(items)}
        )
    repaired, proof = repair_text(proxies, pdf)
    evidence = {d["index"]: d for d in proof}
    revised, decisions = copy.deepcopy(blocks), []
    for proxy_index, (index, proxy) in enumerate(zip(indices, repaired)):
        if proxy_index not in evidence:
            if re.search(r"([\u3400-\u9fff])\1{2,}", proxies[proxy_index]["text"]):
                decisions.append(
                    {
                        "index": index,
                        "page": blocks[index]["page_idx"] + 1,
                        "state": "strict_source_abstention",
                        "text": proxies[proxy_index]["text"],
                    }
                )
            continue
        try:
            items = restore_items(blocks[index]["list_items"], proxy["text"])
        except ValueError as error:
            decisions.append(
                {
                    "index": index,
                    "page": blocks[index]["page_idx"] + 1,
                    "state": "boundary_abstention",
                    "reason": str(error),
                }
            )
            continue
        revised[index]["list_items"] = items
        decisions.append(
            {
                **evidence[proxy_index],
                "index": index,
                "state": "repaired",
                "items_before": blocks[index]["list_items"],
                "items_after": items,
            }
        )
    for before, after in zip(blocks, revised):
        assert {k: v for k, v in before.items() if k != "list_items"} == {
            k: v for k, v in after.items() if k != "list_items"
        }
        if "list_items" in before:
            assert len(before["list_items"]) == len(after["list_items"])
    return revised, decisions


def check():
    assert restore_items(["AAABBB\nCCC", "DDDEEE"], "AB\nC\nDE") == ["AB\nC", "DE"]
    assert restore_items(["A\n", "\nB"], "A\n\n\nB") == ["A\n", "\nB"]
    assert restore_items(["book 1000", "www.example"], "book 1000\nwww.example") == [
        "book 1000",
        "www.example",
    ]
    try:
        restore_items(["AAA", "AAA"], "AA\n")
    except ValueError:
        pass
    else:
        raise AssertionError("cross-item reallocation accepted")
    print(
        "Item boundaries, embedded newlines, whitespace and legitimate repetition preserved"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not args.root or not args.output:
        parser.error("root and fresh output required")
    args.output.mkdir(parents=True, exist_ok=False)
    sources, frozen = (
        read(args.root / "sources.json"),
        read(args.root / "checks-v1.json"),
    )
    assert sha(args.root / "sources.json") == frozen["sources_sha256"]
    records = []
    for case, source in sources.items():
        for field, digest in [
            ("content_list", "content_sha256"),
            ("chunks", "chunks_sha256"),
            ("parsed_pdf", "parsed_pdf_sha256"),
        ]:
            assert sha(source[field]) == source[digest]
        blocks, baseline = read(source["content_list"]), load_chunks(source["chunks"])
        before = copy.deepcopy(blocks)
        started = time.perf_counter()
        repaired, decisions = repair_lists(blocks, source["parsed_pdf"])
        seconds = time.perf_counter() - started
        assert blocks == before
        assert repair_lists(repaired, source["parsed_pdf"])[0] == repaired
        _, chunks, _ = chunk_native_bounded(repaired)
        chunks, _ = retain_headings(repaired, source["parsed_pdf"], chunks)
        if blocks == repaired:
            assert chunks == baseline
        target = args.output / case
        save(target / "content_list.json", repaired)
        save(
            target / "chunks.json",
            [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks],
        )
        save(target / "decisions.json", decisions)
        checks = [c for c in frozen["checks"] if c["case"] == case]
        records.append(
            {
                "case": case,
                "pages": source["pages"],
                "seconds": seconds,
                "repaired_lists": sum(d["state"] == "repaired" for d in decisions),
                "abstentions": sum(d["state"] != "repaired" for d in decisions),
                "baseline": [judge(baseline, c) for c in checks],
                "candidate": [judge(chunks, c) for c in checks],
                "idempotent": True,
                "caller_unchanged": True,
                "item_boundaries_preserved": True,
            }
        )
    save(
        args.output / "summary.json",
        {
            "script_sha256": sha(__file__),
            "glyph_helper_sha256": sha(
                Path(__file__).with_name("experiment_odl_native_text.py")
            ),
            "checks_sha256": sha(args.root / "checks-v1.json"),
            "records": records,
        },
    )
    print(
        "Lists",
        sum(r["repaired_lists"] for r in records),
        "abstentions",
        sum(r["abstentions"] for r in records),
        "seconds",
        round(sum(r["seconds"] for r in records), 3),
    )
    print(
        "Checks",
        sum(c["pass"] for r in records for c in r["baseline"]),
        "->",
        sum(c["pass"] for r in records for c in r["candidate"]),
    )


if __name__ == "__main__":
    main()
