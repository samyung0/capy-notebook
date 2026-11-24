"""Canvas levels: parts answering in one canvas (Epo 2026-11-23, "I'd add that
line and run the canvas bench before landing").

    uv run --with pillow python bench/grading/scripts/canvas_levels.py <env file> <out dir> [repeats] [shared,batch] [questions]

The production prompt and message code are read from
pipeline/pipeline/retrieval/grading.py; the model and route are
canvas_answers.py's. Every marking image is drawn as production draws it: the
question's canvas at 25 % under the student's words in a blue hand.

- shared: three questions whose two parts answer in the stem's canvas, graded
  one call a part (a check's /grade): DRAWN_SECTION without the line "The
  canvas may hold the student's answers to other parts too; mark only the
  answer to the part in <question>." (today) and with it (line). Each has an
  answer where one part's answer sits beside the other's and could be
  credited to the wrong part:
  - cell: (a) label A and B, (b) label C on a plant cell; answers all right,
    "nucleus" written at C with B empty, and B and C swapped;
  - values: (a) 2 x 8, (b) 4 squared, both 16; answers both right, (a) 18,
    (b) left empty;
  - chain: (a) a producer in box A, (b) a herbivore in box B; answers both
    right, swapped, (b) left empty;
  - percent: (a) 15 % of 80, (b) 80 % of 15, worked in one box; the one
    answer is (b)'s working alone, unlabelled, "0.8 × 15 = 12", which holds
    (a)'s value too (gold: (a) none; ambiguous, as x % of y is y % of x);
  - times: (a) 3 × 4, (b) 2 × 6, worked in one box; the one answer is
    "2 × 6 = 12", unlabelled, (b)'s alone (gold: (a) none).
- batch: two four-part /grade-batch calls as an assignment's marking orders
  them (each question's first parts first), under SYSTEM_PROMPT +
  DRAWN_SECTION + BATCH_SECTION: the per-part format before 2026-11-23
  (today, every part with all its images) against the one sending each image
  once (once). Call A holds cell and values (shared drawings), call B chain
  and a triangle question whose stem canvas is a figure of both its parts,
  each answered on its own canvas.

Four workers, no retries; the key is read from the env file and never
written. Raw replies go to <out dir>/rows.jsonl, the totals to summary.json.
"""

from __future__ import annotations

import ast
import base64
import io
import json
import re
import sys
import unicodedata
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
import canvas_answers as ca  # noqa: E402
import deepseek_grading as dg  # noqa: E402
import online_batching as ob  # noqa: E402

FADE = 0.25
_NAMES = {
    "SYSTEM_PROMPT", "_DRAWN_RULES", "DRAWN_SECTION", "BATCH_SECTION", "_MAX_TOKENS",
    "_TIMEOUT_S", "_SHARES", "_COMMENT_MAX", "_TAG", "_NOT_WORD", "_LATEX_COMMAND", "_CJK",
    "_INSTRUCTIONS_COMMENT", "_language", "_escape", "_loose", "_question_and_items",
    "user_message", "_image", "Show", "_inline", "SentOnce", "_figures", "answer_message",
    "drawing_message", "_part_content", "batch_message", "decode",
}


def production() -> dict[str, Any]:
    """grading.py's prompt and message code, run here without the pipeline."""
    tree = ast.parse(ob.GRADING.read_text(encoding="utf-8"))
    nodes = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            names = {node.name}
        elif isinstance(node, ast.Assign):
            names = {t.id for t in node.targets if isinstance(t, ast.Name)}
        else:
            names = set()
        if names & _NAMES:
            nodes.append(node)
    space: dict[str, Any] = {
        "re": re, "unicodedata": unicodedata, "json": json, "Any": Any, "Callable": Callable,
        "elitellm": type("elitellm", (), {"ProviderError": ob.ProviderError}),
    }
    exec(compile(ast.Module(nodes, []), str(ob.GRADING), "exec"), space)  # noqa: S102
    return space


P = production()
LINE = "\n- The canvas may hold the student's answers to other parts too; mark only the answer to the part in <question>."
assert LINE in P["DRAWN_SECTION"], "grading.py's DRAWN_SECTION has no shared-canvas line"
SECTIONS = {"today": P["DRAWN_SECTION"].replace(LINE, ""), "line": P["DRAWN_SECTION"]}


def values(d):
    d.text((60, 50), "Fill in the boxes.", font=ca.font(40), fill="black")
    for label, expr, y in (("(a)", "2 × 8 =", 300), ("(b)", "4² =", 560)):
        d.text((120, y), label, font=ca.font(44), fill="black", anchor="lm")
        d.text((260, y), expr, font=ca.font(48), fill="black", anchor="lm")
        d.rectangle([560, y - 70, 900, y + 70], outline=(150, 150, 155), width=3)


def chain(d):
    d.text((60, 50), "A food chain.", font=ca.font(40), fill="black")
    for x, label in ((120, "A"), (620, "B"), (1120, None)):
        d.rectangle([x, 380, x + 340, 560], outline=(150, 150, 155), width=3)
        if label:
            d.text((x + 170, 340), label, font=ca.font(40), fill="black", anchor="mm")
    for x in (470, 970):
        d.line([x, 470, x + 140, 470], fill="black", width=4)
        d.polygon([(x + 140, 470), (x + 115, 455), (x + 115, 485)], fill="black")
    d.text((1290, 470), "fox", font=ca.font(44), fill="black", anchor="mm")


def triangle(d):
    d.text((60, 50), "Fig. 1", font=ca.font(40), fill="black")
    d.polygon([(300, 820), (1100, 820), (300, 220)], outline="black", width=5)
    d.rectangle([300, 760, 360, 820], outline="black", width=3)
    d.text((700, 870), "4 cm", font=ca.font(40), fill="black", anchor="mm")
    d.text((200, 520), "3 cm", font=ca.font(40), fill="black", anchor="mm")
    d.text((760, 470), "5 cm", font=ca.font(40), fill="black", anchor="mm")
    for label, (x, y) in (("P", (300, 180)), ("Q", (260, 860)), ("R", (1140, 860))):
        d.text((x, y), label, font=ca.font(40), fill="black", anchor="mm")


def answer_box(title: str):
    def draw(d):
        d.text((60, 50), title, font=ca.font(40), fill="black")
        d.rectangle([60, 140, 1500, 900], outline=(150, 150, 155), width=3)

    return draw


def percent(d):
    d.text((60, 50), "Show your working for both parts in the box.", font=ca.font(40), fill="black")
    d.rectangle([60, 140, 1500, 900], outline=(150, 150, 155), width=3)


# Shared-canvas questions: the stem's text and canvas, two parts answering in
# it ((text, marking items) each), where the student writes, and each answer's
# words and gold shares per part.
SHARED = {
    "cell": {
        "stem": "The canvas shows a plant cell.",
        "draw": ca.cell,
        "parts": [("Label A and B.", ["A is the cell wall.", "B is the nucleus."]), ("Label C.", ["C is a chloroplast."])],
        "places": ca.QUESTIONS["cell"]["places"],
        "answers": {
            "all": (["cell wall", "nucleus", "chloroplast"], [[1, 1], [1]]),
            "nucleus-at-c": (["cell wall", "", "nucleus"], [[1, 0], [0]]),
            "swapped": (["cell wall", "chloroplast", "nucleus"], [[1, 0], [0]]),
        },
    },
    "values": {
        "stem": "Answer both parts in the boxes on the canvas.",
        "draw": values,
        "parts": [("Work out 2 × 8.", ["2 × 8 = 16"]), ("Work out 4².", ["4² = 16"])],
        "places": [(640, 270), (640, 530)],
        "answers": {
            "both": (["16", "16"], [[1], [1]]),
            "a-wrong": (["18", "16"], [[0], [1]]),
            "b-empty": (["16", ""], [[1], [0]]),
        },
    },
    "chain": {
        "stem": "Complete the food chain on the canvas.",
        "draw": chain,
        "parts": [
            ("Name a producer that could go in box A.", ["A producer, such as grass or another plant, in box A."]),
            ("Name a herbivore that could go in box B.", ["A herbivore, such as a rabbit, in box B."]),
        ],
        "places": [(160, 440), (660, 440)],
        "answers": {
            "both": (["grass", "rabbit"], [[1], [1]]),
            "swapped": (["rabbit", "grass"], [[0], [0]]),
            "b-empty": (["grass", ""], [[1], [0]]),
        },
    },
    "percent": {
        "stem": "Answer both parts on the canvas.",
        "draw": percent,
        "parts": [("Find 15% of 80.", ["15% of 80 = 12"]), ("Find 80% of 15.", ["80% of 15 = 12"])],
        "places": [(120, 300)],
        "answers": {"b-only": (["0.8 × 15 = 12"], [[0], [1]])},
    },
    "times": {
        "stem": "Answer both parts on the canvas.",
        "draw": percent,
        "parts": [("Work out 3 × 4.", ["3 × 4 = 12"]), ("Work out 2 × 6.", ["2 × 6 = 12"])],
        "places": [(120, 300)],
        "answers": {"b-only": (["2 × 6 = 12"], [[0], [1]])},
    },
}


def encode(img: Image.Image, kind: str) -> str:
    buf = io.BytesIO()
    if kind == "jpeg":
        img.save(buf, "JPEG", quality=85)
    else:
        img.save(buf, "WEBP", quality=80)
    return f"data:image/{kind};base64," + base64.b64encode(buf.getvalue()).decode()


def canvas(draw, writing: list[tuple[tuple[int, int], str]], fade: float = FADE) -> str:
    """A marking image: the question's canvas at `fade` and the student's words
    at full strength; fade 1 with no words is a canvas as set (a figure)."""
    img = Image.new("RGB", (ca.W, ca.H), "white")
    draw(ImageDraw.Draw(img))
    if fade < 1:
        img = Image.blend(Image.new("RGB", (ca.W, ca.H), "white"), img, fade)
    d = ImageDraw.Draw(img)
    for (x, y), word in writing:
        if word:
            d.text((x, y), word, font=ca.font(44, hand=True), fill=ca.PEN)
    return encode(img, "jpeg" if fade == 1 else "webp")


def shared_parts(name: str, answer: str) -> list[dict[str, Any]]:
    """The question's parts as Go sends them (questions.GradingTextAndFigures):
    the stem's canvas is their answer, so no figure; each with the one
    drawing."""
    q = SHARED[name]
    words, gold = q["answers"][answer]
    image = canvas(q["draw"], list(zip(q["places"], words)))
    out = []
    for i, (text, items) in enumerate(q["parts"]):
        earlier = "".join(f"Earlier part {j + 1}: {q['parts'][j][0]}\n\n" for j in range(i))
        out.append({
            "id": f"{name}-{'ab'[i]}", "question": f"{q['stem']}\n\n{earlier}Part to grade: {text}",
            "items": [{"text": t, "marks": 1} for t in items], "image": image, "gold": gold[i],
        })
    return out


def triangle_parts() -> list[dict[str, Any]]:
    """A question whose stem canvas is a figure, as set, of both its parts,
    each answered on its own canvas: the perimeter right, the area wrong."""
    figure = canvas(triangle, [], fade=1)
    stem = "Fig. 1 shows a right-angled triangle.\n\n[Figure 1]"
    parts = [
        ("On your canvas, work out the perimeter of the triangle.", "Perimeter = 12 cm", "Perimeter:", "3 + 4 + 5 = 12 cm", [1]),
        ("On your canvas, work out the area of the triangle.", "Area = 6 cm²", "Area:", "3 × 4 = 12 cm²", [0]),
    ]
    out = []
    for i, (text, item, title, words, gold) in enumerate(parts):
        earlier = f"Earlier part 1: {parts[0][0]}\n\n" if i else ""
        out.append({
            "id": f"triangle-{'ab'[i]}", "question": f"{stem}\n\n{earlier}Part to grade: {text}",
            "items": [{"text": item, "marks": 1}], "figures": [figure],
            "image": canvas(answer_box(title), [((120, 300), words)]), "gold": gold,
        })
    return out


def batches() -> dict[str, list[dict[str, Any]]]:
    """Two calls as markAttemptAnswers orders an attempt: first parts first."""
    cell, values_ = shared_parts("cell", "swapped"), shared_parts("values", "a-wrong")
    chain_, tri = shared_parts("chain", "swapped"), triangle_parts()
    return {"A": [cell[0], values_[0], cell[1], values_[1]], "B": [chain_[0], tri[0], chain_[1], tri[1]]}


def batch_content(parts: list[dict[str, Any]], fmt: str) -> list[dict[str, Any]]:
    """/grade-batch's message: today every part with all its images; once as
    grading.batch_message sends it."""
    if fmt == "once":
        return P["batch_message"](parts)
    content = [{"type": "text", "text": "<parts>"}]
    for n, part in enumerate(parts, 1):
        content += P["_part_content"](n, part, P["_inline"])
    return [*content, {"type": "text", "text": "</parts>"}]


def images_in(content: list[dict[str, Any]]) -> int:
    return sum(c.get("type") == "image_url" for c in content)


def run_shared(key: str, job) -> dict[str, Any]:
    name, answer, index, condition, n = job
    part = shared_parts(name, answer)[index]
    user = P["drawing_message"](part["question"], part["items"], part["image"])
    payload = ob.body(P["SYSTEM_PROMPT"] + SECTIONS[condition], user, "plain", 1)
    reply, error, seconds = ob.call(key, payload)
    row = {"study": "shared", "question": name, "answer": answer, "part": "ab"[index], "condition": condition,
           "run": n, "gold": part["gold"], "seconds": seconds, "error": error}
    if reply:
        row["usage"] = reply.get("usage")
        row["content"] = reply["choices"][0]["message"].get("content")
        try:
            row["shares"] = P["decode"](row["content"], part["items"], part["question"], drawn=True)["shares"]
        except ob.ProviderError as exc:
            row["error"] = str(exc)
    return row


def run_batch(key: str, job) -> dict[str, Any]:
    name, fmt, n = job
    parts = batches()[name]
    content = batch_content(parts, fmt)
    system = P["SYSTEM_PROMPT"] + P["DRAWN_SECTION"] + P["BATCH_SECTION"]
    reply, error, seconds = ob.call(key, ob.body(system, content, "plain", len(parts)))
    row = {"study": "batch", "batch": name, "format": fmt, "run": n, "images": images_in(content),
           "gold": {p["id"]: p["gold"] for p in parts}, "seconds": seconds, "error": error}
    if reply:
        row["usage"] = reply.get("usage")
        row["content"] = reply["choices"][0]["message"].get("content")
        row["shares"] = {}
        try:
            entries = {str(e.get("part")): e for e in json.loads(row["content"]).get("parts", []) if isinstance(e, dict)}
        except (TypeError, json.JSONDecodeError, AttributeError):
            row["error"] = "the batch reply is not JSON with parts"
            return row
        for i, part in enumerate(parts, 1):
            try:
                entry = entries.get(f"p{i}")
                if entry is None:
                    raise ob.ProviderError("missing part")
                row["shares"][part["id"]] = P["decode"](json.dumps(entry), part["items"], part["question"], drawn=True)["shares"]
            except ob.ProviderError as exc:
                row["shares"][part["id"]] = None
                row["error"] = str(exc)
    return row


def score(pairs) -> dict[str, Any]:
    """Items matched, marks credited where gold has none and gold marks
    missed, over (case, gold, got) triples; a failed part counts as wrong."""
    items = matched = 0
    unearned = missed = 0.0
    wrong = []
    for case, gold, got in pairs:
        items += len(gold)
        if got is None:
            wrong.append({"case": case, "gold": gold, "got": None})
            continue
        matched += sum(g == s for g, s in zip(gold, got))
        unearned += sum(max(s - g, 0) for g, s in zip(gold, got))
        missed += sum(max(g - s, 0) for g, s in zip(gold, got))
        if list(got) != list(gold):
            wrong.append({"case": case, "gold": gold, "got": got})
    return {"items": items, "items_matched": matched, "unearned_marks": unearned, "missed_marks": missed, "wrong": wrong}


def summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    shared = [r for r in rows if r["study"] == "shared"]
    for condition in SECTIONS:
        mine = [r for r in shared if r["condition"] == condition]
        out[f"shared/{condition}"] = {
            "calls": len(mine),
            "errors": sum(bool(r["error"]) for r in mine),
            "cost_usd": round(sum((r.get("usage") or {}).get("cost", 0) or 0 for r in mine), 5),
            **score((f"{r['question']}/{r['answer']}/{r['part']}#{r['run']}", r["gold"], r.get("shares")) for r in mine),
        }
    batch = [r for r in rows if r["study"] == "batch"]
    for fmt in ("today", "once"):
        mine = [r for r in batch if r["format"] == fmt]
        usage = [r.get("usage") or {} for r in mine]
        out[f"batch/{fmt}"] = {
            "calls": len(mine),
            "errors": sum(bool(r["error"]) for r in mine),
            "images_per_call": {name: next((r["images"] for r in mine if r["batch"] == name), None) for name in ("A", "B")},
            "prompt_tokens": {name: [(r.get("usage") or {}).get("prompt_tokens") for r in mine if r["batch"] == name] for name in ("A", "B")},
            "cost_usd": round(sum(u.get("cost", 0) or 0 for u in usage), 5),
            **score(
                (f"{r['batch']}/{pid}#{r['run']}", gold, (r.get("shares") or {}).get(pid))
                for r in mine for pid, gold in r["gold"].items()
            ),
        }
    # The two formats' shares part by part, run by run.
    pairs = {(r["batch"], r["run"]): {} for r in batch}
    for r in batch:
        pairs[r["batch"], r["run"]][r["format"]] = r.get("shares") or {}
    agree = total = 0
    for got in pairs.values():
        if "today" in got and "once" in got:
            for pid, shares in got["today"].items():
                total += 1
                agree += shares is not None and shares == got["once"].get(pid)
    out["batch/formats_agree"] = {"parts": total, "same_shares": agree}
    return out


def main() -> None:
    env_file, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    repeats = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    studies = sys.argv[4].split(",") if len(sys.argv) > 4 else ["shared", "batch"]
    names = sys.argv[5].split(",") if len(sys.argv) > 5 else list(SHARED)
    key = dg.load_env(env_file).get("OPENROUTER_API_KEY", "")
    if not key:
        raise SystemExit(f"No OPENROUTER_API_KEY in {env_file}")
    dg.TIMEOUT_S = ob.P["_TIMEOUT_S"]["plain"]
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in names:
        for answer in SHARED[name]["answers"]:
            url = shared_parts(name, answer)[0]["image"]
            (out_dir / f"{name}-{answer}.webp").write_bytes(base64.b64decode(url.split(",", 1)[1]))
    for part in triangle_parts():
        for i, url in enumerate([*part["figures"], part["image"]]):
            (out_dir / f"{part['id']}-{i}.{url[11:15]}").write_bytes(base64.b64decode(url.split(",", 1)[1]))
    jobs: list[tuple[Callable, Any]] = []
    if "shared" in studies:
        jobs += [
            (run_shared, (name, answer, index, condition, n))
            for name in names
            for answer in SHARED[name]["answers"]
            for index in range(2)
            for condition in SECTIONS
            for n in range(repeats)
        ]
    if "batch" in studies:
        jobs += [(run_batch, (name, fmt, n)) for name in ("A", "B") for fmt in ("today", "once") for n in range(repeats)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(lambda job: job[0](key, job[1]), jobs))
    with (out_dir / "rows.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    result = summary(rows)
    (out_dir / "summary.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
