"""Download every library book inside the upload limits into OUT/pool and record its producer.

Local copies (review books, budget fixtures) are linked instead of downloaded.
Writes OUT/pool/meta.json: {id: {sha256, pages, bytes, producer, creator, subject, toc}}.
"""

import hashlib
import json
import sys

import boto3
import pymupdf

from common import FIX, POOL, REPO, REVIEW

LIMIT_BYTES, LIMIT_PAGES = 30 * 2**20, 1400
LOCAL = {"introduction-to-basic-legal-citation": FIX / "budget/legal-citation.pdf",
         "interpretation-of-metal-fab-drawings": FIX / "budget/metal-fab-drawings.pdf",
         "open-logic-project": FIX / "budget/open-logic.pdf",
         "advanced-waterworks-mathematics": FIX / "budget/waterworks-math.pdf"}


def s3_client():
    env = {}
    for line in (REPO / ".env.local").read_text().splitlines():
        if line.startswith("KNOWLEDGE_BASE_B2_") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"')
    ep = env["KNOWLEDGE_BASE_B2_ENDPOINT"]
    return env["KNOWLEDGE_BASE_B2_BUCKET"], boto3.client(
        "s3", endpoint_url=ep if ep.startswith("http") else "https://" + ep,
        region_name=env["KNOWLEDGE_BASE_B2_REGION"], aws_access_key_id=env["KNOWLEDGE_BASE_B2_KEY_ID"],
        aws_secret_access_key=env["KNOWLEDGE_BASE_B2_APP_KEY"])


if __name__ == "__main__":
    POOL.mkdir(parents=True, exist_ok=True)
    books = json.loads((REPO / "lab/knowledge/books.json").read_text())["books"]
    for p in (REVIEW / "books").glob("*.pdf"):
        LOCAL.setdefault(p.stem, p)
    bucket, s3 = s3_client()
    meta_path = POOL / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    for b in books:
        if b["bytes"] > LIMIT_BYTES or b["pages"] > LIMIT_PAGES or b["id"] in meta:
            continue
        target = POOL / f"{b['id']}.pdf"
        if not target.exists():
            src = LOCAL.get(b["id"])
            if src and src.exists():
                target.symlink_to(src.resolve())
            else:
                try:
                    s3.download_file(bucket, f"books/{b['sha256']}.pdf", str(target))
                except Exception as e:  # a few manifest entries are missing from the bucket
                    print("MISSING", b["id"], e, file=sys.stderr)
                    target.unlink(missing_ok=True)
                    continue
        if hashlib.sha256(target.read_bytes()).hexdigest() != b["sha256"]:
            print("SHA MISMATCH", b["id"], file=sys.stderr)
            continue
        doc = pymupdf.open(target)
        m = doc.metadata or {}
        meta[b["id"]] = dict(sha256=b["sha256"], bytes=b["bytes"], pages=doc.page_count,
                             producer=m.get("producer", ""), creator=m.get("creator", ""),
                             subject=b["subject_id"], toc=len(doc.get_toc()))
        meta_path.write_text(json.dumps(meta, indent=1))
        print(b["id"], doc.page_count, m.get("producer", "")[:40], "|", m.get("creator", "")[:40], flush=True)
