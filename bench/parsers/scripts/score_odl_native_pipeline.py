"""Verify measured native pipeline repeats and the frozen second-pass source checks."""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
from collections import Counter
from pathlib import Path

from experiment_odl_heading_context import judge
from experiment_odl_native_tables import japan_checks
from experiment_odl_ocr_disagreement import block_text, fragment_match, normalized
from experiment_odl_reading_order import order_check
from pipeline.retrieval.chunking import Chunk, Region


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "local", type=Path, help="parent of dated experiment directories"
    )
    parser.add_argument("output", type=Path, help="new verification JSON")
    parser.add_argument(
        "--extended-prefix",
        default="extended",
        help="measured extended run directory prefix",
    )
    args = parser.parse_args()
    hashes = {}

    def read(path):
        data = path.read_bytes()
        hashes[str(path)] = hashlib.sha256(data).hexdigest()
        return json.loads(data)

    def root(name):
        return args.local / ("2026-09-09-odl-" + name)

    def chunks(folder, case):
        records = read(folder / case / "chunks.json")
        return [
            Chunk(
                **{k: v for k, v in c.items() if k not in {"indexed_text", "regions"}},
                regions=[Region(**r) for r in c["regions"]],
            )
            for c in records
        ]

    measured = root("native-measured")
    results = {}
    for arm in ["baseline", "native", "extended"]:
        prefix = args.extended_prefix if arm == "extended" else arm
        folders = [measured / f"{prefix}-r{i}" for i in [1, 2, 3]]
        runs = [read(folder / "complete.json") for folder in folders]
        assert all(len(run["records"]) == 8 for run in runs)
        assert all(sum(c["pages"] for c in run["records"]) == 254 for run in runs)
        for folder, run in zip(folders, runs):
            assert [(c["id"], c["source_sha256"]) for c in run["records"]] == [
                (c["id"], c["source_sha256"]) for c in runs[0]["records"]
            ]
            for current, first in zip(run["records"], runs[0]["records"]):
                for field, filename in [
                    ("content_sha256", "content_list.json"),
                    ("chunks_sha256", "chunks.json"),
                ]:
                    path = folder / current["id"] / filename
                    read(path)
                    assert hashes[str(path)] == current[field], path
                assert current["content_sha256"] == first["content_sha256"]
                assert current["chunks_sha256"] == first["chunks_sha256"]
        results[arm] = {
            "run_prefix": prefix,
            "seconds": [r["seconds"] for r in runs],
            "median_seconds": statistics.median(r["seconds"] for r in runs),
            "peak_memory_bytes": [r["peak_memory_bytes"] for r in runs],
            "peak_swap_bytes": [r["peak_swap_bytes"] for r in runs],
            "chunks": sum(c["chunks"] for c in runs[0]["records"]),
            "repeated_output_hashes_identical": True,
        }
    native, extended = measured / "native-r1", measured / f"{args.extended_prefix}-r1"
    cases = [c["id"] for c in runs[0]["records"]]
    conservation = []
    for case in cases:
        historical = read(
            root("accuracy") / "combined-final" / case / "chunks-after.json"
        )
        assert historical == read(native / case / "chunks.json")
        before, after = [
            read(p / case / "content_list.json") for p in [native, extended]
        ]
        if args.extended_prefix != "extended":
            original = measured / "extended-r1" / case
            assert read(original / "chunks.json") == read(
                extended / case / "chunks.json"
            )
            assert read(original / "headings.json") == read(
                extended / case / "headings.json"
            )

        def stripped(block):
            return json.dumps(
                {k: v for k, v in block.items() if k != "text_level"}, sort_keys=True
            )

        assert Counter(map(stripped, before)) == Counter(map(stripped, after))
        conservation.append(
            {
                "case": case,
                "native_matches_prior_reviewed_replay": True,
                "extended_preserves_every_block_except_heading_level_and_order": True,
            }
        )
    heading_checks = read(root("heading-context") / "checks-v2.json")["checks"]
    heading_results = [judge(chunks(extended, c["case"]), c) for c in heading_checks]
    assert all(c["pass"] for c in heading_results)
    japanese = read(root("native-tables") / "frozen-checks.json")["japan"]
    japanese["screen_page"] = japanese["page"]
    japan = japan_checks(
        read(extended / "japan-migration/content_list.json"),
        chunks(extended, "japan-migration"),
        japanese,
    )
    assert japan["native_rows"] == 48 and japan["native_numeric_cells"] == 384
    assert all(
        r["raw_exact"] and r["self_contained_chunks"] for r in japan["source_rows"]
    )
    assert all(r["headers"] and r["title_unit"] for r in japan["all_native_rows"])
    preserved = []
    # These exact chunks were source-scored in the first-pass verification.
    for case, index in [("ccl-feedback", 39), ("taln-complexity", 24)]:
        expected = chunks(native, case)[index].text
        if case == "taln-complexity":
            # The source check covers the whole table and its significance caption.
            # Heading cleanup can repack the unrelated prose after that caption.
            expected = "\n\n".join(expected.split("\n\n")[:2])
        hits = [i for i, c in enumerate(chunks(extended, case)) if expected in c.text]
        assert hits, (case, "previous source-checked chunk disappeared")
        preserved.append({"case": case, "prior_chunk": index, "extended_chunks": hits})
    order = []
    for c in read(root("reading-order") / "vm/checks-full-v2.json")["checks"]:
        if c["case"] != "german-education":
            continue
        hits = [
            i
            for i, chunk in enumerate(chunks(extended, c["case"]))
            if chunk.page_start <= c["page"] + 1 <= chunk.page_end
            and order_check(chunk.text, c["anchors"][:2])["pass"]
        ]
        assert hits
        order.append({"id": c["id"], "chunks": hits})
    fragments = read(root("ocr-disagreement") / "source-fragments.json")["fragments"]
    fragments += read(root("ocr-disagreement") / "heldout-fragments.json")["fragments"]
    nist = []
    for fragment in fragments:
        judged = {"id": fragment["id"], "page": fragment["page"]}
        for arm, folder in [("native", native), ("extended", extended)]:
            page_chunks = [
                c
                for c in chunks(folder, "nist-accelerometers")
                if c.page_start <= fragment["page"] <= c.page_end
            ]
            judged[arm] = fragment_match(
                fragment["text"], "\n".join(c.text for c in page_chunks)
            )
            judged[arm]["exact_in_one_chunk"] = any(
                normalized(fragment["text"]) in normalized(c.text) for c in page_chunks
            )
            blocks = read(folder / "nist-accelerometers/content_list.json")
            raw = "\n".join(
                block_text(b) for b in blocks if b["page_idx"] == fragment["page"] - 1
            )
            judged[arm]["raw"] = fragment_match(fragment["text"], raw)
        # Overlapping chunks can duplicate a boundary and inflate the joined score.
        # Retain that score, but test raw conservation and exact single-chunk gains separately.
        assert judged["extended"]["raw"]["edits"] <= judged["native"]["raw"]["edits"]
        nist.append(judged)
    assert next(c for c in nist if c["id"] == "p9-frequencies")["extended"][
        "exact_in_one_chunk"
    ]
    result = {
        "timings": results,
        "conservation": conservation,
        "headings": heading_results,
        "japan": japan,
        "preserved_source_chunks": preserved,
        "german_continuations": order,
        "nist_fragments": nist,
        "input_sha256": hashes,
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    print(json.dumps(results))
    print(
        f"Verified {len(cases)} documents, {len(heading_results)} heading checks and {len(nist)} NIST fragments."
    )


if __name__ == "__main__":
    main()
