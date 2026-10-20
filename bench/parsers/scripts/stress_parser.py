"""Stress one throwaway parser container through the production artifact route.

Runs on the ingest host with the stdlib only. Each request copies its source
into the container's spool and posts the same JSON the parse coordinator
sends, with a fingerprint unique to the run so no bundle is served from cache.
A sampler thread reads the container's cgroup every 250 ms (memory split into
anon and file, swap, CPU and CPU-quota throttling, OOM kills, RSS of Java, the
API process and the parse child, VmPeak of the parse child, LibreOffice and
Java, and Java's VmData, which its data rlimit bounds) and the host's CPU,
steal, free memory and swap.

    python3 stress_parser.py solo  --manifest m.json --out DIR --container NAME
    python3 stress_parser.py burst --manifest m.json --out DIR --container NAME

``solo`` sends the documents one after another. ``burst`` sends them all at
once, so queue wait and the 429 at queue capacity show up. ``--keep DIR``
copies each bundle (``--keep-ids`` limits which) before it is deleted.
``--watch`` names containers that must not restart and ``--abort-swap-gib``
the host swap growth allowed; past either the parser container is killed and
the pass ends with ``abort.txt``. ``corpus`` builds image-only PDFs from page
ranges of a source and needs PyMuPDF (run it inside the parser image).

Token from ``PARSER_TOKEN``. Results: ``DIR/<mode>.jsonl`` (one response per
document plus its sampled peaks), ``DIR/<mode>-samples.csv`` and
``DIR/<mode>-summary.json``.
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

SCHEMA = "capy-parser-bundle-v6"
GIB = 1 << 30
# VmPeak (the kernel's peak virtual size per process, which RLIMIT_AS bounds)
# kept per process kind, by /proc Name.
VMPEAK = {"child": "child_vmpeak", "soffice.bin": "office_vmpeak", "java": "java_vmpeak"}
# VmData (private writable mappings, which RLIMIT_DATA bounds) per process
# kind: the JVM runs under a data cap instead of an address-space cap.
VMDATA = {"java": "java_vmdata", "soffice.bin": "office_vmdata", "child": "child_vmdata"}
PER_PROCESS = ("child_max_rss", "child_max_vm", *VMPEAK.values(), *VMDATA.values())
COUNTS = {"child": "child_count", "java": "java_count", "soffice.bin": "office_count"}


def cgroup_dir(container: str) -> Path:
    full = subprocess.check_output(
        ["docker", "inspect", "-f", "{{.Id}}", container], text=True
    ).strip()
    systemd = Path(f"/sys/fs/cgroup/system.slice/docker-{full}.scope")
    if systemd.exists():
        return systemd
    # The cgroupfs driver (Docker Desktop) names the container's cgroup by id.
    return next(Path("/sys/fs/cgroup").glob(f"**/*{full}*"))


def spool_dir(container: str) -> Path:
    mounts = json.loads(
        subprocess.check_output(
            ["docker", "inspect", "-f", "{{json .Mounts}}", container], text=True
        )
    )
    return next(
        Path(m["Source"]) for m in mounts if m["Destination"] == "/var/lib/capy-parse"
    )


def host_cpu() -> tuple[int, int, int, int]:
    """Host jiffies since boot: busy (steal included), idle plus iowait,
    steal, iowait."""
    fields = [int(v) for v in Path("/proc/stat").read_text().split("\n", 1)[0].split()[1:]]
    user, nice, system, idle, iowait, irq, softirq, steal = (fields + [0] * 8)[:8]
    return user + nice + system + irq + softirq + steal, idle + iowait, steal, iowait


def meminfo() -> dict[str, int]:
    return {
        line.split(":")[0]: int(line.split()[1]) * 1024
        for line in Path("/proc/meminfo").read_text().splitlines()
    }


class Sampler(threading.Thread):
    def __init__(self, cgroup: Path, out: Path) -> None:
        super().__init__(daemon=True)
        self.cgroup, self.rows, self.stop = cgroup, [], threading.Event()
        self.out = out
        # The first process of each kind: its command line and the rlimits
        # in force (proof of the caps a pass ran under). A parse child
        # confines itself after it starts, so one seen before that (Docker's
        # single seccomp filter) is replaced by the first confined one.
        self.first_seen: dict[str, dict] = {}

    def remember(self, name: str, pid: str, status: str) -> None:
        if name not in COUNTS or self.first_seen.get(name, {}).get("confined"):
            return
        confined = any(
            line.startswith("Seccomp_filters:") and int(line.split()[1]) > 1
            for line in status.splitlines()
        )
        if name in self.first_seen and not confined:
            return
        try:
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            limits = Path(f"/proc/{pid}/limits").read_text()
        except OSError:
            return
        keep = ("Max cpu time", "Max file size", "Max data size", "Max open files", "Max address space", "Max core file size")
        flags = ("NoNewPrivs", "Seccomp", "Uid", "CapEff")
        self.first_seen[name] = {
            "cmdline": cmdline[:2000],
            "limits": [line for line in limits.splitlines() if line.startswith(keep)],
            "status": [line for line in status.splitlines() if line.startswith(flags)],
            "confined": confined,
        }

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
        """RSS summed per process kind, plus the largest single parse child's
        RSS and virtual size, the largest VmPeak of a parse child (over its
        life, which spans documents), a LibreOffice soffice.bin and a JVM, the
        largest VmData of each, and the process count per kind."""
        totals: dict[str, int] = dict.fromkeys((*PER_PROCESS, *COUNTS.values()), 0)
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
                # A spawned parse child runs multiprocessing's spawn entry
                # point; its resource tracker counts with the API process.
                name = "child" if b"spawn_main" in cmdline else "api"

            def kib(key: str) -> int:
                return int(fields.get(key, "0 kB").split()[0]) * 1024

            rss = kib("VmRSS")
            totals[name] = totals.get(name, 0) + rss
            if name == "child":
                totals["child_max_rss"] = max(totals["child_max_rss"], rss)
                totals["child_max_vm"] = max(totals["child_max_vm"], kib("VmSize"))
            if key := VMPEAK.get(name):
                totals[key] = max(totals[key], kib("VmPeak"))
            if key := VMDATA.get(name):
                totals[key] = max(totals[key], kib("VmData"))
            if key := COUNTS.get(name):
                totals[key] += 1
                self.remember(name, pid, status)
        return totals

    def run(self) -> None:
        while not self.stop.is_set():
            stat = self.keyed("memory.stat")
            cpu = self.keyed("cpu.stat")
            rss = self.rss_by_name()
            mem = meminfo()
            busy, idle, steal, iowait = host_cpu()
            known = ("java", "api", "child", "soffice.bin", *PER_PROCESS, *COUNTS.values())
            self.rows.append(
                {
                    "t": time.time(),
                    "current": int(self.read("memory.current") or 0),
                    "anon": stat.get("anon", 0),
                    "file": stat.get("file", 0),
                    "swap": int(self.read("memory.swap.current") or 0),
                    "cpu_usec": cpu.get("usage_usec", 0),
                    "nr_throttled": cpu.get("nr_throttled", 0),
                    "throttled_usec": cpu.get("throttled_usec", 0),
                    "oom_kill": self.keyed("memory.events").get("oom_kill", 0),
                    # Tasks (threads included) against the pids limit, and
                    # forks the limit refused.
                    "pids": int(self.read("pids.current") or 0),
                    "pids_refused": self.keyed("pids.events").get("max", 0),
                    "host_available": mem["MemAvailable"],
                    "host_swap_used": mem["SwapTotal"] - mem["SwapFree"],
                    "host_busy": busy,
                    "host_idle": idle,
                    "host_steal": steal,
                    "host_iowait": iowait,
                    "java_rss": rss.get("java", 0),
                    "api_rss": rss.get("api", 0),
                    "child_rss": rss.get("child", 0),
                    "office_rss": rss.get("soffice.bin", 0),
                    **{key: rss[key] for key in (*PER_PROCESS, *COUNTS.values())},
                    "other_rss": sum(v for k, v in rss.items() if k not in known),
                }
            )
            time.sleep(0.25)

    def finish(self) -> None:
        self.stop.set()
        self.join()
        (self.out.parent / "processes.json").write_text(json.dumps(self.first_seen, indent=1))
        with self.out.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(self.rows[0]))
            writer.writeheader()
            writer.writerows(self.rows)

    def window(self, start: float, end: float) -> dict[str, float]:
        rows = [r for r in self.rows if start <= r["t"] <= end]
        if len(rows) < 2:
            return {}
        first, last = rows[0], rows[-1]
        cpu_s = (last["cpu_usec"] - first["cpu_usec"]) / 1e6
        host_total = (last["host_busy"] + last["host_idle"]) - (
            first["host_busy"] + first["host_idle"]
        )
        ncpu = os.cpu_count() or 1

        def peak(key: str) -> float:
            return round(max(r[key] for r in rows) / GIB, 2)

        return {
            "peak_current_gib": peak("current"),
            "peak_anon_gib": peak("anon"),
            "peak_swap_gib": peak("swap"),
            "peak_java_rss_gib": peak("java_rss"),
            "peak_api_rss_gib": peak("api_rss"),
            "peak_child_rss_gib": peak("child_rss"),
            "peak_office_rss_gib": peak("office_rss"),
            "peak_one_child_rss_gib": peak("child_max_rss"),
            "peak_one_child_vm_gib": peak("child_max_vm"),
            "peak_child_vmpeak_gib": peak("child_vmpeak"),
            "peak_office_vmpeak_gib": peak("office_vmpeak"),
            "peak_java_vmpeak_gib": peak("java_vmpeak"),
            "peak_java_vmdata_gib": peak("java_vmdata"),
            "peak_office_vmdata_gib": peak("office_vmdata"),
            "peak_child_vmdata_gib": peak("child_vmdata"),
            "peak_other_rss_gib": peak("other_rss"),
            "max_java": max(r["java_count"] for r in rows),
            "max_office": max(r["office_count"] for r in rows),
            "avg_cores": round(cpu_s / max(end - start, 1e-6), 2),
            "throttled_s": round((last["throttled_usec"] - first["throttled_usec"]) / 1e6, 1),
            "host_busy_cores": round(
                ncpu * (last["host_busy"] - first["host_busy"]) / max(host_total, 1), 2
            ),
            "host_steal_pct": round(
                100 * (last["host_steal"] - first["host_steal"]) / max(host_total, 1), 1
            ),
            "oom_kills": last["oom_kill"] - first["oom_kill"],
            "peak_pids": max(r["pids"] for r in rows),
            "pids_refused": last["pids_refused"] - first["pids_refused"],
            "min_host_available_gib": round(
                min(r["host_available"] for r in rows) / GIB, 2
            ),
            "peak_host_swap_gib": peak("host_swap_used"),
        }

    def busiest(self, seconds: float = 10.0) -> float:
        """The container's highest average cores over any ``seconds`` window."""
        best, j = 0.0, 0
        for i, row in enumerate(self.rows):
            while self.rows[j]["t"] < row["t"] - seconds:
                j += 1
            span = row["t"] - self.rows[j]["t"]
            if span >= seconds * 0.9:
                best = max(best, (row["cpu_usec"] - self.rows[j]["cpu_usec"]) / 1e6 / span)
        return round(best, 2)


class Watchdog(threading.Thread):
    """Ends the pass when host swap grows past ``swap_bytes`` or a watched
    container restarts: the parser container is killed, so every request
    fails at once, and the reason is written to ``abort.txt``."""

    def __init__(self, container: str, watch: list[str], swap_bytes: int, out: Path) -> None:
        super().__init__(daemon=True)
        self.container, self.watch, self.swap_bytes, self.out = container, watch, swap_bytes, out
        self.stop, self.reason = threading.Event(), ""
        self.swap0 = self.swap_used()
        self.state0 = self.states()

    @staticmethod
    def swap_used() -> int:
        mem = meminfo()
        return mem["SwapTotal"] - mem["SwapFree"]

    def states(self) -> dict[str, str]:
        if not self.watch:
            return {}
        out = subprocess.run(
            ["docker", "inspect", "-f", "{{.Name}} {{.RestartCount}} {{.State.StartedAt}} {{.State.Status}}", *self.watch],
            capture_output=True, text=True, check=False,
        ).stdout
        return {line.split()[0].lstrip("/"): line for line in out.splitlines() if line}

    def run(self) -> None:
        while not self.stop.wait(2.0):
            grown = self.swap_used() - self.swap0
            if grown > self.swap_bytes:
                self.trip(f"host swap grew {grown / GIB:.2f} GiB")
                return
            now = self.states()
            for name, line in self.state0.items():
                if now.get(name) != line:
                    self.trip(f"watched container changed: {line!r} -> {now.get(name)!r}")
                    return

    def trip(self, reason: str) -> None:
        self.reason = reason
        (self.out / "abort.txt").write_text(f"{time.strftime('%H:%M:%S')} {reason}\n")
        print(json.dumps({"abort": reason}), flush=True)
        subprocess.run(["docker", "kill", self.container], capture_output=True, check=False)


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
    suffix = Path(doc["path"]).suffix.lower() or ".pdf"
    key = f"sources/stress-{fingerprint[:16]}{suffix}"
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
    bundle = spool / body["output_key"]
    if args.keep and (not args.keep_ids or doc["id"] in args.keep_ids) and bundle.exists():
        Path(args.keep).mkdir(parents=True, exist_ok=True)
        shutil.copyfile(bundle, Path(args.keep) / f"{doc['id']}.zip")
    bundle.unlink(missing_ok=True)
    return {
        "id": doc["id"],
        "pages": doc.get("pages"),
        "status": status,
        "code": payload.get("code") or (None if status == 200 else payload.get("detail")),
        "detail": None if status == 200 else str(payload.get("detail") or "")[:300],
        "client_s": round(ended - started, 1),
        "server_s": payload.get("_server_parse_s"),
        "queue_s": round((payload.get("_queue_ms") or 0) / 1000, 1),
        # The parse child's own phases summed (Office conversion included).
        "phases_s": round((payload.get("_execution_ms") or 0) / 1000, 1),
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


def summarize(results: list[dict], sampler: Sampler, health: dict, abort: str) -> dict:
    rows = sampler.rows
    whole = sampler.window(rows[0]["t"], rows[-1]["t"])
    ok = [r for r in results if r["status"] == 200]
    return {
        "parser_version": health.get("parser_version"),
        "parse_workers": health.get("parse_workers"),
        "queue_depth": health.get("queue_depth"),
        "document_timeout_s": health.get("parse_document_timeout_s"),
        "ok": len(ok),
        "of": len(results),
        "failed": [(r["id"], r["status"], r["code"], r["detail"]) for r in results if r["status"] != 200],
        "wall_s": round(max(r["_ended"] for r in results) - min(r["_started"] for r in results), 1),
        "pages_ok": sum(r["pages"] or 0 for r in ok),
        "longest_queue_s": max((r["queue_s"] for r in ok), default=None),
        "longest_execution_s": max((r["execution_s"] or 0 for r in ok), default=None),
        "busiest_10s_cores": sampler.busiest(10.0),
        "host_swap_start_gib": round(rows[0]["host_swap_used"] / GIB, 2),
        "abort": abort or None,
        **whole,
    }


def run(args) -> None:
    docs = json.loads(Path(args.manifest).read_text())
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    spool = spool_dir(args.container)
    health = wait_healthy(args.url, args.token)
    (out / "health.json").write_text(json.dumps(health, indent=1))
    sampler = Sampler(cgroup_dir(args.container), out / f"{args.mode}-samples.csv")
    sampler.start()
    watchdog = Watchdog(
        args.container,
        [n for n in (args.watch or "").split(",") if n],
        int(args.abort_swap_gib * GIB),
        out,
    )
    watchdog.start()
    time.sleep(1)
    results: list[dict] = []
    if args.mode == "solo":
        for doc in docs:
            if watchdog.reason:
                break
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
    watchdog.stop.set()
    sampler.finish()
    with (out / f"{args.mode}.jsonl").open("w") as handle:
        for result in results:
            execution = (result["server_s"] or 0) - result["queue_s"]
            end = result["_ended"]
            start = end - execution if execution > 0 else result["_started"]
            result["execution_s"] = round(execution, 1) if execution > 0 else None
            result.update(sampler.window(start, end))
            handle.write(json.dumps({k: v for k, v in result.items() if k[0] != "_"}) + "\n")
    summary = summarize(results, sampler, health, watchdog.reason)
    (out / f"{args.mode}-summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary), flush=True)


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
        p.add_argument("--keep", help="copy bundles here before they are deleted")
        p.add_argument("--keep-ids", type=lambda v: set(filter(None, v.split(","))), default=set())
        p.add_argument("--watch", help="comma-separated containers that must not restart")
        p.add_argument("--abort-swap-gib", type=float, default=1.0)
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
