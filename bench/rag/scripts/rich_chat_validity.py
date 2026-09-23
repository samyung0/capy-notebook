"""Collect a bounded, synthetic answer-format sample with no repair/retries.

Uses the production prompt and provider request builders, with frozen mock tool
evidence. This measures answer formatting, not retrieval or production traffic.
Provider credentials are read in memory from the existing UAT worker.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "lab/playground/scripts"))
import common

from pipeline.elitellm import client
from pipeline.prompts import chat
from pipeline.registry import ModelConfig
from pipeline.retrieval import openui
from pipeline.retrieval.response_guard import contains_tool_protocol

EVIDENCE = """Synthetic text-only study notes, read_document result:
[1] Atomicity means a transaction's changes all happen or none happen. Isolation
prevents concurrent transactions from observing intermediate changes. Durability
means committed changes survive a restart.
[2] Alice starts with 250 USD and Bob with 100 USD. A transfer of 50 USD leaves
Alice with 200 USD and Bob with 150 USD. The total stays 350 USD. Begin the
transaction, debit Alice, credit Bob, then commit; roll back if either update fails.
[3] Hourly total balances: 09:00 = 350 USD; 10:00 = 400 USD; 11:00 = 380 USD.
Transaction count and latency observations: A = (10, 12 ms), B = (20, 17 ms),
C = (30, 26 ms). These synthetic measurements are provided for this test only.
"""


async def run(output: Path, repeats: int, models: list[str]) -> None:
    cases = json.loads((ROOT / "bench/rag/fixtures/rich-chat-cases.json").read_text())
    secrets = common.worker_env()
    prompt = chat.system_prompt("en")
    output.mkdir(parents=True, exist_ok=False)
    (output / "prompt.txt").write_text(prompt)
    (output / "cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2))
    (output / "evidence.txt").write_text(EVIDENCE)
    (output / "metadata.json").write_text(
        json.dumps(
            {
                "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
                "repeats": repeats,
                "cases_per_model": len(cases) * repeats,
                "models": models,
                "routes": {
                    "glm": client.TENCENT_CHAT_URL,
                    "deepseek": client.DEEPSEEK_CHAT_URL,
                },
                "thinking": {"glm": "low", "deepseek": "high"},
                "temperature": None,
                "max_tokens": None,
                "stream": True,
            },
            indent=2,
        )
    )
    gates = {name: asyncio.Semaphore(2) for name in models}
    async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=15)) as http:

        async def sample(name: str, case: dict, repeat: int) -> None:
            async with gates[name]:
                messages = [
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": case["question"]},
                ]
                if case["evidence"]:
                    messages += [
                        {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "read",
                                    "type": "function",
                                    "function": {
                                        "name": "read_document",
                                        "arguments": '{"file_id":"synthetic"}',
                                    },
                                }
                            ],
                        },
                        {"role": "tool", "tool_call_id": "read", "content": EVIDENCE},
                    ]
                    if name == "deepseek":
                        # Thinking-mode tool history requires this field, even
                        # for the synthetic read preceding the sampled answer.
                        messages[-2]["reasoning_content"] = ""
                glm = name == "glm"
                model = "glm-5.3-flash" if glm else "deepseek-flash"
                spec = ModelConfig(
                    version=1,
                    provider_name=name,
                    provider_slug="zai" if glm else "deepseek",
                    model_name=model,
                    model_slug=model,
                    slots=("chat",),
                )
                body = (client.zai_request if glm else client.deepseek_request)(
                    spec,
                    messages,
                    temperature=None,
                    tools=None,
                    response_format=None,
                    max_tokens=None,
                    thinking="low" if glm else "high",
                    stream=True,
                    tool_choice=None,
                )
                key = secrets["TENCENT_API_KEY" if glm else "DEEPSEEK_API_KEY"]
                url = client.TENCENT_CHAT_URL if glm else client.DEEPSEEK_CHAT_URL
                record = {
                    "model": name,
                    "wire_model": model,
                    "thinking": "low" if glm else "high",
                    "wire_thinking": body.get("thinking"),
                    "reasoning_effort": body.get("reasoning_effort"),
                    "case": case["id"],
                    "repeat": repeat,
                    "known_passages": 3 if case["evidence"] else 0,
                    "content": "",
                    "reasoning": "",
                    "usage": {},
                    "finish_reason": None,
                }
                started = time.monotonic()
                try:
                    async with asyncio.timeout(180):
                        async with http.stream(
                            "POST",
                            url,
                            headers={"Authorization": f"Bearer {key}"},
                            json=body,
                        ) as response:
                            response.raise_for_status()
                            async for line in response.aiter_lines():
                                if (
                                    not line.startswith("data:")
                                    or line[5:].strip() == "[DONE]"
                                ):
                                    continue
                                data = json.loads(line[5:])
                                if data.get("usage"):
                                    record["usage"] = data["usage"]
                                for choice in data.get("choices", []):
                                    delta = choice.get("delta") or {}
                                    record["content"] += delta.get("content") or ""
                                    record["reasoning"] += (
                                        delta.get("reasoning_content") or ""
                                    )
                                    record["finish_reason"] = (
                                        choice.get("finish_reason")
                                        or record["finish_reason"]
                                    )
                except (httpx.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
                    record["transport_error"] = type(exc).__name__
                    if isinstance(exc, httpx.HTTPStatusError):
                        record["http_status"] = exc.response.status_code
                record["seconds"] = round(time.monotonic() - started, 2)
                path = output / f"{name}-{case['id']}-{repeat}.json"
                path.write_text(json.dumps(record, ensure_ascii=False, indent=2))
                print(
                    json.dumps(
                        {
                            "model": name,
                            "case": case["id"],
                            "repeat": repeat,
                            "characters": len(record["content"]),
                            "seconds": record["seconds"],
                            "error": record.get("transport_error"),
                        }
                    ),
                    flush=True,
                )

        await asyncio.gather(
            *(
                sample(name, case, repeat)
                for repeat in range(repeats)
                for case in cases
                for name in gates
            )
        )


def score(output: Path) -> None:
    rows = []
    for path in sorted(output.glob("*.json")):
        row = json.loads(path.read_text())
        if not isinstance(row, dict) or "wire_model" not in row:
            continue
        renderer = openui.LangRenderer(lambda known=row["known_passages"]: known)
        renderer.push(row["content"])
        renderer.finish()
        unknown = []
        if renderer.program:
            unknown = [
                n
                for call in openui.walk(renderer.program)
                if isinstance(passages := call.prop("passages"), list)
                for n in passages
                if isinstance(n, int) and not 1 <= n <= row["known_passages"]
            ]
        rows.append(
            {
                "model": row["model"],
                "case": row["case"],
                "repeat": row["repeat"],
                "content": renderer.text if renderer.answer_shaped else row["content"],
                "pythonValid": renderer.complete,
                "unknownPassages": unknown,
                "transportError": row.get("transport_error"),
                "protocolLeak": contains_tool_protocol(row["content"]),
            }
        )
    result = subprocess.run(
        ["pnpm", "exec", "tsx", "bench/rag/scripts/rich_chat_score.ts"],
        cwd=ROOT,
        input=json.dumps(rows),
        text=True,
        capture_output=True,
        check=True,
    )
    (output / "scores.json").write_text(result.stdout)
    scored = json.loads(result.stdout)
    print(json.dumps(scored["prompts"]))
    for model in sorted({r["model"] for r in scored["scored"]}):
        selected = [r for r in scored["scored"] if r["model"] == model]
        print(
            json.dumps(
                {
                    "model": model,
                    "responses": len(selected),
                    "protocol_leaks": sum(r["protocolLeak"] for r in selected),
                    "transport_errors": sum(
                        bool(r["transportError"]) for r in selected
                    ),
                    "format_invalid": sum(r["formatInvalid"] for r in selected),
                    "invalid_including_data": sum(r["invalid"] for r in selected),
                    "partial": sum(r["recovery"] == "partial" for r in selected),
                    "unusable": sum(r["recovery"] == "unusable" for r in selected),
                }
            )
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--repeats", type=int)
    parser.add_argument("--model", choices=("glm", "deepseek"))
    parser.add_argument("--score", action="store_true")
    args = parser.parse_args()
    if args.score:
        score(args.output)
        raise SystemExit
    if args.repeats is None or args.repeats < 1:
        parser.error("repeats must be positive")
    asyncio.run(
        run(
            args.output,
            args.repeats,
            [args.model] if args.model else ["glm", "deepseek"],
        )
    )
    score(args.output)
