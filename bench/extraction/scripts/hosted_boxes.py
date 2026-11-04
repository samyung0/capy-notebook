"""Hosted models trained to return boxes, against DeepSeek's figure box call
(``extraction.locate``), on the same 40 gold figures: 14 scanned
(``fixtures/scanned/figures.json``) and 26 born-digital
(``fixtures/digital/figures.json``). Report:
``reports/2026-11-04-hosted-figure-boxes.md``.

Each call sees one page image as production renders it (``capture.render``,
long side 1,568 px) and the page's figures listed as production lists them
("Question <label>: <description>"), asked in the model's own box format and
the way its docs ask for detection, with production's instruction (the whole
figure with its labels, nothing of the question text). Answers are turned into
left/top/right/bottom on the 0-1000 grid. A failed call is retried once, as
production retries it. Run from the repository root with the root .venv:

    python -I bench/extraction/scripts/hosted_boxes.py call <model> --repeat 1 \
        --scans <hkdse-math-compulsory> --digital <born-digital> --env-file <keys>
    python -I bench/extraction/scripts/hosted_boxes.py lines --source tesseract \
        --scans ... --digital ...
    python -I bench/extraction/scripts/hosted_boxes.py deepseek <saved runs>... \
        --name deepseek-today --repeat 1
    python -I bench/extraction/scripts/hosted_boxes.py score --scans ... --digital ...
    python -I bench/extraction/scripts/hosted_boxes.py sheet <model>:<method>... \
        --scans ... --digital ... --out <jpg>

``mistral`` (OpenRouter's file-parser plugin with the mistral-ocr engine) needs
numpy and OpenCV: ``uv run --no-project --with numpy --with
opencv-python-headless --with pymupdf==1.28.2 --with pillow --with httpx
python -I ... mistral --repeat 1 --scans ... --digital ... --env-file ...``.
``deepseek`` turns saved ``locate_digital.py`` runs (and the prompt-variant
runs of the same shape) into this bench's runs. ``layout`` does the same for
``layout_match.py``'s final crops, so they are scored here too.

OpenRouter calls are held on named providers with fallbacks off and DeepInfra
ignored; each call records the provider that served it and what OpenRouter
billed. Model Studio (Singapore) calls are priced from their token counts at
the list prices below; on 2026-11-04 the key answered 403 "Access denied by
API-Key restrictions" from the Mac for every model, so no Model Studio run
exists. Every call adds to ``.results/hosted/spend.json``; a run stops before
a call that would take the total past ``SPEND_CAP``.

``score`` rescores every saved run raw, with today's pad, with a wider pad,
grown to nearby ink on the page image, and grown to short text lines
(``lines-<source>.json``). The pads, the ink growth and the text-line growth
are tuned on half the figures and checked on the other half. ``--trim-gold``
scores against gold boxes cut to what is printed inside them, and the
head-to-head table always shows both golds. Keys are read into the process
only, never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import functools
import itertools
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import locate_digital as ld  # noqa: E402  (puts the pipeline on the path)
import run as bench  # noqa: E402

OUT = bench.RESULTS / "hosted"
FIXTURES = HERE.parent / "fixtures"
SPEND_CAP = 0.95
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
CONCURRENCY = 4
TIMEOUT_S = 120

# fmt: the box format the model was trained on. price: Model Studio list
# price per million tokens (input, output), Singapore, 2026-11-04.
MODELS: dict[str, dict] = {
    "qwen3-vl-235b": {
        "api": "openrouter",
        "slug": "qwen/qwen3-vl-235b-a22b-instruct",
        "order": ["parasail", "venice"],
        "fmt": "qwen",
    },
    "qwen3-vl-30b": {
        "api": "openrouter",
        "slug": "qwen/qwen3-vl-30b-a3b-instruct",
        "order": ["novita", "siliconflow"],
        "fmt": "qwen",
    },
    "gemini-3.8-flash": {
        "api": "openrouter",
        "slug": "google/gemini-3.8-flash",
        "order": ["google-ai-studio", "google-vertex"],
        "fmt": "gemini",
        "reasoning": {"effort": "minimal"},
    },
    "gemini-3.5-flash-lite": {
        "api": "openrouter",
        "slug": "google/gemini-3.5-flash-lite",
        "order": ["google-ai-studio", "google-vertex"],
        "fmt": "gemini",
        "reasoning": {"effort": "minimal"},
    },
    "qwen3.6-flash": {
        "api": "openrouter",
        "slug": "qwen/qwen3.6-flash",
        "order": ["alibaba"],
        "fmt": "qwen",
        "reasoning": {"enabled": False},
    },
    "qwen3.6-plus": {
        "api": "openrouter",
        "slug": "qwen/qwen3.6-plus",
        "order": ["alibaba"],
        "fmt": "qwen",
        "reasoning": {"enabled": False},
    },
    "glm-4.5v": {
        "api": "openrouter",
        "slug": "z-ai/glm-4.5v",
        "order": ["z-ai"],
        "fmt": "glm",
        "reasoning": {"enabled": False},
    },
    "glm-4.6v": {
        "api": "openrouter",
        "slug": "z-ai/glm-4.6v",
        "order": ["z-ai"],
        "fmt": "glm",
        "reasoning": {"enabled": False},
    },
    "ms-qwen3-vl-plus": {
        "api": "modelstudio",
        "slug": "qwen3-vl-plus",
        "fmt": "qwen",
        "price": (0.2, 1.6),
        "body": {"enable_thinking": False},
    },
    "ms-qwen3.6-flash": {
        "api": "modelstudio",
        "slug": "qwen3.6-flash",
        "fmt": "qwen",
        "price": (0.25, 1.5),
        "body": {"enable_thinking": False},
    },
    "ms-qwen-vl-ocr": {
        "api": "modelstudio",
        "slug": "qwen-vl-ocr",
        "fmt": "qwen",
        "price": (0.07, 0.16),
        "pixels": True,
    },
}
LAYOUT = "layout-plus-l-1017"
LINES_MODEL = "ms-qwen-vl-ocr"
# The advanced_recognition task's fixed prompt (Model Studio docs); the
# OpenAI-compatible endpoint takes it as text beside the image.
LINES_PROMPT = (
    "Locate all text lines and return the coordinates of the rotated rectangle"
    "([cx, cy, width, height, angle])."
)
# On Model Studio's OCR models: keep the 1,568 px page at its size.
MIN_PIXELS, MAX_PIXELS = 32 * 32 * 3, 32 * 32 * 2048

RULE = (
    "A figure's box holds the whole figure with its labels, title, axis labels "
    "and caption, and nothing of the question text, options or answer lines "
    "around it."
)


def prompt(fmt: str, listed: str) -> tuple[str | None, str]:
    """(system, user text) in the model's own detection style."""
    page = "This is a page of a printed exam or worksheet."
    if fmt == "qwen":
        return None, (
            f"{page} Locate each of these figures:\n{listed}\n\n{RULE} Report bbox "
            "coordinates in JSON format: a list with one entry per figure, in the "
            'order listed, {"label": "<figure number>", "bbox_2d": [x1, y1, x2, '
            "y2]}, coordinates relative to the image on a 0-1000 scale."
        )
    if fmt == "gemini":
        return (
            "Return bounding boxes as a JSON array with labels. Never return masks "
            "or code fencing.",
            f"{page} Detect the 2d bounding box of each of these figures:\n{listed}"
            f"\n\n{RULE} Output a JSON list with one entry per figure, in the order "
            'listed, where "label" is the figure\'s number and "box_2d" is [ymin, '
            "xmin, ymax, xmax] normalized to 0-1000.",
        )
    if fmt == "glm":
        return None, (
            f"{page} Find each of these figures:\n{listed}\n\n{RULE} For each "
            "figure, in the order listed, write one line with its number and its "
            "bounding box, like `1: <|begin_of_box|>[x1, y1, x2, y2]<|end_of_box|>`, "
            "coordinates relative to the image on a 0-1000 scale."
        )
    raise ValueError(fmt)


# ------------------------------------------------------------------ figures


def figures(scans: Path, digital: Path, trim: bool = False) -> list[dict]:
    """Every gold figure with its set, PDF and next-question top. With ``trim``,
    each gold box is cut to the ink printed inside it (``trim_to_ink``)."""
    out = []
    for f in json.loads((FIXTURES / "scanned" / "figures.json").read_text())["figures"]:
        out.append({**f, "set": "scanned", "pdf": str(scans / f"{f['paper']}.pdf")})
    for f in json.loads((FIXTURES / "digital" / "figures.json").read_text())["figures"]:
        pdf = digital / f["paper"] / "paper.pdf"
        nxt = ld.next_question_top(pdf, f["page"], f["box"][3])
        out.append({**f, "set": "digital", "pdf": str(pdf), "next_question_top": nxt})
    seen: dict[str, int] = {}
    for n, f in enumerate(out):
        f["id"] = figure_id(f, seen)
        # Tuning half: every other figure in each set.
        f["half"] = "tune" if n % 2 == 0 else "check"
        if trim:
            f["box"] = trim_to_ink(f)
    return out


def trim_to_ink(f: dict) -> list[float]:
    """The gold box cut to what is printed inside it. Some gold boxes hold blank
    page: maths Q17's follows its circle's Bezier control points, 3% past the
    printed circle, and the scanned ones were read by hand. Counts anything
    darker than TRIM_LEVEL, far paler than INK_LEVEL, so faint parts of a figure
    stay in the gold whether or not ink growth can see them."""
    mask = ink_page(f["pdf"], f["page"], TRIM_LEVEL)
    w, h = mask.size
    g = f["box"]
    left, top = round(g[0] * w / 1000), round(g[1] * h / 1000)
    found = mask.crop((left, top, round(g[2] * w / 1000), round(g[3] * h / 1000)))
    bbox = found.getbbox()
    if bbox is None:
        return g
    return [
        (left + bbox[0]) / w * 1000,
        (top + bbox[1]) / h * 1000,
        (left + bbox[2]) / w * 1000,
        (top + bbox[3]) / h * 1000,
    ]


def figure_id(f: dict, seen: dict[str, int]) -> str:
    """paper-p<page>-q<label>-<k>: k counts a question's figures on a page."""
    base = f"{f['paper']}-p{f['page']}-q{f['label']}"
    seen[base] = seen.get(base, 0) + 1
    return f"{base}-{seen[base]}"


def pages(figs: list[dict]) -> dict[tuple[str, int], list[dict]]:
    out: dict[tuple[str, int], list[dict]] = {}
    for f in figs:
        out.setdefault((f["paper"], f["page"]), []).append(f)
    return out


@functools.cache
def page_jpeg(pdf: str, number: int) -> bytes:
    from pipeline.config import cfg
    from pipeline.retrieval import capture

    jpeg, _box, _size = capture.render(Path(pdf), number, None, cfg.capture_max_edge)
    return jpeg


def data_url(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()


# ------------------------------------------------------------------ parsing


def _json_list(text: str):
    text = re.sub(r"```(?:json)?", "", text)
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end < start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def _ordered(entries: list[tuple[str, list]], labels: list[str]) -> list[list] | None:
    """Boxes in listed order: matched by the entry's label (the figure's
    number, or "Question <label>") when every entry matches a different
    figure, else as answered."""
    if len(entries) != len(labels):
        return None
    place = []
    for answered, _ in entries:
        answered = str(answered).strip()
        n = int(answered) - 1 if answered.isdigit() else None
        if n is None or not 0 <= n < len(labels):
            hits = [
                i
                for i, label in enumerate(labels)
                if re.search(rf"\bQuestion {re.escape(label)}\b", answered)
            ]
            n = hits[0] if len(hits) == 1 else None
        place.append(n)
    if None in place or len(set(place)) != len(place):
        return [b for _, b in entries]
    return [b for _, b in sorted(zip(place, (b for _, b in entries), strict=True))]


def _keyed_entries(text: str, key: str) -> list[tuple[str, list]]:
    """(label, box) pairs read off the answer's text in order, for answers
    that are not a list of objects (Qwen3-VL sometimes writes every figure's
    label and box into one object, repeating the keys)."""
    entries: list[tuple[str, list]] = []
    label, box = None, None
    pattern = rf'"(label|{key})"\s*:\s*(?:"([^"]*)"|\[([^\]]*)\])'
    for m in re.finditer(pattern, text):
        if m.group(1) == key:
            if box is not None:
                entries.append((label or "", box))
                label = None
            try:
                box = [float(v) for v in m.group(3).split(",")]
            except (TypeError, ValueError):
                return []
        else:
            label = m.group(2)
        if label is not None and box is not None:
            entries.append((label, box))
            label, box = None, None
    if box is not None:
        entries.append((label or "", box))
    return entries


def parse(fmt: str, text: str, labels: list[str]) -> list[list[float]] | None:
    """The answer's boxes as [left, top, right, bottom] on 0-1000, or None."""
    if fmt == "glm":
        found = re.findall(
            r"(?:(\d+)\s*[:.)]\s*)?(?:<\|begin_of_box\|>)?\s*\[\[?\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]?\]",
            text,
        )
        entries = [(m[0], [float(v) for v in m[1:]]) for m in found]
    else:
        key = "box_2d" if fmt == "gemini" else "bbox_2d"
        data = _json_list(text)
        entries = []
        if isinstance(data, list) and all(
            isinstance(i, dict) and isinstance(i.get(key), list) for i in data
        ):
            entries = [(i.get("label", ""), i[key]) for i in data]
        if len(entries) != len(labels):
            entries = _keyed_entries(text, key)
    boxes = _ordered(entries, labels)
    if boxes is None:
        return None
    out = []
    for b in boxes:
        if len(b) != 4 or not all(isinstance(v, (int, float)) for v in b):
            return None
        if fmt == "gemini":
            b = [b[1], b[0], b[3], b[2]]
        box = [min(1000.0, max(0.0, float(v))) for v in b]
        if not (box[0] < box[2] and box[1] < box[3]):
            return None
        out.append(box)
    return out


# ------------------------------------------------------------------ calls


def load_keys(path: str) -> dict[str, str]:
    keys = {}
    for line in Path(path).read_text().splitlines():
        name, _, value = line.strip().partition("=")
        if name in (
            "OPENROUTER_API_KEY",
            "ALIBABA_MODELSTUDIO_KEY",
            "ALIBABA_MODELSTUDIO_URL",
        ):
            keys[name] = value.strip().strip('"')
    return keys


class Spend:
    """The bench's running total across processes, in .results/hosted/spend.json."""

    path = OUT / "spend.json"

    def __init__(self) -> None:
        OUT.mkdir(parents=True, exist_ok=True)
        self.data = (
            json.loads(self.path.read_text())
            if self.path.exists()
            else {"usd": 0.0, "by": {}}
        )

    def add(self, name: str, usd: float) -> None:
        self.data["usd"] = round(self.data["usd"] + usd, 6)
        self.data["by"][name] = round(self.data["by"].get(name, 0.0) + usd, 6)
        self.path.write_text(json.dumps(self.data, indent=1))

    def check(self, margin: float) -> None:
        if self.data["usd"] + margin > SPEND_CAP:
            raise SystemExit(
                f"stopping: spent ${self.data['usd']:.4f}, cap ${SPEND_CAP}"
            )


async def complete(
    client,
    keys: dict,
    model: dict,
    system: str | None,
    text: str,
    image: str,
    max_tokens: int,
    extra_image: dict | None = None,
) -> dict:
    """One call; returns text, provider, cost, tokens and seconds."""
    content = [
        {"type": "image_url", "image_url": {"url": image}, **(extra_image or {})},
        {"type": "text", "text": text},
    ]
    messages = ([{"role": "system", "content": system}] if system else []) + [
        {"role": "user", "content": content}
    ]
    body = {"model": model["slug"], "messages": messages, "max_tokens": max_tokens}
    if model["api"] == "openrouter":
        url = OPENROUTER_URL
        headers = {"Authorization": f"Bearer {keys['OPENROUTER_API_KEY']}"}
        body["provider"] = {
            "order": model["order"],
            "allow_fallbacks": False,
            "ignore": ["deepinfra"],
        }
        body["usage"] = {"include": True}
        if "reasoning" in model:
            body["reasoning"] = model["reasoning"]
        if model["fmt"] == "gemini":
            body["response_format"] = {"type": "json_object"}
    else:
        url = keys["ALIBABA_MODELSTUDIO_URL"].rstrip("/") + "/chat/completions"
        headers = {"Authorization": f"Bearer {keys['ALIBABA_MODELSTUDIO_KEY']}"}
        body |= model.get("body", {})
    started = time.monotonic()
    resp = await client.post(url, headers=headers, json=body, timeout=TIMEOUT_S)
    seconds = time.monotonic() - started
    try:
        raw = resp.json()
    except ValueError:
        raw = {}
    if resp.status_code != 200 or "choices" not in raw:
        err = raw.get("error") if isinstance(raw, dict) else None
        raise RuntimeError(
            f"HTTP {resp.status_code}: {json.dumps(err)[:300] if err else resp.text[:300]}"
        )
    usage = raw.get("usage") or {}
    details = usage.get("completion_tokens_details") or {}
    message = raw["choices"][0]["message"]
    tokens_in, tokens_out = (
        usage.get("prompt_tokens", 0),
        usage.get("completion_tokens", 0),
    )
    if model["api"] == "openrouter":
        cost = usage.get("cost") or 0.0
        provider = raw.get("provider")
    else:
        price = model["price"]
        cost = (tokens_in * price[0] + tokens_out * price[1]) / 1e6
        provider = "alibaba-model-studio-sg"
    return {
        "text": message.get("content") or "",
        "reasoning_chars": len(
            message.get("reasoning") or message.get("reasoning_content") or ""
        ),
        "provider": provider,
        "cost": cost,
        "tokens": [tokens_in, tokens_out, details.get("reasoning_tokens", 0)],
        "seconds": round(seconds, 2),
    }


async def call_run(args) -> None:
    import httpx

    keys = load_keys(args.env_file)
    model = MODELS[args.model]
    figs = figures(Path(args.scans), Path(args.digital))
    by_page = pages(figs)
    if args.limit:
        by_page = dict(itertools.islice(by_page.items(), args.limit))
    spend = Spend()
    spend.check(0.0)
    name = f"{args.model}-{args.repeat}"
    sem = asyncio.Semaphore(CONCURRENCY)
    max_tokens = model.get("max_tokens", 1000)
    extra = (
        {"min_pixels": MIN_PIXELS, "max_pixels": MAX_PIXELS}
        if model.get("pixels")
        else None
    )

    async def one(client, key, items) -> dict:
        listed = "\n".join(
            f"{n}. Question {f['label']}: {f['description']}"
            for n, f in enumerate(items, 1)
        )
        system, text = prompt(model["fmt"], listed)
        image = data_url(page_jpeg(items[0]["pdf"], key[1]))
        attempts = []
        async with sem:
            for _ in range(2):
                spend.check(0.01)
                try:
                    got = await complete(
                        client, keys, model, system, text, image, max_tokens, extra
                    )
                except (RuntimeError, httpx.HTTPError) as exc:
                    attempts.append({"error": str(exc)[:300]})
                    continue
                spend.add(args.model, got["cost"])
                got["boxes"] = parse(
                    model["fmt"], got["text"], [f["label"] for f in items]
                )
                attempts.append(got)
                if got["boxes"] is not None:
                    break
        last = attempts[-1]
        return {
            "paper": key[0],
            "page": key[1],
            "ids": [f["id"] for f in items],
            "attempts": attempts,
            "boxes": last.get("boxes"),
        }

    started = time.monotonic()
    async with httpx.AsyncClient() as client:
        calls = await asyncio.gather(*(one(client, k, v) for k, v in by_page.items()))
    raw = {}
    for c in calls:
        for i, fid in enumerate(c["ids"]):
            raw[fid] = c["boxes"][i] if c["boxes"] else None
    attempts = [a for c in calls for a in c["attempts"]]
    result = {
        "model": args.model,
        "slug": model["slug"],
        "api": model["api"],
        "repeat": args.repeat,
        "seconds": round(time.monotonic() - started, 1),
        "calls": len(calls),
        "attempts": len(attempts),
        "failed_calls": sum(1 for c in calls if c["boxes"] is None),
        "providers": sorted({a["provider"] for a in attempts if a.get("provider")}),
        "billed_usd": round(sum(a.get("cost", 0) for a in attempts), 5),
        "call_seconds": sorted(a["seconds"] for a in attempts if "seconds" in a),
        "tokens": [
            sum(a["tokens"][i] for a in attempts if "tokens" in a) for i in range(3)
        ],
        "raw": raw,
        "page_calls": calls,
    }
    folder = OUT / ("probes" if args.limit else "runs")
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.json").write_text(json.dumps(result, indent=1))
    if args.limit:
        for c in calls:
            print(
                c["paper"],
                c["page"],
                [
                    a.get("error")
                    or (a["provider"], a["tokens"], a["seconds"], a["text"][:400])
                    for a in c["attempts"]
                ],
            )
    show = {
        k: result[k]
        for k in (
            "seconds",
            "calls",
            "attempts",
            "failed_calls",
            "providers",
            "billed_usd",
            "tokens",
        )
    }
    print(name, json.dumps(show), "spent so far", spend.data["usd"])
    for c in calls:
        if c["boxes"] is None:
            print(
                "  failed",
                c["paper"],
                c["page"],
                [a.get("error") or a.get("text", "")[:200] for a in c["attempts"]],
            )


# ------------------------------------------------------------- text lines


def _parse_lines(text: str, size: tuple[int, int]) -> list[dict]:
    """advanced_recognition's text lines as {text, box (0-1000)}; its rotated
    rectangles are [cx, cy, width, height, angle] in the page image's
    pixels."""
    data = _json_list(text)
    lines = []
    w, h = size
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        rect = item.get("rotate_rect")
        if not (isinstance(rect, list) and len(rect) == 5):
            continue
        cx, cy, rw, rh, angle = (float(v) for v in rect)
        if abs(angle) > 45:
            rw, rh = rh, rw
        box = [
            (cx - rw / 2) / w * 1000,
            (cy - rh / 2) / h * 1000,
            (cx + rw / 2) / w * 1000,
            (cy + rh / 2) / h * 1000,
        ]
        lines.append(
            {"text": str(item.get("text", "")), "box": [round(v, 1) for v in box]}
        )
    return lines


def tesseract_lines(pdf: str, number: int) -> list[dict]:
    """The page's text lines from Tesseract on a 2,200 px grey render, as
    {text, box (0-1000)}."""
    import subprocess
    import tempfile

    import pymupdf

    with pymupdf.open(pdf) as doc:
        pg = doc[number - 1]
        scale = 2200 / max(pg.rect.width, pg.rect.height)
        pix = pg.get_pixmap(
            matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csGRAY
        )
        with tempfile.NamedTemporaryFile(suffix=".png") as png:
            pix.save(png.name)
            tsv = subprocess.run(
                ["tesseract", png.name, "-", "--psm", "3", "tsv"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
    w, h = pix.width, pix.height
    grouped: dict[tuple, dict] = {}
    for row in tsv.splitlines()[1:]:
        f = row.split("\t")
        if len(f) < 12 or f[0] != "5" or not f[11].strip():
            continue
        x, y, bw, bh = (int(v) for v in f[6:10])
        line = grouped.setdefault(
            tuple(f[1:5]), {"words": [], "box": [x, y, x + bw, y + bh]}
        )
        line["words"].append(f[11].strip())
        b = line["box"]
        line["box"] = [min(b[0], x), min(b[1], y), max(b[2], x + bw), max(b[3], y + bh)]
    return [
        {
            "text": " ".join(line["words"]),
            "box": [
                round(line["box"][0] / w * 1000, 1),
                round(line["box"][1] / h * 1000, 1),
                round(line["box"][2] / w * 1000, 1),
                round(line["box"][3] / h * 1000, 1),
            ],
        }
        for line in grouped.values()
    ]


async def lines_run(args) -> None:
    """Every page's text lines, from Model Studio's advanced_recognition task
    or from Tesseract, into .results/hosted/lines-<source>.json."""
    import io

    import httpx
    from PIL import Image

    figs = figures(Path(args.scans), Path(args.digital))
    by_page = pages(figs)
    if args.limit:
        by_page = dict(itertools.islice(by_page.items(), args.limit))
    if args.source == "tesseract":
        calls = [
            {"paper": k[0], "page": k[1], "lines": tesseract_lines(v[0]["pdf"], k[1])}
            for k, v in by_page.items()
        ]
    else:
        keys = load_keys(args.env_file)
        model = MODELS[LINES_MODEL]
        spend = Spend()
        sem = asyncio.Semaphore(CONCURRENCY)
        extra = {"min_pixels": MIN_PIXELS, "max_pixels": MAX_PIXELS}

        async def one(client, key, items):
            jpeg = page_jpeg(items[0]["pdf"], key[1])
            size = Image.open(io.BytesIO(jpeg)).size
            async with sem:
                spend.check(0.01)
                got = await complete(
                    client, keys, model, None, LINES_PROMPT, data_url(jpeg), 8000, extra
                )
            spend.add("lines", got["cost"])
            return {
                "paper": key[0],
                "page": key[1],
                "size": size,
                **got,
                "lines": _parse_lines(got["text"], size),
            }

        async with httpx.AsyncClient() as client:
            calls = await asyncio.gather(
                *(one(client, k, v) for k, v in by_page.items())
            )
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"lines-{args.source}.json").write_text(
        json.dumps(calls, indent=1, ensure_ascii=False)
    )
    print(
        "lines",
        args.source,
        len(calls),
        "pages",
        sum(len(c["lines"]) for c in calls),
        "lines",
    )


# ------------------------------------------------------------- mistral-ocr

# The file-parser plugin's model call: the cheapest image model, one token.
MISTRAL_CARRIER = ("qwen/qwen3-vl-30b-a3b-instruct", ["novita"])


def _locate_crop(page, crop, scales):
    """Where a crop sits on the page, by normalised cross-correlation over
    ``scales`` (crop pixels to page pixels): (score, scale, x, y, w, h)."""
    import cv2

    best = (-1.0, 0, 0, 0, 0, 0)
    for scale in scales:
        w, h = round(crop.shape[1] * scale), round(crop.shape[0] * scale)
        if w < 8 or h < 8 or w > page.shape[1] or h > page.shape[0]:
            continue
        tpl = cv2.resize(crop, (w, h), interpolation=cv2.INTER_AREA)
        res = cv2.matchTemplate(page, tpl, cv2.TM_CCOEFF_NORMED)
        _, score, _, (x, y) = cv2.minMaxLoc(res)
        if score > best[0]:
            best = (score, scale, x, y, w, h)
    return best


async def mistral_run(args) -> None:
    """OpenRouter's file-parser plugin with the mistral-ocr engine, one page
    PDF a call. The parsed file holds the page's markdown and the images
    Mistral cut out of it, but no coordinates, so each image is found on the
    page again by template matching (needs numpy and opencv). Each gold figure
    takes the image that overlaps it most."""
    import cv2
    import httpx
    import numpy as np
    import pymupdf

    keys = load_keys(args.env_file)
    figs = figures(Path(args.scans), Path(args.digital))
    by_page = pages(figs)
    if args.limit:
        by_page = dict(itertools.islice(by_page.items(), args.limit))
    spend = Spend()
    sem = asyncio.Semaphore(CONCURRENCY)

    async def parse_page(client, key, items):
        with pymupdf.open(items[0]["pdf"]) as src:
            one = pymupdf.open()
            one.insert_pdf(src, from_page=key[1] - 1, to_page=key[1] - 1)
            pdf = one.tobytes()
        body = {
            "model": MISTRAL_CARRIER[0],
            "provider": {
                "order": MISTRAL_CARRIER[1],
                "allow_fallbacks": False,
                "ignore": ["deepinfra"],
            },
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Reply with the word ok."},
                        {
                            "type": "file",
                            "file": {
                                "filename": "page.pdf",
                                "file_data": "data:application/pdf;base64,"
                                + base64.b64encode(pdf).decode(),
                            },
                        },
                    ],
                }
            ],
            "plugins": [{"id": "file-parser", "pdf": {"engine": "mistral-ocr"}}],
            "max_tokens": 4,
            "usage": {"include": True},
        }
        async with sem:
            spend.check(0.01)
            started = time.monotonic()
            resp = await client.post(
                OPENROUTER_URL,
                headers={"Authorization": f"Bearer {keys['OPENROUTER_API_KEY']}"},
                json=body,
                timeout=TIMEOUT_S,
            )
            seconds = time.monotonic() - started
        raw = resp.json()
        if "choices" not in raw:
            return {
                "paper": key[0],
                "page": key[1],
                "error": json.dumps(raw.get("error"))[:300],
            }
        cost = (raw.get("usage") or {}).get("cost") or 0.0
        spend.add("mistral-ocr", cost)
        texts, images = [], []
        for a in raw["choices"][0]["message"].get("annotations") or []:
            for part in (a.get("file") or {}).get("content", []):
                if part.get("type") == "text":
                    texts.append(part["text"])
                elif part.get("type") == "image_url":
                    url = (
                        part["image_url"]["url"]
                        if isinstance(part["image_url"], dict)
                        else part["image_url"]
                    )
                    images.append(base64.b64decode(url.split(",", 1)[1]))
        return {
            "paper": key[0],
            "page": key[1],
            "provider": raw.get("provider"),
            "cost": cost,
            "seconds": round(seconds, 2),
            "markdown": "".join(texts),
            "images": images,
        }

    async with httpx.AsyncClient() as client:
        calls = await asyncio.gather(
            *(parse_page(client, k, v) for k, v in by_page.items())
        )

    raw_boxes: dict[str, list[float] | None] = {}
    paper_scale: dict[str, float] = {}
    for call in calls:
        items = by_page[(call["paper"], call["page"])]
        located = []
        if call.get("images"):
            with pymupdf.open(items[0]["pdf"]) as doc:
                pg = doc[call["page"] - 1]
                zoom = 1000 / pg.rect.width
                pix = pg.get_pixmap(
                    matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csGRAY
                )
            page = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width
            )
            for data in call["images"]:
                crop = cv2.imdecode(
                    np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE
                )
                known = paper_scale.get(call["paper"])
                if known:
                    scales = [known * (1 + d / 200) for d in range(-8, 9)]
                else:
                    scales = [1000 / wm for wm in np.geomspace(500, 3000, 120)]
                score, scale, x, y, w, h = _locate_crop(page, crop, scales)
                if score > 0.8 and not known:
                    paper_scale[call["paper"]] = scale
                located.append(
                    {
                        "score": round(score, 3),
                        "box": [
                            x / pix.width * 1000,
                            y / pix.height * 1000,
                            (x + w) / pix.width * 1000,
                            (y + h) / pix.height * 1000,
                        ],
                    }
                )
        call["located"] = located
        call["image_count"] = len(call.pop("images", []) or [])
        for f in items:
            best = max(
                located, key=lambda c: ld._overlap(c["box"], f["box"]), default=None
            )
            hit = best is not None and ld._overlap(best["box"], f["box"]) > 0
            raw_boxes[f["id"]] = [round(v, 1) for v in best["box"]] if hit else None
    secs = sorted(c["seconds"] for c in calls if "seconds" in c)
    result = {
        "model": "mistral-ocr",
        "slug": "file-parser/mistral-ocr",
        "api": "openrouter",
        "repeat": args.repeat,
        "calls": len(calls),
        "attempts": len(calls),
        "failed_calls": sum(1 for c in calls if "error" in c),
        "providers": sorted({c["provider"] for c in calls if c.get("provider")}),
        "billed_usd": round(sum(c.get("cost", 0) for c in calls), 5),
        "call_seconds": secs,
        "tokens": [0, 0, 0],
        "paper_scale": paper_scale,
        "raw": raw_boxes,
        "pages": calls,
    }
    folder = OUT / ("probes" if args.limit else "runs")
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"mistral-ocr-{args.repeat}.json").write_text(
        json.dumps(result, indent=1)
    )
    weak = [
        (c["paper"], c["page"], loc["score"])
        for c in calls
        for loc in c.get("located", [])
        if loc["score"] < 0.8
    ]
    print(
        "mistral-ocr",
        args.repeat,
        {k: result[k] for k in ("calls", "failed_calls", "providers", "billed_usd")},
        "images",
        sum(c.get("image_count", 0) for c in calls),
        "weak matches",
        weak,
        "figures without an image",
        [k for k, v in raw_boxes.items() if v is None],
        "spent so far",
        spend.data["usd"],
    )


def import_layout(args) -> None:
    """The layout bench's final crops (PP-DocLayout_plus-L, 1017 picking the
    numbered box, adjacent caption, 1% pad) as two of this bench's runs: scan
    descriptions from window runs 73 with digital repeat 1, 74 with repeat 2.
    Its files keep each crop's edges against the gold, rounded to a grid unit."""
    figs = figures(Path(args.scans), Path(args.digital))
    gold = {f["id"]: f["box"] for f in figs}
    scans = json.loads(Path(args.scans_match).read_text())
    for repeat, (run, digital_path) in enumerate(
        (("73", args.digital_match[0]), ("74", args.digital_match[1])), 1
    ):
        digital = json.loads(Path(digital_path).read_text())
        sets = [v for k, v in scans["sets"].items() if k.endswith(f"-{run}")]
        sets += list(digital["sets"].values())
        raw, seen = {}, {}
        for row in (r for one in sets for r in one["rows"]):
            paper, page = row["page"].rsplit("-p", 1)
            fid = figure_id(
                {"paper": paper, "page": int(page), "label": row["label"]}, seen
            )
            raw[fid] = [
                g + e for g, e in zip(gold[fid], row["crop"]["edges"], strict=True)
            ]
        result = {
            "model": LAYOUT,
            "slug": "PP-DocLayout_plus-L + deepseek/deepseek-v4.1-flash-1017",
            "api": "openrouter",
            "repeat": repeat,
            "calls": sum(one["pages"] for one in sets),
            "providers": digital["providers"],
            "billed_usd": round(scans["billed_usd"] / 2 + digital["billed_usd"], 5),
            "raw": raw,
        }
        (OUT / "runs").mkdir(parents=True, exist_ok=True)
        (OUT / "runs" / f"{LAYOUT}-{repeat}.json").write_text(
            json.dumps(result, indent=1)
        )
        print(LAYOUT, repeat, len(raw), "figures")


def import_deepseek(args) -> None:
    """A saved locate_digital / locate_variants run (scanned or digital) as one
    of this bench's runs; runs given together are merged."""
    raw, meta = {}, {"seconds": 0.0, "billed_usd": 0.0, "calls": 0, "providers": set()}
    for path in args.runs:
        data = json.loads(Path(path).read_text())
        seen: dict[str, int] = {}
        for row in data["figures"]:
            fid = figure_id(row, seen)
            raw[fid] = row["raw"]["box"] if "raw" in row else None
        meta["seconds"] += data.get("seconds", 0)
        meta["billed_usd"] += data.get("billed_usd", 0)
        meta["calls"] += data.get("calls", 0)
        meta["providers"] |= set(data.get("providers", []))
    result = {
        "model": args.name,
        "slug": "deepseek/deepseek-v4.1-flash-1017",
        "api": "openrouter",
        "repeat": args.repeat,
        **meta,
        "providers": sorted(meta["providers"]),
        "billed_usd": round(meta["billed_usd"], 5),
        "raw": raw,
        "sources": [Path(p).name for p in args.runs],
    }
    (OUT / "runs").mkdir(parents=True, exist_ok=True)
    (OUT / "runs" / f"{args.name}-{args.repeat}.json").write_text(
        json.dumps(result, indent=1)
    )
    print(args.name, args.repeat, len(raw), "figures")


# ------------------------------------------------------- post-processing

PAD = (20, 30, 20, 5)  # extraction.FIGURE_PAD
WIDE = [(s, 30, s, b) for s in (30, 40, 50, 60) for b in (10, 15, 20)]
NARROW = [
    (5, 5, 5, 5),
    (10, 10, 10, 10),
    (15, 15, 15, 15),
    (20, 20, 20, 20),
    (10, 20, 10, 5),
    (15, 20, 15, 5),
    (20, 20, 20, 5),
]
INK = [
    {"gap": g, "cap": c, "margin": m}
    for g in (4, 6, 8, 12, 16)
    for c in (30, 50, 80, 120)
    for m in (0, 5, 10)
]
LINES = [
    {"reach": r, "longest": n, "margin": m}
    for r in (5, 10, 20, 30)
    for n in (6, 12, 20)
    for m in (0, 5, 10)
]
INK_LEVEL = 150  # grey below this is ink
INK_MIN = 2  # dark pixels a strip needs to count as ink
TRIM_LEVEL = 235  # grey below this is printed, for trimming the gold


def pad(box: list[float], p: tuple) -> list[float]:
    return [
        max(0.0, box[0] - p[0]),
        max(0.0, box[1] - p[1]),
        min(1000.0, box[2] + p[2]),
        min(1000.0, box[3] + p[3]),
    ]


@functools.cache
def ink_page(pdf: str, number: int, level: int = INK_LEVEL):
    """The page at the model image's scale as a 0/255 ink mask."""
    import io

    from PIL import Image

    grey = Image.open(io.BytesIO(page_jpeg(pdf, number))).convert("L")
    return grey.point(lambda v: 255 if v < level else 0)


def grow_ink(
    mask, box: list[float], gap: float, cap: float, margin: float
) -> list[float]:
    """Push each edge outward while the strip just outside it holds ink;
    stop after ``gap`` blank grid units or ``cap`` units from the start."""
    w, h = mask.size
    sx, sy = w / 1000, h / 1000
    x0, y0, x1, y1 = (
        round(box[0] * sx),
        round(box[1] * sy),
        round(box[2] * sx),
        round(box[3] * sy),
    )
    lim = (
        max(0, x0 - round(cap * sx)),
        max(0, y0 - round(cap * sy)),
        min(w - 1, x1 + round(cap * sx)),
        min(h - 1, y1 + round(cap * sy)),
    )
    gx, gy = max(1, round(gap * sx)), max(1, round(gap * sy))

    def ink(region) -> bool:
        return mask.crop(region).histogram()[255] >= INK_MIN

    changed = True
    while changed:
        changed = False
        # left
        pos, blank, new = x0, 0, x0
        while pos > lim[0] and blank < gx:
            pos -= 1
            if ink((pos, y0, pos + 1, y1 + 1)):
                new, blank = pos, 0
            else:
                blank += 1
        if new != x0:
            x0, changed = new, True
        # right
        pos, blank, new = x1, 0, x1
        while pos < lim[2] and blank < gx:
            pos += 1
            if ink((pos, y0, pos + 1, y1 + 1)):
                new, blank = pos, 0
            else:
                blank += 1
        if new != x1:
            x1, changed = new, True
        # top
        pos, blank, new = y0, 0, y0
        while pos > lim[1] and blank < gy:
            pos -= 1
            if ink((x0, pos, x1 + 1, pos + 1)):
                new, blank = pos, 0
            else:
                blank += 1
        if new != y0:
            y0, changed = new, True
        # bottom
        pos, blank, new = y1, 0, y1
        while pos < lim[3] and blank < gy:
            pos += 1
            if ink((x0, pos, x1 + 1, pos + 1)):
                new, blank = pos, 0
            else:
                blank += 1
        if new != y1:
            y1, changed = new, True
    grown = [x0 / sx, y0 / sy, (x1 + 1) / sx, (y1 + 1) / sy]
    return pad(grown, (margin, margin, margin, margin))


def grow_lines(
    lines: list[dict], box: list[float], reach: float, longest: int, margin: float
) -> list[float]:
    """Take in each short text line (``longest`` characters or fewer) that
    touches the box or sits within ``reach`` grid units of it, until none is
    left; long lines are question text and are never taken."""
    b = list(box)
    short = [ln["box"] for ln in lines if 0 < len(ln["text"].strip()) <= longest]
    changed = True
    while changed:
        changed = False
        for lb in short:
            near = (
                lb[0] < b[2] + reach
                and lb[2] > b[0] - reach
                and lb[1] < b[3] + reach
                and lb[3] > b[1] - reach
            )
            inside = lb[0] >= b[0] and lb[1] >= b[1] and lb[2] <= b[2] and lb[3] <= b[3]
            if near and not inside:
                b = [
                    min(b[0], lb[0]),
                    min(b[1], lb[1]),
                    max(b[2], lb[2]),
                    max(b[3], lb[3]),
                ]
                changed = True
    return pad(b, (margin, margin, margin, margin))


# ------------------------------------------------------------------ scoring


def score_one(
    fig: dict, others: list[list[float]], box: list[float] | None
) -> dict | None:
    if box is None:
        return None
    scored = ld.score(fig, box, others, fig.get("next_question_top"))
    # ld.score rounds; compare the exact values, as layout_score.py does.
    inter = ld._overlap(fig["box"], box)
    scored["whole"] = inter / ld._area(fig["box"]) >= 0.98
    scored["tight"] = inter / ld._area(box) >= 0.7
    return scored


def tally(scored: list[dict | None]) -> dict:
    ok = [s for s in scored if s]
    return {
        "n": len(scored),
        "whole": sum(1 for s in ok if s["whole"]),
        "tight": sum(1 for s in ok if s["tight"]),
        "both": sum(1 for s in ok if s["whole"] and s["tight"]),
        "next": sum(1 for s in ok if s["next_question"]),
        "other": sum(1 for s in ok if s["other_figure"]),
        "none": sum(1 for s in scored if s is None),
        "share": round(sum(s["figure_share"] for s in ok) / len(ok), 3) if ok else 0,
    }


def objective(t: dict) -> tuple:
    """Crops both whole and tight first; another question or figure in a crop
    costs two of them; whole breaks ties."""
    return (t["both"] - 2 * (t["next"] + t["other"]), t["whole"])


def load_runs(figs: list[dict]) -> dict[str, list[dict]]:
    """Every saved run, its raw boxes read again from the saved answers with
    today's parser: each page takes its first answer that parses, as
    production would have."""
    label = {f["id"]: f["label"] for f in figs}
    runs: dict[str, list[dict]] = {}
    for path in sorted((OUT / "runs").glob("*.json")):
        data = json.loads(path.read_text())
        fmt = MODELS[data["model"]]["fmt"] if data["model"] in MODELS else None
        for call in data.get("page_calls", []) if fmt else []:
            boxes = None
            for attempt in call["attempts"]:
                if "text" in attempt:
                    boxes = parse(fmt, attempt["text"], [label[i] for i in call["ids"]])
                    if boxes:
                        break
            for n, fid in enumerate(call["ids"]):
                data["raw"][fid] = boxes[n] if boxes else None
        runs.setdefault(data["model"], []).append(data)
        if data["model"] == "mistral-ocr":
            # Mistral cuts a figure made of separate drawings (two shapes, four
            # option diagrams, a key) into several images. Their union, taking
            # every image mostly inside the gold box: an upper bound, since
            # production would have to group them from the markdown.
            union = dict(data, model="mistral-ocr-union", raw={})
            by_page = {
                (c["paper"], c["page"]): c.get("located", []) for c in data["pages"]
            }
            for f in figs:
                inside = [
                    c["box"]
                    for c in by_page.get((f["paper"], f["page"]), [])
                    if ld._overlap(c["box"], f["box"]) > 0.5 * ld._area(c["box"])
                ]
                union["raw"][f["id"]] = (
                    [
                        min(b[0] for b in inside),
                        min(b[1] for b in inside),
                        max(b[2] for b in inside),
                        max(b[3] for b in inside),
                    ]
                    if inside
                    else data["raw"].get(f["id"])
                )
            runs.setdefault(union["model"], []).append(union)
    return runs


def methods(lines_by_source: dict):
    """Each post-processing as (name, settings, function(fig, raw, setting) -> box)."""
    out = [
        ("raw", [None], lambda fig, raw, p: raw),
        ("pad", [PAD], lambda fig, raw, p: pad(raw, p)),
        ("narrow", NARROW, lambda fig, raw, p: pad(raw, p)),
        ("wide", WIDE, lambda fig, raw, p: pad(raw, p)),
        (
            "ink",
            INK,
            lambda fig, raw, p: grow_ink(
                ink_page(fig["pdf"], fig["page"]), raw, p["gap"], p["cap"], p["margin"]
            ),
        ),
    ]
    for source, by_page in lines_by_source.items():

        def fn(fig, raw, p, by_page=by_page):
            lines = by_page.get((fig["paper"], fig["page"]))
            if lines is None:
                return None
            return grow_lines(lines, raw, p["reach"], p["longest"], p["margin"])

        out.append((f"lines-{source}", LINES, fn))
    return out


def score_all(args) -> dict:
    figs = figures(Path(args.scans), Path(args.digital), trim=args.trim_gold)
    by_page = pages(figs)
    others = {
        f["id"]: [g["box"] for g in by_page[(f["paper"], f["page"])] if g is not f]
        for f in figs
    }
    lines_by_source = {
        path.stem.removeprefix("lines-"): {
            (c["paper"], c["page"]): c["lines"] for c in json.loads(path.read_text())
        }
        for path in sorted(OUT.glob("lines-*.json"))
    }
    runs = load_runs(figs)
    report: dict = {}
    for name, model_runs in runs.items():
        entry = {"runs": [], "methods": {}}
        for r in model_runs:
            entry["runs"].append(
                {
                    k: r.get(k)
                    for k in (
                        "repeat",
                        "seconds",
                        "calls",
                        "attempts",
                        "failed_calls",
                        "providers",
                        "billed_usd",
                        "call_seconds",
                        "tokens",
                    )
                }
            )
        for method, settings, fn in methods(lines_by_source):
            if name == LAYOUT and method != "raw":
                continue  # its saved boxes are already finished crops
            # Tune on the tune half over both runs, check on the other half.
            best, best_key = None, None
            for setting in settings:
                scored = [
                    score_one(
                        f,
                        others[f["id"]],
                        fn(f, r["raw"][f["id"]], setting)
                        if r["raw"].get(f["id"])
                        else None,
                    )
                    for r in model_runs
                    for f in figs
                    if f["half"] == "tune"
                ]
                key = objective(tally(scored))
                if best_key is None or key > best_key:
                    best, best_key = setting, key
            per_run = []
            for r in model_runs:
                row = {}
                boxes = {}
                for subset in ("scanned", "digital"):
                    scored = []
                    for f in figs:
                        if f["set"] != subset:
                            continue
                        raw = r["raw"].get(f["id"])
                        box = fn(f, raw, best) if raw else None
                        boxes[f["id"]] = box
                        scored.append(score_one(f, others[f["id"]], box))
                    row[subset] = tally(scored)
                row["check"] = tally(
                    [
                        score_one(f, others[f["id"]], boxes[f["id"]])
                        for f in figs
                        if f["half"] == "check"
                    ]
                )
                row["boxes"] = boxes
                per_run.append(row)
            entry["methods"][method] = {"setting": best, "runs": per_run}
            if method == "wide":
                # The whole sweep on all figures, both runs together.
                entry["wide_sweep"] = []
                for setting in settings:
                    row = {"setting": setting}
                    for subset in ("scanned", "digital"):
                        row[subset] = tally(
                            [
                                score_one(
                                    f,
                                    others[f["id"]],
                                    fn(f, r["raw"][f["id"]], setting)
                                    if r["raw"].get(f["id"])
                                    else None,
                                )
                                for r in model_runs
                                for f in figs
                                if f["set"] == subset
                            ]
                        )
                    entry["wide_sweep"].append(row)
        report[name] = entry
    OUT.mkdir(parents=True, exist_ok=True)
    name = "summary-trimmed.json" if args.trim_gold else "summary.json"
    (OUT / name).write_text(json.dumps(report, indent=1))
    return report


# One setting each, the same on both golds: what the report compares head to head.
HEAD_TO_HEAD = [
    (LAYOUT, None),
    ("qwen3-vl-30b", {"gap": 6, "cap": 50, "margin": 10}),
    ("qwen3-vl-30b", {"gap": 6, "cap": 50, "margin": 5}),
    ("qwen3.6-plus", (5, 5, 5, 5)),
    ("qwen3.6-plus", {"gap": 6, "cap": 30, "margin": 5}),
    ("qwen3.6-plus", PAD),
    ("glm-4.5v", {"gap": 8, "cap": 80, "margin": 5}),
    ("deepseek-today", {"gap": 6, "cap": 80, "margin": 5}),
    ("deepseek-today", PAD),
]


def print_head_to_head(args) -> None:
    print(
        "\n| Gold | Model | Setting | Scans whole /28 | Scans tight | Digital whole "
        "/52 | Digital tight | Whole /80 | Tight /80 | Both /80 | Next q, other "
        "| Tuning half whole/tight/both /40 | Check half /40 |"
    )
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for trim in (False, True):
        figs = figures(Path(args.scans), Path(args.digital), trim=trim)
        by_page = pages(figs)
        runs = load_runs(figs)
        others = {
            f["id"]: [g["box"] for g in by_page[(f["paper"], f["page"])] if g is not f]
            for f in figs
        }
        for name, setting in HEAD_TO_HEAD:
            rows = [
                (
                    f,
                    score_one(
                        f, others[f["id"]], _finish(f, r["raw"][f["id"]], setting)
                    ),
                )
                for r in runs[name]
                for f in figs
            ]
            a = tally([x for f, x in rows if f["set"] == "scanned"])
            b = tally([x for f, x in rows if f["set"] == "digital"])
            t = tally([x for f, x in rows if f["half"] == "tune"])
            c = tally([x for f, x in rows if f["half"] == "check"])
            print(
                f"| {'printed ink' if trim else 'as it stands'} | {name} "
                f"| {json.dumps(setting)} | {a['whole']} | {a['tight']} | {b['whole']} "
                f"| {b['tight']} | {a['whole'] + b['whole']} | {a['tight'] + b['tight']} "
                f"| {a['both'] + b['both']} "
                f"| {a['next'] + b['next']}, {a['other'] + b['other']} "
                f"| {t['whole']}/{t['tight']}/{t['both']} "
                f"| {c['whole']}/{c['tight']}/{c['both']} |"
            )


def _finish(f: dict, raw: list[float], setting) -> list[float]:
    """A raw box with one setting: None as it is, a tuple a pad, a dict ink growth."""
    if setting is None:
        return raw
    if isinstance(setting, tuple):
        return pad(raw, setting)
    return grow_ink(ink_page(f["pdf"], f["page"]), raw, **setting)


def _both_runs(m: dict) -> dict:
    """A method's counts over both runs, by set and in all."""
    out = {}
    for field in ("whole", "tight", "both", "next", "other", "none"):
        out[f"S{field}"] = sum(r["scanned"][field] for r in m["runs"])
        out[f"D{field}"] = sum(r["digital"][field] for r in m["runs"])
        out[field] = out[f"S{field}"] + out[f"D{field}"]
    out["check"] = "/".join(
        str(sum(r["check"][k] for r in m["runs"])) for k in ("whole", "tight", "both")
    )
    out["per_run"] = ", ".join(
        str(r["scanned"]["whole"] + r["digital"]["whole"]) for r in m["runs"]
    )
    return out


def print_tables(report: dict) -> None:
    """Markdown tables, counts over both runs: 28 scanned crops, 52 digital."""
    print(
        "| Model | Method | Setting | Scans whole | Scans tight | Digital whole "
        "| Digital tight | Whole /80 | Tight /80 | Both /80 | Next q | Other fig "
        "| Whole per run | Check half whole/tight/both /40 |"
    )
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for name, entry in report.items():
        for method, m in entry["methods"].items():
            c = _both_runs(m)
            print(
                f"| {name} | {method} | {json.dumps(m['setting'])} | {c['Swhole']} "
                f"| {c['Stight']} | {c['Dwhole']} | {c['Dtight']} | {c['whole']} "
                f"| {c['tight']} | {c['both']} | {c['next']} | {c['other']} "
                f"| {c['per_run']} | {c['check']} |"
            )
    print("\nWide pad sweep (sides/bottom: whole S+D, tight, both, next+other)")
    for name, entry in report.items():
        cells = []
        for row in entry.get("wide_sweep") or []:
            a, b = row["scanned"], row["digital"]
            cells.append(
                f"{row['setting'][0]}/{row['setting'][3]}: {a['whole']}+{b['whole']} "
                f"t{a['tight'] + b['tight']} b{a['both'] + b['both']} "
                f"x{a['next'] + b['next'] + a['other'] + b['other']}"
            )
        if cells:
            print(f"- {name}: " + "; ".join(cells))
    print(
        "\n| Model | Provider | Calls | $ per call, run 1 | $ per 16 pages | Median s "
        "| p90 s | Tokens in, out per call | Reasoning tokens |"
    )
    print("|---|---|---|---|---|---|---|---|---|")
    for name, entry in report.items():
        runs = entry["runs"]
        if not runs[0].get("call_seconds"):
            continue
        attempts = sum(r["attempts"] for r in runs)
        first = runs[0]["billed_usd"] / runs[0]["attempts"]
        secs = sorted(x for r in runs for x in r["call_seconds"])
        tokens = [sum(r["tokens"][i] for r in runs) for i in range(3)]
        providers = sorted({p for r in runs for p in r["providers"]})
        print(
            f"| {name} | {', '.join(providers)} | {attempts} | {first:.5f} "
            f"| {16 * first:.4f} | {secs[len(secs) // 2]:.1f} "
            f"| {secs[int(len(secs) * 0.9)]:.1f} "
            f"| {tokens[0] // attempts}, {tokens[1] // attempts} | {tokens[2]} |"
        )


# --------------------------------------------------------------- contact sheet


def _px(box: list[float], w: int, h: int) -> list[float]:
    return [box[0] * w / 1000, box[1] * h / 1000, box[2] * w / 1000, box[3] * h / 1000]


def sheet(args) -> None:
    """The misses (under 98% covered) of each model:method, gold box green,
    crop red, on the page image."""
    import io

    from PIL import Image, ImageDraw, ImageFont

    figs = {f["id"]: f for f in figures(Path(args.scans), Path(args.digital))}
    report = json.loads((OUT / "summary.json").read_text())
    tiles = []
    for spec in args.specs:
        model, method = spec.split(":")
        for n, r in enumerate(report[model]["methods"][method]["runs"], 1):
            for fid, box in r["boxes"].items():
                f = figs[fid]
                s = ld.score(f, box, [], None) if box else None
                if s and s["covered"] >= 0.98:
                    continue
                page = Image.open(io.BytesIO(page_jpeg(f["pdf"], f["page"]))).convert(
                    "RGB"
                )
                w, h = page.size
                union = (
                    f["box"]
                    if box is None
                    else [
                        min(f["box"][0], box[0]),
                        min(f["box"][1], box[1]),
                        max(f["box"][2], box[2]),
                        max(f["box"][3], box[3]),
                    ]
                )
                area = pad(union, (30, 30, 30, 30))
                draw = ImageDraw.Draw(page)
                draw.rectangle(_px(f["box"], w, h), outline=(0, 170, 0), width=3)
                if box:
                    draw.rectangle(_px(box, w, h), outline=(220, 0, 0), width=3)
                tile = page.crop([round(v) for v in _px(area, w, h)])
                tile.thumbnail((420, 300))
                canvas = Image.new("RGB", (420, 322), "white")
                canvas.paste(tile, (0, 22))
                cov = f"{s['covered']:.0%} covered" if s else "no box"
                ImageDraw.Draw(canvas).text(
                    (4, 4),
                    f"{model} {method} r{n}: {fid[:-2]}, {cov}",
                    fill="black",
                    font=ImageFont.load_default(12),
                )
                tiles.append(canvas)
    if not tiles:
        print("no misses")
        return
    cols = 3
    rows = (len(tiles) + cols - 1) // cols
    out = Image.new("RGB", (cols * 420, rows * 322), "white")
    for i, t in enumerate(tiles):
        out.paste(t, ((i % cols) * 420, (i // cols) * 322))
    out.save(args.out, "JPEG", quality=70)
    print(args.out, len(tiles), "misses", os.path.getsize(args.out), "bytes")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("call", "lines", "mistral", "score", "sheet"):
        p = sub.add_parser(name)
        p.add_argument("--scans", required=True)
        p.add_argument("--digital", required=True)
        if name in ("call", "lines", "mistral"):
            p.add_argument("--env-file", required=name != "lines")
            p.add_argument("--limit", type=int, default=0, help="first N pages only")
        if name == "lines":
            p.add_argument(
                "--source", choices=("tesseract", "modelstudio"), default="tesseract"
            )
        if name == "call":
            p.add_argument("model", choices=sorted(MODELS))
        if name in ("call", "mistral"):
            p.add_argument("--repeat", type=int, default=1)
        if name == "sheet":
            p.add_argument("specs", nargs="+", help="model:method")
            p.add_argument("--out", required=True)
    sub.choices["score"].add_argument("--trim-gold", action="store_true")
    p = sub.add_parser("layout")
    p.add_argument("--scans", required=True)
    p.add_argument("--digital", required=True)
    p.add_argument("scans_match", help="layout-match-scans-*.json")
    p.add_argument("digital_match", nargs=2, help="layout-match-digital-*-{1,2}.json")
    p = sub.add_parser("deepseek")
    p.add_argument("runs", nargs="+")
    p.add_argument("--name", required=True)
    p.add_argument("--repeat", type=int, required=True)
    args = parser.parse_args()
    if args.command == "call":
        asyncio.run(call_run(args))
    elif args.command == "lines":
        asyncio.run(lines_run(args))
    elif args.command == "mistral":
        asyncio.run(mistral_run(args))
    elif args.command == "deepseek":
        import_deepseek(args)
    elif args.command == "layout":
        import_layout(args)
    elif args.command == "score":
        print_tables(score_all(args))
        print_head_to_head(args)
    else:
        sheet(args)


if __name__ == "__main__":
    main()
