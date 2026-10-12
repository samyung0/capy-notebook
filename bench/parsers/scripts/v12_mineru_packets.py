"""Chunk both arms with the shipped chunker and write one blinded review packet per page."""
import json, random, sys
from dataclasses import asdict
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks

out = Path(sys.argv[1])
sample = json.loads((out / "sample.json").read_text())
rng = random.Random(7)
key = {}


def arm(content_dir: Path, pdf: Path, offset: int):
    """Blocks and chunks keyed by original page number. offset maps page_idx to it."""
    blocks = json.loads((content_dir / "content_list.json").read_text())
    ref = content_dir / "refinement.json"
    furniture = json.loads(ref.read_text())["furniture"] if ref.exists() else []
    parsed = content_dir / "parsed.pdf"
    chunks = retain_headings(blocks, parsed if parsed.exists() else pdf, pack_blocks(blocks, frozenset(furniture)))
    by_page_blocks, by_page_chunks = {}, {}
    for b in blocks:
        by_page_blocks.setdefault(b.get("page_idx", -1) + offset, []).append(b)
    for c in chunks:
        for p in sorted({r.page for r in c.regions}):
            by_page_chunks.setdefault(p - 1 + offset, []).append(c)
    return by_page_blocks, by_page_chunks


def show_block(b: dict) -> str:
    t = b["type"]
    if t in ("text", "title") or (t == "discarded"):
        lvl = b.get("text_level", 0)
        tag = f"heading L{lvl}" if lvl else ("dropped as page furniture" if t == "discarded" else "text")
        return f"[{tag}] {b.get('text', '')}"
    if t == "list":
        return "[list]\n" + "\n".join(f"  - {i}" for i in b.get("list_items", []))
    if t == "equation":
        return f"[equation] {b.get('text') or b.get('latex', '')}"
    if t == "table":
        cap = " ".join(b.get("table_caption", []) or [])
        foot = " ".join(b.get("table_footnote", []) or [])
        return f"[table] caption: {cap}\n{b.get('table_body', '')}\nfootnote: {foot}"
    if t in ("image", "chart"):
        cap = " ".join(b.get("image_caption", []) or b.get(f"{t}_caption", []) or [])
        return f"[{t}] caption: {cap!r}"
    return f"[{t}] {json.dumps({k: v for k, v in b.items() if k not in ('bbox',)}, ensure_ascii=False)[:600]}"


for b in sample["books"]:
    lo, hi = b["window"]
    pdf = out / "books" / f"{b['id']}.pdf"
    arms = {
        "shipped": arm(out / "odl" / "book" / b["id"], pdf, 1),
        "mineru": arm(out / "mineru" / "mps" / b["id"], out / "odl" / "window" / b["id"] / "window.pdf", lo),
    }
    for p in range(lo, hi + 1):
        order = ["shipped", "mineru"]; rng.shuffle(order)
        key[f"{b['id']}:{p}"] = {"A": order[0], "B": order[1]}
        parts = [f"# {b['title']} — PDF page {p}", f"Page image: pages/{b['id']}/p{p}.png", ""]
        for label, name in zip("AB", order):
            blocks, chunks = arms[name]
            parts.append(f"## Parser {label}: raw blocks in reading order")
            parts += [show_block(x) for x in blocks.get(p, [])] or ["(no blocks)"]
            parts.append(f"\n## Parser {label}: indexed chunks touching this page (section path | start of text)")
            for c in chunks.get(p, []):
                parts.append(f"- path: {c.section_path!r} | {c.text[:160]!r}")
            parts.append("")
        d = out / "packets" / b["id"]; d.mkdir(parents=True, exist_ok=True)
        (d / f"p{p}.md").write_text("\n".join(parts))
(out / "blind_key.json").write_text(json.dumps(key, indent=1))
print("packets", len(key))
