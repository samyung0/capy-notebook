"""Download pinned public inference artifacts into the ignored local data dir."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "grading-benchmark"


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "Capy-Grading-Eval"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def download(url: str, target: Path, expected: str | None = None) -> dict:
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        partial = target.with_suffix(target.suffix + ".partial")
        print(f"Downloading {target.name}", flush=True)
        with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as out:
            shutil.copyfileobj(response, out, 4 * 1024 * 1024)
        partial.replace(target)
    with target.open("rb") as source:
        sha = hashlib.file_digest(source, "sha256").hexdigest()
    if expected and sha != expected.removeprefix("sha256:"):
        raise ValueError(f"Checksum mismatch: {target}")
    return {"path": str(target.relative_to(DATA)), "bytes": target.stat().st_size, "sha256": sha, "url": url}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    listing = sub.add_parser("list")
    listing.add_argument("repos", nargs="+")
    model = sub.add_parser("model")
    model.add_argument("repo")
    model.add_argument("filename")
    model.add_argument("--revision", required=True)
    native = sub.add_parser("native")
    native.add_argument("--tag", required=True)
    native.add_argument("--asset", action="append")
    source = sub.add_parser("source")
    source.add_argument("--tag", required=True)
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    if args.command == "source":
        tag = urllib.parse.quote(args.tag, safe="")
        target = DATA / "downloads" / f"llama-source-{tag}.zip"
        record = download(f"https://codeload.github.com/ggml-org/llama.cpp/zip/refs/tags/{tag}", target)
        destination = DATA / "source"
        destination.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(target) as archive:
            for entry in archive.infolist():
                if not (destination / entry.filename).resolve().is_relative_to(destination.resolve()):
                    raise ValueError("Archive path escapes source directory")
            archive.extractall(destination)
        target.with_suffix(".source.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        print(json.dumps(record))
        return
    if args.command == "list":
        for repo in args.repos:
            info = fetch_json(f"https://huggingface.co/api/models/{repo}?blobs=true")
            print(json.dumps({"repo": repo, "sha": info["sha"], "files": info["siblings"]}, ensure_ascii=True))
        return
    if args.command == "model":
        info = fetch_json(f"https://huggingface.co/api/models/{args.repo}/revision/{args.revision}?blobs=true")
        file = next(f for f in info["siblings"] if f["rfilename"] == args.filename)
        filename = Path(args.filename)
        if filename.is_absolute() or ".." in filename.parts:
            raise ValueError("Expected a relative repository filename")
        target = DATA / "models" / args.repo.replace("/", "--") / filename
        url = f"https://huggingface.co/{args.repo}/resolve/{info['sha']}/{urllib.parse.quote(args.filename, safe='/')}"
        record = download(url, target, file.get("lfs", {}).get("sha256"))
        record.update(repo=args.repo, revision=info["sha"])
        target.with_suffix(target.suffix + ".source.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        print(json.dumps(record))
        return
    info = fetch_json(f"https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{args.tag}")
    if not args.asset:
        print(json.dumps([{"name": a["name"], "bytes": a["size"]} for a in info["assets"]]))
        return
    for name in args.asset:
        asset = next(a for a in info["assets"] if a["name"] == name)
        record = download(asset["browser_download_url"], DATA / "downloads" / name, asset.get("digest"))
        destination = DATA / "llama.cpp" / args.tag
        destination.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(DATA / record["path"]) as archive:
            for entry in archive.infolist():
                resolved = (destination / entry.filename).resolve()
                if not resolved.is_relative_to(destination.resolve()):
                    raise ValueError("Archive path escapes runtime directory")
            archive.extractall(destination)
        (destination / (name + ".source.json")).write_text(json.dumps(record, indent=2), encoding="utf-8")
        print(json.dumps(record))


if __name__ == "__main__":
    main()
