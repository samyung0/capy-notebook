"""Question figures sent to the grader as images, against today's text only
(Epo 2026-11-23: "Bench it first").

    uv run --with pillow python bench/grading/scripts/question_figures.py <env file> <out dir>

Eight questions (fixtures/question-figures.json) whose marking needs their
figure, each drawn here, three answers each. Two conditions, the production
prompt and code read from pipeline/pipeline/retrieval/grading.py:
- text: today, the figure as "[Figure: description]" in <question>;
- image: the drafted wording (FIGURE_LINE, not yet approved), the figure as
  "[Figure 1: description]" and its image after <marking_items>, labelled
  "Figure 1:".
The description is a teacher's short alt text, without the figure's details.
One call a part on the grading pin and its production route, four workers,
no retries. Raw replies go to <out dir>/rows.jsonl.
"""

from __future__ import annotations

import base64
import io
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import deepseek_grading as dg  # noqa: E402
import online_batching as ob  # noqa: E402

FIXTURE = ob.ROOT / "bench/grading/fixtures/question-figures.json"
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
TODAY_LINE = "- <question>: the question text (stem, earlier parts and the part to grade). Figures appear as text descriptions."
FIGURE_LINE = '- <question>: the question text (stem, earlier parts and the part to grade). An image in the question appears as [Figure N: description], and the image itself follows <marking_items>, labelled "Figure N:". Any other figure appears as a text description.'
assert TODAY_LINE in ob.P["SYSTEM_PROMPT"]
IMAGE_PROMPT = ob.P["SYSTEM_PROMPT"].replace(TODAY_LINE, FIGURE_LINE)
# Variant "check": the same line, then one sentence telling the marker to check
# what the answer says of a figure against its image.
CHECK_LINE = FIGURE_LINE.replace(
    " Any other figure", " Check anything the answer reads from a figure, such as a label, value or direction, against its image. Any other figure"
)
CHECK_PROMPT = ob.P["SYSTEM_PROMPT"].replace(TODAY_LINE, CHECK_LINE)
CONDITIONS = ("text", "image", "check")


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size)


def axes(d, box, xs, ys, xlabel, ylabel, xticks=True):
    """Axes with gridlines over box (left, top, right, bottom) for ticks xs, ys."""
    left, top, right, bottom = box
    x0, x1, y0, y1 = xs[0], xs[-1], ys[0], ys[-1]

    def at(x, y):
        return left + (x - x0) / (x1 - x0) * (right - left), bottom - (y - y0) / (y1 - y0) * (bottom - top)

    for y in ys:
        _, py = at(x0, y)
        d.line([left, py, right, py], fill=(215, 215, 215), width=1)
        d.text((left - 12, py), str(y), font=font(18), fill="black", anchor="rm")
    for x in xs:
        px, _ = at(x, y0)
        d.line([px, top, px, bottom], fill=(215, 215, 215), width=1)
        if xticks:
            d.text((px, bottom + 10), str(x), font=font(18), fill="black", anchor="mt")
    d.line([left, bottom, right, bottom], fill="black", width=2)
    d.line([left, top, left, bottom], fill="black", width=2)
    d.text(((left + right) / 2, bottom + 40), xlabel, font=font(20), fill="black", anchor="mt")
    d.text((left - 70, top - 30), ylabel, font=font(20), fill="black")
    return at


def rainfall(d):
    months = [("Mar", 20), ("Apr", 45), ("May", 70), ("Jun", 95), ("Jul", 140), ("Aug", 110)]
    left, top, right, bottom = 110, 60, 760, 460
    at = axes(d, (left, top, right, bottom), [0, 6], list(range(0, 161, 20)), "", "Rainfall (mm)", xticks=False)
    for i, (name, mm) in enumerate(months):
        x = left + (i + 0.5) * (right - left) / 6
        _, y = at(0, mm)
        d.rectangle([x - 35, y, x + 35, bottom], fill=(90, 130, 200))
        d.text((x, bottom + 10), name, font=font(18), fill="black", anchor="mt")


def cell(d):
    d.rectangle([150, 80, 650, 440], outline=(40, 120, 40), width=8)
    d.rounded_rectangle([330, 150, 600, 400], 40, outline=(80, 80, 200), width=4, fill=(225, 235, 255))
    d.ellipse([200, 130, 300, 230], outline=(120, 60, 20), width=4, fill=(230, 200, 170))
    for label, (x, y), (tx, ty) in (("A", (150, 300), (60, 300)), ("B", (250, 180), (60, 120)), ("C", (465, 275), (740, 275))):
        d.line([x, y, tx + 20 if tx < x else tx - 20, ty], fill="black", width=2)
        d.text((tx, ty), label, font=font(30), fill="black", anchor="mm")


def cyclist(d):
    at = axes(d, (110, 60, 760, 440), list(range(0, 21, 2)), list(range(0, 61, 10)), "Time (s)", "Distance (m)")
    d.line([*at(0, 0), *at(10, 50), *at(20, 50)], fill=(200, 50, 50), width=4)


def readings(d):
    rows = [("Reading", "Current (A)"), ("1", "4.2"), ("2", "4.6"), ("3", "4.4")]
    for r, (a, b) in enumerate(rows):
        y = 100 + r * 70
        d.rectangle([200, y, 400, y + 70], outline="black", width=2)
        d.rectangle([400, y, 600, y + 70], outline="black", width=2)
        weight = font(26)
        d.text((300, y + 35), a, font=weight, fill="black", anchor="mm")
        d.text((500, y + 35), b, font=weight, fill="black", anchor="mm")


def lighthouse(d):
    d.line([(60, 470), (220, 380), (300, 260), (460, 200), (600, 80), (780, 40)], fill=(60, 110, 170), width=5)
    d.text((620, 300), "Sea", font=font(26), fill=(60, 110, 170))
    d.text((150, 200), "Land", font=font(26), fill=(90, 120, 60))
    hx, hy = 380, 320
    d.ellipse([hx - 10, hy - 10, hx + 10, hy + 10], fill="black")
    d.text((hx - 20, hy + 18), "Harbour", font=font(22), fill="black")
    lx, ly = 600, 110
    d.polygon([(lx, ly - 30), (lx - 12, ly + 20), (lx + 12, ly + 20)], fill=(200, 40, 40))
    d.text((lx + 20, ly - 10), "Lighthouse", font=font(22), fill="black")
    d.line([90, 120, 90, 50], fill="black", width=3)
    d.polygon([(90, 40), (82, 58), (98, 58)], fill="black")
    d.text((90, 20), "N", font=font(24), fill="black", anchor="mm")


def energy(d):
    slices = [("Gas", 40, (200, 120, 60)), ("Wind", 25, (90, 160, 210)), ("Nuclear", 20, (160, 120, 200)), ("Solar", 15, (230, 200, 70))]
    box = [220, 70, 580, 430]
    start = -90.0
    for name, pct, colour in slices:
        end = start + pct * 3.6
        d.pieslice(box, start, end, fill=colour, outline="white", width=3)
        mid = math.radians((start + end) / 2)
        d.text((400 + 240 * math.cos(mid), 250 + 240 * math.sin(mid)), name, font=font(24), fill="black", anchor="mm")
        start = end


def foodweb(d):
    at = {"Grass": (400, 440), "Rabbit": (230, 290), "Grasshopper": (570, 290), "Bird": (570, 150), "Fox": (300, 70)}
    for a, b in (("Grass", "Rabbit"), ("Grass", "Grasshopper"), ("Grasshopper", "Bird"), ("Rabbit", "Fox"), ("Bird", "Fox")):
        (x0, y0), (x1, y1) = at[a], at[b]
        d.line([x0, y0 - 20, x1, y1 + 20], fill="black", width=3)
        angle = math.atan2((y1 + 20) - (y0 - 20), x1 - x0)
        tip = (x1, y1 + 20)
        d.polygon([tip, (tip[0] - 18 * math.cos(angle - 0.4), tip[1] - 18 * math.sin(angle - 0.4)),
                   (tip[0] - 18 * math.cos(angle + 0.4), tip[1] - 18 * math.sin(angle + 0.4))], fill="black")
    for name, (x, y) in at.items():
        d.rounded_rectangle([x - 85, y - 20, x + 85, y + 20], 8, outline="black", width=2, fill=(245, 245, 235))
        d.text((x, y), name, font=font(22), fill="black", anchor="mm")


def triangle(d):
    a, b, c = (120, 420), (680, 420), (300, 90)
    d.polygon([a, b, c], outline="black", width=4)
    d.text((a[0] + 70, a[1] - 35), "60°", font=font(28), fill="black")
    d.text((b[0] - 110, b[1] - 35), "50°", font=font(28), fill="black")
    d.text((c[0] - 5, c[1] + 50), "x", font=font(30), fill="black")


DRAW = {f.__name__: f for f in (rainfall, cell, cyclist, readings, lighthouse, energy, foodweb, triangle)}


def figure(name: str) -> str:
    image = Image.new("RGB", (820, 520), "white")
    DRAW[name](ImageDraw.Draw(image))
    out = io.BytesIO()
    image.save(out, "PNG")
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()


def cases() -> list[dict]:
    out = []
    for q in json.loads(FIXTURE.read_text(encoding="utf-8"))["questions"]:
        for a in q["answers"]:
            out.append({
                "case_id": f"{q['id']}/{a['kind']}", "question": q, "answer": a["text"],
                "items": [{**item, "gold": g} for item, g in zip(q["items"], a["gold"])],
            })
    return out


def request(case: dict, condition: str, images: dict[str, str]) -> dict:
    q = case["question"]
    items = [{"text": i["text"], "marks": i["marks"]} for i in case["items"]]
    answer = f"<student_answer>\n{ob.P['_escape'](case['answer'])}\n</student_answer>"
    if condition == "text":
        text = f"[Figure: {q['description']}]\n\nPart to grade: {q['text']}"
        user = ob.P["user_message"](text, items, case["answer"])
        system = ob.P["SYSTEM_PROMPT"]
    else:
        text = f"[Figure 1: {q['description']}]\n\nPart to grade: {q['text']}"
        user = [
            {"type": "text", "text": ob.P["_question_and_items"](text, items)},
            {"type": "text", "text": "Figure 1:"},
            {"type": "image_url", "image_url": {"url": images[q["figure"]]}},
            {"type": "text", "text": answer},
        ]
        system = IMAGE_PROMPT if condition == "image" else CHECK_PROMPT
    return ob.body(system, user, "plain", 1)


def main() -> None:
    env_file, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    key = dg.load_env(env_file).get("OPENROUTER_API_KEY", "")
    if not key:
        raise SystemExit(f"No OPENROUTER_API_KEY in {env_file}")
    dg.TIMEOUT_S = ob.P["_TIMEOUT_S"]["plain"]
    images = {name: figure(name) for name in DRAW}
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, url in images.items():
        (out_dir / f"{name}.png").write_bytes(base64.b64decode(url.split(",", 1)[1]))
    conditions = sys.argv[3].split(",") if len(sys.argv) > 3 else CONDITIONS
    jobs = [(case, condition) for case in cases() for condition in conditions]

    def one(job):
        case, condition = job
        reply, error, seconds = ob.call(key, request(case, condition, images))
        row = {"case": case["case_id"], "condition": condition, "seconds": seconds, "error": error}
        if reply:
            row["usage"] = reply.get("usage")
            row["content"] = reply["choices"][0]["message"].get("content")
            items = [{"text": i["text"], "marks": i["marks"]} for i in case["items"]]
            try:
                row["shares"] = ob.P["decode"](row["content"], items, case["answer"])["shares"]
            except ob.ProviderError as exc:
                row["error"] = str(exc)
        return row

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(one, jobs))
    with (out_dir / f"rows-{'-'.join(conditions)}.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    gold = {c["case_id"]: c["items"] for c in cases()}
    result = {}
    for condition in conditions:
        mine = [r for r in rows if r["condition"] == condition]
        matched = items = 0
        unearned = missed = 0.0
        wrong = []
        for row in mine:
            got = row.get("shares")
            for i, item in enumerate(gold[row["case"]]):
                items += 1
                if got is None:
                    continue
                matched += got[i] == item["gold"]
                diff = (got[i] - item["gold"]) * item["marks"]
                unearned += max(diff, 0)
                missed += max(-diff, 0)
            if got != [i["gold"] for i in gold[row["case"]]]:
                wrong.append({"case": row["case"], "gold": [i["gold"] for i in gold[row["case"]]], "got": got})
        usage = [r.get("usage") or {} for r in mine]
        result[condition] = {
            "calls": len(mine), "failed_calls": sum(1 for r in mine if r.get("error")),
            "items": items, "items_matched": matched, "unearned_marks": unearned, "missed_marks": missed,
            "prompt_tokens": sum(u.get("prompt_tokens", 0) for u in usage),
            "cost_usd": round(sum(u.get("cost", 0) or 0 for u in usage), 5),
            "wrong_parts": wrong,
        }
    (out_dir / f"summary-{'-'.join(conditions)}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
