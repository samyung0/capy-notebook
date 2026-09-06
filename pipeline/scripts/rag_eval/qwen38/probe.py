"""Replay empty-answer final requests with explicit tool disabling after the run."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time

import httpx
from qwen38 import ROOT, URL, client


async def main():
    rows = [json.loads(s) for s in (ROOT / "chat.jsonl").read_text().splitlines()]
    assert len(rows) == 192
    requests = [
        json.loads(s) for s in (ROOT / "llm-requests.jsonl").read_text().splitlines()
    ]
    key = json.loads((ROOT.parent / "embedding-secrets.json").read_text())["alibaba"]
    by_call = {
        call["id"]: request
        for request in requests
        for event in request["responses"]
        for choice in event.get("choices", [])
        for call in choice.get("delta", {}).get("tool_calls", [])
        if call.get("id")
    }
    output = []
    for ordinal, row in enumerate(rows):
        if row["answer"].strip():
            continue
        call_id = row["calls"][-1]["args"]["_tool_call_id"]
        original = by_call[call_id]
        assert not original["body"].get("tools")
        assert "tool_choice" not in original["body"]
        wire = {**original["body"], "tool_choice": "none"}
        result = {
            "ordinal": ordinal,
            **{k: row[k] for k in ("id", "variant", "repeat")},
            "original_response_id": original["response_id"],
            "original_body_sha256": hashlib.sha256(
                json.dumps(original["body"], sort_keys=True).encode()
            ).hexdigest(),
            "only_request_change": {"tool_choice": "none"},
            "responses": [],
        }
        start = time.perf_counter()
        try:
            async for event in client._stream_sse(URL, client._bearer(key), wire):
                if event.get("model"):
                    assert event["model"] == "qwen3.8-flash"
                result["responses"].append(event)
                if event.get("usage"):
                    result["usage"] = event["usage"]
        except (client.ProviderError, httpx.HTTPError, OSError, ValueError) as exc:
            result["error"] = f"{type(exc).__name__}: {exc}"
        result["elapsed_s"] = time.perf_counter() - start
        deltas = [
            c.get("delta", {})
            for e in result["responses"]
            for c in e.get("choices", [])
        ]
        result["answer"] = "".join(d.get("content") or "" for d in deltas)
        result["returned_tools"] = any(d.get("tool_calls") for d in deltas)
        output.append(result)
        (ROOT / "terminal-probe.json").write_text(
            json.dumps(output, ensure_ascii=False, indent=2) + "\n"
        )
        print(
            json.dumps({k: v for k, v in result.items() if k != "responses"}),
            flush=True,
        )


if __name__ == "__main__":
    asyncio.run(main())
