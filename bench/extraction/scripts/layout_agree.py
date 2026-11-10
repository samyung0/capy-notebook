"""How far two layout models agree on the same pages, from their
``layout_detect.py`` records:

    python bench/extraction/scripts/layout_agree.py <reference.json> <other.json>

A region is reproduced when the other model has an unmatched region with the
same label at an IoU of 0.8 or more, both at a score of 0.5 or more (greedy,
highest IoU first). Prints the share of the reference's regions the other
reproduces, the share of the other's the reference has, and the same for the
figure regions (``image`` and ``chart``) of 0.5% of the page or more.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCORE = 0.5
SAME = 0.8
FIGURE_LABELS = {"image", "chart"}
# On the 0-1000 grid: 0.5% of the page.
FIGURE_AREA = 5000


def area(box: list[float]) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def iou(a: list[float], b: list[float]) -> float:
    shared = area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])
    return shared / (area(a) + area(b) - shared) if shared else 0.0


def matched(reference: list[dict], other: list[dict]) -> int:
    pairs = sorted(
        (
            (iou(a["box"], b["box"]), i, j)
            for i, a in enumerate(reference)
            for j, b in enumerate(other)
            if a["label"] == b["label"]
        ),
        reverse=True,
    )
    used_a: set[int] = set()
    used_b: set[int] = set()
    for value, i, j in pairs:
        if value < SAME:
            break
        if i not in used_a and j not in used_b:
            used_a.add(i)
            used_b.add(j)
    return len(used_a)


def pages(path: str) -> dict[str, list[dict]]:
    record = json.loads(Path(path).read_text())
    return {
        page["page"]: [r for r in page["regions"] if r["score"] >= SCORE]
        for page in record["pages"]
    }


def main() -> None:
    reference, other = pages(sys.argv[1]), pages(sys.argv[2])
    for name, keep in (
        ("all regions", lambda r: True),
        (
            "figure regions",
            lambda r: r["label"] in FIGURE_LABELS and area(r["box"]) >= FIGURE_AREA,
        ),
    ):
        same = in_reference = in_other = 0
        for page, regions in reference.items():
            a = [r for r in regions if keep(r)]
            b = [r for r in other[page] if keep(r)]
            same += matched(a, b)
            in_reference += len(a)
            in_other += len(b)
        print(
            f"{name}: {same} of {in_reference} reproduced "
            f"({same / max(1, in_reference):.1%}), {same} of {in_other} of the "
            f"other's ({same / max(1, in_other):.1%})"
        )


if __name__ == "__main__":
    main()
