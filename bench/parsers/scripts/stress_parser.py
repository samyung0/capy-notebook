"""Stress one throwaway parser container through the production artifact route.

Runs on the ingest host with the stdlib only. Each request copies its source
into the container's spool and posts the same JSON the parse coordinator
sends, with a fingerprint unique to the run so no bundle is served from cache.
A sampler thread reads the container's cgroup every 250 ms (memory split into
anon and file, swap, CPU, OOM kills, and RSS of Java, the API process and the
parse child).

    python3 stress_parser.py solo  --manifest m.json --out DIR --container NAME
    python3 stress_parser.py burst --manifest m.json --out DIR --container NAME

``solo`` sends the documents one after another. ``burst`` sends them all at
once, so queue wait and the 429 at queue capacity show up. ``corpus`` builds
image-only PDFs from page ranges of a source and needs PyMuPDF (run it inside
the parser image).

Token from ``PARSER_TOKEN``. Results: ``DIR/<mode>.jsonl`` (one response per
document plus its sampled peaks) and ``DIR/<mode>-samples.csv``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

SCHEMA = "capy-parser-bundle-v4"


def cgroup_dir(container: str) -> Path:
    full = subprocess.check_output(
        ["docker", "inspect", "-f", "{{.Id}}", container], text=True
    ).strip()
    return Path(f"/sys/fs/cgroup/system.slice/docker-{full}.scope")


def spool_dir(container: str) -> Path:
    mounts = json.loads(
        subprocess.check_output(
            ["docker", "inspect", "-f", "{{json .Mounts}}", container], text=True
        )
    )
    return next(
        Path(m["Source"]) for m in mounts if m["Destination"] == "/var/lib/capy-parse"
    )


class Sampler(threading.Thread):
    def __init__(self, cgroup: Path, out: Path) -> None:
        super().__init__(daemon=True)
        self.cgroup, self.rows, self.stop = cgroup, [], threading.Event()
        self.out = out

    def read(self, name: str) -> str:
        try:
            return (self.cgroup / name).read_text()
        except OSError:
            return ""

    def keyed(self, name: str) -> dict[str, int]:
        return {
            k: int(v)
            for k, v in (line.split() for line in self.read(name).splitlines())
        }

    def rss_by_name(self) -> dict[str, int]:
        totals: dict[str, int] = {}
        for pid in self.read("cgroup.procs").split():
            try:
                status = Path(f"/proc/{pid}/status").read_text()
            except OSError:
                continue
            fields = dict(
                line.split(":", 1) for line in status.splitlines() if ":" in line
            )
            name = fields.get("Name", "?").strip()
            if name.startswith("python") or name == "uvicorn":
                try:
                    cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
                except OSError:
                    continue
                # The spawned parse child runs multiprocessing's entry point.
                name = "child" if b"multiprocessing" in cmdline else "api"
            rss = int(fields.get("VmRSS", "0 kB").split()[0]) * 1024
            totals[name] = totals.get(name, 0) + rss
        return totals

    def run(self) -> None:
        while not self.stop.is_set():
            stat = self.keyed("memory.stat")
            rss = self.rss_by_name()
            self.rows.append(
                {
                    "t": time.time(),
                    "current": int(self.read("memory.current") or 0),
                    "anon": stat.get("anon", 0),
                    "file": stat.get("file", 0),
                    "swap": int(self.read("memory.swap.current") or 0),
                    "cpu_usec": self.keyed("cpu.stat").get("usage_usec", 0),
                    "oom_kill": self.keyed("memory.events").get("oom_kill", 0),
                    "java_rss": rss.get("java", 0),
                    "api_rss": rss.get("api", 0),
                    "child_rss": rss.get("child", 0),
                    "other_rss": sum(
                        v for k, v in rss.items() if k not in ("java", "api", "child")
                    ),
                }
            )
            time.sleep(0.25)

    def finish(self) -> None:
        self.stop.set()
        self.join()
        with self.out.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(self.rows[0]))
            writer.writeheader()
            writer.writerows(self.rows)

    def window(self, start: float, end: float) -> dict[str, float]:
        rows = [r for r in self.rows if start <= r["t"] <= end]
        if len(rows) < 2:
            return {}
        gib = 1 << 30
        cpu_s = (rows[-1]["cpu_usec"] - rows[0]["cpu_usec"]) / 1e6
        return {
            "peak_current_gib": round(max(r["current"] for r in rows) / gib, 2),
            "peak_anon_gib": round(max(r["anon"] for r in rows) / gib, 2),
            "peak_swap_gib": round(max(r["swap"] for r in rows) / gib, 2),
            "peak_java_rss_gib": round(max(r["java_rss"] for r in rows) / gib, 2),
            "peak_api_rss_gib": round(max(r["api_rss"] for r in rows) / gib, 2),
            "peak_child_rss_gib": round(max(r["child_rss"] for r in rows) / gib, 2),
            "peak_other_rss_gib": round(max(r["other_rss"] for r in rows) / gib, 2),
            "avg_cores": round(cpu_s / max(end - start, 1e-6), 2),
            "oom_kills": rows[-1]["oom_kill"] - rows[0]["oom_kill"],
        }


def post(url: str, token: str, body: dict | None, timeout: float) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        data=None if body is None else json.dumps(body).encode(),
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read())
        except ValueError:
            return exc.code, {}
    except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
        return 0, {"detail": f"connection: {exc}"}


def parse_one(args, doc: dict, spool: Path, version: str) -> dict:
    data = Path(doc["path"]).read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    fingerprint = hashlib.sha256(f"{args.tag}:{doc['id']}:{sha}".encode()).hexdigest()
    key = f"sources/stress-{fingerprint[:16]}.pdf"
    target = spool / key
    shutil.copyfile(doc["path"], target)
    os.chown(target, 10001, 10001)
    target.chmod(0o640)
    body = {
        "source_key": key,
        "source_sha256": sha,
        "output_key": f"artifacts/{fingerprint}.zip",
        "filename": Path(doc["path"]).name,
        "artifact_schema": SCHEMA,
        "parser_version": version,
        "source_fingerprint": fingerprint,
        "request_id": str(uuid.uuid4()),
    }
    started = time.time()
    status, payload = post(f"{args.url}/file_parse", args.token, body, 3000)
    ended = time.time()
    target.unlink(missing_ok=True)
    (spool / body["output_key"]).unlink(missing_ok=True)
    return {
        "id": doc["id"],
        "pages": doc.get("pages"),
        "status": status,
        "code": payload.get("code") or payload.get("detail"),
        "client_s": round(ended - started, 1),
        "server_s": payload.get("_server_parse_s"),
        "queue_s": round((payload.get("_queue_ms") or 0) / 1000, 1),
        "ocr_pages": payload.get("_ocr_page_count"),
        "page_count": payload.get("_page_count"),
        "phases": payload.get("_phases"),
        "artifact_mib": round((payload.get("artifact") or {}).get("size", 0) / 2**20, 1),
        "_started": started,
        "_ended": ended,
    }


def wait_healthy(url: str, token: str) -> dict:
    for _ in range(240):
        status, body = post(f"{url}/healthz", token, None, 5)
        if status == 200 and body.get("ok"):
            return body
        time.sleep(1)
    raise SystemExit("parser never became healthy")


def run(args) -> None:
    docs = json.loads(Path(args.manifest).read_text())
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    spool = spool_dir(args.container)
    health = wait_healthy(args.url, args.token)
    sampler = Sampler(cgroup_dir(args.container), out / f"{args.mode}-samples.csv")
    sampler.start()
    time.sleep(1)
    results: list[dict] = []
    if args.mode == "solo":
        for doc in docs:
            wait_healthy(args.url, args.token)
            results.append(parse_one(args, doc, spool, health["parser_version"]))
            print(json.dumps({k: v for k, v in results[-1].items() if k[0] != "_"}), flush=True)
            time.sleep(args.gap)
    else:
        lock = threading.Lock()

        def worker(doc: dict) -> None:
            result = parse_one(args, doc, spool, health["parser_version"])
            with lock:
                results.append(result)
                print(json.dumps({k: v for k, v in result.items() if k[0] != "_"}), flush=True)

        threads = []
        for doc in docs:
            threads.append(threading.Thread(target=worker, args=(doc,)))
            threads[-1].start()
            time.sleep(0.5)  # a stable queue order
        for thread in threads:
            thread.join()
    time.sleep(1)
    sampler.finish()
    with (out / f"{args.mode}.jsonl").open("w") as handle:
        for result in results:
            execution = (result["server_s"] or 0) - result["queue_s"]
            end = result["_ended"]
            start = end - execution if execution > 0 else result["_started"]
            result["execution_s"] = round(execution, 1) if execution > 0 else None
            result.update(sampler.window(start, end))
            handle.write(json.dumps({k: v for k, v in result.items() if k[0] != "_"}) + "\n")


def corpus(args) -> None:
    import fitz  # PyMuPDF, present in the parser image

    source = fitz.open(args.source)
    out = fitz.open()
    first, last = (int(v) for v in args.pages.split("-"))
    for index in range(first, last + 1):
        page = source[index % source.page_count]
        pixmap = page.get_pixmap(dpi=args.dpi, colorspace=fitz.csGRAY)
        target = out.new_page(width=page.rect.width, height=page.rect.height)
        target.insert_image(target.rect, stream=pixmap.tobytes("jpg", jpg_quality=75))
    out.save(args.output, deflate=True)
    print(args.output, out.page_count, os.path.getsize(args.output) // 2**20, "MiB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="mode", required=True)
    for mode in ("solo", "burst"):
        p = sub.add_parser(mode)
        p.add_argument("--manifest", required=True)
        p.add_argument("--out", required=True)
        p.add_argument("--container", required=True)
        p.add_argument("--url", default="http://127.0.0.1:18090")
        p.add_argument("--tag", default=uuid.uuid4().hex[:8])
        p.add_argument("--gap", type=float, default=5)
    c = sub.add_parser("corpus")
    c.add_argument("source")
    c.add_argument("output")
    c.add_argument("--pages", required=True, help="first-last, 0-based, wraps")
    c.add_argument("--dpi", type=int, default=200)
    args = parser.parse_args()
    if args.mode == "corpus":
        corpus(args)
        return
    args.token = os.environ["PARSER_TOKEN"]
    run(args)


if __name__ == "__main__":
    main()
