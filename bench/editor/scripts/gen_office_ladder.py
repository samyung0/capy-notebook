#!/usr/bin/env python3
"""The Office size ladder (opt-survey PLAN.md section 4, step 1): per format
and content shape, fixtures of growing size, each with its size split
(office_sizes.py) into XML parts and media, next to the bench's own six
fixtures for comparison. Writes the files and sizes.json to <out-dir>
(default bench/editor/.results/ladder, gitignored); nothing is committed.

- DOCX (gen_long_docx.py, sections): text 24-192 (62-496 pages), table,
  picture (two ~230 KB pictures a section);
- XLSX (gen_large_xlsx.py, 8 sheets, rows per sheet): formula 2k-8k
  (8-33 MiB unzipped), values, style;
- PPTX (gen_large_pptx.py, slides): text, picture (two ~380 KB a slide).

usage: gen_office_ladder.py [out-dir] [--only docx|xlsx|pptx]
"""

import argparse
import json
import os
import subprocess
import sys

from office_sizes import sizes

scripts = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(scripts, "..", "..", ".."))
parser = argparse.ArgumentParser(description="Generate the Office size ladder.")
parser.add_argument("out", nargs="?", default=os.path.join(root, "bench", "editor", ".results", "ladder"))
parser.add_argument("--only", choices=["docx", "xlsx", "pptx"])
options = parser.parse_args()
out = os.path.abspath(options.out)
only = options.only
exchange_plan = os.path.join(root, "e2e", "fixtures", "files", "rich-content", "exchange-plan.docx")

LADDER = [
    ("docx", "text", [24, 48, 96, 192]),
    ("docx", "table", [12, 24, 48, 96]),
    ("docx", "picture", [6, 12, 24, 48, 64]),
    ("xlsx", "formula", [2000, 4000, 8000]),
    ("xlsx", "values", [2000, 4000, 8000]),
    ("xlsx", "style", [2000, 4000, 8000]),
    ("pptx", "text", [50, 100, 200, 400]),
    ("pptx", "picture", [5, 10, 20, 40]),
]
BENCH = [
    "e2e/fixtures/files/rich-content/exchange-plan.docx",
    "bench/editor/fixtures/office/long-handbook.docx",
    "e2e/fixtures/files/rich-content/course-guide.xlsx",
    "bench/editor/fixtures/office/large-gradebook.xlsx",
    "e2e/fixtures/files/rich-content/lecture.pptx",
    "bench/parsers/fixtures/docs/jp_llm2.pptx",
]


def generate(fmt, shape, step, path):
    script = {"docx": "gen_long_docx.py", "xlsx": "gen_large_xlsx.py", "pptx": "gen_large_pptx.py"}[fmt]
    command = [sys.executable, os.path.join(scripts, script)]
    if fmt == "docx":
        command += [exchange_plan, path, str(step), shape]
    elif fmt == "xlsx":
        command += [path, "8", str(step), shape]
    else:
        command += [path, str(step), shape]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)


os.makedirs(out, exist_ok=True)
rows = []
for path in BENCH:
    if only and not path.endswith(only):
        continue
    rows.append({"format": path.rsplit(".", 1)[1], "shape": "bench", "step": None, **sizes(os.path.join(root, path))})
for fmt, shape, steps in LADDER:
    if only and fmt != only:
        continue
    for step in steps:
        path = os.path.join(out, f"{fmt}-{shape}-{step}.{fmt}")
        generate(fmt, shape, step, path)
        rows.append({"format": fmt, "shape": shape, "step": step, **sizes(path)})
        print(f"{fmt} {shape} {step}", file=sys.stderr)

with open(os.path.join(out, "sizes.json"), "w") as file:
    json.dump(rows, file, indent=2)
mib = lambda value: f"{value / 1048576:.2f}"
print("| file | zipped MiB | unzipped MiB | XML MiB | media MiB | other MiB |")
print("| --- | --- | --- | --- | --- | --- |")
for row in rows:
    print(
        f"| {row['file']} | {mib(row['zippedBytes'])} | {mib(row['unzippedBytes'])} | {mib(row['xmlBytes'])} "
        f"| {mib(row['mediaBytes'])} | {mib(row['otherBytes'])} |"
    )
