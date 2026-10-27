#!/usr/bin/env python3
"""Tabulates a `loadgen pages` summary: per list (and sort), the median and
p95 time of each page, p1 to p6+, and the request count, as Markdown."""

import json
import re
import sys
from collections import defaultdict

PAGE = re.compile(r"^GET (?P<list>.+) p(?P<page>\d\+?)$")


def main(path: str) -> None:
    summary = json.loads(open(path).read())
    lists: dict[str, dict[str, dict]] = defaultdict(dict)
    others = []
    for label in summary["labels"]:
        match = PAGE.match(label["label"])
        if match:
            lists[match["list"]][match["page"]] = label
        else:
            others.append(label)
    pages = ["1", "2", "3", "4", "5", "6+"]
    print("| List | " + " | ".join(f"p{p}" for p in pages) + " |")
    print("| ---- | " + " | ".join("---" for _ in pages) + " |")
    for name in sorted(lists):
        cells = []
        for p in pages:
            row = lists[name].get(p)
            cells.append(f"{row['p50_ms']:.0f} / {row['p95_ms']:.0f}" if row else "")
        print(f"| `{name}` | " + " | ".join(cells) + " |")
    print()
    print("Cells are median / p95 ms. Other requests:")
    for label in others:
        print(f"- `{label['label']}`: {label['count']} calls, median {label['p50_ms']:.0f} ms, p95 {label['p95_ms']:.0f} ms")


if __name__ == "__main__":
    main(sys.argv[1])
