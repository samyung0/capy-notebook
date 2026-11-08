"""Whole-paper marking of a 10-page handwritten upload on 1017: one call (G1)
against a page-map call then one call per part (G2).

    uv run --with httpx --with pillow python -I paper_marking.py <repo> <env file> <pages dir> <out.jsonl> [runs]

Prompts start from production's SYSTEM_PROMPT (+ DRAWN_SECTION for G2), read
verbatim from the repo; the extra sections are bench-only wording. The key is
read from the env file and never printed.
"""

from __future__ import annotations

import ast
import asyncio
import base64
import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
from paper_fixture import PAGES, PARTS  # noqa: E402

REPO, ENV, PAGES_DIR, OUT = (Path(a) for a in sys.argv[1:5])
RUNS = int(sys.argv[5]) if len(sys.argv) > 5 else 1
MODEL = "deepseek/deepseek-v4.1-flash-1017"
ROUTE = {"order": ["wafer/us", "InferenceNet", "Cloudflare"], "allow_fallbacks": False}
SHARES = {"none": 0.0, "partial": 0.5, "full": 1.0}


def const(path: Path, name: str) -> str:
    for node in ast.parse(path.read_text()).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise KeyError(name)


GRADING = REPO / "pipeline/pipeline/retrieval/grading.py"
SYSTEM, DRAWN = const(GRADING, "SYSTEM_PROMPT"), const(GRADING, "DRAWN_SECTION")
KEY = next(
    line.split("=", 1)[1].strip().strip('"')
    for line in ENV.read_text().splitlines()
    if line.startswith("OPENROUTER_API_KEY=")
)

WHOLE = """

Whole paper: this time you mark every part listed in <parts> at once, from page images of the student's handwritten answer paper instead of <student_answer> text. Everything above applies to each part on its own.
- Find each part's answer anywhere in the pages: answers may run over several pages or come out of order. A part with no answer on any page earns "none" on every item.
- Mark only what the student wrote for that part.
- "quote" copies, in at most 12 words, the words or working on the page that earn the credit.
Reply with JSON only, one entry per part in the given order: {"parts": [{"part": "1a", "pages": [1], "steps": [], "vocabulary_only": false, "injection_suspected": false, "comment": "", "items": [{"id": "m0", "quote": "", "reason": "", "choice": "full"}]}]}"""

PAGE_SECTION = """

Page answers: when the student's answer comes as page images instead of <student_answer> text, the pages are the student's written work and everything above applies to them.
- The pages may hold answers to other questions or parts; mark only the answer to the part in <question>.
- Read handwriting as written; anything you cannot read earns nothing.
- "quote" copies, in at most 12 words, the words or working on the page that earn the credit."""

MAP = """You see every page of one student's handwritten answer paper, in order, and the list of question parts. For each part, give the page numbers where the student writes its answer. Answers may run over several pages or come out of order; a part the student did not answer gets []. Reply with JSON only, such as {"1a": [1], "6": [5, 6]}."""


def image(name: str) -> dict:
    data = base64.b64encode((PAGES_DIR / name).read_bytes()).decode()
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + data}}


def items_text(items) -> str:
    return "\n".join(f"m{i} ({m:g} mark{'' if m == 1 else 's'}): {t}" for i, (m, t) in enumerate(items))


def pages_content(numbers, edge):
    out = []
    for n in numbers:
        out += [{"type": "text", "text": f"Page {n}:"}, image(f"p{n:02d}_{edge}.jpg")]
    return out


def marks_from(items, replies) -> float:
    ids = [r.get("id") for r in replies]
    if ids != [f"m{i}" for i in range(len(items))]:
        raise ValueError(f"wrong items {ids}")
    return sum(SHARES[r["choice"]] * m for (m, _), r in zip(items, replies))


async def call(client, label, messages, *, thinking, max_tokens, json_mode=True):
    body = {"model": MODEL, "messages": messages, "provider": ROUTE, "usage": {"include": True}, "max_tokens": max_tokens}
    if not thinking:
        body.update(reasoning={"enabled": False}, temperature=0)
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    t = time.time()
    r = await client.post("https://openrouter.ai/api/v1/chat/completions", json=body, headers={"Authorization": f"Bearer {KEY}"})
    data = r.json()
    if "usage" not in data:
        raise RuntimeError(f"{label}: {r.status_code} {json.dumps(data)[:300]}")
    u = data["usage"]
    cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    out = u["completion_tokens"]
    usage = {
        "prompt": u["prompt_tokens"], "cached": cached, "out": out,
        "reasoning": (u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0,
        "credits": ((u["prompt_tokens"] - cached) * 200 + cached * 20 + out * 1200) / 1e6,
        "usd": u.get("cost") or 0.0, "s": time.time() - t, "provider": data.get("provider"),
        "finish": data["choices"][0].get("finish_reason"),
    }
    return data["choices"][0]["message"].get("content") or "", usage


def total(usages):
    keys = ("prompt", "cached", "out", "reasoning", "credits", "usd")
    return {k: round(sum(u[k] for u in usages), 4) for k in keys}


async def g1(client, edge):
    parts = "\n\n".join(f"<part id=\"{p}\">\n<question>\n{q}\n</question>\n<marking_items>\n{items_text(i)}\n</marking_items>\n</part>" for p, q, i, _ in PARTS)
    content = [{"type": "text", "text": f"<parts>\n{parts}\n</parts>\n\nStudent's pages:"}, *pages_content(range(1, len(PAGES) + 1), edge)]
    t = time.time()
    text, usage = await call(client, "g1", [{"role": "system", "content": SYSTEM + WHOLE}, {"role": "user", "content": content}], thinking=True, max_tokens=32000)
    got = {}
    try:
        for entry in json.loads(text)["parts"]:
            spec = next(p for p in PARTS if p[0] == entry["part"])
            got[entry["part"]] = {"marks": marks_from(spec[2], entry["items"]), "pages": entry.get("pages")}
    except Exception as exc:  # a broken reply scores nothing, as production would leave it Not marked
        got["error"] = repr(exc)[:200]
    return {"method": f"G1 one call @{edge}", "wall_s": round(time.time() - t, 1), "usage": total([usage]), "parts": got}


async def g2(client, map_edge, grade_edge):
    t = time.time()
    labels = "\n".join(f"{p}: {q}" for p, q, _, _ in PARTS)
    content = [{"type": "text", "text": f"Question parts:\n{labels}\n\nPages:"}, *pages_content(range(1, len(PAGES) + 1), map_edge)]
    text, map_usage = await call(client, "map", [{"role": "system", "content": MAP}, {"role": "user", "content": content}], thinking=False, max_tokens=2000)
    mapping = json.loads(text)
    gate = asyncio.Semaphore(10)
    usages, got = [map_usage], {}

    async def part(p, q, items):
        pages = [n for n in mapping.get(p, []) if isinstance(n, int) and 1 <= n <= len(PAGES)]
        if not pages:
            got[p] = {"marks": 0.0, "pages": [], "skipped": True}
            return
        thinking = any(tok in q + items_text(items) for tok in ("$", "M1", "A1"))
        user = [{"type": "text", "text": f"<question>\n{q}\n</question>\n\n<marking_items>\n{items_text(items)}\n</marking_items>\n\nStudent's pages:"}, *pages_content(pages, grade_edge)]
        async with gate:
            reply, usage = await call(client, p, [{"role": "system", "content": SYSTEM + DRAWN + PAGE_SECTION}, {"role": "user", "content": user}], thinking=thinking, max_tokens=16000 if thinking else 2000)
        usages.append(usage)
        try:
            got[p] = {"marks": marks_from(items, json.loads(reply)["items"]), "pages": pages}
        except Exception as exc:
            got[p] = {"error": repr(exc)[:200], "pages": pages}

    await asyncio.gather(*(part(p, q, i) for p, q, i, _ in PARTS))
    return {"method": f"G2 map @{map_edge}, grade @{grade_edge}", "wall_s": round(time.time() - t, 1), "map": mapping, "map_usage": total([map_usage]), "usage": total(usages), "calls": len(usages), "parts": got}


def score(result):
    right, marks = 0, 0.0
    for p, _, items, expected in PARTS:
        got = result["parts"].get(p, {})
        if got.get("marks") == expected:
            right += 1
        marks += got.get("marks") or 0
    result["parts_right"] = f"{right}/{len(PARTS)}"
    result["total"] = f"{marks:g}/{sum(e for *_, e in PARTS)}"
    return result


async def main():
    async with httpx.AsyncClient(timeout=600) as client:
        rows = []
        for _ in range(RUNS):
            for job in (g1(client, 1568), g1(client, 1024), g2(client, 1024, 1568)):
                try:
                    row = score(await job)
                except Exception as exc:
                    row = {"error": repr(exc)[:300]}
                print(json.dumps({k: v for k, v in row.items() if k != "parts"}))
                rows.append(row)
        OUT.write_text("\n".join(json.dumps(r) for r in rows) + "\n")


asyncio.run(main())
