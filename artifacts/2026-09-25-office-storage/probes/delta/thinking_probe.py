"""Which request field turns DeepSeek V4.1 Flash thinking off on DeepInfra?"""

import json

import httpx
import llm

QUESTION = [{"role": "user", "content": "What is 17 * 23? Reply with the number only."}]
VARIANTS = {
    "none": {},
    "template": {"chat_template_kwargs": {"thinking": False}},
    "deepseek": {"thinking": {"type": "disabled"}},
    "effort_none": {"reasoning_effort": "none"},
}
for name, extra in VARIANTS.items():
    body = {
        "model": llm.FLASH,
        "messages": QUESTION,
        "temperature": 0.3,
        "max_tokens": 400,
        **extra,
    }
    if llm.spent() + 0.001 > llm.SOFT_CAP_USD:
        raise SystemExit("cap")
    r = httpx.post(
        llm.URL, headers={"Authorization": f"Bearer {llm.KEY}"}, json=body, timeout=120
    )
    raw = r.json()
    usage = raw.get("usage") or {}
    msg = ((raw.get("choices") or [{}])[0].get("message")) or {}
    with llm.LEDGER.open("a", encoding="utf-8") as fh:
        fh.write(
            json.dumps(
                {
                    "tag": f"thinking-probe-{name}",
                    "model": llm.FLASH,
                    "usage": usage,
                    "cost_usd": float(usage.get("estimated_cost") or 0.0),
                }
            )
            + "\n"
        )
    print(
        name,
        r.status_code,
        json.dumps(
            {
                "content": msg.get("content"),
                "reasoning_len": len(msg.get("reasoning_content") or ""),
                "usage": usage,
            }
        )[:600],
    )
print("spent", llm.spent())
