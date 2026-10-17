"""Counts of recordings/index.json per format and status, and the problems.

  python summary.py <recordings dir>
"""

import collections
import json
import pathlib
import sys

index = json.loads((pathlib.Path(sys.argv[1]) / "index.json").read_text(encoding="utf8"))
by = collections.Counter((e["format"], e["status"]) for e in index)
for (fmt, status), n in sorted(by.items()):
    print(f"{fmt:5} {status:13} {n}")
print("total", len(index))
for e in index:
    if e["status"] != "ok":
        print(f"  {e['status']:13} {e['caseId']}: {e.get('error', '')[:160]}")
