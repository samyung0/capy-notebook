"""Is production's window call the call the window-pick test ran with? Dumps the
messages, tools and settings of the page window's first call, and the tool results
for figures that cannot be read, on the same two pages and boxes, for diffing.

Epo 2026-11-04: production matches ``figure_windows.py`` at ``5700f09fd`` word for
word. That commit's bench wraps its own production code, so each dump runs in its
own process against its own tree:

    mkdir /tmp/variant && git archive 5700f09fd pipeline bench/extraction server/internal/models \
        | tar -x -C /tmp/variant
    python -I prompt_match.py production > production.json
    python -I prompt_match.py variant /tmp/variant > variant.json
    diff production.json variant.json

No model is called and no key is read.
"""

from __future__ import annotations

import asyncio
import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
OPEN = ("7", ["a"], [{"label": "a", "blocks": [{"type": "text", "text": "Find x."}]}])
REGIONS = {
    5: [
        {"label": "image", "score": 0.9713, "box": [278.4, 125.2, 805.1, 307.6]},
        {"label": "chart", "score": 0.884, "box": [100.0, 400.0, 300.0, 600.0]},
        # Nearly the same box as the chart: one of the two stays.
        {"label": "image", "score": 0.61, "box": [101.0, 401.0, 300.0, 600.0]},
        {"label": "figure_title", "score": 0.8, "box": [120.0, 605.0, 280.0, 620.0]},
        {"label": "text", "score": 0.95, "box": [80.0, 650.0, 900.0, 700.0]},
    ],
    6: [
        {"label": "image", "score": 0.56, "box": [200.0, 100.0, 500.0, 300.0]},
        # The figure with its options: the text of its own takes this box out.
        {"label": "image", "score": 0.62, "box": [190.0, 90.0, 900.0, 600.0]},
        {"label": "text", "score": 0.9, "box": [210.0, 400.0, 500.0, 550.0]},
    ],
}
TEXTS = {5: "1. Find the area of the figure.", 6: ""}
UNREADABLE = [
    [{"boxes": [99], "part": "", "description": "x"}],
    [{"boxes": [1, 3], "part": "", "description": "x"}],
    [{"boxes": [], "part": "", "description": "x"}],
    [{"boxes": [], "image": 9, "part": "", "description": "x"}],
    [{"boxes": [1], "part": "z", "description": "x"}],
]
READABLE = [
    [{"boxes": [1], "part": "", "description": "x"}],
    [{"boxes": [2], "part": "a", "description": "x"}],
    [{"boxes": [3], "part": "", "description": "x"}],
    [{"boxes": [1, 2], "part": "", "description": "x"}],
    [{"boxes": [], "image": 2, "part": "", "description": "x"}],
]


def stub(sent: list[dict]):
    """The model: records the call and closes the window."""

    async def complete_response(messages, **kwargs):
        sent.append(
            {
                "messages": copy.deepcopy(messages),
                "tools": kwargs["tools"],
                "max_tokens": kwargs["max_tokens"],
                "call_purpose": kwargs["call_purpose"],
                "other_settings": sorted(
                    set(kwargs) - {"tools", "max_tokens", "call_purpose"}
                ),
            }
        )
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    finish_reason="stop",
                    message={"role": "assistant", "content": "DONE"},
                )
            ],
            usage=SimpleNamespace(output_tokens=1),
        )

    return complete_response


async def page_image() -> str:
    return "data:image/jpeg;base64,AA=="


async def page_crop(box):
    return b"", (1, 1)


def dump(extraction, read_figures, sent: list[dict], run, pages, model) -> None:
    async def closes() -> None:
        run.expected = ["1", "2", "7"]
        await extraction._window(run, pages, model=model)

    asyncio.run(closes())
    out = {
        "window_call": sent[0],
        "unreadable": [read_figures(raw, ["a"])[1] for raw in UNREADABLE],
        "crops": [
            [
                [figure.page.number, figure.box, figure.part]
                for figure in read_figures(raw, ["a"])[0]
            ]
            for raw in READABLE
        ],
    }
    print(json.dumps(out, indent=1, ensure_ascii=False, sort_keys=False))


def production() -> None:
    sys.path.insert(0, str(HERE))
    import run as bench  # puts the pipeline on the path

    from pipeline.retrieval import extraction, layout

    sent: list[dict] = []
    extraction.models.complete_response = stub(sent)
    pages = [
        extraction.Page(
            number,
            "paper.pdf",
            TEXTS[number],
            page_image,
            page_crop,
            tuple(
                layout.Region(r["label"], r["score"], r["box"]) for r in REGIONS[number]
            ),
        )
        for number in (5, 6)
    ]

    async def validate(question):
        return None

    run = extraction.Run(validate=validate, ai_label="AI-written")
    add_open(run, extraction)

    def read(raw, parts):
        return extraction.read_figures(
            raw, pages, parts, extraction.numbered_boxes(pages)
        )

    dump(
        extraction, read, sent, run, pages, bench.spec("x", "x", "x", (1, 1, 1), "low")
    )


def add_open(run, extraction) -> None:
    label, part_labels, parts = OPEN
    run.order[label] = 0
    run.recorded[label] = extraction.Recorded(
        label,
        {"id": "q", "stem": [], "parts": parts},
        part_labels,
        ["printed"],
    )
    run.open_label = label


def variant(tree: str) -> None:
    sys.path.insert(0, str(Path(tree) / "bench" / "extraction" / "scripts"))
    # Its own run.py puts its own pipeline first on the path.
    import figure_matching as fm
    import figure_windows as fw
    import run as bench

    from pipeline.retrieval import extraction

    sent: list[dict] = []
    extraction.models.complete_response = stub(sent)
    fw.install()
    det = {fm.stem_of("paper", number): REGIONS[number] for number in REGIONS}
    state = fw.State("boxes", "paper", det)
    fw.STATE.set(state)
    pages = [
        extraction.Page(number, "paper.pdf", TEXTS[number], page_image, page_crop)
        for number in (5, 6)
    ]

    async def validate(question):
        return None

    run = extraction.Run(validate=validate, ai_label="AI-written")
    add_open(run, extraction)

    def read(raw, parts):
        return extraction.read_figures(raw, pages, parts)

    dump(
        extraction, read, sent, run, pages, bench.spec("x", "x", "x", (1, 1, 1), "low")
    )


if __name__ == "__main__":
    if sys.argv[1] == "production":
        production()
    else:
        variant(sys.argv[2])
