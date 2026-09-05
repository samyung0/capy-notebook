"""Upload only the fresh QA documents through the isolated lab's normal API."""

import json
import sys

sys.path.insert(0, "/lab")
from index_corpus import ROOT, guard, write_json
from upload_corpus import request


def main():
    guard()
    api = "http://127.0.0.1:8082"
    corpus = ROOT / "corpus"
    manifest = json.loads((corpus / "manifest.json").read_text())
    path = corpus / "workspaces.json"
    state = json.loads(path.read_text()) if path.exists() else {}
    for label, ws in json.loads(
        (ROOT / "retrieval-workspaces.json").read_text()
    ).items():
        if label.startswith("miracl-"):
            assert ws["ready"]
            state[label] = {
                "id": ws["id"],
                "files": ws["files"],
                "mode": "component_fixture",
            }
    write_json(path, state)
    for label, filenames in manifest["upload_workspaces"].items():
        if label not in state:
            workspace = request(
                api + "/api/workspaces", {"name": "Broad chat 20260905 " + label}
            )
            state[label] = {"id": workspace["id"], "files": {}, "mode": "normal_upload"}
            write_json(path, state)
        ws = state[label]
        pending = ws.setdefault("pending_uploads", {})
        for name in filenames:
            if name in ws["files"]:
                continue
            payload = (corpus / "sources" / name).read_bytes()
            if name not in pending:
                pending[name] = request(
                    api + f"/api/workspaces/{ws['id']}/sources/uploads",
                    {
                        "name": name,
                        "kind": "md",
                        "contentType": "text/markdown",
                        "sizeBytes": len(payload),
                        "captionImages": False,
                    },
                    retry_429=True,
                )
                write_json(path, state)
            upload = pending[name]
            if not upload.get("put_complete"):
                request(
                    upload["url"],
                    payload,
                    method=upload["method"],
                    headers=upload["headers"],
                )
                upload["put_complete"] = True
                write_json(path, state)
            ws["files"][name] = request(
                api
                + f"/api/workspaces/{ws['id']}/sources/uploads/{upload['uploadId']}/complete",
                {},
                retry_429=True,
            )
            del pending[name]
            write_json(path, state)
            print(label, name, ws["files"][name], flush=True)


if __name__ == "__main__":
    main()
