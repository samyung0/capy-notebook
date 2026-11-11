"""Legacy conversions through a throwaway parser's /file_parse, then an
ordinary parse of each converted file.

Takes stress_parser.py's arguments (``DRIVER=legacy_convert_probe.py`` with
capacity_pass.sh); ``--manifest`` is a folder of .doc, .xls and .ppt files that
holds a ``lesson.doc``. After the conversions it sends four requests the parser
must refuse. Rows go to stdout and ``OUT/probe.json``; the converted files to
``OUT/converted``."""

import argparse
import hashlib
import json
import os
import shutil
import sys
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import stress_parser as sp

TARGET = {".doc": "docx", ".xls": "xlsx", ".ppt": "pptx"}


def convert(args, spool, version, data, name, convert_to, tag):
    sha = hashlib.sha256(data).hexdigest()
    fingerprint = hashlib.sha256(f"{args.tag}:{tag}:{sha}".encode()).hexdigest()
    key = f"sources/probe-{fingerprint[:16]}{Path(name).suffix.lower()}"
    target = spool / key
    target.write_bytes(data)
    os.chown(target, 10001, 10001)
    target.chmod(0o640)
    # The request id is the job's id: the output file is that job's own, while
    # the fingerprint (and the quarantine) is the bytes'.
    job = f"probe-{uuid.uuid4().hex[:12]}"
    body = {
        "source_key": key,
        "source_sha256": sha,
        "output_key": f"artifacts/{fingerprint}.{job}.{convert_to}",
        "filename": name,
        "artifact_schema": sp.SCHEMA,
        "parser_version": version,
        "source_fingerprint": fingerprint,
        "request_id": job,
        "convert_to": convert_to,
    }
    status, payload = sp.post(f"{args.url}/file_parse", args.token, body, 900)
    target.unlink(missing_ok=True)
    out = spool / body["output_key"]
    row = {
        "case": tag,
        "name": name,
        "to": convert_to,
        "status": status,
        "code": payload.get("code"),
        "detail": str(payload.get("detail") or "")[:160],
        "converted": payload.get("converted"),
        "artifact": payload.get("artifact"),
    }
    if status == 200 and out.exists():
        blob = out.read_bytes()
        row["bytes"] = len(blob)
        row["zip"] = zipfile.is_zipfile(out)
        row["sha_matches"] = hashlib.sha256(blob).hexdigest() in json.dumps(payload.get("artifact"))
        kept = Path(args.out) / "converted" / f"{Path(name).stem}.{convert_to}"
        kept.parent.mkdir(parents=True, exist_ok=True)
        kept.write_bytes(blob)
        row["kept"] = str(kept)
    row["left_in_spool"] = out.exists()
    out.unlink(missing_ok=True)
    return row


def main():
    p = argparse.ArgumentParser()
    p.add_argument("mode")
    p.add_argument("--manifest", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--container", required=True)
    p.add_argument("--url", default="http://127.0.0.1:18090")
    p.add_argument("--tag", default=uuid.uuid4().hex[:8])
    args, _ = p.parse_known_args()
    args.token, args.keep, args.keep_ids = os.environ["PARSER_TOKEN"], None, set()
    Path(args.out).mkdir(parents=True, exist_ok=True)
    spool = sp.spool_dir(args.container)
    health = sp.wait_healthy(args.url, args.token)
    version = health["parser_version"]
    rows = []

    def keep(row):
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)

    converted = []
    for path in sorted(Path(args.manifest).iterdir()):
        row = convert(args, spool, version, path.read_bytes(), path.name, TARGET[path.suffix.lower()], "ok")
        keep(row)
        if row.get("kept"):
            converted.append(row["kept"])
    sample = Path(args.manifest) / "lesson.doc"
    # The refusals: a new-format file named .doc, junk in an OLE2 container,
    # a target that is not the suffix's twin, and a target of no kind.
    keep(convert(args, spool, version, Path(converted[0]).read_bytes(), "renamed.doc", "docx", "zip-named-doc"))
    keep(convert(args, spool, version, b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + os.urandom(8192), "junk.doc", "docx", "junk-ole"))
    keep(convert(args, spool, version, sample.read_bytes(), "lesson.doc", "xlsx", "wrong-twin"))
    keep(convert(args, spool, version, sample.read_bytes(), "lesson.doc", "pdf", "bad-target"))
    # Each converted file then takes the ordinary parse.
    for kept in converted:
        result = sp.parse_one(args, {"id": Path(kept).name, "path": kept, "pages": None}, spool, version)
        keep({"case": "parse", **{k: result[k] for k in ("id", "status", "code", "detail", "server_s", "page_count", "phases")}})
    (Path(args.out) / "probe.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False))


main()
