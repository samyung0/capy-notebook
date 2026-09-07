"""Sequential, resumable agent evaluation against the isolated curated lab.

Store full stream events and actual tool results, including document reads.
Numeric answer checks are diagnostics; missing-evidence answers need review.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from upload_corpus import request

CONDITIONS = {
    "baseline": {
        "top_k": 5,
        "per_file_cap": 4,
        "lex_weight": 0.5,
        "overlap_footer": True,
    },
    "lexical_equal": {
        "top_k": 5,
        "per_file_cap": 4,
        "lex_weight": 1.0,
        "overlap_footer": True,
    },
    "no_stop_hint": {
        "top_k": 5,
        "per_file_cap": 4,
        "lex_weight": 0.5,
        "overlap_footer": False,
    },
    "top8": {"top_k": 8, "per_file_cap": 4, "lex_weight": 0.5, "overlap_footer": True},
    "follow_links": {
        "top_k": 5,
        "per_file_cap": 4,
        "lex_weight": 0.5,
        "overlap_footer": True,
    },
    "navigable_hits": {
        "top_k": 5,
        "per_file_cap": 4,
        "lex_weight": 0.5,
        "overlap_footer": True,
    },
    "follow_links_ids": {
        "top_k": 5,
        "per_file_cap": 4,
        "lex_weight": 0.5,
        "overlap_footer": True,
    },
}


def normalize(text):
    return re.sub(r"[^\w.-]+|_", "", text.casefold())


def supports(passage, evidence):
    if passage["file_name"] != evidence["file"]:
        return False
    text = normalize(passage["text"])
    if "quote" in evidence:
        return normalize(evidence["quote"]) in text
    return all(normalize(value) in text for value in evidence["contains"])


def score(question, answer, passages, cited_ids):
    groups = question["evidence_groups"]
    reached = [any(supports(p, e) for p in passages for e in group) for group in groups]
    cited = [
        any(
            p["chunk_id"] in cited_ids and supports(p, e)
            for p in passages
            for e in group
        )
        for group in groups
    ]
    patterns = question["answer_patterns"]
    values = [
        bool(
            re.search(
                r"(?<![\w.-])" + re.escape(value) + r"(?![\w.])", answer, re.IGNORECASE
            )
        )
        for value in patterns
    ]
    return {
        "evidence_groups": len(groups),
        "reached": reached,
        "cited": cited,
        "all_evidence_reached": all(reached) if groups else None,
        "all_evidence_cited": all(cited) if groups else None,
        "answer_values_present": all(values) if patterns else None,
        "answer_value_matches": values,
        "needs_manual_grade": not patterns,
    }


def run(root, args):
    api = "http://127.0.0.1:8082"
    corpus = root / "corpus"
    workspaces = json.loads((corpus / "workspaces.json").read_text())
    questions = json.loads((corpus / "questions.json").read_text())
    questions = [
        q for q in questions if args.split == "all" or q["split"] == args.split
    ]
    if args.ids:
        ids = set(args.ids.split(","))
        questions = [q for q in questions if q["id"] in ids]
    variants = args.variants.split(",")
    assert all(v in CONDITIONS for v in variants)
    out = root / args.output
    done_keys = set()
    if out.exists():
        done_keys = {
            (r["id"], r["variant"], r["repeat"])
            for r in (json.loads(line) for line in out.read_text().splitlines())
            if getattr(args, "skip_attempted", False) or r.get("status") == "complete"
        }
    plan = [(q, v, i) for i in range(args.repeats) for q in questions for v in variants]
    random.Random(20260905).shuffle(plan)
    for q, v, i in plan:
        if (q["id"], v, i) in done_keys:
            continue
        (root / "variant.json").write_text(json.dumps(dict(name=v, **CONDITIONS[v])))
        ws = workspaces[q["workspace"]]["id"]
        conversation = request(
            api + f"/api/workspaces/{ws}/conversations",
            {"title": f"eval {q['id']} {v} {i}"},
        )
        started = time.monotonic()
        req = urllib.request.Request(
            api + f"/api/workspaces/{ws}/chat/stream",
            data=json.dumps(
                {"conversationId": conversation["id"], "text": q["q"]}
            ).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        events = []
        try:
            with urllib.request.urlopen(req, timeout=240) as stream:
                for raw in stream:
                    if raw.startswith(b"data: "):
                        events.append(json.loads(raw[6:]))
        except urllib.error.HTTPError as exc:
            events.append(
                {
                    "type": "error",
                    "code": exc.code,
                    "message": exc.read().decode()[:1000],
                }
            )
        elapsed = time.monotonic() - started
        start = next((e for e in events if e["type"] == "start"), {})
        complete = next((e for e in reversed(events) if e["type"] == "done"), {})
        msg_id = start.get("messageId")
        blocks = [
            e["blockId"]
            for e in events
            if e["type"] == "block_end" and e.get("kind") == "answer"
        ]
        answer = "".join(
            e.get("text", "")
            for e in events
            if e["type"] == "block_delta" and blocks and e.get("blockId") == blocks[-1]
        )
        calls = []
        evidence_file = root / "tool-evidence.jsonl"
        if evidence_file.exists() and msg_id:
            calls = [
                r
                for r in (
                    json.loads(line) for line in evidence_file.read_text().splitlines()
                )
                if r["message_id"] == msg_id
            ]
        passages = [p for c in calls for p in c["passages"]]
        citations_event = next(
            (e for e in reversed(events) if e["type"] == "citations"), {}
        )
        citations = citations_event.get("citations", [])
        numbers = {int(n) for n in re.findall(r"\[(\d{1,3})\]", answer)}
        cited_ids = {
            c.get("chunkId") for n, c in enumerate(citations, 1) if n in numbers
        }
        result = {
            "id": q["id"],
            "category": q["category"],
            "split": q["split"],
            "workspace": q["workspace"],
            "variant": v,
            "repeat": i,
            "question": q["q"],
            "gold_answer": q["answer"],
            "message_id": msg_id,
            "conversation_id": conversation["id"],
            "model": start,
            "status": complete.get("status"),
            "elapsed_s": round(elapsed, 3),
            "answer": answer,
            "score": score(q, answer, passages, cited_ids),
            "calls": calls,
            "citations": citations,
            "events": events,
            "errors": [e for e in events if e["type"] == "error"],
        }
        with out.open("a") as stream:
            stream.write(json.dumps(result, ensure_ascii=False) + "\n")
        print(
            q["id"],
            v,
            i,
            result["status"],
            f"{elapsed:.1f}s",
            json.dumps(result["score"]),
            "errors=" + json.dumps(result["errors"]),
            flush=True,
        )
        if result["errors"]:
            raise RuntimeError(
                "Stopped on infrastructure/model error; inspect the saved record before retrying."
            )
        time.sleep(max(0, 5 - elapsed))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--variants", required=True)
    parser.add_argument(
        "--split", choices=["development", "holdout", "all"], required=True
    )
    parser.add_argument("--repeats", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ids")
    run_args = parser.parse_args()
    run(run_args.root, run_args)
