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
    uv run --project pipeline python bench/rag/intake/scripts/materials_judge.py summary
"""

from __future__ import annotations

import argparse
import json
import random
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


def pairwise(limit: int | None, seed: int) -> None:
    system = (FIXTURES / "materials-pairwise-prompt.txt").read_text(encoding="utf-8")
    done = 0
    for first_arm, second_arm in PAIRS:
        for path in outputs(first_arm):
            other = EVAL / second_arm / path.name
            if not other.exists():
                continue
            verdict_path = JUDGE / "pairwise" / f"{first_arm}{second_arm}" / f"{path.stem}.json"
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
            outcome = claude_headless.call(system, [{"type": "text", "text": text}], PAIRWISE_SCHEMA, model=MODEL, effort=EFFORT)
            outcome.update(pair=f"{first_arm}{second_arm}", output=path.name, labels=labels, materials={a: len(m) for a, m in mats.items()})
            verdict_path.parent.mkdir(parents=True, exist_ok=True)
            verdict_path.write_text(json.dumps(outcome, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
            print(json.dumps({"pair": f"{first_arm}{second_arm}", "output": path.name, "ok": outcome["value"] is not None, "seconds": outcome["seconds"]}), flush=True)
            done += 1
            if limit and done >= limit:
                return


def summary() -> None:
    fid = {a: {"materials": 0, "claims": 0, "supported": 0, "wrong": 0, "unsupported": 0, "by_kind_wrong": {}} for a in ARMS}
    for path in sorted((JUDGE / "fidelity").glob("*/*.json")) if (JUDGE / "fidelity").exists() else []:
        d = json.loads(path.read_text(encoding="utf-8"))
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
    pair = {}
    for path in sorted((JUDGE / "pairwise").glob("*/*.json")) if (JUDGE / "pairwise").exists() else []:
        d = json.loads(path.read_text(encoding="utf-8"))
        v = d.get("value")
        if not v:
            continue
        p = pair.setdefault(d["pair"], {k: {} for k in ("coherence", "completeness", "level_fit", "overall")})
        for k in p:
            winner = d["labels"].get(v[k], "tie")
            p[k][winner] = p[k].get(winner, 0) + 1
    counters = {}
    for a in ARMS:
        rows = [json.loads(p.read_text(encoding="utf-8")) for p in outputs(a)]
        if not rows:
            continue
        c = counters[a] = {"runs": len(rows), "with_material": sum(1 for r in rows if materials_of(r)), "errors": sum(1 for r in rows for t in r["turns"] if t.get("error"))}
        for key in ("tool_calls", "input_tokens", "cached_tokens", "wall_seconds", "captures", "excerpts_read", "sections_read", "questions_copied", "questions_written"):
            vals = [r["counters"].get(key) or 0 for r in rows]
            c[key] = {"total": round(sum(vals), 1), "per_run": round(sum(vals) / len(vals), 1)}
        c["books_cited_per_run"] = round(sum(len(r["counters"].get("books_cited") or []) for r in rows) / len(rows), 2)
    print(json.dumps({"fidelity": fid, "pairwise": pair, "counters": counters}, indent=1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["fidelity", "pairwise", "summary"])
    parser.add_argument("--arm", choices=ARMS)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--seed", type=int, default=20261006)
    args = parser.parse_args()
    if args.command == "fidelity":
        fidelity(args.arm, args.limit)
    elif args.command == "pairwise":
        pairwise(args.limit, args.seed)
    else:
        summary()


if __name__ == "__main__":
    main()
