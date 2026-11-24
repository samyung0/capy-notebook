"""Canvas answers: the student answers on the question's own canvas, so the
marking image holds the teacher's content too (Epo 2026-11-23: "sure change and
maybe test for 1-2 simple quesitons").

    uv run --with pillow python bench/grading/scripts/canvas_answers.py <env file> <out dir> [repeats] [questions] [conditions]

Three canvas questions drawn here, three answers each, written in a pen colour
and hand: a labelled plant cell; a water cycle with a word bank on the canvas
(the trap: its words are the teacher's, not answers); a table of squares whose
first row the teacher filled in the same pen as a worked example, with a marking
scheme that names that row too, as one written later might (the trap: the row
is not the student's). Three conditions, on the
production prompt, model and route read from pipeline/pipeline/retrieval/grading.py:
- today: DRAWN_SECTION's first line as it was before canvases;
- plain: the line saying the canvas may already hold the question's own
  content (no way to tell whose a mark is);
- faded: the question's content drawn at 40% in the image, the line saying so
  and to credit only the student's work;
- faint: at 25%, the line saying faded marks earn nothing (production since
  2026-11-23);
- pair: the question's canvas as set as a first image, then the answered one.
Only that first line changes: every condition keeps production's rules after
it, the shared-canvas line too once it landed (canvas_levels.py).
One call a part, no sample answer, four workers, no retries. Raw replies go to
<out dir>/rows.jsonl.
"""

from __future__ import annotations

import ast
import base64
import io
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import deepseek_grading as dg  # noqa: E402
import online_batching as ob  # noqa: E402

FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
HAND = "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf"
PEN = (40, 80, 210)
# The marking image's size for a 1,920 x 1,200 answer area.
W, H = 1568, 980
FADE = 0.4


def drawn_section() -> str:
    """grading.py's DRAWN_SECTION, its string pieces joined, without importing
    the pipeline."""
    strings: dict[str, str] = {}

    def value(node: ast.expr) -> str:
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return value(node.left) + value(node.right)
        if isinstance(node, ast.Name):
            return strings[node.id]
        return ast.literal_eval(node)

    tree = ast.parse(ob.GRADING.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            try:
                strings[node.targets[0].id] = value(node.value)
            except (KeyError, ValueError, TypeError):
                continue
    if "DRAWN_SECTION" not in strings:
        raise SystemExit("No DRAWN_SECTION in grading.py")
    return strings["DRAWN_SECTION"]


# The line before the canvas (FIRST) and the plain one Epo took first
# (PLAIN_LINE); production holds FAINT_LINE since 2026-11-23.
FIRST = "Drawn answers: when the student's answer is an image instead of <student_answer> text, the image is the student's work and everything above applies to it."
PLAIN_LINE = "Drawn answers: when the student's answer is an image instead of <student_answer> text, the image is the student's work on the question's canvas and everything above applies to it. The canvas may already hold the question's own text, diagrams and boxes."
PRODUCTION = drawn_section()
FADED_LINE = "Drawn answers: when the student's answer is an image instead of <student_answer> text, the image is the student's work on the question's canvas and everything above applies to it. The question's own text, diagrams and boxes are drawn faded; the student's work is drawn at full strength. Credit only the student's work."
# Stronger variants after "faded" still credited a worked example (run 2).
FAINT_LINE = "Drawn answers: when the student's answer is an image instead of <student_answer> text, the image is the student's work on the question's canvas and everything above applies to it. Faded marks are the question's own text, diagrams, boxes and worked examples, printed before the student answered: they earn nothing, even where they match a marking item. Only marks at full strength are the student's work."
PAIR_LINE = "Drawn answers: when the student's answer is an image instead of <student_answer> text, the image is the student's work on the question's canvas and everything above applies to it. The question's canvas as set comes first: anything already on it, worked examples included, is the question's and earns nothing, even where it matches a marking item. Credit only what the student's canvas adds to it."
assert FAINT_LINE in PRODUCTION
TODAY = PRODUCTION.replace(FAINT_LINE, FIRST)
SECTIONS = {
    "today": TODAY,
    "plain": TODAY.replace(FIRST, PLAIN_LINE),
    "faded": TODAY.replace(FIRST, FADED_LINE),
    "faint": TODAY.replace(FIRST, FAINT_LINE),
    "pair": TODAY.replace(FIRST, PAIR_LINE),
}
FADES = {"faded": FADE, "faint": 0.25}
CONDITIONS = tuple(SECTIONS)


def font(size: int, hand: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(HAND if hand else FONT, size)


def boxes(d, places):
    for x, y in places:
        d.rectangle([x, y, x + 330, y + 70], outline=(150, 150, 155), width=3)


def cell(d):
    d.text((60, 50), "Label A, B and C on the plant cell.", font=font(40), fill="black")
    d.rounded_rectangle([250, 170, 820, 830], 120, outline=(60, 140, 70), width=12, fill=(236, 247, 232))
    d.rounded_rectangle([275, 195, 795, 805], 100, outline=(130, 195, 125), width=4)
    d.rounded_rectangle([440, 330, 690, 600], 80, outline=(140, 180, 225), width=4, fill=(222, 236, 252))
    d.ellipse([320, 250, 440, 370], outline=(140, 105, 185), width=5, fill=(236, 224, 247))
    for cx, cy in ((735, 300), (740, 690), (330, 700)):
        d.ellipse([cx - 40, cy - 20, cx + 40, cy + 20], outline=(75, 155, 63), width=4, fill=(160, 210, 140))
    for label, (x, y), ty in (("A", (820, 240), 210), ("B", (400, 330), 430), ("C", (760, 690), 690)):
        d.line([x, y, 1060, ty], fill="black", width=3)
        d.text((1080, ty), label, font=font(36), fill="black", anchor="lm")
    boxes(d, [(1130, 175), (1130, 395), (1130, 655)])


def cycle(d):
    d.text((60, 50), "Use the word bank to name stages 1, 2 and 3 of the water cycle.", font=font(36), fill="black")
    d.rectangle([60, 120, 1500, 200], outline=(120, 120, 125), width=3)
    d.text((80, 160), "Word bank:  evaporation    condensation    precipitation    collection", font=font(32), fill="black", anchor="lm")
    d.rectangle([60, 760, 1500, 930], fill=(200, 225, 250))
    d.text((90, 890), "sea", font=font(30), fill=(40, 80, 140))
    for cx, cy in ((700, 330), (780, 300), (860, 330)):
        d.ellipse([cx - 90, cy - 55, cx + 90, cy + 55], fill=(225, 228, 235), outline=(150, 155, 165), width=3)
    d.line([300, 740, 560, 380], fill="black", width=4)
    d.polygon([(560, 380), (530, 395), (552, 418)], fill="black")
    d.line([960, 400, 1150, 740], fill="black", width=4)
    d.polygon([(1150, 740), (1122, 722), (1146, 708)], fill="black")
    for x in (650, 700, 750):
        d.line([x, 400, x - 15, 450], fill=(90, 140, 220), width=3)
    for label, (x, y) in (("1", (480, 560)), ("2", (965, 265)), ("3", (1100, 600))):
        d.text((x, y), label, font=font(40), fill="black", anchor="mm")
    boxes(d, [(40, 520), (1000, 230), (1160, 560)])


def squares(d):
    d.text((60, 50), "Complete the table of squares.", font=font(40), fill="black")
    left, middle, right = 300, 600, 1000
    rows = [160, 260, 380, 500, 620]
    for y in rows:
        d.line([left, y, right, y], fill="black", width=3)
    for x in (left, middle, right):
        d.line([x, rows[0], x, rows[-1]], fill="black", width=3)
    d.text((450, 210), "n", font=font(40), fill="black", anchor="mm")
    d.text((800, 210), "n²", font=font(40), fill="black", anchor="mm")
    for n, y in zip((3, 4, 5), (320, 440, 560)):
        d.text((450, y), str(n), font=font(40), fill="black", anchor="mm")
    # The teacher's worked example, in the pen the students use.
    d.text((780, 290), "9", font=font(44, hand=True), fill=PEN)


QUESTIONS = {
    "cell": {
        "draw": cell,
        "text": "Label A, B and C on the plant cell.",
        "items": ["A is the cell wall.", "B is the nucleus.", "C is a chloroplast."],
        "places": [(1145, 182), (1145, 402), (1145, 662)],
        "answers": {
            "all": (["cell wall", "nucleus", "chloroplast"], [1, 1, 1]),
            "pigment": (["cell wall", "nucleus", "chlorophyll"], [1, 1, 0]),
            "one": (["cell wall", "", ""], [1, 0, 0]),
        },
    },
    "cycle": {
        "draw": cycle,
        "text": "Use the word bank to name stages 1, 2 and 3 of the water cycle.",
        "items": ["1 is evaporation.", "2 is condensation.", "3 is precipitation."],
        "places": [(55, 527), (1015, 237), (1175, 567)],
        "answers": {
            "all": (["evaporation", "condensation", "precipitation"], [1, 1, 1]),
            "one": (["evaporation", "", ""], [1, 0, 0]),
            "swapped": (["evaporation", "precipitation", "condensation"], [1, 0, 0]),
        },
    },
    "squares": {
        "draw": squares,
        "text": "Complete the table of squares.",
        "items": ["3 squared is 9.", "4 squared is 16.", "5 squared is 25."],
        "places": [(770, 410), (770, 530)],
        "answers": {
            "both": (["16", "25"], [0, 1, 1]),
            "one": (["16", ""], [0, 1, 0]),
            "wrong": (["12", "20"], [0, 0, 0]),
        },
    },
}


def image(name: str, answer: str | None, fade: float = 1.0) -> str:
    """The answered canvas, the question's content at `fade` strength; with no
    answer, the question's canvas as set."""
    q = QUESTIONS[name]
    teacher = Image.new("RGB", (W, H), "white")
    q["draw"](ImageDraw.Draw(teacher))
    if fade < 1:
        teacher = Image.blend(Image.new("RGB", (W, H), "white"), teacher, fade)
    d = ImageDraw.Draw(teacher)
    for (x, y), word in zip(q["places"], q["answers"][answer][0] if answer else []):
        if word:
            d.text((x, y), word, font=font(44, hand=True), fill=PEN)
    buf = io.BytesIO()
    teacher.save(buf, "WEBP", quality=80)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()


def request(name: str, answer: str, condition: str, url: str, blank: str) -> dict:
    q = QUESTIONS[name]
    items = [{"text": text, "marks": 1} for text in q["items"]]
    user = [{"type": "text", "text": ob.P["_question_and_items"](f"Part to grade: {q['text']}", items)}]
    if condition == "pair":
        user += [
            {"type": "text", "text": "The question's canvas as set:"},
            {"type": "image_url", "image_url": {"url": blank}},
            {"type": "text", "text": "Student's canvas:"},
        ]
    user.append({"type": "image_url", "image_url": {"url": url}})
    return ob.body(ob.P["SYSTEM_PROMPT"] + SECTIONS[condition], user, "plain", 1)


def main() -> None:
    env_file, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    repeats = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    names = sys.argv[4].split(",") if len(sys.argv) > 4 else list(QUESTIONS)
    key = dg.load_env(env_file).get("OPENROUTER_API_KEY", "")
    if not key:
        raise SystemExit(f"No OPENROUTER_API_KEY in {env_file}")
    dg.TIMEOUT_S = ob.P["_TIMEOUT_S"]["plain"]
    out_dir.mkdir(parents=True, exist_ok=True)
    conditions = sys.argv[5].split(",") if len(sys.argv) > 5 else list(CONDITIONS)
    urls = {}
    for name in names:
        q = QUESTIONS[name]
        for answer in [None, *q["answers"]]:
            for fade in {1.0, *FADES.values()}:
                url = image(name, answer, fade)
                urls[name, answer, fade] = url
                (out_dir / f"{name}-{answer or 'blank'}-{fade}.webp").write_bytes(base64.b64decode(url.split(",", 1)[1]))
    jobs = [
        (name, answer, condition, n)
        for name in names
        for answer in QUESTIONS[name]["answers"]
        for condition in conditions
        for n in range(repeats)
    ]

    def one(job):
        name, answer, condition, n = job
        url = urls[name, answer, FADES.get(condition, 1.0)]
        reply, error, seconds = ob.call(key, request(name, answer, condition, url, urls[name, None, 1.0]))
        row = {"question": name, "answer": answer, "condition": condition, "run": n, "seconds": seconds, "error": error}
        if reply:
            row["usage"] = reply.get("usage")
            row["content"] = reply["choices"][0]["message"].get("content")
            items = [{"text": text, "marks": 1} for text in QUESTIONS[name]["items"]]
            try:
                row["shares"] = ob.P["decode"](row["content"], items, QUESTIONS[name]["text"], drawn=True)["shares"]
            except ob.ProviderError as exc:
                row["error"] = str(exc)
        return row

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(one, jobs))
    with (out_dir / "rows.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    result = {}
    for condition in conditions:
        mine = [r for r in rows if r["condition"] == condition]
        wrong = []
        matched = items = 0
        unearned = missed = 0.0
        for row in mine:
            gold = QUESTIONS[row["question"]]["answers"][row["answer"]][1]
            got = row.get("shares")
            items += len(gold)
            if got is None:
                wrong.append({"case": f"{row['question']}/{row['answer']}", "error": row["error"]})
                continue
            matched += sum(g == s for g, s in zip(gold, got))
            unearned += sum(max(s - g, 0) for g, s in zip(gold, got))
            missed += sum(max(g - s, 0) for g, s in zip(gold, got))
            if got != gold:
                wrong.append({"case": f"{row['question']}/{row['answer']}", "gold": gold, "got": got})
        usage = [r.get("usage") or {} for r in mine]
        result[condition] = {
            "calls": len(mine),
            "items": items,
            "items_matched": matched,
            "unearned_marks": unearned,
            "missed_marks": missed,
            "cost_usd": round(sum(u.get("cost", 0) or 0 for u in usage), 5),
            "wrong": wrong,
        }
    (out_dir / "summary.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
