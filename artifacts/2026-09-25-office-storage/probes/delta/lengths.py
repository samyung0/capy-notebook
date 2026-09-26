"""Descriptor and summary lengths of every full regeneration, before and after
the pipeline's truncation (50 words for the descriptor)."""

import json
import sys
from pathlib import Path

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline.retrieval.indexing import (
    _parse_summary_payload,
    _truncate_words,
    _words,
)

HERE = Path(__file__).resolve().parent
rows = []
for f in sorted((HERE / "calls").glob("full-*.json")):
    rec = json.loads(f.read_text(encoding="utf-8"))
    d, s = _parse_summary_payload(rec["content"])
    stored = _truncate_words(d, 50)
    rows.append(
        {
            "call": f.name[:12],
            "descriptor_words": len(_words(d)),
            "summary_words": len(_words(s)),
            "stored_descriptor_ends_mid_sentence": stored.rstrip()[-1:] not in ".!?",
            "output_tokens": rec["usage"].get("completion_tokens"),
        }
    )
for r in rows:
    print(r)
n = len(rows)
print("calls", n)
print("descriptor over 50 words:", sum(r["descriptor_words"] > 50 for r in rows))
print(
    "stored descriptor cut mid-sentence:",
    sum(r["stored_descriptor_ends_mid_sentence"] for r in rows),
)
words = sorted(r["summary_words"] for r in rows)
print("summary words min/median/max:", words[0], words[n // 2], words[-1])
