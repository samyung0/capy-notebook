"""The reparse probe's chapter variants (BetterOffice exports): one-sentence
edit, 12 paragraphs extended with the same filler, 20 one-word fixes. Each is
a single refresh from chapter-noedit. Full regeneration of each, and diff-mode
(v3) and insert-only (v4) deltas from the base's full summary."""

import json
import sys
from pathlib import Path

import delta
import llm
import run
import sizes

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline.prompts.ingest import summary_messages
from pipeline.retrieval.chunking import estimate_tokens

HERE = Path(__file__).resolve().parent
BASE = "chapter-noedit.docx"
VARIANTS = ["chapter-small.docx", "chapter-section.docx", "chapter-scattered.docx"]
FILLER = "analysts revisit this idea"


def full(name: str) -> dict:
    chunks = sizes.load(name)
    body = "\n\n".join(c.indexed_text() for c in chunks)
    rec = llm.chat(f"probe-full-{name}", summary_messages(body, run.TARGET))
    return {**run.finish(rec["content"], run.TARGET), "usage": rec["usage"]}


out = {"base": full(BASE)}
old = sizes.load(BASE)
for name in VARIANTS:
    new = sizes.load(name)
    doc_tokens = estimate_tokens("\n\n".join(c.indexed_text() for c in new))
    changes = delta.text_changes(old, new)
    gone, fresh = delta.section_changes(old, new)
    base = out["base"]
    d3 = llm.chat(
        f"probe-diff3-{name}",
        delta.diff_messages_v3(
            base["descriptor"],
            base["summary"],
            changes,
            run.TARGET,
            doc_tokens,
            gone,
            fresh,
        ),
    )
    ins = llm.chat(
        f"probe-insert-{name}",
        delta.insert_messages(
            base["descriptor"], base["summary"], changes, run.TARGET, doc_tokens
        ),
    )
    row = {
        "full": full(name),
        "diff3": {**run.finish(d3["content"], run.TARGET), "usage": d3["usage"]},
        "insert": {**run.finish(ins["content"], run.TARGET), "usage": ins["usage"]},
        "diff_tokens": sum(c.tokens() for c in changes),
        "doc_tokens": doc_tokens,
    }
    out[name] = row
    for arm in ("full", "diff3", "insert"):
        s = row[arm]
        text = (s["descriptor"] + " " + s["summary"]).lower()
        same_d = s["descriptor"] == base["descriptor"]
        print(
            name,
            arm,
            "words",
            len(s["summary"].split()),
            "filler mentioned" if FILLER in text or "revisit" in text else "no filler",
            "descriptor unchanged" if same_d else "descriptor changed",
        )
(HERE / "probe-variants.json").write_text(
    json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8"
)
print("spent", round(llm.spent(), 4))
