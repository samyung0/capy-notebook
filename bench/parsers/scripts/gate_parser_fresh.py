"""Fresh-parse gate: the same sources through two running parser services.

``parse`` sends each source to every ``--arm NAME=URL`` over the multipart
``/file_parse`` route (bearer token from ``PARSER_TOKEN_<NAME>``), one document
at a time per arm, arms in parallel. It keeps the final blocks, the frozen
furniture and Office page evidence under ``--output/<arm>/<id>/``. A finished
document is skipped on rerun. The multipart route does not return a
font-repaired ``parsed.pdf``, so both arms measure against the original PDF.

``compare`` packs both arms with the production chunker. For each document it
reports:

- body retention (``evaluate_unseen_headings.compare_body``);
- outline anchors: headings whose title matches an outline entry on their
  page;
- outline roots at level 1;
- banner and boundary counts;
- the gold witnesses;
- ancestry: for every body block both arms emit, the heading components one
  arm has and the other lacks. A lost component that is still a heading counts
  as lost ancestry; outline-confirmed when an outline entry with its title
  spans the body block's page. A book-title heading (parser v10) closes the
  stack without entering it, counts as its own lost class, and stays out of
  anchors and roots.

``deck`` writes a numbered-title variant of a PPTX: every slide title after
the cover gains a section number that advances when the title changes, and
one run of repeated titles ends in ``Step N`` instead.

    PARSER_TOKEN_V5=... PARSER_TOKEN_V6=... uv run --project pipeline python \
      bench/parsers/scripts/gate_parser_fresh.py parse --manifest gate.json \
      --arm v5=http://127.0.0.1:18092 --arm v6=http://127.0.0.1:18091 --output OUT
    uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py \
      compare --manifest gate.json --output OUT [--measure-dir DIR]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [
    str(REPO / "parser"),
    str(REPO / "pipeline"),
    str(Path(__file__).parent),
]


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ------------------------------------------------------------------ parse


def parse_arm(name: str, url: str, sources: list[dict], output: Path) -> None:
    import httpx

    token = os.environ[f"PARSER_TOKEN_{name.upper()}"]
    version = httpx.get(f"{url}/healthz", timeout=30).json()["parser_version"]
    for source in sources:
        folder = output / name / source["id"]
        if (folder / "result.json").exists():
            continue
        path = REPO / source["path"]
        started = time.perf_counter()
        response = httpx.post(
            f"{url}/file_parse",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": (path.name, path.read_bytes())},
            data={"filename": path.name},
            timeout=httpx.Timeout(2400, connect=30),
        )
        seconds = time.perf_counter() - started
        if response.status_code != 200:
            print(
                name,
                source["id"],
                "FAILED",
                response.status_code,
                response.text[:200],
                flush=True,
            )
            continue
        result = response.json()
        write(folder / "content_list.json", result["content_list"])
        refinement = {"furniture": result["_furniture"]}
        if result.get("_page_evidence") is not None:
            refinement["page_evidence"] = result["_page_evidence"]
        write(folder / "refinement.json", refinement)
        write(
            folder / "result.json",
            {
                "id": source["id"],
                "parser_version": version,
                "source_sha256": sha256(path),
                "pages": result["_page_count"],
                "ocr_pages": len(result["_ocr_pages"]),
                "blocks": len(result["content_list"]),
                "server_parse_s": result.get("_server_parse_s"),
                "wall_s": round(seconds, 1),
            },
        )
        print(
            name,
            source["id"],
            result["_page_count"],
            "pages",
            round(seconds),
            "s",
            flush=True,
        )


# ------------------------------------------------------------------ compare


def key(block: dict) -> tuple:
    return (
        block.get("page_idx"),
        tuple(block.get("bbox") or []),
        str(block.get("text") or ""),
    )


def heading(block: dict) -> bool:
    level = block.get("text_level")
    return block.get("type") == "text" and type(level) is int and level > 0


def book_title(block: dict) -> bool:
    """A title-page heading the parser marked (v10): never a path component."""
    return heading(block) and block.get("_source_role") == "book-title"


def chunks_for(blocks: list[dict], folder: Path, source: Path):
    from pipeline.retrieval.headings import retain_headings
    from pipeline.retrieval.packing import pack_blocks

    refinement = read(folder / "refinement.json")
    chunks = pack_blocks(blocks, frozenset(refinement["furniture"]))
    evidence = refinement.get("page_evidence")
    if evidence is not None:
        return retain_headings(
            blocks, source, chunks, verified=set(evidence["visible_headings"])
        )
    return retain_headings(blocks, source, chunks)


def stacks(blocks: list[dict], furniture: frozenset) -> dict[int, list[int]]:
    """The chunker's heading stack (block indices) in front of each body block."""
    from pipeline.retrieval.chunking import _heading_boundary_level, _is_furniture

    stack: list[tuple[int, int]] = []
    paths = {}
    for index, block in enumerate(blocks):
        if _is_furniture(block, furniture):
            continue
        boundary = _heading_boundary_level(block)
        if boundary is None and book_title(block):
            boundary = block["text_level"]
        if boundary is not None:
            while stack and stack[-1][1] >= boundary:
                stack.pop()
            if not book_title(block):
                continue
        if book_title(block):
            paths[index] = [i for i, _ in stack]  # its text stays in the chunk
        elif heading(block) and str(block.get("text") or "").strip():
            while stack and stack[-1][1] >= block["text_level"]:
                stack.pop()
            stack.append((index, block["text_level"]))
        elif block.get("type") == "text" and str(block.get("text") or "").strip():
            paths[index] = [i for i, _ in stack]
    return paths


def outline_spans(document) -> list[tuple[str, int, int]]:
    """(title key, first page, last page) of every outline entry, 0-based."""
    from odl.headings import _outline_title

    toc = [row for row in document.get_toc() if row[2] > 0]
    spans = []
    for position, (level, title, page) in enumerate(toc):
        end = len(document)
        for later in toc[position + 1 :]:
            if later[0] <= level:
                end = later[2]
                break
        spans.append((_outline_title(title), page - 1, end - 1))
    return spans


def ancestry(old: list[dict], new: list[dict], furniture: tuple, spans) -> dict:
    from odl.headings import _outline_title

    old_paths, new_paths = stacks(old, furniture[0]), stacks(new, furniture[1])
    new_index = {key(b): i for i, b in enumerate(new)}
    old_index = {key(b): i for i, b in enumerate(old)}
    counts, examples = Counter(), defaultdict(list)

    def confirmed(block, body_page):
        title = _outline_title(str(block.get("text") or ""))
        return any(
            t == title and first <= body_page <= last for t, first, last in spans
        )

    for index, path in old_paths.items():
        other = new_index.get(key(old[index]))
        if other is None or other not in new_paths:
            continue
        counts["body_blocks"] += 1
        before = {key(old[i]) for i in path}
        after = {key(new[i]) for i in new_paths[other]}
        page = old[index]["page_idx"]
        for lost in before - after:
            target = new[new_index[lost]] if lost in new_index else None
            if target is not None and book_title(target):
                counts["lost_book_title"] += 1
                continue
            if target is None or not heading(target):
                counts["lost_removed_artefact"] += 1
                continue
            label = (
                "lost_heading_outline"
                if confirmed(target, page)
                else "lost_heading_other"
            )
            counts[label] += 1
            if len(examples[label]) < 5:
                examples[label].append(
                    {
                        "page": page + 1,
                        "lost": lost[2][:60],
                        "body": old[index]["text"][:60],
                    }
                )
        for gained in after - before:
            source = old[old_index[gained]] if gained in old_index else None
            label = (
                "gained_outline"
                if confirmed(new[new_index[gained]], page)
                else "gained_other"
            )
            if source is not None and not heading(source):
                label = "gained_restored_heading"
            counts[label] += 1
            if len(examples[label]) < 5:
                examples[label].append(
                    {
                        "page": page + 1,
                        "gained": gained[2][:60],
                        "body": old[index]["text"][:60],
                    }
                )
        counts["body_blocks_changed"] += before != after
    return {"counts": dict(counts), "examples": dict(examples)}


def anchors_and_roots(old: list[dict], new: list[dict], document) -> dict:
    from odl.headings import _outline_title

    titles = {
        (page - 1, _outline_title(t)): level
        for level, t, page in document.get_toc()
        if page > 0
    }
    new_by_key = {key(b): b for b in new}
    result = Counter()
    lost = []
    for block in old:
        level = titles.get(
            (block.get("page_idx"), _outline_title(str(block.get("text") or "")))
        )
        after = new_by_key.get(key(block))
        if level is None or not heading(block) or (after and book_title(after)):
            continue
        result["anchors"] += 1
        if after is not None and heading(after):
            result["anchors_retained"] += 1
        else:
            lost.append(block["text"][:60])
        if level == 1 and block["text_level"] == 1:
            result["roots_v5"] += 1
            result["roots_retained"] += (
                after is not None and after.get("text_level") == 1
            )
    result["roots_v6"] = sum(
        heading(b)
        and not book_title(b)
        and b["text_level"] == 1
        and titles.get((b.get("page_idx"), _outline_title(b["text"]))) == 1
        for b in new
    )
    return {**result, "lost_anchor_texts": lost[:10]}


def banners(blocks: list[dict]) -> dict:
    roles = Counter(b.get("_source_role") for b in blocks if b.get("_source_role"))
    return {
        "running_banners": roles["running-banner"],
        "bullet_items": roles["bullet-item"],
        "boundaries": sum(bool(b.get("_heading_boundary_level")) for b in blocks),
        "page_numbers": sum(b.get("type") == "page_number" for b in blocks),
        "headings": sum(heading(b) for b in blocks),
    }


def witness(blocks: list[dict], chunks, case: dict, scale: tuple[float, float]) -> dict:
    """Blocks under a gold witness box and the path of prose after it."""
    x0, y0, x1, y1 = case["bbox"]
    box = [x0 * scale[0], y0 * scale[1], x1 * scale[0], y1 * scale[1]]
    page = case["page"] - 1
    under = [
        (
            b.get("type"),
            b.get("text_level"),
            b.get("_source_role"),
            str(b.get("text") or "")[:50],
        )
        for b in blocks
        if b.get("page_idx") == page
        and len(b.get("bbox") or []) == 4
        and b["bbox"][0] < box[2]
        and b["bbox"][2] > box[0]
        and b["bbox"][1] < box[3]
        and b["bbox"][3] > box[1]
    ]
    anchor = case.get("following_text_anchor")
    paths = sorted(
        {
            c.section_path
            for c in chunks
            if (anchor and anchor in c.text)
            or (
                not anchor
                and any(
                    r.page == case["page"] and r.bbox[1] >= box[1] for r in c.regions
                )
            )
        }
    )[:3]
    return {"blocks": under, "paths": paths}


def score_scope(case: dict, state: dict) -> str:
    paths = state["paths"]
    if not paths:
        return "unmeasured"
    required = case["required_section_ancestor"].casefold()
    forbidden = [f.casefold() for f in case["forbidden_section_ancestors"]]
    ok = all(
        required in p.casefold() and not any(f in p.casefold() for f in forbidden)
        for p in paths
    )
    return "pass" if ok else "fail"


def measure_book(
    book_id: str, arm: Path, blocks: list[dict], chunks, measure_dir: Path
) -> int:
    """Wrong-path chunks with the section-path investigation's measure.py."""
    sys.path.insert(0, str(measure_dir))
    import books as intake
    import measure

    book = next(b for b in intake.books() if b["id"] == book_id)
    saved = read(book["dir"] / "corpus.json")
    corpus = {
        "book": saved["book"],
        "chunks": [
            {
                "id": f"c{i}",
                "excerpt_id": f"c{i}",
                "section_path": c.section_path,
                "regions": [{"page": r.page, "bbox": r.bbox} for r in c.regions],
                "page_start": c.page_start,
            }
            for i, c in enumerate(chunks)
        ],
    }
    (arm / "parsed").mkdir(exist_ok=True)
    (arm / "parsed/refinement.json").write_bytes((arm / "refinement.json").read_bytes())
    # measure.py pushes every text_level block; a book title closes the stack
    # as a banner boundary does, which is how it reads the chunker's rule.
    blocks = [
        {
            **{k: v for k, v in b.items() if k != "text_level"},
            "type": "discarded",
            "_source_role": "running-banner",
            "_heading_boundary_level": b["text_level"],
        }
        if book_title(b)
        else b
        for b in blocks
    ]
    measure.load = lambda _: (corpus, blocks)
    return measure.measure({**book, "dir": arm})["wrong_chunks"]


def compare(args) -> None:
    import pymupdf
    from evaluate_unseen_headings import compare_body

    manifest = read(args.manifest)
    gold = defaultdict(list)
    for path in args.gold:
        for case in read(path)["cases"]:
            gold[case["source_id"]].append(case)
    report = {}
    for source in manifest["sources"]:
        folders = [args.output / arm / source["id"] for arm in args.arms]
        if not all((f / "result.json").exists() for f in folders):
            continue
        path = REPO / source["path"]
        blocks = [read(f / "content_list.json") for f in folders]
        furniture = tuple(
            frozenset(read(f / "refinement.json")["furniture"]) for f in folders
        )
        chunks = [chunks_for(b, f, path) for b, f in zip(blocks, folders)]
        row = {
            "pages": read(folders[1] / "result.json")["pages"],
            "blocks_equal_length": len(blocks[0]) == len(blocks[1]),
            "chunks": [len(c) for c in chunks],
            "v5": banners(blocks[0]),
            "v6": banners(blocks[1]),
        }
        body = compare_body(blocks[0], blocks[1], chunks[0], chunks[1])
        row["body"] = {
            k: body[k]
            for k in (
                "baseline_source_bound_literal_covered",
                "candidate_source_bound_literal_covered",
                "newly_missing_source_bound_text_count",
                "citation_geometry_or_grouping_changed_count",
            )
        }
        # A missing unit is expected when v6 removed that very block as a
        # banner or page number; anything else is unexplained.
        v6_at = {
            (b.get("page_idx", -1) + 1, tuple(b.get("bbox") or [])): b
            for b in blocks[1]
        }
        missing = Counter()
        for unit in body["newly_missing_covered_units"]:
            if unit["classification"] != "newly_missing_source_bound_text":
                continue
            after = v6_at.get((unit["page"], tuple(unit["bbox"] or [])), {})
            removed = after.get("type") in ("discarded", "page_number")
            missing["removed_banner_or_folio" if removed else "unexplained"] += 1
            if not removed:
                row["body"].setdefault("unexplained_examples", []).append(
                    unit["text"][:80]
                )
        row["body"]["missing"] = dict(missing)
        # Banners v5 removed that v6 keeps as headings, by margin.
        restored = Counter()
        v6_by_key = {key(b): b for b in blocks[1]}
        for block in blocks[0]:
            after = v6_by_key.get(key(block))
            if (
                block.get("_source_role") == "running-banner"
                and after
                and heading(after)
            ):
                restored["top" if block["bbox"][3] < 100 else "bottom"] += 1
        row["v5_banners_kept_as_headings"] = dict(restored)
        if path.suffix.lower() == ".pdf":
            with pymupdf.open(path) as document:
                row["outline"] = anchors_and_roots(blocks[0], blocks[1], document)
                row["ancestry"] = ancestry(
                    blocks[0], blocks[1], furniture, outline_spans(document)
                )
                # Both gold sets use PDF points, top-left, 1-based pages.
                for case in gold.get(source["id"], []):
                    rect = document[case["page"] - 1].rect
                    scale = (1000 / rect.width, 1000 / rect.height)
                    states = [
                        witness(b, c, case, scale) for b, c in zip(blocks, chunks)
                    ]
                    entry = {
                        "changed": states[0] != states[1],
                        "v5": states[0],
                        "v6": states[1],
                    }
                    if "required_section_ancestor" in case:
                        entry["verdict"] = [score_scope(case, s) for s in states]
                    row.setdefault("gold", {})[case["id"]] = entry
        else:
            row["ancestry"] = ancestry(blocks[0], blocks[1], furniture, [])
        if source.get("book") and args.measure_dir:
            row["wrong_chunks"] = [
                measure_book(source["id"], f, b, c, args.measure_dir)
                for f, b, c in zip(folders, blocks, chunks)
            ]
        report[source["id"]] = row
        print(
            source["id"][:36].ljust(36),
            "body-missing",
            row["body"]["missing"],
            "v5-banners-kept",
            row["v5_banners_kept_as_headings"],
            "anchors",
            row.get("outline", {}).get("anchors_retained"),
            "/",
            row.get("outline", {}).get("anchors"),
            "roots",
            row.get("outline", {}).get("roots_v5"),
            "->",
            row.get("outline", {}).get("roots_v6"),
            "ancestry",
            row["ancestry"]["counts"],
            "wrong",
            row.get("wrong_chunks"),
            flush=True,
        )
    write(args.output / f"compare-{args.arms[0]}-{args.arms[1]}.json", report)


# ------------------------------------------------------------------ deck


def deck(args) -> None:
    """Numbered-title variant of a real deck, for the numbered-slide guard."""
    with (
        zipfile.ZipFile(args.source) as source,
        zipfile.ZipFile(args.target, "w", zipfile.ZIP_DEFLATED) as target,
    ):
        slides = sorted(
            (
                n
                for n in source.namelist()
                if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)
            ),
            key=lambda n: int(re.findall(r"\d+", n)[0]),
        )
        shape = re.compile(
            r'<p:sp>(?:(?!</p:sp>).)*?type="(?:title|ctrTitle)"(?:(?!</p:sp>).)*?</p:sp>',
            re.DOTALL,
        )
        edits, section, previous, step = {}, 0, None, 0
        for name in slides[args.skip :]:
            title = shape.search(source.read(name).decode("utf-8"))
            runs = list(re.finditer(r"<a:t>([^<]*)</a:t>", title[0])) if title else []
            if not runs:
                continue
            label = runs[0][1]
            step = (
                step + 1
                if args.step_title in label and label == previous
                else int(args.step_title in label)
            )
            section += label != previous
            # (run to replace, new text): a trailing Step N, else a leading section number
            edits[name] = (
                (runs[-1], f"{runs[-1][1]} Step {step}")
                if step
                else (runs[0], f"{section} {label}")
            )
            previous = label
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename in edits:
                xml = data.decode("utf-8")
                title = shape.search(xml)
                run, value = edits[item.filename]
                block = (
                    title[0][: run.start()]
                    + f"<a:t>{value}</a:t>"
                    + title[0][run.end() :]
                )
                data = xml.replace(title[0], block, 1).encode("utf-8")
            target.writestr(item, data)
        numbers = edits
    print("retitled", len(numbers), "slides")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("parse")
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--arm", action="append", required=True)
    p.add_argument("--output", type=Path, required=True)
    c = sub.add_parser("compare")
    c.add_argument("--manifest", type=Path, required=True)
    c.add_argument("--output", type=Path, required=True)
    c.add_argument("--gold", type=Path, nargs="*", default=[])
    c.add_argument("--measure-dir", type=Path)
    c.add_argument(
        "--arms", nargs=2, default=["v5", "v6"], help="baseline and candidate"
    )
    d = sub.add_parser("deck")
    d.add_argument("source", type=Path)
    d.add_argument("target", type=Path)
    d.add_argument("--skip", type=int, default=3)
    d.add_argument("--step-title", default="重要な問い")
    args = parser.parse_args()
    if args.command == "deck":
        deck(args)
    elif args.command == "parse":
        sources = read(args.manifest)["sources"]
        threads = [
            threading.Thread(
                target=parse_arm, args=(*arm.split("=", 1), sources, args.output)
            )
            for arm in args.arm
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    else:
        compare(args)


if __name__ == "__main__":
    main()
