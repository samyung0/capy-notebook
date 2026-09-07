"""Upload a generated corpus through an isolated lab gateway's normal API."""

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def request(url, data=None, *, method=None, headers=None, retry_429=False):
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        headers = {**(headers or {}), "content-type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    for attempt in range(60 if retry_429 else 1):
        try:
            with urllib.request.urlopen(req, timeout=180) as response:
                body = response.read()
            break
        except urllib.error.HTTPError as exc:
            if not retry_429 or exc.code != 429 or attempt == 59:
                raise
            delay = min(30, max(2, int(exc.headers.get("Retry-After", "10"))))
            print("Admission wait", delay, exc.read().decode()[:400], flush=True)
            time.sleep(delay)
    return json.loads(body) if body else None


def main(root: Path, api: str):
    assert api == "http://127.0.0.1:8082", (
        "This runner only targets the isolated curated lab."
    )
    manifest = json.loads((root / "manifest.json").read_text())
    state_path = root / "workspaces.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    for corpus in ["complete", "missing_bridge"]:
        if corpus not in state:
            workspace = request(
                api + "/api/workspaces", {"name": f"Curated RAG 20260905 {corpus}"}
            )
            state[corpus] = {"id": workspace["id"], "files": {}}
            state_path.write_text(json.dumps(state, indent=2))
        ws = state[corpus]
        pending = ws.setdefault("pending_uploads", {})
        for item in manifest["sources"]:
            name = item["file"]
            if name in ws["files"]:
                continue
            if (
                corpus == "missing_bridge"
                and name in manifest["omitted_from_missing_bridge"]
            ):
                continue
            payload = (root / "sources" / name).read_bytes()
            kind, ctype = (
                ("pdf", "application/pdf")
                if name.endswith(".pdf")
                else ("md", "text/markdown")
            )
            if name not in pending:
                pending[name] = request(
                    api + f"/api/workspaces/{ws['id']}/sources/uploads",
                    {
                        "name": name,
                        "kind": kind,
                        "contentType": ctype,
                        "sizeBytes": len(payload),
                        "captionImages": False,
                    },
                    retry_429=True,
                )
                state_path.write_text(json.dumps(state, indent=2))
            upload = pending[name]
            if not upload.get("put_complete"):
                request(
                    upload["url"],
                    payload,
                    method=upload["method"],
                    headers=upload["headers"],
                )
                upload["put_complete"] = True
                state_path.write_text(json.dumps(state, indent=2))
            result = request(
                api
                + f"/api/workspaces/{ws['id']}/sources/uploads/{upload['uploadId']}/complete",
                {},
                retry_429=True,
            )
            ws["files"][name] = result
            del pending[name]
            state_path.write_text(json.dumps(state, indent=2))
            print(corpus, name, json.dumps(result), flush=True)
            time.sleep(1)


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2])
