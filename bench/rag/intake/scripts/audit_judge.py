"""Blind fidelity judge for the parser audit packets.

For every packet holding both texts of a pair of sides (`audit_packets.py`),
one headless Claude call reads the page image and the two texts, labelled A
and B in a per-packet random order, and returns per-block verdicts under a JSON
schema. The judge prompt is frozen in
`bench/rag/intake/fixtures/audit-judge-prompt.txt`. Verdicts are written next to
the packets as `pNNNN.<side>-<side>.verdict.json`, one file per pair, and the
run is resumable; `summary` tallies faithful blocks and issues per side.

Transport: one Anthropic Messages API call per packet (adaptive thinking at the
judge's effort, the schema as structured output), billed to `ANTHROPIC_API_KEY`.
The 10-07 MinerU/reviewed verdicts ran the same model, effort, prompt and
schema through the Claude Code CLI.

    uv run --project pipeline python bench/rag/intake/scripts/audit_judge.py run --sides mineru,reviewed [--book ahss4] [--limit N]
    uv run --project pipeline python bench/rag/intake/scripts/audit_judge.py summary --sides mineru,reviewed
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
AUDIT = ROOT / "bench/rag/reports/local/2026-10-intake-eval/audit"
PROMPT = ROOT / "bench/rag/intake/fixtures/audit-judge-prompt.txt"
MODEL = "claude-opus-5-5"
EFFORT = "medium"

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["text_a", "text_b", "page_notes"],
    "properties": {
        "text_a": {"$ref": "#/$defs/side"},
        "text_b": {"$ref": "#/$defs/side"},
        "page_notes": {"type": "string"},
    },
    "$defs": {
        "issue": {
            "type": "object",
            "additionalProperties": False,
            "required": ["kind", "printed", "in_text"],
            "properties": {
                "kind": {"type": "string", "enum": ["missing", "wrong", "extra", "garbled"]},
                "printed": {"type": "string"},
                "in_text": {"type": "string"},
            },
        },
        "block": {
            "type": "object",
            "additionalProperties": False,
            "required": ["block", "faithful", "issues"],
            "properties": {
                "block": {"type": "integer"},
                "faithful": {"type": "boolean"},
                "issues": {"type": "array", "items": {"$ref": "#/$defs/issue"}},
            },
        },
        "side": {"type": "array", "items": {"$ref": "#/$defs/block"}},
    },
}

API_URL = "https://api.anthropic.com/v1/messages"


def blocks_text(label: str, blocks: list[dict]) -> str:
    lines = [f"## Text {label}: {len(blocks)} blocks"]
    for i, b in enumerate(blocks, 1):
        lines.append(f"[{label}{i}] (section: {b['section_path'] or '-'})\n{b['text']}\n")
    return "\n".join(lines)


def verdict_path(packet_path: Path, sides: tuple[str, str]) -> Path:
    return packet_path.with_name(f"{packet_path.stem}.{sides[0]}-{sides[1]}.verdict.json")


def judge(packet: dict, sides: tuple[str, str], seed: int) -> dict:
    order = list(sides)
    random.Random(f"{seed}:{packet['book']}:{packet['page']}").shuffle(order)
    labels = dict(zip(("A", "B"), order))
    image = (ROOT / packet["image"]).read_bytes()
    text = (
        f"Book page {packet['page']} (PDF page). Blocks are numbered A1.. and B1.. in reading order; "
        "report each block by its number.\n\n"
        + blocks_text("A", packet["texts"][labels["A"]])
        + "\n"
        + blocks_text("B", packet["texts"][labels["B"]])
    )
    body = {
        "model": MODEL,
        "max_tokens": 32000,
        "system": PROMPT.read_text(encoding="utf-8"),
        "thinking": {"type": "adaptive", "display": "omitted"},
        "output_config": {"effort": EFFORT, "format": {"type": "json_schema", "schema": SCHEMA}},
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": text},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(image).decode()}},
                ],
            }
        ],
    }
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode(),
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    started = time.monotonic()
    value = response = error = None
    try:
        with urllib.request.urlopen(request, timeout=900) as reply:
            response = json.loads(reply.read())
        answer = next(b["text"] for b in response["content"] if b["type"] == "text")
        value = json.loads(answer)
    except urllib.error.HTTPError as e:
        error = {"status": e.code, "body": e.read().decode(errors="replace")[-800:]}
    except (urllib.error.URLError, TimeoutError, StopIteration, ValueError) as e:
        error = {"exception": repr(e)[-800:], "stop_reason": (response or {}).get("stop_reason")}
    return {
        "labels": labels,
        "verdict": value,
        "error": error,
        "usage": (response or {}).get("usage"),
        "seconds": round(time.monotonic() - started, 1),
        "model": MODEL,
        "effort": EFFORT,
        "transport": "anthropic-api",
    }


def run(sides: tuple[str, str], book: str | None, limit: int | None, seed: int) -> None:
    index = json.loads((AUDIT / "index.json").read_text(encoding="utf-8"))
    done = 0
    for item in index:
        if book and item["book"] != book:
            continue
        if not set(sides) <= set(item["sides"]):
            continue
        packet_path = ROOT / item["packet"]
        out = verdict_path(packet_path, sides)
        if out.exists() and json.loads(out.read_text(encoding="utf-8")).get("verdict") is not None:
            continue
        packet = json.loads(packet_path.read_text(encoding="utf-8"))
        outcome = judge(packet, sides, seed)
        out.write_text(json.dumps(outcome, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
        print(json.dumps({"book": item["book"], "page": item["page"], "ok": outcome["verdict"] is not None, "seconds": outcome["seconds"]}), flush=True)
        done += 1
        if limit and done >= limit:
            break


def summary(sides: tuple[str, str]) -> None:
    tally = {s: {"pages": 0, "blocks": 0, "faithful": 0, "silent_pages": 0, "issues": {}} for s in sides}
    by_book: dict[str, dict] = {}
    for path in sorted(AUDIT.glob(f"*/p*.{sides[0]}-{sides[1]}.verdict.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if not data.get("verdict"):
            continue
        book = path.parent.name
        for label, side in data["labels"].items():
            blocks = data["verdict"][f"text_{label.lower()}"]
            t = tally[side]
            t["pages"] += 1
            t["blocks"] += len(blocks)
            t["faithful"] += sum(1 for b in blocks if b["faithful"])
            kinds = [issue["kind"] for b in blocks for issue in b["issues"]]
            for kind in kinds:
                t["issues"][kind] = t["issues"].get(kind, 0) + 1
            # Silent errors (wrong or missing) are the ones that reach a learner.
            t["silent_pages"] += any(kind in ("wrong", "missing") for kind in kinds)
            bb = by_book.setdefault(book, {s: {"blocks": 0, "faithful": 0} for s in sides})[side]
            bb["blocks"] += len(blocks)
            bb["faithful"] += sum(1 for b in blocks if b["faithful"])
    for side, t in tally.items():
        t["faithful_share"] = round(t["faithful"] / t["blocks"], 3) if t["blocks"] else None
    print(json.dumps({"overall": tally, "by_book": by_book}, indent=1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["run", "summary"])
    parser.add_argument("--sides", required=True, help="two packet sides, comma-separated, e.g. mineru,reviewed")
    parser.add_argument("--book")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--seed", type=int, default=20261006)
    args = parser.parse_args()
    sides = tuple(args.sides.split(","))
    if len(sides) != 2 or sides[0] == sides[1]:
        raise SystemExit("--sides takes two different side names")
    if args.command == "run":
        run(sides, args.book, args.limit, args.seed)
    else:
        summary(sides)


if __name__ == "__main__":
    main()
