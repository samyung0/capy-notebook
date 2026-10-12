import json, os, sys, hashlib
from pathlib import Path
import boto3
env = {}
for line in Path(".env.local").read_text().splitlines():
    if line.startswith("KNOWLEDGE_BASE_B2_") and "=" in line:
        k, v = line.split("=", 1); env[k] = v.strip().strip('"')
out = Path(sys.argv[1])
s3 = boto3.client("s3", endpoint_url=env["KNOWLEDGE_BASE_B2_ENDPOINT"] if env["KNOWLEDGE_BASE_B2_ENDPOINT"].startswith("http") else "https://" + env["KNOWLEDGE_BASE_B2_ENDPOINT"],
    region_name=env["KNOWLEDGE_BASE_B2_REGION"], aws_access_key_id=env["KNOWLEDGE_BASE_B2_KEY_ID"], aws_secret_access_key=env["KNOWLEDGE_BASE_B2_APP_KEY"])
for b in json.loads((out / "sample.json").read_text())["books"]:
    target = out / "books" / f"{b['id']}.pdf"
    if not target.exists():
        s3.download_file(env["KNOWLEDGE_BASE_B2_BUCKET"], f"books/{b['sha256']}.pdf", str(target))
    h = hashlib.sha256(target.read_bytes()).hexdigest()
    print(b["id"], target.stat().st_size, "ok" if h == b["sha256"] else "SHA MISMATCH")
