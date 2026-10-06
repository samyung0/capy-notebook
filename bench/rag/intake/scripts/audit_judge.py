"""Blind fidelity judge for the parser audit packets.

For every packet with both texts (`audit_packets.py`), one headless Claude call
reads the page image and the two texts, labelled A and B in a per-packet
random order, and returns per-block verdicts under a JSON schema. The judge
prompt is frozen in `bench/rag/intake/fixtures/audit-judge-prompt.txt`.
Verdicts are written next to the packets and the run is resumable; `summary`
tallies faithful blocks and issues per parser.

Transport: the Claude Code CLI on the developer's subscription, as in
`bench/parsers/scripts/compare_claude_recovery.py` (tools off, no MCP servers,
no session persistence; ANTHROPIC_* variables removed so the login is used).

    uv run --project pipeline python bench/rag/intake/scripts/audit_judge.py run [--book ahss4] [--limit N]
    uv run --project pipeline python bench/rag/intake/scripts/audit_judge.py summary
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
AUDIT = ROOT / "bench/rag/reports/local/2026-10-intake-eval/audit"
PROMPT = ROOT / "bench/rag/intake/fixtures/audit-judge-prompt.txt"
MODEL = "claude-opus-5-5"
EFFORT = "medium"
SIDES = ("mineru", "reviewed")

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

FLAGS = [
    "-p",
    "--model",
    MODEL,
    "--effort",
    EFFORT,
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
]


def blocks_text(label: str, blocks: list[dict]) -> str:
    lines = [f"## Text {label}: {len(blocks)} blocks"]
    for i, b in enumerate(blocks, 1):
        lines.append(f"[{label}{i}] (section: {b['section_path'] or '-'})\n{b['text']}\n")
    return "\n".join(lines)


def judge(packet: dict, seed: int) -> dict:
    order = list(SIDES)
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
    event = {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"type": "text", "text": text},
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(image).decode()}},
            ],
        },
    }
    env = dict(os.environ)
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        env.pop(name, None)
    cmd = ["claude", *FLAGS, "--system-prompt", PROMPT.read_text(encoding="utf-8"), "--json-schema", json.dumps(SCHEMA)]
    started = time.monotonic()
    proc = subprocess.run(cmd, input=json.dumps(event) + "\n", capture_output=True, text=True, encoding="utf-8", env=env, timeout=900)
    result = None
    for line in proc.stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "result":
            result = e
    value = (result or {}).get("structured_output")
    return {
        "labels": labels,
        "verdict": value,
        "error": None if value is not None else {"returncode": proc.returncode, "stderr": proc.stderr[-800:], "result": (result or {}).get("result")},
        "usage": (result or {}).get("usage"),
        "seconds": round(time.monotonic() - started, 1),
        "model": MODEL,
        "effort": EFFORT,
    }


def run(book: str | None, limit: int | None, seed: int) -> None:
    index = json.loads((AUDIT / "index.json").read_text(encoding="utf-8"))
    done = 0
    for item in index:
        if book and item["book"] != book:
            continue
        if set(item["sides"]) != set(SIDES):
            continue
        packet_path = ROOT / item["packet"]
        verdict_path = packet_path.with_suffix(".verdict.json")
        if verdict_path.exists() and json.loads(verdict_path.read_text(encoding="utf-8")).get("verdict") is not None:
            continue
        packet = json.loads(packet_path.read_text(encoding="utf-8"))
        outcome = judge(packet, seed)
        verdict_path.write_text(json.dumps(outcome, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
        print(json.dumps({"book": item["book"], "page": item["page"], "ok": outcome["verdict"] is not None, "seconds": outcome["seconds"]}), flush=True)
        done += 1
        if limit and done >= limit:
            break


def summary() -> None:
    tally = {s: {"pages": 0, "blocks": 0, "faithful": 0, "issues": {}} for s in SIDES}
    by_book: dict[str, dict] = {}
    for path in sorted(AUDIT.glob("*/p*.verdict.json")):
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
            for b in blocks:
                for issue in b["issues"]:
                    t["issues"][issue["kind"]] = t["issues"].get(issue["kind"], 0) + 1
            bb = by_book.setdefault(book, {s: {"blocks": 0, "faithful": 0} for s in SIDES})[side]
            bb["blocks"] += len(blocks)
            bb["faithful"] += sum(1 for b in blocks if b["faithful"])
    for side, t in tally.items():
        t["faithful_share"] = round(t["faithful"] / t["blocks"], 3) if t["blocks"] else None
    print(json.dumps({"overall": tally, "by_book": by_book}, indent=1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["run", "summary"])
    parser.add_argument("--book")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--seed", type=int, default=20261006)
    args = parser.parse_args()
    if args.command == "run":
        run(args.book, args.limit, args.seed)
    else:
        summary()


if __name__ == "__main__":
    main()
