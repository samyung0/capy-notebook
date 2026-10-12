"""Shipped v12 parser (parser/odl/refine.parse_pdf) on whole books and on the sampled windows."""
import json, sys, time, shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "parser"))
import pymupdf
from odl.refine import parse_pdf

out = Path(sys.argv[1]); mode = sys.argv[2]  # book | window
only = sys.argv[3] if len(sys.argv) > 3 else None
sample = json.loads((out / "sample.json").read_text())
for b in sample["books"]:
    if only and b["id"] != only: continue
    src = out / "books" / f"{b['id']}.pdf"
    d = out / "odl" / mode / b["id"]
    if (d / "result.json").exists(): continue
    shutil.rmtree(d, ignore_errors=True); (d / "work").mkdir(parents=True)
    if mode == "book":
        data = src.read_bytes()
    else:
        lo, hi = b["window"]
        with pymupdf.open(src) as o, pymupdf.open() as s:
            s.insert_pdf(o, from_page=lo - 1, to_page=hi - 1); data = s.tobytes(garbage=4, deflate=True)
        (d / "window.pdf").write_bytes(data)
    t = time.perf_counter()
    p = parse_pdf(data, d / "work", java_timeout_s=3600)
    secs = time.perf_counter() - t
    (d / "content_list.json").write_text(json.dumps(p.content_list, ensure_ascii=False))
    (d / "refinement.json").write_text(json.dumps({"furniture": p.furniture}))
    if p.parsed_pdf is not None: (d / "parsed.pdf").write_bytes(p.parsed_pdf)
    shutil.rmtree(d / "work", ignore_errors=True)
    r = {"book": b["id"], "mode": mode, "pages": p.page_count, "seconds": secs, "phases": p.phases, "ocr_pages": len(p.ocr_pages), "blocks": len(p.content_list)}
    (d / "result.json").write_text(json.dumps(r, indent=1)); print(json.dumps(r), flush=True)
