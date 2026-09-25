import json
from pathlib import Path

root = Path(
    r"C:\WEB\capy-notebook\bench\rag\reports\local\2026-09-09-odl-agentic\snapshots"
)
for p in root.rglob("answers.jsonl"):
    for line in p.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        tc = (r.get("telemetry") or {}).get("toolCallsByName") or {}
        if tc.get("describe_documents"):
            print(p)
            print("Q:", r.get("id"), r.get("question"))
            print("tools:", tc, "status:", r.get("status"))
            print("answer:", (r.get("answer") or "")[:600])
            for c in r.get("calls") or []:
                print("CALL", json.dumps(c, ensure_ascii=False)[:300])
            for t in r.get("rendered_tool_results") or []:
                s = json.dumps(t, ensure_ascii=False)
                if "describe" in s or "summary" in s.lower():
                    print("RESULT", s[:1500])
