"""Check embedded image identity after observing external filename collisions."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import subprocess
from pathlib import Path

from compare_opendataloader import CONFIGS, Hybrid, save
from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--inspect-only", action="store_true")
    args = parser.parse_args()
    entry = next(
        item
        for item in json.loads((args.root / "corpus.json").read_text())["entries"]
        if item["id"] == "screen__biology-accuracy-sample"
    )
    source = args.root / entry["pdf"]
    for name in ["odl-auto-rapid", "odl-full-rapid-autoocr"]:
        target = args.root / "probes" / f"embedded-images-{name}"
        target.mkdir(parents=True, exist_ok=True)
        hybrid = Hybrid(args.root, CONFIGS[name], target)
        try:
            if not args.inspect_only:
                hybrid.ensure(entry)
            command = [
                "opendataloader-pdf",
                str(source),
                "--output-dir",
                str(target),
                "--format",
                "json,markdown",
                "--image-output",
                "embedded",
                "--markdown-with-html",
                "--threads",
                "2",
                "--hybrid",
                "docling-fast",
                "--hybrid-mode",
                CONFIGS[name]["hybrid"],
                "--hybrid-url",
                "http://127.0.0.1:5002",
                "--hybrid-timeout",
                "600000",
            ]
            if args.inspect_only:
                command = json.loads((target / "image-identity.json").read_text())[
                    "command"
                ]
            if not args.inspect_only:
                with (target / "converter.log").open("w") as log:
                    subprocess.run(
                        command,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        check=True,
                        timeout=600,
                    )
            document = json.loads((target / f"{source.stem}.json").read_text())
            records = []

            def visit(value: object, target=target, records=records) -> None:
                if isinstance(value, list):
                    for child in value:
                        visit(child)
                elif isinstance(value, dict):
                    if value.get("type") in {"image", "picture"}:
                        record = {
                            key: value.get(key)
                            for key in ["id", "page number", "bounding box"]
                        }
                        uri = value.get("data") or value.get("source", "")
                        record["embedded"] = uri.startswith("data:image/")
                        if record["embedded"]:
                            header, payload = uri.split(",", 1)
                            assert ";base64" in header, header
                            data = base64.b64decode(payload, validate=True)
                            digest = hashlib.sha256(data).hexdigest()
                            with Image.open(io.BytesIO(data)) as img:
                                record["size"] = list(img.size)
                                suffix = img.format.lower()
                            path = target / f"{digest}.{suffix}"
                            path.write_bytes(data)
                            record.update(
                                sha256=digest, file=path.name, bytes=len(data)
                            )
                        else:
                            record["source"] = uri
                        records.append(record)
                    for child in value.values():
                        if isinstance(child, (dict, list)):
                            visit(child)

            visit(document)
            save(
                target / "image-identity.json",
                {
                    "command": command,
                    "input_sha256": entry["pdf_sha256"],
                    "images": records,
                },
            )
            print(
                json.dumps(
                    {
                        "config": name,
                        "images": len(records),
                        "embedded": sum(x["embedded"] for x in records),
                    }
                ),
                flush=True,
            )
        finally:
            hybrid.close()


if __name__ == "__main__":
    main()
