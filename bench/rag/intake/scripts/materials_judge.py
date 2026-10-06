"""Judge the materials the three arms built: per-claim fidelity and blind pairwise preference.

Inputs are the run outputs `reports/local/2026-10-intake-eval/<arm>/<request>[-r2].json`
written by run_requests.py. `fidelity` resolves each material's excerpt ids to
book pages through the arm's library (scratch for B, live through the tunnel
for A and C), renders those pages and asks the judge for a verdict on every
checkable claim. `pairwise` shows the same request's materials from two arms
in a random First/Second order and asks which serves the learner better.
Prompts are frozen in bench/rag/intake/fixtures/materials-*.txt; the judge is
Claude Opus 5.5 at medium effort through the CLI. Both commands are resumable.

    uv run --project pipeline --with pymupdf==1.28.2 python bench/rag/intake/scripts/materials_judge.py fidelity [--arm A] [--limit N]
    uv run --project pipeline python bench/rag/intake/scripts/materials_judge.py pairwise [--limit N]
    uv run --project pipeline python bench/rag/intake/scripts/materials_judge.py pairwise --model claude-sonnet-5-5 --sample 0.2
    uv run --project pipeline python bench/rag/intake/scripts/materials_judge.py locator
    uv run --project pipeline python bench/rag/intake/scripts/materials_judge.py chapters
    uv run --project pipeline python bench/rag/intake/scripts/materials_judge.py summary

The second rater (`pairwise --model ... --sample`) rates a seeded share of the
pairs into judge/pairwise-<model>/; `locator` judges whether the first place
each run read in the library is on topic; `chapters` judges the notes of each
generic request as a set and records the run's mechanical counts (materials
before the confirmation turn, input tokens per material, compactions, ledger).
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import claude_headless  # noqa: E402

EVAL = ROOT / "bench/rag/reports/local/2026-10-intake-eval"
JUDGE = EVAL / "judge"
FIXTURES = ROOT / "bench/rag/intake/fixtures"
MODEL, EFFORT = "claude-opus-5-5", "medium"
ARMS = ("A", "B", "C")
PAIRS = (("A", "B"), ("A", "C"))
SCRATCH = "postgresql://postgres:intake@127.0.0.1:15445/capy_library"
PAGE_CAP = 10
TEXT_CAP = 40_000

FIDELITY_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["claims", "summary"],
    "properties": {
        "claims": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["claim", "kind", "verdict", "page", "reason"],
                "properties": {
                    "claim": {"type": "string"},
                    "kind": {"type": "string", "enum": ["definition", "formula", "number", "rule", "arithmetic", "quiz_answer", "flashcard", "other"]},
                    "verdict": {"type": "string", "enum": ["supported", "wrong", "unsupported"]},
                    "page": {"type": "integer"},
                    "reason": {"type": "string"},
                },
            },
        },
        "summary": {"type": "string"},
    },
}
CHOICE = {"type": "string", "enum": ["first", "second", "tie"]}
PAIRWISE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["coherence", "completeness", "level_fit", "overall", "reasons"],
    "properties": {"coherence": CHOICE, "completeness": CHOICE, "level_fit": CHOICE, "overall": CHOICE, "reasons": {"type": "string"}},
}


def live_url() -> str:
    from dotenv import dotenv_values

    url = dotenv_values(ROOT / ".env.local").get("LIBRARY_DATABASE_URL")
    if not url:
        raise SystemExit("LIBRARY_DATABASE_URL is not in .env.local")
    parts = urlsplit(url)
    credentials = f"{parts.username}:{parts.password}@" if parts.username else ""
    return urlunsplit(parts._replace(netloc=f"{credentials}127.0.0.1:15433"))


def outputs(arm: str) -> list[Path]:
    return sorted((EVAL / arm).glob("*.json")) if (EVAL / arm).exists() else []


def materials_of(output: dict) -> list[dict]:
    return [m for turn in output["turns"] for m in (turn.get("materials") or [])]


def material_text(materials: list[dict]) -> str:
    parts = [f"# [{m['kind']}] {m['title']}\n\n{m.get('content') or ''}" for m in materials]
    text = "\n\n---\n\n".join(parts)
    return text if len(text) <= TEXT_CAP else text[:TEXT_CAP] + "\n\n[cut at the judge's length cap]"


def excerpt_pages(conn, excerpt_ids: list[str]) -> dict[str, list[int]]:
    """{book_id: sorted pages} for the excerpts, from library_excerpts."""
    rows = conn.execute("SELECT book_id, pages FROM library_excerpts WHERE id = ANY(%s)", (excerpt_ids,)).fetchall()
    by_book: dict[str, set[int]] = {}
    for book, pages in rows:
        by_book.setdefault(book, set()).update(int(p) for p in pages or [])
    return {b: sorted(p) for b, p in by_book.items()}


def render(pdf: Path, page: int, target: Path) -> None:
    import fitz

    if target.exists():
        return
    with fitz.open(pdf) as doc:
        p = doc[page - 1]
        scale = 1568 / max(p.rect.width, p.rect.height)
        p.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(target, output="jpeg", jpg_quality=85)


def pick_pages(pages: list[int]) -> list[int]:
    if len(pages) <= PAGE_CAP:
        return pages
    step = len(pages) / PAGE_CAP
    return sorted({pages[int(i * step)] for i in range(PAGE_CAP)})


def fidelity(arm: str | None, limit: int | None) -> None:
    import psycopg

    manifest = {b["id"]: b for b in json.loads((ROOT / "lab/knowledge/books.json").read_text(encoding="utf-8"))["books"]}
    system = (FIXTURES / "materials-fidelity-prompt.txt").read_text(encoding="utf-8")
    conns: dict[str, object] = {}
    done = 0
    for a in [arm] if arm else ARMS:
        for path in outputs(a):
            output = json.loads(path.read_text(encoding="utf-8"))
            for i, material in enumerate(materials_of(output)):
                verdict_path = JUDGE / "fidelity" / a / f"{path.stem}-{i}.json"
                if verdict_path.exists() and json.loads(verdict_path.read_text(encoding="utf-8")).get("value"):
                    continue
                if a not in conns:
                    conns[a] = psycopg.connect(SCRATCH if a == "B" else live_url())
                pages_by_book = excerpt_pages(conns[a], material.get("excerpt_ids") or []) if material.get("excerpt_ids") else {}
                content: list[dict] = []
                shown = []
                for book, pages in pages_by_book.items():
                    pdf = ROOT / manifest[book]["pdf_path"]
                    for page in pick_pages(pages):
                        image = JUDGE / "pages" / book / f"p{page:04d}.jpg"
                        image.parent.mkdir(parents=True, exist_ok=True)
                        render(pdf, page, image)
                        content.append({"type": "text", "text": f"[{manifest[book]['title']}, PDF page {page}]"})
                        content.append(claude_headless.image_block(image))
                        shown.append({"book": book, "page": page})
                text = f"Request: {output['turns'][0]['question']}\n\nMaterial ({material['kind']}): {material['title']}\n\n{material.get('content') or ''}"
                if material.get("questions"):
                    text += "\n\nQuiz questions (structured):\n" + json.dumps(material["questions"], ensure_ascii=False)[:8000]
                if material.get("cards"):
                    text += "\n\nFlashcards (structured):\n" + json.dumps(material["cards"], ensure_ascii=False)[:4000]
                if not shown:
                    text += "\n\n[No cited pages could be resolved for this material; every claim is unsupported unless it is self-evident arithmetic.]"
                content.insert(0, {"type": "text", "text": text[:TEXT_CAP]})
                outcome = claude_headless.call(system, content, FIDELITY_SCHEMA, model=MODEL, effort=EFFORT)
                outcome.update(arm=a, output=path.name, material=material["id"], kind=material["kind"], title=material["title"], pages_shown=shown, pages_cited={b: len(p) for b, p in pages_by_book.items()})
                verdict_path.parent.mkdir(parents=True, exist_ok=True)
                verdict_path.write_text(json.dumps(outcome, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
                v = outcome["value"]
                print(json.dumps({"arm": a, "output": path.name, "material": i, "ok": v is not None, "claims": len(v["claims"]) if v else None, "seconds": outcome["seconds"]}), flush=True)
                done += 1
                if limit and done >= limit:
                    return


def pairwise(limit: int | None, seed: int, model: str = MODEL, sample: float | None = None) -> None:
    """Blind pairwise verdicts; with ``model``/``sample`` a second rater on a seeded share of the pairs."""
    system = (FIXTURES / "materials-pairwise-prompt.txt").read_text(encoding="utf-8")
    out_dir = JUDGE / ("pairwise" if model == MODEL else f"pairwise-{model}")
    done = 0
    for first_arm, second_arm in PAIRS:
        for path in outputs(first_arm):
            other = EVAL / second_arm / path.name
            if not other.exists():
                continue
            if sample is not None and random.Random(f"{seed}:{path.stem}:{first_arm}{second_arm}:sample").random() >= sample:
                continue
            verdict_path = out_dir / f"{first_arm}{second_arm}" / f"{path.stem}.json"
            if verdict_path.exists() and json.loads(verdict_path.read_text(encoding="utf-8")).get("value"):
                continue
            left, right = json.loads(path.read_text(encoding="utf-8")), json.loads(other.read_text(encoding="utf-8"))
            mats = {first_arm: materials_of(left), second_arm: materials_of(right)}
            order = [first_arm, second_arm]
            random.Random(f"{seed}:{path.stem}:{first_arm}{second_arm}").shuffle(order)
            labels = {"first": order[0], "second": order[1]}
            request = "\n".join(t["question"] for t in left["turns"])
            text = (
                f"Request (the learner's turns):\n{request}\n\n## First\n\n"
                + (material_text(mats[order[0]]) or "[no material was written]")
                + "\n\n## Second\n\n"
                + (material_text(mats[order[1]]) or "[no material was written]")
            )
            outcome = claude_headless.call(system, [{"type": "text", "text": text}], PAIRWISE_SCHEMA, model=model, effort=EFFORT)
            outcome.update(pair=f"{first_arm}{second_arm}", output=path.name, labels=labels, materials={a: len(m) for a, m in mats.items()})
            verdict_path.parent.mkdir(parents=True, exist_ok=True)
            verdict_path.write_text(json.dumps(outcome, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
            print(json.dumps({"pair": f"{first_arm}{second_arm}", "output": path.name, "ok": outcome["value"] is not None, "seconds": outcome["seconds"]}), flush=True)
            done += 1
            if limit and done >= limit:
                return

LOCATOR_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["on_topic", "reason"],
    "properties": {"on_topic": {"type": "string", "enum": ["yes", "partly", "no"]}, "reason": {"type": "string"}},
}
CHAPTERS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["chapters_requested", "chapters_completed", "notation_consistent", "repeated_explanations", "notes"],
    "properties": {
        "chapters_requested": {"type": "integer"},
        "chapters_completed": {"type": "integer"},
        "notation_consistent": {"type": "string", "enum": ["yes", "mostly", "no"]},
        "repeated_explanations": {"type": "integer"},
        "notes": {"type": "string"},
    },
}
NOTE_CAP = 12_000
CONTROLS = ("stat-16", "stat-24")
EXCERPT_ID = re.compile(r"\[(exc_[0-9a-f]+_\d+_v\d+)\]")


def run_record(turn: dict) -> dict:
    return json.loads((ROOT / "lab/playground/local/runs" / turn["run_id"] / "run.json").read_text(encoding="utf-8"))


def excerpt_path(conn, excerpt_id: str) -> tuple[str, str] | None:
    row = conn.execute("SELECT book_id, section_path FROM library_excerpts WHERE id = %s", (excerpt_id,)).fetchone()
    return (row[0], row[1]) if row else None


def first_read(output: dict, conn) -> dict | None:
    """The first place a run read in the library: the first section read, or for
    excerpt search the top hit of the first search (first succeeded call)."""
    calls = [c for turn in output["turns"] for c in run_record(turn)["calls"]]
    for c in calls:
        if c["name"] == "read_knowledge" and c.get("outcome") == "succeeded" and (c.get("args") or {}).get("section"):
            return {"kind": "section", "book": c["args"].get("book"), "where": c["args"]["section"], "text": (c.get("text_sent_to_model") or "")[:1500]}
    for c in calls:
        if c["name"] in ("search_knowledge", "read_knowledge") and c.get("outcome") == "succeeded":
            text = c.get("text_sent_to_model") or ""
            match = EXCERPT_ID.search(text)
            located = excerpt_path(conn, match.group(1)) if match else None
            return {"kind": c["name"], "book": located[0] if located else None, "where": located[1] if located else None, "text": text[:1500]}
    return None


def locator(arm: str | None, limit: int | None) -> None:
    import psycopg

    manifest = {b["id"]: b for b in json.loads((ROOT / "lab/knowledge/books.json").read_text(encoding="utf-8"))["books"]}
    system = (FIXTURES / "materials-locator-prompt.txt").read_text(encoding="utf-8")
    conns: dict[str, object] = {}
    done = 0
    for a in [arm] if arm else ARMS:
        for path in outputs(a):
            verdict_path = JUDGE / "locator" / a / f"{path.stem}.json"
            if verdict_path.exists() and json.loads(verdict_path.read_text(encoding="utf-8")).get("value"):
                continue
            output = json.loads(path.read_text(encoding="utf-8"))
            if a not in conns:
                conns[a] = psycopg.connect(SCRATCH if a == "B" else live_url())
            read = first_read(output, conns[a])
            if read is None:
                outcome = {"value": {"on_topic": "no", "reason": "the run read nothing from the library"}, "error": None, "usage": None, "seconds": 0, "model": None, "effort": None}
            else:
                title = manifest.get(read["book"] or "", {}).get("title") or read["book"] or "unknown book"
                text = (
                    f"Request:\n{output['turns'][0]['question']}\n\nFirst reading: {title} ({read['book']}), {read['kind']}, path: {read['where'] or 'unresolved'}\n\n"
                    f"Opening lines of what was read:\n{read['text']}"
                )
                outcome = claude_headless.call(system, [{"type": "text", "text": text}], LOCATOR_SCHEMA, model=MODEL, effort=EFFORT)
            outcome.update(arm=a, output=path.name, read=read)
            verdict_path.parent.mkdir(parents=True, exist_ok=True)
            verdict_path.write_text(json.dumps(outcome, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
            v = outcome["value"]
            print(json.dumps({"arm": a, "output": path.name, "ok": v is not None, "on_topic": v and v["on_topic"], "seconds": outcome["seconds"]}), flush=True)
            done += 1
            if limit and done >= limit:
                return


def material_costs(run: dict) -> tuple[list[dict], int]:
    """Input tokens attributed to each material in creation order (every provider
    call since the previous material), and the tokens after the last one."""
    calls, i, pending, rows = run["calls"], 0, 0, []
    for p in run["provider_calls"]:
        names = p.get("tool_calls") or []
        pending += p.get("input_tokens") or 0
        for c in calls[i : i + len(names)]:
            if c["name"] == "create_material" and c.get("outcome") == "succeeded":
                rows.append({"kind": (c.get("args") or {}).get("kind"), "title": ((c.get("args") or {}).get("title") or "")[:70], "input_tokens": pending})
                pending = 0
        i += len(names)
    return rows, pending


def mechanical(output: dict) -> dict:
    runs = [run_record(t) for t in output["turns"]]
    costs = [material_costs(r) for r in runs]
    todos = [t for r in runs for t in (r["ledger"].get("todos") or [])]
    return {
        "materials_per_turn": [len(t.get("materials") or []) for t in output["turns"]],
        "materials_before_confirmation": len(output["turns"][0].get("materials") or []) if len(output["turns"]) > 1 else None,
        "input_tokens_per_material": [row for rows, _ in costs for row in rows],
        "input_tokens_after_last_material": sum(rest for _, rest in costs),
        "compactions": sum(len(r.get("compactions") or []) for r in runs),
        "ledger_todos": len(todos),
        "ledger_open": sum(1 for t in todos if not t.get("done")),
        "inspect_failures": sum(1 for r in runs for c in r["calls"] if c["name"] == "inspect_document" and c.get("outcome") != "succeeded"),
    }


def chapters(arm: str | None, limit: int | None) -> None:
    system = (FIXTURES / "materials-chapters-prompt.txt").read_text(encoding="utf-8")
    done = 0
    for a in [arm] if arm else ARMS:
        for path in outputs(a):
            output = json.loads(path.read_text(encoding="utf-8"))
            if output.get("kind") != "generic":
                continue
            verdict_path = JUDGE / "chapters" / a / f"{path.stem}.json"
            if verdict_path.exists() and json.loads(verdict_path.read_text(encoding="utf-8")).get("value"):
                continue
            notes = [m for m in materials_of(output) if m["kind"] == "note"]
            request = "\n".join(t["question"] for t in output["turns"])
            body = "\n\n---\n\n".join(f"# {m['title']}\n\n{(m.get('content') or '')[:NOTE_CAP]}" for m in notes) or "[no note was written]"
            text = f"Request (the learner's turns):\n{request}\n\n## Notes, in the order written ({len(notes)})\n\n{body}"
            outcome = claude_headless.call(system, [{"type": "text", "text": text}], CHAPTERS_SCHEMA, model=MODEL, effort=EFFORT)
            outcome.update(arm=a, output=path.name, notes=len(notes), mechanical=mechanical(output))
            verdict_path.parent.mkdir(parents=True, exist_ok=True)
            verdict_path.write_text(json.dumps(outcome, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
            v = outcome["value"]
            print(json.dumps({"arm": a, "output": path.name, "ok": v is not None, "completed": v and f"{v['chapters_completed']}/{v['chapters_requested']}", "seconds": outcome["seconds"]}), flush=True)
            done += 1
            if limit and done >= limit:
                return


def refusal_class(error: str) -> str:
    e = error or ""
    if "Read the skills" in e:
        return "skills"
    if "not YAML" in e or "invalid material document" in e or "arguments invalid" in e:
        return "validator"
    if "todo" in e.lower() or "ledger" in e.lower():
        return "ledger"
    if "no read or retained full text" in e or "needs excerpt_ids" in e:
        return "provenance"
    return "other"


def verdicts(directory: Path) -> list[dict]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(directory.glob("*/*.json"))] if directory.exists() else []


def pairwise_tallies(directory: Path) -> dict:
    pair: dict = {}
    for d in verdicts(directory):
        v = d.get("value")
        if not v:
            continue
        p = pair.setdefault(d["pair"], {k: {} for k in ("coherence", "completeness", "level_fit", "overall")})
        for k in p:
            winner = d["labels"].get(v[k], "tie")
            p[k][winner] = p[k].get(winner, 0) + 1
    return pair


def second_rater(primary: Path, second: Path) -> dict:
    """Agreement between the two raters on the pairs both rated, per criterion."""
    first = {(d["pair"], d["output"]): d for d in verdicts(primary) if d.get("value")}
    agree = {k: {"same": 0, "rated": 0} for k in ("coherence", "completeness", "level_fit", "overall")}
    for d in verdicts(second):
        v, f = d.get("value"), first.get((d["pair"], d["output"]))
        if not v or not f:
            continue
        for k in agree:
            agree[k]["rated"] += 1
            if d["labels"].get(v[k], "tie") == f["labels"].get(f["value"][k], "tie"):
                agree[k]["same"] += 1
    for t in agree.values():
        t["share"] = round(t["same"] / t["rated"], 2) if t["rated"] else None
    return {"model": second.name.removeprefix("pairwise-"), "agreement": agree}


def summary() -> None:
    fid = {a: {"materials": 0, "claims": 0, "supported": 0, "wrong": 0, "unsupported": 0, "by_kind_wrong": {}} for a in ARMS}
    for d in verdicts(JUDGE / "fidelity"):
        v = d.get("value")
        if not v:
            continue
        t = fid[d["arm"]]
        t["materials"] += 1
        for c in v["claims"]:
            t["claims"] += 1
            t[c["verdict"]] += 1
            if c["verdict"] == "wrong":
                t["by_kind_wrong"][c["kind"]] = t["by_kind_wrong"].get(c["kind"], 0) + 1
    for t in fid.values():
        t["wrong_share"] = round(t["wrong"] / t["claims"], 3) if t["claims"] else None
        t["unsupported_share"] = round(t["unsupported"] / t["claims"], 3) if t["claims"] else None
    raters = [second_rater(JUDGE / "pairwise", p) for p in sorted(JUDGE.glob("pairwise-*")) if p.is_dir()]
    loc = {a: {} for a in ARMS}
    for d in verdicts(JUDGE / "locator"):
        if d.get("value"):
            loc[d["arm"]][d["value"]["on_topic"]] = loc[d["arm"]].get(d["value"]["on_topic"], 0) + 1
    chap = {a: [] for a in ARMS}
    for d in verdicts(JUDGE / "chapters"):
        if d.get("value"):
            m = d["mechanical"]
            chap[d["arm"]].append(
                {
                    "output": d["output"],
                    **{k: d["value"][k] for k in ("chapters_requested", "chapters_completed", "notation_consistent", "repeated_explanations")},
                    "notes": d["notes"],
                    "materials_before_confirmation": m["materials_before_confirmation"],
                    "compactions": m["compactions"],
                    "ledger_open": m["ledger_open"],
                    "input_tokens_per_material": [r["input_tokens"] for r in m["input_tokens_per_material"]],
                }
            )
    counters = {}
    for a in ARMS:
        rows = [json.loads(p.read_text(encoding="utf-8")) for p in outputs(a)]
        if not rows:
            continue
        c = counters[a] = {"runs": len(rows), "with_material": sum(1 for r in rows if materials_of(r)), "errors": sum(1 for r in rows for t in r["turns"] if t.get("error"))}
        c["materials"] = sum(len(materials_of(r)) for r in rows)
        c["materials_by_kind"] = {}
        for r in rows:
            for m in materials_of(r):
                c["materials_by_kind"][m["kind"]] = c["materials_by_kind"].get(m["kind"], 0) + 1
        for key in ("tool_calls", "input_tokens", "cached_tokens", "wall_seconds", "captures", "excerpts_read", "sections_read", "questions_copied", "questions_written"):
            vals = [r["counters"].get(key) or 0 for r in rows]
            c[key] = {"total": round(sum(vals), 1), "per_run": round(sum(vals) / len(vals), 1)}
        c["input_tokens_per_material"] = round(c["input_tokens"]["total"] / c["materials"]) if c["materials"] else None
        c["books_cited_per_run"] = round(sum(len(r["counters"].get("books_cited") or []) for r in rows) / len(rows), 2)
        writes = [w for r in rows for t in r["turns"] for w in (t.get("writes") or [])]
        c["writes"] = {"succeeded": sum(1 for w in writes if w.get("outcome") == "succeeded"), "refused": sum(1 for w in writes if w.get("outcome") == "refused"), "refused_by_class": {}}
        for w in writes:
            if w.get("outcome") == "refused":
                k = refusal_class(w.get("error") or "")
                c["writes"]["refused_by_class"][k] = c["writes"]["refused_by_class"].get(k, 0) + 1
        c["controls"] = {r["request_id"] + ("-r2" if r.get("repeat") == 2 else ""): {"materials": len(materials_of(r)), "tool_calls": r["counters"].get("tool_calls")} for r in rows if r["request_id"] in CONTROLS}
        c["generic_materials_before_confirmation"] = sum(len(r["turns"][0].get("materials") or []) for r in rows if r.get("kind") == "generic" and len(r["turns"]) > 1)
    print(json.dumps({"fidelity": fid, "pairwise": pairwise_tallies(JUDGE / "pairwise"), "second_rater": raters, "locator": loc, "chapters": chap, "counters": counters}, indent=1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["fidelity", "pairwise", "locator", "chapters", "summary"])
    parser.add_argument("--arm", choices=ARMS)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--seed", type=int, default=20261006)
    parser.add_argument("--model", default=MODEL, help="pairwise: the rater; a second model writes to judge/pairwise-<model>/")
    parser.add_argument("--sample", type=float, help="pairwise: rate only this seeded share of the pairs (the second rater's 0.2)")
    args = parser.parse_args()
    if args.command == "fidelity":
        fidelity(args.arm, args.limit)
    elif args.command == "pairwise":
        pairwise(args.limit, args.seed, args.model, args.sample)
    elif args.command == "locator":
        locator(args.arm, args.limit)
    elif args.command == "chapters":
        chapters(args.arm, args.limit)
    else:
        summary()


if __name__ == "__main__":
    main()
