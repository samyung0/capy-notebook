"""Blind holdout gate: a candidate parser against the current one on PDFs the
developer has not seen.

A subagent fetches the PDFs, runs these steps and grades the packets; the
developer sees only what ``score`` prints (aggregates, no document names), so
fixes cannot be fitted to the holdout. Details stay in the run directory under
the ignored ``reports/local/``. A set that has to be opened for diagnosis is
spent: the next gate needs new PDFs.

    python holdout_gate.py parse BASE_DIR RUN/out-base RUN/pdfs/*.pdf   # parser venv
    python holdout_gate.py parse CAND_DIR RUN/out-cand RUN/pdfs/*.pdf
    python holdout_gate.py packets RUN                                  # repo venv
    (grade RUN/packets/*/*.md into RUN/review/<doc>.json with the rubric)
    python holdout_gate.py score RUN

PARSER_DIR holds a ``parser/`` copy (``git archive`` for the base); build its
``parser/java/build.sh`` first where it exists (the Java entry point). The rubric
is ``fixtures/v12-mineru-review-rubric.md``.
"""

from __future__ import annotations

import json
import random
import shutil
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ARMS = ("base", "cand")
ELEMENTS = ("formulas", "tables", "figures", "headings")
PAGE_GRADES = ("section_path", "text")
SCORE = {"good": 1.0, "partial": 0.5, "bad": 0.0, "none": 0.0}
PAGES_PER_DOC = 3


def parse(parser_dir: Path, out: Path, pdfs: list[Path]) -> None:
    sys.path.insert(0, str(parser_dir / "parser"))
    from odl.refine import parse_pdf

    times = out / "times.json"
    out.mkdir(parents=True, exist_ok=True)
    record = json.loads(times.read_text()) if times.exists() else {}
    for pdf in pdfs:
        d = out / pdf.stem
        if (d / "content_list.json").exists():
            continue
        shutil.rmtree(d, ignore_errors=True)
        (d / "work").mkdir(parents=True)
        start = time.perf_counter()
        try:
            parsed = parse_pdf(pdf.read_bytes(), d / "work", java_timeout_s=1800)
        except Exception as error:  # a crash is a gate result, not a stop
            record[pdf.stem] = {"error": type(error).__name__}
            shutil.rmtree(d)
            continue
        record[pdf.stem] = {"seconds": round(time.perf_counter() - start, 1)}
        (d / "content_list.json").write_text(
            json.dumps(parsed.content_list, ensure_ascii=False)
        )
        (d / "refinement.json").write_text(json.dumps({"furniture": parsed.furniture}))
        if parsed.parsed_pdf:
            (d / "parsed.pdf").write_bytes(parsed.parsed_pdf)
        shutil.rmtree(d / "work")
        times.write_text(json.dumps(record, indent=1))
        print(pdf.stem, record[pdf.stem], flush=True)
    times.write_text(json.dumps(record, indent=1))


def _show(block: dict) -> str:
    kind, level = block["type"], block.get("text_level")
    if kind == "image":
        caption = " ".join(block.get("image_caption") or [])
        labels = " | ".join(block.get("figure_labels") or [])
        return f"[figure] caption: {caption!r}" + (f" labels: {labels!r}" if labels else "")
    if kind == "table":
        return f"[table]\n{block.get('table_body', '')}"
    if kind == "list":
        return "[list]\n" + "\n".join(f"  - {i}" for i in block.get("list_items", []))
    if kind == "discarded":
        return f"[dropped as page furniture] {block.get('text', '')}"
    if kind == "page_number":
        return f"[dropped as page number] {block.get('text', '')}"
    if kind == "equation":
        return f"[equation] {block.get('text', '')}"
    text = block.get("text", "")
    return f"[heading L{level}] {text}" if level else f"[{kind}] {text}"


def _arm_pages(d: Path) -> tuple[dict, dict]:
    from pipeline.retrieval.headings import retain_headings
    from pipeline.retrieval.packing import pack_blocks

    blocks = json.loads((d / "content_list.json").read_text())
    furniture = json.loads((d / "refinement.json").read_text())["furniture"]
    pdf = d / "parsed.pdf" if (d / "parsed.pdf").exists() else d.parent.parent / "pdfs" / f"{d.name}.pdf"  # RUN/pdfs
    chunks = retain_headings(blocks, pdf, pack_blocks(blocks, frozenset(furniture)))
    by_page: dict[int, list] = defaultdict(list)
    chunk_pages: dict[int, list] = defaultdict(list)
    for block in blocks:
        by_page[block.get("page_idx", -1)].append(block)
    for chunk in chunks:
        for page in sorted({r.page for r in chunk.regions}):
            chunk_pages[page - 1].append(chunk)
    return by_page, chunk_pages


def packets(run: Path) -> None:
    import pymupdf

    sys.path.insert(0, str(REPO / "pipeline"))
    rng = random.Random(run.name)
    key: dict[str, dict[str, str]] = {}
    for pdf in sorted((run / "pdfs").glob("*.pdf")):
        dirs = {arm: run / f"out-{arm}" / pdf.stem for arm in ARMS}
        if not all((d / "content_list.json").exists() for d in dirs.values()):
            continue  # a crash, counted by score
        arms = {arm: _arm_pages(d) for arm, d in dirs.items()}
        with pymupdf.open(pdf) as doc:
            pages = [p for p in range(len(doc)) if len(doc[p].get_text().strip()) > 200]
            pages = pages or list(range(len(doc)))
            for p in sorted(rng.sample(pages, min(PAGES_PER_DOC, len(pages)))):
                (run / "pages" / pdf.stem).mkdir(parents=True, exist_ok=True)
                doc[p].get_pixmap(dpi=110).save(run / "pages" / pdf.stem / f"p{p + 1}.png")
                order = list(ARMS)
                rng.shuffle(order)
                key[f"{pdf.stem}:{p + 1}"] = {"A": order[0], "B": order[1]}
                parts = [f"# {pdf.stem}, PDF page {p + 1}", f"Page image: pages/{pdf.stem}/p{p + 1}.png", ""]
                for label, arm in zip("AB", order):
                    blocks, chunks = arms[arm]
                    parts.append(f"## Parser {label}: raw blocks in reading order")
                    parts += [_show(b) for b in blocks.get(p, [])] or ["(no blocks)"]
                    parts.append(f"\n## Parser {label}: indexed chunks touching this page (section path | start of text)")
                    parts += [f"- path: {c.section_path!r} | {c.text[:160]!r}" for c in chunks.get(p, [])]
                    parts.append("")
                (run / "packets" / pdf.stem).mkdir(parents=True, exist_ok=True)
                (run / "packets" / pdf.stem / f"p{p + 1}.md").write_text("\n".join(parts))
    (run / "blind_key.json").write_text(json.dumps(key, indent=1))
    print("pages", len(key))


def _structure(d: Path) -> dict:
    blocks = json.loads((d / "content_list.json").read_text())
    levels = [b["text_level"] for b in blocks if isinstance(b.get("text_level"), int) and b["text_level"] > 0]
    text = " ".join(str(b.get("text", "")) + " ".join(map(str, b.get("list_items") or [])) for b in blocks)
    return {
        "headings": len(levels),
        "max_level": max(levels, default=0),
        "private_use": sum(0xE000 <= ord(c) <= 0xF8FF for c in text),
    }


def _bootstrap(per_doc: dict[str, list[float]], rounds: int = 2000) -> tuple[float, float, float]:
    """Mean candidate-minus-base difference per graded element, with a 95%
    interval from resampling documents (pages of one document are not
    independent)."""
    docs = [v for v in per_doc.values() if v]
    flat = [x for v in docs for x in v]
    if not flat:
        return 0.0, 0.0, 0.0
    rng = random.Random(0)
    means = []
    for _ in range(rounds):
        sample = [x for _ in docs for x in rng.choice(docs)]
        means.append(sum(sample) / len(sample))
    means.sort()
    return sum(flat) / len(flat), means[int(0.025 * rounds)], means[int(0.975 * rounds)]


def score(run: Path) -> None:
    key = json.loads((run / "blind_key.json").read_text())
    diffs: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    tally: dict[str, Counter] = defaultdict(Counter)
    means: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    false: dict[str, Counter] = {arm: Counter() for arm in ARMS}
    doc_total: dict[str, float] = defaultdict(float)
    missing = 0
    for page_id, labels in key.items():
        doc, page = page_id.rsplit(":", 1)
        review = run / "review" / f"{doc}.json"
        graded = {str(g["page"]): g for g in json.loads(review.read_text())} if review.exists() else {}
        if page not in graded:
            missing += 1
            continue
        g = graded[page]
        arm_of = {labels["A"]: "A", labels["B"]: "B"}
        pairs = [(kind, el.get(arm_of["base"]), el.get(arm_of["cand"])) for kind in ELEMENTS for el in g.get(kind, [])]
        pairs += [(kind, g.get(arm_of["base"], {}).get(kind), g.get(arm_of["cand"], {}).get(kind)) for kind in PAGE_GRADES]
        for kind, base, cand in pairs:
            if base not in SCORE or cand not in SCORE:
                continue
            d = SCORE[cand] - SCORE[base]
            diffs[kind][doc].append(d)
            doc_total[doc] += d
            tally[kind]["win" if d > 0 else "loss" if d < 0 else "tie"] += 1
            means[kind]["base"].append(SCORE[base])
            means[kind]["cand"].append(SCORE[cand])
        for arm in ARMS:
            side = g.get(arm_of[arm], {})
            false[arm]["headings"] += side.get("false_headings", 0) or 0
            false[arm]["tables"] += side.get("false_tables", 0) or 0

    print(f"pages graded {len(key) - missing}/{len(key)}, documents {len({k.rsplit(':', 1)[0] for k in key})}")
    print(f"{'element':13s} {'n':>4s} {'base':>5s} {'cand':>5s}  win/tie/loss   diff [95% CI]")
    for kind in (*ELEMENTS, *PAGE_GRADES):
        n = len(means[kind]["base"])
        if not n:
            continue
        mean, low, high = _bootstrap(diffs[kind])
        t = tally[kind]
        print(
            f"{kind:13s} {n:4d} {sum(means[kind]['base']) / n:5.2f} {sum(means[kind]['cand']) / n:5.2f}  "
            f"{t['win']:3d}/{t['tie']:3d}/{t['loss']:3d}   {mean:+.2f} [{low:+.2f}, {high:+.2f}]"
        )
    print(f"false headings base {false['base']['headings']} cand {false['cand']['headings']}; "
          f"false tables base {false['base']['tables']} cand {false['cand']['tables']}")
    print(f"documents worse overall {sum(v < 0 for v in doc_total.values())}, "
          f"better {sum(v > 0 for v in doc_total.values())}, same {sum(v == 0 for v in doc_total.values())}")

    times = {arm: json.loads((run / f"out-{arm}" / "times.json").read_text()) for arm in ARMS}
    crashes = {arm: sum("error" in v for v in times[arm].values()) for arm in ARMS}
    both = [d for d in times["base"] if "seconds" in times["base"][d] and "seconds" in times["cand"].get(d, {})]
    ratios = sorted(times["cand"][d]["seconds"] / max(times["base"][d]["seconds"], 0.1) for d in both)
    total = sum(times["cand"][d]["seconds"] for d in both) / max(sum(times["base"][d]["seconds"] for d in both), 0.1)
    print(f"crashes base {crashes['base']} cand {crashes['cand']}; time cand/base total {total:.2f}, "
          f"median {ratios[len(ratios) // 2] if ratios else 0:.2f}, max {ratios[-1] if ratios else 0:.2f}")
    structure = {arm: [_structure(run / f"out-{arm}" / d) for d in both] for arm in ARMS}
    for field in ("headings", "max_level", "private_use"):
        base = sum(s[field] for s in structure["base"])
        cand = sum(s[field] for s in structure["cand"])
        print(f"{field:12s} base {base} cand {cand}")


if __name__ == "__main__":
    command, *rest = sys.argv[1:]
    if command == "parse":
        parse(Path(rest[0]), Path(rest[1]), [Path(p) for p in rest[2:]])
    elif command == "packets":
        packets(Path(rest[0]))
    elif command == "score":
        score(Path(rest[0]))
    else:
        raise SystemExit(__doc__)
