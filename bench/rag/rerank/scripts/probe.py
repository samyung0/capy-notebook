"""Synthetic API probes, run before any library query is reranked.

1. Which rerank models the Beijing workspace serves, and on which route:
   qwen3-rerank (documented on the OpenAI-compatible route), qwen3.7-text-rerank
   and gte-rerank-v2 (documented on the native route), plus the two
   undocumented cross combinations.
2. Whether scores depend on the other documents in the request: the same
   two documents alone and inside a four-document request.
3. DeepInfra Qwen3-Reranker 0.6B/4B/8B: response shape, whether the
   instruction field is honoured (explicit default vs omitted vs the
   period-less DeepInfra default), pointwise invariance, billed tokens.

4. (`instruct`) Whether each route honours the instruction: two documents
   that answer different aspects of one query, ranked under two contrived
   instructions, and billed tokens with a long instruction.
5. (`singapore`) qwen3.7-text-rerank on the Singapore workspace, since the
   Beijing workspace answers 403 AccessDenied for it on both routes.

All texts are invented; nothing from the library is sent. No retries except
429. Output: data/rerank-eval/probe[-instruct|-singapore].json. Cost: a few
thousand tokens.

  python probe.py base | instruct | singapore
"""

from __future__ import annotations

import asyncio
import sys

import rr

Q = "What colour is the fictional box?"
A = "The fictional box is blue."
B = "The weather is sunny today."
C = "Boxes can be painted in many colours, and some are left plain."
D = "The fictional box sits on a red table next to a green lamp."
# ~1,400 characters of invented textbook-like prose, the median library chunk length.
LONG = (
    "A worked example in this chapter follows a small bakery through one month of trading. "
    "The owner records the cost of flour, butter and sugar on each delivery, then divides the total by the number of loaves "
    "baked to find an average ingredient cost per loaf. Labour is treated separately: two part-time assistants are paid by the "
    "hour, and their wages are spread across the loaves in the same way. The example then asks the reader to compare the "
    "average cost with the selling price, and to explain why the margin narrows in weeks when the oven is used below capacity. "
    "Fixed costs such as rent and insurance do not change with the number of loaves, so a quieter week carries the same fixed "
    "cost over fewer units. The reader is asked to compute the break-even quantity, the number of loaves at which revenue "
    "exactly covers fixed and variable costs, and to state what happens to that quantity if the price of flour rises by ten "
    "percent. A short table lists four weeks of output, ingredient spending and wage hours, and the questions at the end "
    "ask for a line graph of cost per loaf against output, a sentence describing the trend, and a recommendation about "
    "whether the bakery should open on Sundays, given the extra wage premium paid on weekends and the expected demand."
)

EXTRA = {
    "probe-qwen3-rerank@native": {"provider": "alibaba", "model": "qwen3-rerank", "endpoint": "native", "price": 0.5},
    "probe-qwen3.7-text-rerank@compat": {"provider": "alibaba", "model": "qwen3.7-text-rerank", "endpoint": "compat", "price": 0.5},
    "probe-gte-rerank-v2@native": {"provider": "alibaba", "model": "gte-rerank-v2", "endpoint": "native", "price": 0.8},
}


async def one(http, key, docs, instruction_id="default", instruction=None, query=Q):
    text = instruction if instruction is not None else (None if instruction_id is None else rr.instructions()[instruction_id])
    try:
        scores, usage, meta, ms = await rr.attempt(http, key, query, docs, text, phase="probe", instruction_id=instruction_id)
        return {"ok": True, "scores": scores, "usage": usage, "meta": meta, "ms": round(ms)}
    except rr.ProviderError as exc:
        return {"ok": False, "status": exc.status, "error": str(exc)[:300]}


async def base():
    rr.RERANKERS.update(rr.PROBE_ONLY)
    rr.RERANKERS.update(EXTRA)
    out = {"ts": rr.utc(), "alibaba": {}, "deepinfra": {}}
    async with rr.client(60.0) as http:
        for key in ("ali-qwen3-rerank", "ali-qwen3.7-rerank", *EXTRA):
            out["alibaba"][key] = {"pair": await one(http, key, [A, B])}
        for key in ("ali-qwen3-rerank", "ali-qwen3.7-rerank"):
            row = out["alibaba"][key]
            row["four"] = await one(http, key, [A, B, C, D])
            row["long_pair"] = await one(http, key, [LONG, A], query="How is the break-even quantity found in the bakery example?")
            row["no_instruction"] = await one(http, key, [A, B], instruction_id=None)
        for key in ("di-0.6b", "di-4b", "di-8b"):
            row = {}
            row["pair"] = await one(http, key, [A, B])
            row["three"] = await one(http, key, [A, C, D])
            row["no_instruction"] = await one(http, key, [A, B], instruction_id=None)
            row["deepinfra_default"] = await one(
                http, key, [A, B], instruction_id="deepinfra-default",
                instruction="Given a web search query, retrieve relevant passages that answer the query",
            )
            row["long_pair"] = await one(http, key, [LONG, A], query="How is the break-even quantity found in the bakery example?")
            out["deepinfra"][key] = row
    rr.write_json(rr.DATA / "probe.json", out)
    for provider in ("alibaba", "deepinfra"):
        for key, row in out[provider].items():
            print(provider, key)
            for name, r in row.items():
                if r["ok"]:
                    print(f"   {name:18s} ok  scores={[round(s, 5) for s in r['scores']]} usage={r['usage']} {r['ms']} ms")
                else:
                    print(f"   {name:18s} ERR {r['status']} {r['error'][:160]}")
    print(rr.spend())


E = "The fictional box weighs two kilograms."
COLOUR = "Given a query about an object, retrieve the passage that states the object's colour."
WEIGHT = "Given a query about an object, retrieve the passage that states the object's weight."
LONG_INSTRUCTION = " ".join(["Given a learner's question, retrieve the textbook passage that answers it."] * 6)


async def instruct():
    out = {"ts": rr.utc()}
    async with rr.client(60.0) as http:
        for key in ("ali-qwen3-rerank", "di-0.6b", "di-4b", "di-8b"):
            row = {}
            for name, text in (("colour", COLOUR), ("weight", WEIGHT), ("long", LONG_INSTRUCTION)):
                row[name] = await one(http, key, [A, E], instruction_id=name, instruction=text, query="Tell me about the fictional box.")
            row["default"] = await one(http, key, [A, E], query="Tell me about the fictional box.")
            out[key] = row
    rr.write_json(rr.DATA / "probe-instruct.json", out)
    report(out)


async def singapore():
    rr.RERANKERS["probe-sg-qwen3.7-text-rerank@native"] = {
        "provider": "alibaba", "model": "qwen3.7-text-rerank", "endpoint": "native", "price": 0.5, "region": "singapore"}
    rr.RERANKERS["probe-sg-qwen3-rerank@compat"] = {
        "provider": "alibaba", "model": "qwen3-rerank", "endpoint": "compat", "price": 0.5, "region": "singapore"}
    out = {"ts": rr.utc()}
    async with rr.client(60.0) as http:
        for key in ("probe-sg-qwen3.7-text-rerank@native", "probe-sg-qwen3-rerank@compat"):
            row = {"pair": await one(http, key, [A, B])}
            if row["pair"]["ok"]:
                row["four"] = await one(http, key, [A, B, C, D])
                row["long_pair"] = await one(http, key, [LONG, A], query="How is the break-even quantity found in the bakery example?")
                for name, text in (("colour", COLOUR), ("weight", WEIGHT), ("long", LONG_INSTRUCTION)):
                    row[name] = await one(http, key, [A, E], instruction_id=name, instruction=text, query="Tell me about the fictional box.")
                row["default_ae"] = await one(http, key, [A, E], query="Tell me about the fictional box.")
            out[key] = row
    rr.write_json(rr.DATA / "probe-singapore.json", out)
    report(out)


def report(out):
    for key, row in out.items():
        if key == "ts":
            continue
        print(key)
        for name, r in row.items():
            if r["ok"]:
                print(f"   {name:12s} ok  scores={[round(s, 5) for s in r['scores']]} usage={r['usage']} {r['ms']} ms")
            else:
                print(f"   {name:12s} ERR {r['status']} {r['error'][:160]}")
    print(rr.spend())


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run({"base": base, "instruct": instruct, "singapore": singapore}[sys.argv[1]]())
