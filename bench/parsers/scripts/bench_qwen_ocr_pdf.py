"""Qwen3.5-OCR on every page of one PDF: chat-completions prompt vs DashScope document_parsing.

Renders each page to a 2560-pixel JPEG, sends it to the Beijing Model Studio
workspace, and stores the text, usage and timing per page. `score` compares
one or more run directories against the PDF's embedded text. The credential
is read from `ALIBABA_API_KEY` and never written to disk.
"""

import argparse
import asyncio
import base64
import difflib
import io
import json
import os
import re
import statistics
import time
import unicodedata
from collections import Counter
from pathlib import Path

PROMPT = (
    "Describe this file from a study document so a student's search can find the "
    "information it carries. Extract all visible raw facts such as text, tables, "
    "formulas, data, labels, etc. Do not add any text that is not visible in the page "
    "or depicted in the images. Do not duplicate information. Do not add any "
    "unnecessary summary, title, line breaks, the response is processed automatically "
    "by a RAG pipeline."
)
MAX_EDGE = 2560
# Beijing list prices, USD per million tokens, September 2026.
PRICE_IN, PRICE_OUT = 0.069, 0.275


def render(page) -> tuple[bytes, tuple[int, int]]:
    import pymupdf
    from PIL import Image

    scale = MAX_EDGE / max(page.rect.width, page.rect.height)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
    image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=80)
    return buffer.getvalue(), image.size


def request(arm: str, host: str, data_url: str) -> tuple[str, dict]:
    if arm == "docparse":
        return host + "/api/v1/services/aigc/multimodal-generation/generation", {
            "model": "qwen3.5-ocr",
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "image": data_url,
                                "min_pixels": 3072,
                                "max_pixels": 8388608,
                                "enable_rotate": False,
                            }
                        ],
                    }
                ]
            },
            "parameters": {
                "ocr_options": {"task": "document_parsing"},
                "max_tokens": 16384,
            },
        }
    return host + "/compatible-mode/v1/chat/completions", {
        "model": "qwen3.5-ocr",
        "max_tokens": 16384,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    }


def parse_response(arm: str, payload: dict) -> tuple[str, str, dict]:
    if arm == "docparse":
        usage = payload["usage"]
        choice = payload["output"]["choices"][0]
        text = "".join(part.get("text", "") for part in choice["message"]["content"])
        return (
            text,
            choice["finish_reason"],
            {
                "prompt_tokens": usage["input_tokens"],
                "completion_tokens": usage["output_tokens"],
            },
        )
    choice = payload["choices"][0]
    return choice["message"]["content"], choice["finish_reason"], payload["usage"]


async def run(args: argparse.Namespace) -> None:
    import httpx
    import pymupdf

    key = os.environ.get("ALIBABA_API_KEY")
    if not key:
        raise SystemExit("ALIBABA_API_KEY is not set")
    args.output.mkdir(parents=True, exist_ok=False)
    doc = pymupdf.open(args.pdf)
    pages = args.pages or list(range(1, len(doc) + 1))
    gate = asyncio.Semaphore(args.concurrency)
    (args.output / "run.json").write_text(
        json.dumps(
            {
                "pdf": str(args.pdf),
                "arm": args.arm,
                "host": args.host,
                "pages": pages,
                "max_edge": MAX_EDGE,
                "prompt": PROMPT if args.arm == "chat" else None,
                "started_unix": time.time(),
            },
            indent=1,
        )
    )

    async with httpx.AsyncClient(timeout=300) as client:

        async def one(number: int) -> dict:
            # Render inside the gate: rendering blocks the loop, and rendering
            # every page before the first response stalls a long document.
            async with gate:
                page = doc[number - 1]
                jpeg, size = render(page)
                stem = args.output / f"p{number:02d}"
                stem.with_suffix(".jpg").write_bytes(jpeg)
                stem.with_suffix(".native.txt").write_text(page.get_text())
                data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
                url, body = request(args.arm, args.host, data_url)
                started = time.monotonic()
                response = await client.post(
                    url, json=body, headers={"Authorization": f"Bearer {key}"}
                )
                seconds = time.monotonic() - started
            record = {
                "page": number,
                "status": response.status_code,
                "seconds": round(seconds, 2),
                "image_px": size,
                "image_bytes": len(jpeg),
            }
            try:
                text, finish, usage = parse_response(args.arm, response.json())
                stem.with_suffix(".ocr.txt").write_text(text)
                record.update(finish_reason=finish, usage=usage, chars=len(text))
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                record["error"] = f"{type(exc).__name__}: {exc}"
                record["body"] = response.text.replace(key, "[REDACTED]")[:2000]
            print(json.dumps(record, ensure_ascii=False), flush=True)
            return record

        records = await asyncio.gather(*(one(n) for n in pages))
    (args.output / "records.json").write_text(
        json.dumps(records, ensure_ascii=False, indent=1)
    )


def words(text: str, cjk: bool = False) -> list[str]:
    text = unicodedata.normalize("NFKC", text).lower()
    # Strip LaTeX control words, Markdown image links and markup so formula and
    # link tokens do not count as prose.
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\\[a-zA-Z]+|[{}$_^*#|]", " ", text)
    if cjk:
        # Japanese and Chinese have no word spaces; score characters instead.
        return [c for c in text if c.isalnum()]
    return re.sub(r"[^\w]+", " ", text).split()


def flat(text: str) -> str:
    # Case, Unicode form, punctuation and whitespace are ignored, as in the
    # original source-probe evaluator.
    return re.sub(r"[^\w]+", "", unicodedata.normalize("NFKC", text).lower())


def probe(args: argparse.Namespace) -> None:
    """Apply the page-scoped source probes from opendataloader-checks.json."""
    checks = json.loads(args.checks.read_text())
    mapping = next(m for m in checks["page_mappings"] if m["source"] == args.mapping)
    passed = 0
    selected = [c for c in checks["checks"] if c["source"] == mapping["checks_from"]]
    for check in selected:
        number = mapping["pages"][check["page"]] + 1
        path = args.run / f"p{number:02d}.ocr.txt"
        if not path.is_file():
            print(f"skip  p{number:02d}  {check['id']}  (page not in run)")
            continue
        raw = path.read_text()
        text = flat(raw)
        if "anchors" in check:
            ok = all(flat(a) in text for a in check["anchors"])
        elif "ordered" in check:
            positions = [text.find(flat(a)) for a in check["ordered"]]
            ok = all(p >= 0 for p in positions) and positions == sorted(positions)
        else:
            # Row values must appear in order inside one HTML row or one line.
            pattern = ".*".join(re.escape(flat(v)) for v in check["row"])
            candidates = raw.split("<tr>") + raw.splitlines()
            ok = any(re.search(pattern, flat(row)) for row in candidates)
        passed += ok
        print(f"{'pass' if ok else 'FAIL'}  p{number:02d}  {check['id']}")
    print(f"{passed}/{len(selected)} probes on {args.run.name}")


def score(args: argparse.Namespace) -> None:
    rows = {}
    for run_dir in args.runs:
        records = json.loads((run_dir / "records.json").read_text())
        for record in records:
            number = record["page"]
            native_raw = (run_dir / f"p{number:02d}.native.txt").read_text()
            ocr_raw = (run_dir / f"p{number:02d}.ocr.txt").read_text()
            native, ocr = words(native_raw, args.cjk), words(ocr_raw, args.cjk)
            counts, seen = Counter(native), Counter(ocr)
            recall = sum(min(counts[w], seen[w]) for w in counts) / max(1, len(native))
            similarity = difflib.SequenceMatcher(
                None, native, ocr, autojunk=False
            ).ratio()
            rows.setdefault(number, {})[run_dir.name] = {
                "seconds": record["seconds"],
                "in": record["usage"]["prompt_tokens"],
                "out": record["usage"]["completion_tokens"],
                "recall": recall,
                "similarity": similarity,
                "display_math": len(
                    re.findall(r"\$\$|^\s*\$(?!\$)", ocr_raw, re.MULTILINE)
                ),
                "equation_numbers": len(
                    re.findall(r"\(\d+\.\d+\)\s*$", ocr_raw, re.MULTILINE)
                ),
                "native_equation_numbers": len(
                    re.findall(r"^\(\d+\.\d+\)$", native_raw, re.MULTILINE)
                ),
            }
    names = [r.name for r in args.runs]
    print("page | " + " | ".join(f"{n}: sec recall sim disp eqno" for n in names))
    for number in sorted(rows):
        cells = []
        for name in names:
            r = rows[number][name]
            cells.append(
                f"{r['seconds']:>5} {r['recall']:.3f} {r['similarity']:.3f} "
                f"{r['display_math']:>3} {r['equation_numbers']:>3}"
            )
        print(f"{number:>4} | " + " | ".join(cells))
    for name in names:
        values = [rows[n][name] for n in rows]
        tokens_in = sum(v["in"] for v in values)
        tokens_out = sum(v["out"] for v in values)
        print(
            f"{name}: in={tokens_in} out={tokens_out} "
            f"median_sec={statistics.median(v['seconds'] for v in values):.1f} "
            f"mean_recall={statistics.mean(v['recall'] for v in values):.3f} "
            f"mean_sim={statistics.mean(v['similarity'] for v in values):.3f} "
            f"cost=${tokens_in / 1e6 * PRICE_IN + tokens_out / 1e6 * PRICE_OUT:.4f}"
        )
    if args.json:
        args.json.write_text(json.dumps(rows, indent=1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    runner = sub.add_parser("run")
    runner.add_argument("pdf", type=Path)
    runner.add_argument("output", type=Path)
    runner.add_argument("--arm", choices=["chat", "docparse"], default="chat")
    runner.add_argument(
        "--host", required=True, help="https://<workspace>.cn-beijing.maas.aliyuncs.com"
    )
    runner.add_argument("--pages", type=int, nargs="*")
    runner.add_argument("--concurrency", type=int, default=4)
    scorer = sub.add_parser("score")
    scorer.add_argument("runs", type=Path, nargs="+")
    scorer.add_argument("--json", type=Path)
    scorer.add_argument(
        "--cjk", action="store_true", help="score characters, not words"
    )
    prober = sub.add_parser("probe")
    prober.add_argument("run", type=Path)
    prober.add_argument("--checks", type=Path, required=True)
    prober.add_argument("--mapping", required=True, help="page_mappings source name")
    args = parser.parse_args()
    if args.command == "run":
        if not 1 <= args.concurrency <= 4:
            raise SystemExit("concurrency must be 1-4")
        asyncio.run(run(args))
    elif args.command == "score":
        score(args)
    else:
        probe(args)


if __name__ == "__main__":
    main()
