"""Compute the summary input budget and call plan for the measured book,
using the real indexing helpers with a deepseek-flash-shaped pin (no network)."""

import json
import sys
from pathlib import Path

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline import registry
from pipeline.retrieval import indexing
from pipeline.retrieval.chunking import estimate_tokens
from pipeline.retrieval.confidence import ocr_pages, score_chunks
from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks

spec = registry.ModelConfig(
    provider_slug="deepseek",
    model_slug="deepseek-flash",
    version=3,
    provider_name="DeepSeek",
    model_name="Flash 4.1",
    thinking_levels=("low", "mid", "high", "max"),
    default_thinking="high",
    micros_per_input_token=250,
    micros_per_output_token=1000,
    micros_per_cached_input_token=25,
    context_window_tokens=1_000_000,
)
registry.set_job_pins(registry.JobPins(ingest=spec))
budget = indexing._input_budget()
path = Path(sys.argv[1])
result = json.loads(Path(str(path) + ".parsed.json").read_text(encoding="utf-8"))
cl = result["content_list"]
ev = result["_page_evidence"]
chunks = pack_blocks(cl, frozenset(result.get("_furniture") or []))
chunks = retain_headings(cl, path, chunks, verified=set(ev["visible_headings"]))
score_chunks(chunks, path, ocr=ocr_pages(cl), page_texts=ev["page_texts"])
body = "\n\n".join(c.indexed_text() for c in chunks)
tokens = estimate_tokens(body)
print(
    json.dumps(
        {
            "input_budget_est_tokens": budget,
            "book_body_est_tokens": tokens,
            "body_chars": len(body),
            "word_target": indexing._summary_word_target(len(body)),
            "single_call": tokens <= budget,
            "groups_if_mapped": len(indexing._chunk_groups(chunks, budget)),
            "max_single_call_pages_at_this_density": int(
                budget / (tokens / result["_page_count"])
            ),
        }
    )
)
