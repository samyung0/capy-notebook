"""Instrument the real agent in the disposable lab, with explicit test variants.

No application file is modified. Complete tool evidence is written only for the
fictional lab workspaces. Run sequentially; variant.json selects one condition.
"""

import dataclasses
import json
import os
import time
from pathlib import Path

assert os.environ.get("GATEWAY_URL") == "http://127.0.0.1:8082"

from pipeline.config import cfg
from pipeline.prompts import chat as chat_prompts
from pipeline.retrieval import store, tools

ROOT = Path("/lab")
original_run = tools.run
original_overlap = tools._overlap_footer
original_prompt = chat_prompts.system_prompt
original_render = tools.render_result
FOLLOW_LINKS = (
    "\n- If a retrieved passage supplies an identifier or refers to another source "
    "that can answer the question, follow that reference with a search or document "
    "read before deciding the answer is unavailable. A passage lacking the answer "
    "does not establish that the workspace lacks it."
)


def experiment_prompt(locale):
    condition = json.loads((ROOT / "variant.json").read_text())
    text = original_prompt(locale)
    if condition["name"] in {"follow_links", "follow_links_ids"}:
        text += FOLLOW_LINKS
    return text


def experiment_render(result, numbered):
    condition = json.loads((ROOT / "variant.json").read_text())
    text = original_render(result, numbered)
    if condition["name"] in {"navigable_hits", "follow_links_ids"} and numbered:
        locations = "\n".join(
            f"[{number}] file_id={passage.file_id}, start={passage.chunk_idx}"
            for number, passage in numbered
        )
        text += "\n\nLocations for read_document:\n" + locations
    return text


async def observed_run(name, args, ctx):
    condition = json.loads((ROOT / "variant.json").read_text())
    cfg.search_top_k = condition["top_k"]
    cfg.search_per_file_cap = condition["per_file_cap"]
    store._LEX_WEIGHT = condition["lex_weight"]
    tools._overlap_footer = (
        original_overlap if condition["overlap_footer"] else lambda *_: ""
    )
    start = time.monotonic()
    result = await original_run(name, args, ctx)
    record = {
        "message_id": ctx.assistant_message_id,
        "workspace_id": ctx.workspace_id,
        "variant": condition["name"],
        "name": name,
        "args": args,
        "elapsed_s": round(time.monotonic() - start, 3),
        "text": result.text(),
        "error": result.error,
        "refused": result.refused,
        "passages": [dataclasses.asdict(p) for p in result.passages],
    }
    with (ROOT / "tool-evidence.jsonl").open("a") as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + "\n")
    return result


tools.run = observed_run
# Patched on the module, not imported by name: chat_messages() resolves
# system_prompt as a global at call time, so this override reaches the
# real agent without touching an application file.
chat_prompts.system_prompt = experiment_prompt
tools.render_result = experiment_render

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("pipeline.retrieve.service:app", host="127.0.0.1", port=8002)
