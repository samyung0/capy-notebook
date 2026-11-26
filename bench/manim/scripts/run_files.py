"""Every scene of some scene files, as run_all.sh does for ManimGX's examples: export the CMV film
(the smaller form, beside the original take), decode it, check it against the take, delete the
takes. Scenes that don't run under ManimGX are recorded with their error.

usage: python3 run_files.py <python> <out.jsonl> <scene.py>[:<import folder>…] …
  <python>         one with manimgx and the files' own dependencies
  :<import folder> folders the file imports from (shared classes, a ManimGL stand-in); the
                   file's own folder comes first
Files are run as Manim CE code (`cmv-manimgx export --ce`). Every leaf Scene class of a file is a scene:
a class whose bases end in "Scene" or are classes of the file, that no other class extends.
One JSON line per scene: {scene, export, decode, check} or {scene, error}.
"""

import ast
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
python, out_path, *specs = sys.argv[1:]
out = open(out_path, "a")
work = Path(tempfile.mkdtemp(prefix="cmv-"))


def last(cmd: list[str]) -> dict:
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    if p.returncode != 0:
        return {"error": (p.stderr.strip().splitlines() or ["?"])[-1][:300]}
    return json.loads(p.stdout.strip().splitlines()[-1])


for spec in specs:
    file, *folders = spec.split(":")
    tree = ast.parse(Path(file).read_text())
    classes = {c.name: [getattr(b, "id", getattr(b, "attr", "")) for b in c.bases] for c in tree.body if isinstance(c, ast.ClassDef)}
    extended = {b for bases in classes.values() for b in bases}
    leaves = [n for n, bases in classes.items() if n not in extended and any(b.endswith("Scene") or b in classes for b in bases)]
    for name in leaves:
        tag = f"{Path(file).parent.name}.{Path(file).stem}.{name}"
        cmv, take, rebuilt = work / f"{tag}.cmv", work / f"{tag}.take", work / f"{tag}.rebuilt.take"
        paths = sum((["--path", f] for f in folders), [])
        e = last([python, "-I", "-m", "cmv_manimgx", "export", file, name, "-o", str(cmv), "--take", str(take), "--ce", "--json", *paths])
        if "error" in e:
            row = {"scene": tag, "error": e["error"]}
        else:
            d = last([python, "-I", str(HERE / "decode.py"), str(cmv), "--take", str(rebuilt)])
            c = last([python, "-I", str(HERE / "check.py"), str(take), str(rebuilt if rebuilt.exists() else cmv), "30"])
            row = {"scene": tag, "export": e, "decode": d, "check": c}
        out.write(json.dumps(row) + "\n")
        out.flush()
        for p in (cmv, take, rebuilt):
            p.unlink(missing_ok=True)
