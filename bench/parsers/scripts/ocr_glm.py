"""GLM-5.3-Flash (Relace) as the OCR stage, against the parser's RapidOCR.

Runs inside the parser image (PyMuPDF, RapidOCR and ``odl`` on the path), so
the RapidOCR arm is the production code path (``odl.ocr.page_blocks``).

    python ocr_glm.py prepare --manifest pages.json --out DIR
    python ocr_glm.py rapid   --out DIR
    python ocr_glm.py glm     --out DIR --edge 2048 --concurrency 8
    python ocr_glm.py score   --out DIR
    python ocr_glm.py ramp    --out DIR --edge 2048 --levels 8 16 32 64

``prepare`` turns each manifest page into an image-only page (``scan`` pages
are copied as they are; ``render`` pages are rasterised to grey JPEG, like the
2026-09-28 scan corpus, and keep the native text as truth; ``degrade`` also
lowers the resolution and tilts the page). ``score`` compares every arm with
the truth as multiset token recall (text lost) and precision (text invented).
``ramp`` sends 2 x N page requests with N in flight per level and records
latency, 429s, timeouts and errors. Key from ``RELACE_API_KEY`` (``ramp
--key-env`` picks another, e.g. a second account's key).
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pymupdf
from PIL import Image

URL = "https://models.relace.ai/v1/chat/completions"
MODEL = "z-ai/glm-5.3-flash"
PRICE = {"input": 0.040, "cached": 0.015, "output": 0.50}  # USD per 1M, live /v1/models
PROMPT = (
    "Caption this page and extract all the visible text, formulas, tables and "
    "images. Keep text identical. Do not add any information not visible on the "
    "page. The result is directly consumed through a RAG pipeline."
)


# --- prepare -------------------------------------------------------------


def to_image_pdf(image: Image.Image, rect: pymupdf.Rect, quality: int) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=quality)
    out = pymupdf.open()
    page = out.new_page(width=rect.width, height=rect.height)
    page.insert_image(page.rect, stream=buffer.getvalue())
    return out.tobytes(deflate=True)


def prepare(args) -> None:
    out = Path(args.out)
    (out / "pages").mkdir(parents=True, exist_ok=True)
    pages = []
    for doc in json.loads(Path(args.manifest).read_text()):
        source = pymupdf.open(doc["path"])
        for number in doc["pages"]:
            page = source[number - 1]
            pid = f"{doc['id']}-p{number}"
            single = pymupdf.open()
            single.insert_pdf(source, from_page=number - 1, to_page=number - 1)
            truth = None
            if doc["kind"] == "scan":
                data = single.tobytes()
            else:
                truth = page.get_text()
                dpi = 100 if doc["kind"] == "degrade" else 150
                pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
                image = Image.frombytes("L", (pix.width, pix.height), pix.samples)
                if doc["kind"] == "degrade":
                    image = image.rotate(1.2, expand=True, fillcolor=255)
                data = to_image_pdf(image, page.rect, 50 if doc["kind"] == "degrade" else 75)
            (out / "pages" / f"{pid}.pdf").write_bytes(data)
            pages.append(
                {"id": pid, "group": doc["group"], "kind": doc["kind"], "truth": truth}
            )
    (out / "pages.json").write_text(json.dumps(pages, ensure_ascii=False, indent=1))
    print(len(pages), "pages")


# --- arms ----------------------------------------------------------------


def rapid(args) -> None:
    from odl import ocr

    out = Path(args.out)
    results = {}
    for page in json.loads((out / "pages.json").read_text()):
        with pymupdf.open(out / "pages" / f"{page['id']}.pdf") as document:
            started = time.perf_counter()
            blocks = ocr.page_blocks(document[0])
            seconds = time.perf_counter() - started
        results[page["id"]] = {
            "text": "\n".join(b["text"] for b in blocks),
            "seconds": round(seconds, 2),
        }
        print(page["id"], round(seconds, 1), len(blocks), "lines", flush=True)
    (out / "rapid.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))


def page_jpeg(path: Path, edge: int) -> bytes:
    with pymupdf.open(path) as document:
        page = document[0]
        scale = edge / max(page.rect.width, page.rect.height)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csGRAY)
        image = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=80)
    return buffer.getvalue()


def call_glm(key: str, jpeg: bytes, timeout: float) -> dict:
    body = {
        "model": MODEL,
        "reasoning_effort": "low",
        "temperature": 0,
        "max_tokens": 8192,
        # Relace refuses an image with no conversation context (no system
        # prompt, tools or earlier turns) on some of its servers.
        "messages": [
            {"role": "system", "content": PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
                        },
                    },
                ],
            },
        ],
    }
    request = urllib.request.Request(
        URL,
        data=json.dumps(body).encode(),
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    started = time.time()
    result: dict = {"started": started}
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read())
        choice = payload["choices"][0]
        usage = payload.get("usage") or {}
        cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
        result |= {
            "status": 200,
            "text": choice["message"].get("content") or "",
            "finish": choice.get("finish_reason"),
            "input_tokens": usage.get("prompt_tokens", 0),
            "cached_tokens": cached,
            "output_tokens": usage.get("completion_tokens", 0),
            "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get(
                "reasoning_tokens", 0
            ),
        }
    except urllib.error.HTTPError as exc:
        result |= {
            "status": exc.code,
            "error": exc.read().decode(errors="replace")[:300],
            "retry_after": exc.headers.get("retry-after"),
        }
    except TimeoutError:
        result |= {"status": "timeout"}
    except (urllib.error.URLError, ConnectionError, OSError) as exc:
        result |= {"status": "error", "error": str(exc)[:300]}
    result["seconds"] = round(time.time() - started, 2)
    return result


def cost(r: dict) -> float:
    fresh = r.get("input_tokens", 0) - r.get("cached_tokens", 0)
    return (
        fresh * PRICE["input"]
        + r.get("cached_tokens", 0) * PRICE["cached"]
        + r.get("output_tokens", 0) * PRICE["output"]
    ) / 1e6


def glm(args) -> None:
    out = Path(args.out)
    key = os.environ["RELACE_API_KEY"]
    pages = json.loads((out / "pages.json").read_text())

    def one(page: dict) -> tuple[str, dict]:
        jpeg = page_jpeg(out / "pages" / f"{page['id']}.pdf", args.edge)
        result = call_glm(key, jpeg, args.timeout)
        result["jpeg_kib"] = round(len(jpeg) / 1024)
        print(page["id"], result["status"], result["seconds"], result.get("finish"), flush=True)
        return page["id"], result

    with ThreadPoolExecutor(args.concurrency) as pool:
        results = dict(pool.map(one, pages))
    (out / f"glm-{args.edge}.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))


# --- score ---------------------------------------------------------------

CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")
MARKUP = re.compile(r"</?[a-z]+[^>]*>|\\[a-zA-Z]+|[#*_|`$\\{}^~>\[\]]|-{3,}|:?-{3,}:?")


def tokens(text: str) -> Counter:
    text = unicodedata.normalize("NFKC", text).lower()
    text = MARKUP.sub(" ", text).replace("[figure]", " ")
    out: Counter = Counter()
    for word in re.findall(r"\w+", text):
        if CJK.search(word):
            out.update(ch for ch in word if not ch.isspace())
        else:
            out[word] += 1
    return out


def structure(text: str) -> dict:
    lines = text.splitlines()
    return {
        "headings": sum(1 for l in lines if re.match(r"#{1,6} ", l)),
        "table_rows": sum(1 for l in lines if l.strip().startswith("|")) + text.count("<tr"),
        "math": text.count("$") // 2,
    }


def repeated(text: str) -> bool:
    """A degenerate tail: one short unit repeated many times."""
    tail = text[-600:]
    return bool(re.search(r"(.{2,40}?)\1{8,}", tail, re.S))


def score(args) -> None:
    out = Path(args.out)
    pages = json.loads((out / "pages.json").read_text())
    arms = {"rapid": json.loads((out / "rapid.json").read_text())}
    for path in sorted(out.glob("glm-*.json")):
        arms[path.stem] = json.loads(path.read_text())
    rows = []
    for page in pages:
        truth = tokens(page["truth"]) if page["truth"] else None
        for arm, results in arms.items():
            r = results.get(page["id"])
            if r is None:
                continue
            text = r.get("text") or ""
            row = {
                "page": page["id"], "group": page["group"], "kind": page["kind"], "arm": arm,
                "status": r.get("status", 200), "seconds": r["seconds"],
                "finish": r.get("finish"), "repeated": repeated(text),
                "chars": len(text), **structure(text),
            }
            if arm != "rapid":
                row |= {"input_tokens": r.get("input_tokens"), "output_tokens": r.get("output_tokens"),
                        "reasoning_tokens": r.get("reasoning_tokens"), "usd": round(cost(r), 6)}
            if truth:
                got = tokens(text)
                common = sum((truth & got).values())
                row["recall"] = round(common / max(1, sum(truth.values())), 4)
                row["precision"] = round(common / max(1, sum(got.values())), 4)
            rows.append(row)
    (out / "scores.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    for arm in arms:
        mine = [r for r in rows if r["arm"] == arm]
        for group in sorted({r["group"] for r in mine}):
            g = [r for r in mine if r["group"] == group]
            scored = [r for r in g if "recall" in r]
            line = {"arm": arm, "group": group, "pages": len(g),
                    "ok": sum(1 for r in g if r["status"] == 200),
                    "seconds_median": sorted(r["seconds"] for r in g)[len(g) // 2]}
            if scored:
                line["recall"] = round(sum(r["recall"] for r in scored) / len(scored), 3)
                line["recall_min"] = min(r["recall"] for r in scored)
                line["precision"] = round(sum(r["precision"] for r in scored) / len(scored), 3)
                line["precision_min"] = min(r["precision"] for r in scored)
            line["headings"] = sum(r["headings"] for r in g)
            line["table_rows"] = sum(r["table_rows"] for r in g)
            line["math"] = sum(r["math"] for r in g)
            line["repeated"] = sum(r["repeated"] for r in g)
            if arm != "rapid":
                line["usd"] = round(sum(r.get("usd", 0) for r in g), 4)
            print(json.dumps(line, ensure_ascii=False))


# --- ramp ----------------------------------------------------------------


def ramp(args) -> None:
    out = Path(args.out)
    key = os.environ[args.key_env]
    pages = [p for p in json.loads((out / "pages.json").read_text()) if p["kind"] != "degrade"]
    jpegs = [page_jpeg(out / "pages" / f"{p['id']}.pdf", args.edge) for p in pages]
    log = (out / f"ramp-{args.edge}{args.tag}.jsonl").open("a")
    for level in args.levels:
        jobs = [jpegs[i % len(jpegs)] for i in range(args.per_level * level)]
        started = time.time()
        with ThreadPoolExecutor(level) as pool:
            results = list(pool.map(lambda j: call_glm(key, j, args.timeout), jobs))
        wall = time.time() - started
        for r in results:
            r.pop("text", None)
            log.write(json.dumps({"level": level, **r}) + "\n")
        log.flush()
        ok = [r for r in results if r["status"] == 200]
        lat = sorted(r["seconds"] for r in ok) or [0]
        summary = {
            "level": level, "requests": len(results), "ok": len(ok),
            "http_429": sum(1 for r in results if r["status"] == 429),
            "timeouts": sum(1 for r in results if r["status"] == "timeout"),
            "other_fail": sum(1 for r in results if r["status"] not in (200, 429, "timeout")),
            "truncated": sum(1 for r in ok if r.get("finish") == "length"),
            "p50_s": lat[len(lat) // 2], "p95_s": lat[min(len(lat) - 1, int(len(lat) * 0.95))],
            "max_s": lat[-1], "wall_s": round(wall, 1),
            "pages_per_min": round(len(ok) / wall * 60, 1),
            "usd": round(sum(cost(r) for r in ok), 4),
        }
        print(json.dumps({"key": args.key_env, **summary}), flush=True)
        if len(ok) < 0.8 * len(results):
            print("stop: more than 20% failed", flush=True)
            break


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="mode", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--manifest", required=True)
    p.add_argument("--out", required=True)
    for mode in ("rapid", "score"):
        sub.add_parser(mode).add_argument("--out", required=True)
    g = sub.add_parser("glm")
    g.add_argument("--out", required=True)
    g.add_argument("--edge", type=int, default=2048)
    g.add_argument("--concurrency", type=int, default=8)
    g.add_argument("--timeout", type=float, default=180)
    r = sub.add_parser("ramp")
    r.add_argument("--out", required=True)
    r.add_argument("--edge", type=int, default=2048)
    r.add_argument("--levels", type=int, nargs="+", default=[8, 16, 32, 64])
    r.add_argument("--per-level", type=int, default=2)
    r.add_argument("--timeout", type=float, default=180)
    r.add_argument("--key-env", default="RELACE_API_KEY")
    r.add_argument("--tag", default="", help="suffix for the ramp log file")
    args = parser.parse_args()
    {"prepare": prepare, "rapid": rapid, "glm": glm, "score": score, "ramp": ramp}[args.mode](args)


if __name__ == "__main__":
    main()
