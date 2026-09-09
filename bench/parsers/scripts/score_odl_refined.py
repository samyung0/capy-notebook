"""Apply the frozen source checks to saved final chunks from any parser arm.

These narrow literal/context checks are diagnostics, not whole-document scores.
Table semantics and formula correctness require the separate source audits.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from experiment_odl_heading_context import judge as judge_context
from experiment_odl_heading_retention import judge as judge_heading
from experiment_odl_heading_retention import load_chunks
from experiment_odl_native_text import judge as judge_text
from experiment_odl_native_text import read, save, sha
from experiment_odl_ocr_disagreement import fragment_match, normalized


def score(run, local):
    families = [
        ("text", "native-text/checks-v1.json", judge_text),
        ("lists", "list-text/checks-v1.json", judge_text),
        ("headings", "heading-context/checks-v2.json", judge_context),
        ("retention", "heading-retention/checks-v1.json", judge_heading),
    ]
    chunks, hashes, scores = {}, {}, {}

    def get_chunks(case):
        if case not in chunks:
            path = run / case / "chunks.json"
            hashes[str(path)] = sha(path)
            chunks[case] = load_chunks(path)
        return chunks[case]

    for family, relative, judge in families:
        path = local / ("2026-09-09-odl-" + relative)
        hashes[str(path)] = sha(path)
        scores[family] = [
            judge(get_chunks(check["case"]), check) for check in read(path)["checks"]
        ]
    fragments = []
    for name in ["source-fragments.json", "heldout-fragments.json"]:
        path = local / "2026-09-09-odl-ocr-disagreement" / name
        hashes[str(path)] = sha(path)
        for fragment in read(path)["fragments"]:
            candidates = [
                c
                for c in get_chunks("nist-accelerometers")
                if c.page_start is not None
                and c.page_start <= fragment["page"] <= c.page_end
            ]
            fragments.append(
                {
                    "id": fragment["id"],
                    "joined": fragment_match(
                        fragment["text"], "\n".join(c.text for c in candidates)
                    ),
                    "exact_in_one_chunk": any(
                        normalized(fragment["text"]) in normalized(c.text)
                        for c in candidates
                    ),
                }
            )
    return {
        "run": str(run.resolve()),
        "summary": {
            name: {"pass": sum(c["pass"] for c in checks), "total": len(checks)}
            for name, checks in scores.items()
        },
        "checks": scores,
        "nist_fragments": fragments,
        "inputs_sha256": hashes,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", type=Path, required=True)
    parser.add_argument("--runs", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("output must be new")
    results = [score(run, args.local) for run in args.runs]
    save(args.output, {"script_sha256": sha(Path(__file__)), "runs": results})
    for result in results:
        print(result["run"], result["summary"])


if __name__ == "__main__":
    main()
