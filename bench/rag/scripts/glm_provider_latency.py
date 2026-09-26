"""GLM-5.3-Flash on Relace vs Tencent TokenHub: latency, prompt caching, rate limits.

Streams every call so time to first token (reasoning or answer) is separate
from total time. No retries; a 90 s backstop. Keys come from .env.local
(RELACE_API_KEY, TOKENHUB) into memory only; samples hold no text.

    .venv/Scripts/python.exe bench/rag/scripts/glm_provider_latency.py effort
    .venv/Scripts/python.exe bench/rag/scripts/glm_provider_latency.py latency --cycles 20
    .venv/Scripts/python.exe bench/rag/scripts/glm_provider_latency.py cache
    .venv/Scripts/python.exe bench/rag/scripts/glm_provider_latency.py burst
    .venv/Scripts/python.exe bench/rag/scripts/glm_provider_latency.py report

latency: interleaved short prompts and a ~12k-token chat-agent prompt (the
production chat system prompt plus library chunks as a tool result), low
reasoning. cache: multi-turn sessions that share the system prompt across
sessions and grow per turn, the way the chat loop does; Relace runs with and
without prompt_cache_key. burst: concurrency ramp of tiny requests to find
429s. Samples land in the ignored data/glm-provider-latency/.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import random
import re
import statistics
import sys
import time
import uuid
from collections import defaultdict
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "data" / "glm-provider-latency"
SAMPLES = OUT / "samples.jsonl"
BACKSTOP_S = 90.0


def _env() -> dict[str, str]:
    env = {}
    for line in (REPO / ".env.local").read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Z_]+)\s*=\s*(.*)", line)
        if m:
            env[m[1]] = m[2].strip().strip("\"'")
    return env


ENV = _env()
TARGETS = {
    "relace": ("https://models.relace.ai/v1/chat/completions", ENV["RELACE_API_KEY"], "z-ai/glm-5.3-flash"),
    "tencent": ("https://tokenhub.tencentcloudmaas.com/v1/chat/completions", ENV["TOKENHUB"], "glm-5.3-flash"),
}


def _system_prompt() -> str:
    sys.path.insert(0, str(REPO / "pipeline"))
    from pipeline.prompts.chat import system_prompt

    return system_prompt("en")


def _chunks() -> list[str]:
    path = REPO / "data" / "qwen37-embedding" / "library" / "chunks.jsonl.gz"
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return [t for t in (json.loads(line)["indexed_text"] for line in f) if 400 < len(t) < 3000]


SYSTEM = _system_prompt()
CHUNKS = _chunks()
QUESTIONS = [
    "Summarise the main claim of passage [2] in two sentences.",
    "Which passage best explains a cause-and-effect relationship? Cite it.",
    "List three key terms from the passages and define each briefly.",
    "Does any passage contradict another? Answer briefly with citations.",
    "Write one exam-style question answerable from passage [5].",
    "What is the most important idea across these passages, in one sentence?",
]
SHORT = [
    "Explain photosynthesis to a 12-year-old in three sentences.",
    "Give two differences between mitosis and meiosis.",
    "What does a p-value mean? One short paragraph.",
    "Translate 'the library opens at nine' into French and Japanese.",
]


def _tool_result(rng: random.Random, n: int) -> str:
    return "\n\n".join(f"[{i + 1}] {c}" for i, c in enumerate(rng.sample(CHUNKS, n)))


def _agent_messages(rng: random.Random, question: str, nonce: str = "") -> list[dict]:
    # Shape of a chat-agent turn after one search: system, user, tool call, tool result.
    call = {"id": "call_1", "type": "function", "function": {"name": "search_workspace", "arguments": json.dumps({"query": question})}}
    return [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": (f"(session {nonce}) " if nonce else "") + question},
        {"role": "assistant", "content": "", "tool_calls": [call]},
        {"role": "tool", "tool_call_id": "call_1", "content": _tool_result(rng, 16)},
    ]


async def call(client: httpx.AsyncClient, target: str, messages: list[dict], *, effort: str = "low",
               max_tokens: int = 1024, extra: dict | None = None) -> dict:
    url, key, model = TARGETS[target]
    body = {
        "model": model,
        "messages": messages,
        "reasoning_effort": effort,
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": True,
        "stream_options": {"include_usage": True},
        **(extra or {}),
    }
    t0 = time.perf_counter()
    s: dict = {"target": target, "ts": time.time()}
    first = first_answer = None
    usage = None
    content = []
    try:
        async with client.stream("POST", url, headers={"Authorization": "Bearer " + key}, json=body,
                                 timeout=BACKSTOP_S) as r:
            s["status"] = r.status_code
            s["headers"] = {k: v for k, v in r.headers.items() if re.search(r"rate|limit|retry|remaining", k, re.I)}
            if r.status_code != 200:
                s["error"] = (await r.aread()).decode(errors="replace")[:300]
            else:
                async for line in r.aiter_lines():
                    if not line.startswith("data:") or line.strip() == "data: [DONE]":
                        continue
                    chunk = json.loads(line[5:])
                    if chunk.get("usage"):
                        usage = chunk["usage"]
                    for ch in chunk.get("choices") or []:
                        d = ch.get("delta") or {}
                        if (d.get("reasoning_content") or d.get("reasoning") or d.get("content") or d.get("tool_calls")) and first is None:
                            first = time.perf_counter() - t0
                        if d.get("content"):
                            content.append(d["content"])
                            if first_answer is None:
                                first_answer = time.perf_counter() - t0
    except Exception as e:  # noqa: BLE001 - every failure is a sample
        s["status"] = "exception"
        s["error"] = f"{type(e).__name__}: {e}"[:300]
    s["total_s"] = time.perf_counter() - t0
    s["ttft_s"] = first
    s["ttfa_s"] = first_answer
    if usage:
        details = usage.get("prompt_tokens_details") or {}
        s["prompt"] = usage.get("prompt_tokens")
        s["cached"] = details.get("cached_tokens") or usage.get("cached_tokens") or 0
        s["completion"] = usage.get("completion_tokens")
        s["reasoning"] = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", usage.get("reasoning_tokens"))
    s["answer_chars"] = sum(map(len, content))
    s["_answer"] = "".join(content)
    return s


def save(sample: dict, **tags) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sample = {k: v for k, v in sample.items() if not k.startswith("_")} | tags
    with SAMPLES.open("a", encoding="utf-8") as f:
        f.write(json.dumps(sample) + "\n")
    brief = {k: sample.get(k) for k in ("mode", "workload", "target", "status", "ttft_s", "total_s", "prompt", "cached", "completion")}
    print(json.dumps({k: round(v, 2) if isinstance(v, float) else v for k, v in brief.items()}), flush=True)


async def effort() -> None:
    q = [{"role": "user", "content": "A train leaves at 09:14 and arrives at 13:52 after two stops of 7 minutes each. How many minutes was it moving? Answer with the number."}]
    async with httpx.AsyncClient() as c:
        for target in TARGETS:
            for level in ("low", "high", "max"):
                save(await call(c, target, q, effort=level, max_tokens=8000), mode="effort", workload=level)


async def latency(cycles: int) -> None:
    rng = random.Random(7)
    async with httpx.AsyncClient() as c:
        for i in range(cycles):
            order = list(TARGETS)
            rng.shuffle(order)
            short = [{"role": "user", "content": SHORT[i % len(SHORT)]}]
            # Fresh chunks per cycle, same for both targets, so neither gets a cache hit on the tool result.
            agent = _agent_messages(random.Random(i), QUESTIONS[i % len(QUESTIONS)], nonce=uuid.uuid4().hex[:8])
            for target in order:
                save(await call(c, target, short, max_tokens=600), mode="latency", workload="short", cycle=i)
                save(await call(c, target, agent), mode="latency", workload="agent", cycle=i)


async def cache(sessions: int, turns: int) -> None:
    arms = [("relace", None), ("relace", "key"), ("tencent", None)]
    async with httpx.AsyncClient() as c:
        for s in range(sessions):
            for target, keyed in arms:
                sid = uuid.uuid4().hex[:8]
                rng = random.Random(1000 + s)
                messages = _agent_messages(rng, QUESTIONS[0], nonce=sid)
                extra = {"prompt_cache_key": f"capy-bench:{sid}"} if keyed else None
                arm = f"{target}{'+key' if keyed else ''}"
                for t in range(turns):
                    r = await call(c, target, messages, extra=extra, max_tokens=700)
                    save(r, mode="cache", workload=arm, session=sid, turn=t)
                    if r.get("status") != 200:
                        break
                    messages = messages + [
                        {"role": "assistant", "content": r["_answer"] or "(no answer)"},
                        {"role": "user", "content": QUESTIONS[(t + 1) % len(QUESTIONS)]},
                    ]
                await asyncio.sleep(2)


async def burst(levels: list[int]) -> None:
    tiny = [{"role": "user", "content": "Reply with the single word: ok"}]
    async with httpx.AsyncClient(limits=httpx.Limits(max_connections=200)) as c:
        for n in levels:
            for target in TARGETS:
                t0 = time.perf_counter()
                results = await asyncio.gather(*(call(c, target, tiny, max_tokens=64) for _ in range(n)))
                wall = time.perf_counter() - t0
                for r in results:
                    save(r, mode="burst", workload=f"c{n}", wall_s=wall)
                await asyncio.sleep(5)


def _pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def report() -> None:
    rows = [json.loads(line) for line in SAMPLES.read_text(encoding="utf-8").splitlines()]
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["mode"], r["workload"], r["target"])].append(r)
    print("| mode | workload | target | n | ok | ttft p50 | ttft p95 | total p50 | total p95 | max | out tok/s p50 | prompt | cached % |")
    print("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for (mode, workload, target), rs in sorted(groups.items()):
        ok = [r for r in rs if r["status"] == 200]
        if mode == "cache":
            target = workload
        tt = [r["ttft_s"] for r in ok if r.get("ttft_s")]
        tot = [r["total_s"] for r in ok]
        rate = [r["completion"] / (r["total_s"] - r["ttft_s"]) for r in ok if r.get("completion") and r.get("ttft_s") and r["total_s"] > r["ttft_s"]]
        prompt = sum(r.get("prompt") or 0 for r in ok)
        cached = sum(r.get("cached") or 0 for r in ok)
        f = lambda xs, p: f"{_pct(xs, p):.2f}" if xs else "-"  # noqa: E731
        print(f"| {mode} | {workload} | {target} | {len(rs)} | {len(ok)} | {f(tt, 50)} | {f(tt, 95)} | {f(tot, 50)} | {f(tot, 95)} | "
              f"{max(tot):.2f} | {statistics.median(rate) if rate else 0:.0f} | {prompt // max(len(ok), 1)} | {100 * cached / prompt if prompt else 0:.0f} |" if ok else
              f"| {mode} | {workload} | {target} | {len(rs)} | 0 | | | | | | | | |")
    print("\nCache hit by turn (cached/prompt %):")
    by_turn: dict[tuple, list] = defaultdict(list)
    for r in rows:
        if r["mode"] == "cache" and r["status"] == 200:
            by_turn[(r["workload"], r["turn"])].append(100 * (r.get("cached") or 0) / r["prompt"])
    for arm in sorted({k[0] for k in by_turn}):
        print(arm, [f"t{t}:" + "/".join(f"{v:.0f}" for v in by_turn[(arm, t)]) for t in sorted(t for a, t in by_turn if a == arm)])
    print("\nNon-200 statuses:")
    errs = defaultdict(int)
    for r in rows:
        if r["status"] != 200:
            errs[(r["mode"], r["workload"], r["target"], r["status"], (r.get("error") or "")[:120], r.get("headers", {}).get("retry-after"))] += 1
    for k, v in sorted(errs.items(), key=str):
        print(v, k)
    heads = {r["target"]: r.get("headers") for r in rows if r.get("headers")}
    print("\nRate-limit headers seen:", heads)


def main() -> None:
    cmd = sys.argv[1]
    arg = lambda name, default: int(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default  # noqa: E731
    if cmd == "effort":
        asyncio.run(effort())
    elif cmd == "latency":
        asyncio.run(latency(arg("--cycles", 20)))
    elif cmd == "cache":
        asyncio.run(cache(arg("--sessions", 3), arg("--turns", 5)))
    elif cmd == "burst":
        asyncio.run(burst([8, 16, 32, 64]))
    elif cmd == "report":
        report()


if __name__ == "__main__":
    main()
