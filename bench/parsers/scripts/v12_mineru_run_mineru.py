"""MinerU 3.4.5 pipeline backend on the same window PDFs the shipped parser read."""
import json, sys, time, shutil, os
from pathlib import Path
def main():
    import torch
    from mineru.cli.common import do_parse
    out = Path(sys.argv[1]); tag = sys.argv[2]; only = sys.argv[3] if len(sys.argv) > 3 else None
    sample = json.loads((out / "sample.json").read_text())
    for b in sample["books"]:
        if only and b["id"] != only: continue
        d = out / "mineru" / tag / b["id"]
        if (d / "result.json").exists(): continue
        shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
        data = (out / "odl" / "window" / b["id"] / "window.pdf").read_bytes()
        t = time.perf_counter()
        do_parse(str(d / "native"), [b["id"]], [data], ["en"], backend="pipeline", parse_method="auto",
                 formula_enable=True, table_enable=True, f_draw_layout_bbox=True, f_draw_span_bbox=False,
                 f_dump_orig_pdf=False, f_dump_model_output=False, f_dump_md=True, f_dump_middle_json=True, f_dump_content_list=True)
        secs = time.perf_counter() - t
        cl = list((d / "native").rglob("*_content_list.json"))[0]
        shutil.copy(cl, d / "content_list.json")
        r = {"book": b["id"], "tag": tag, "device": os.environ.get("MINERU_DEVICE_MODE"), "seconds": secs, "blocks": len(json.loads(cl.read_text()))}
        (d / "result.json").write_text(json.dumps(r, indent=1)); print(json.dumps(r), flush=True)

if __name__ == "__main__":
    main()
