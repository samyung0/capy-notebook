"""Measure 1017 token use and cost per page for each marking path.
Prompts are pulled verbatim from the repo; the key is read from an env file and never printed."""
import ast, base64, json, sys, time
from pathlib import Path
import httpx

REPO = Path(sys.argv[1]); ENV = Path(sys.argv[2]); HERE = Path(sys.argv[3])

def const(path, name):
    tree = ast.parse(path.read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise KeyError(name)

SYSTEM = const(REPO / "pipeline/pipeline/retrieval/grading.py", "SYSTEM_PROMPT")
DRAWN = const(REPO / "pipeline/pipeline/retrieval/grading.py", "DRAWN_SECTION")
VLM = const(REPO / "pipeline/pipeline/prompts/captioning.py", "VLM_PAGE_PROMPT")
KEY = next(l.split("=", 1)[1].strip().strip('"') for l in ENV.read_text().splitlines() if l.startswith("OPENROUTER_API_KEY="))
MODEL = "deepseek/deepseek-v4.1-flash-1017"
ROUTE = {"order": ["wafer/us", "InferenceNet", "Cloudflare"], "allow_fallbacks": False}

def img(name):
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode((HERE / name).read_bytes()).decode()}}

def qi(question, items):
    marking = "\n".join(f"m{i} ({m:g} mark{'' if m == 1 else 's'}): {t}" for i, (m, t) in enumerate(items))
    return f"<question>\n{question}\n</question>\n\n<marking_items>\n{marking}\n</marking_items>"

Q3 = ("3. Solve $x^2 - 5x + 6 = 0$. Show your working.", [(1, "M1 factorises or uses the formula correctly"), (1, "A1 $x = 2$"), (1, "A1 $x = 3$")])
Q2A = ("2 (a) Explain why plants need light for photosynthesis.", [(1, "light energy is absorbed by chlorophyll"), (1, "energy used to split water / make glucose")])
LOCATE = "The image is a whole page of the student's answers. Mark only the answer to the part in <question>; ignore other answers on the page.\n"

def call(label, messages, thinking):
    body = {"model": MODEL, "messages": messages, "provider": ROUTE, "usage": {"include": True},
            "max_tokens": 16000 if thinking else 2000}
    if not thinking:
        body.update(reasoning={"enabled": False}, temperature=0)
    t = time.time()
    r = httpx.post("https://openrouter.ai/api/v1/chat/completions", json=body,
                   headers={"Authorization": f"Bearer {KEY}"}, timeout=240)
    dt = time.time() - t
    data = r.json()
    if "usage" not in data:
        print(label, "ERROR", r.status_code, json.dumps(data)[:300]); return None
    u = data["usage"]
    pin, out = u["prompt_tokens"], u["completion_tokens"]
    cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0
    reas = (u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0) or 0
    credits = ((pin - cached) * 200 + cached * 20 + out * 1200) / 1e6
    row = dict(label=label, provider=data.get("provider"), prompt=pin, cached=cached, out=out, reasoning=reas,
               usd=u.get("cost"), credits=round(credits, 3), s=round(dt, 1),
               answer=(data["choices"][0]["message"].get("content") or "")[:400])
    print(json.dumps(row)); return row

def grade_img(label, q, image, thinking, locate=False):
    sys_ = SYSTEM + DRAWN
    content = [{"type": "text", "text": (LOCATE if locate else "") + qi(*q)}, img(image)]
    return call(label, [{"role": "system", "content": sys_}, {"role": "user", "content": content}], thinking)

def grade_text(label, q, answer, thinking):
    return call(label, [{"role": "system", "content": SYSTEM},
                        {"role": "user", "content": qi(*q) + f"\n\n<student_answer>\n{answer}\n</student_answer>"}], thinking)

rows = []
for rep in range(2):
    rows.append(call(f"vlm_read_1280#{rep}", [{"role": "system", "content": VLM}, {"role": "user", "content": [img("page1280.jpg")]}], False))
    rows.append(call(f"vlm_read_1568#{rep}", [{"role": "system", "content": VLM}, {"role": "user", "content": [img("page1568.jpg")]}], False))
    rows.append(grade_img(f"grade_page1568_plain_q2a#{rep}", Q2A, "page1568.jpg", False, locate=True))
    rows.append(grade_img(f"grade_page1568_thinking_q3#{rep}", Q3, "page1568.jpg", True, locate=True))
    rows.append(grade_img(f"grade_page1024_thinking_q3#{rep}", Q3, "page1024.jpg", True, locate=True))
    rows.append(grade_img(f"grade_crop_thinking_q3#{rep}", Q3, "q3crop.jpg", True))
    rows.append(grade_text(f"grade_text_thinking_q3#{rep}", Q3, "x^2 - 5x + 6 = 0\n(x - 2)(x - 3) = 0\nx = 2 or x = 3", True))
    rows.append(grade_text(f"grade_text_plain_q2a#{rep}", Q2A, "Plants need light because light energy is absorbed by chlorophyll and used to split water, making the energy for glucose.", False))
(HERE / "results.jsonl").write_text("\n".join(json.dumps(r) for r in rows if r))
