"""PP-DocLayout_plus-L beside the parser on the ingest host: runs the passes of a
plan one after another and samples what every container on the host uses.

Runs on the host, as root, with the stdlib only:

    python3 layout_capacity.py run plan.json
    python3 layout_capacity.py summarize results/ > summary.json

A plan is a list of passes, each with a name and any of:

    {"name": "d-2x2", "scenario": "d", "mode": "burst",
     "layout": {"instances": 2, "threads": 2, "cpus": 1, "shares": 128,
                "nice": 19, "no_spin": true},
     "duration": 120}

``scenario`` sends ``manifests/<scenario>.json`` through a fresh parser
container in the production shape of ``deploy/docker-compose.ingest-host.yml``,
with ``stress_parser.py``. The container has no network: the driver runs inside
its network namespace (``nsenter -n``), so no port is opened or published.
``layout`` starts that many instances of ``layout_burst.py``, each in its own
container, which take pages from the moment the parser pass starts until it
ends, or for ``duration`` seconds. A pass with neither just samples the host.

Before each pass the driver waits for the UAT stack and ``capy-library-db`` to
go quiet, or notes that they did not. Every second the sampler records each
container's CPU, CPU pressure, throttling, memory split into anon and file
cache, disk I/O and swap, the parser's CPU and RSS by process kind, and the
host's CPU, memory, swap, disk and network. Host swap past 8 GiB, or a change
in the state of a UAT container, kills this run's containers and ends the plan
with ``abort.txt``. Only containers and volumes named ``capy-layout-capacity-*``
are ever stopped or removed.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import threading
import time
from collections import defaultdict
from pathlib import Path

D = Path("/opt/capy-layout-capacity-20261104")
PARSER_SHA = "e200b841ef27b7a7bcc7223ca856935ab52b9f9a"
PARSER_IMAGE = f"capy-ingest-nonprod-parser:{PARSER_SHA}"
LAYOUT_IMAGE = "python:3.12-slim"
PREFIX = "capy-layout-capacity"
PARSER = f"{PREFIX}-parser"
SPOOL, WORK = f"{PREFIX}-spool", f"{PREFIX}-work"
UAT = [
    "capy-ingest-nonprod-parser-1",
    "capy-ingest-nonprod-parse-coordinator-uat-1",
    "capy-ingest-nonprod-worker-uat-1",
    "capy-ingest-nonprod-import-worker-uat-1",
    "capy-ingest-nonprod-host-sampler-uat-1",
]
SHARED = [*UAT, "capy-library-db", "capy-odl-agentic-db"]
GIB = 1 << 30
ABORT_SWAP = 8 * GIB
QUIET_CORES = 0.3
QUIET_TRIES = 20
TICK = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")

# The production parser's settings, as the compose file and the env example set
# them (CAPY_PARSE_WORKERS 7: Epo 2026-10-16; the 600 s deadline the same day).
PARSER_ENV = {
    "APP_ENV": "production",
    "RELEASE_SHA": PARSER_SHA,
    "PARSER_BIND_ADDRESS": "127.0.0.1",
    "CAPY_PARSE_WORKERS": "7",
    "CAPY_PARSE_QUEUE_DEPTH": "8",
    "CAPY_PARSE_DOCUMENT_TIMEOUT": "600",
    "CAPY_PARSE_OCR_PAGE_CAP": "500",
    "CAPY_PARSE_MAX_PAGES": "1400",
    "CAPY_PARSER_JVM_MAX_HEAP": "1g",
    "MALLOC_ARENA_MAX": "2",
    "CAPY_PARSE_SHARED_DIR": "/var/lib/capy-parse",
    "CAPY_OFFICE_CONVERT_TIMEOUT": "180",
    "CAPY_OFFICE_PREVIEW_MAX_BYTES": "134217728",
    "CAPY_PARSE_ARTIFACT_MAX_BYTES": "268435456",
    "CAPY_PARSE_ARTIFACT_MAX_ENTRY_BYTES": "134217728",
    "CAPY_PARSE_ARTIFACT_MAX_EXPANDED_BYTES": "536870912",
    "CAPY_PARSE_CONTENT_MAX_BYTES": "134217728",
    "CAPY_PARSE_CONTENT_MAX_BLOCKS": "250000",
}


def docker(*args: str, check: bool = True, env: dict | None = None) -> str:
    return subprocess.run(
        ["docker", *args],
        check=check,
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
    ).stdout.strip()


# ------------------------------------------------------------------ sampling


def read(path: Path) -> str:
    try:
        return path.read_text()
    except OSError:
        return ""


def keyed(path: Path) -> dict[str, int]:
    out = {}
    for line in read(path).splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("-").isdigit():
            out[parts[0]] = int(parts[1])
    return out


def pressure(path: Path) -> dict[str, int]:
    """Stall time so far, in microseconds, from a PSI file."""
    out = {}
    for line in read(path).splitlines():
        kind, *fields = line.split()
        out[kind] = int(next(f for f in fields if f.startswith("total=")).split("=")[1])
    return out


def container_row(cg: Path) -> dict:
    cpu, mem = keyed(cg / "cpu.stat"), keyed(cg / "memory.stat")
    rbytes = wbytes = 0
    for line in read(cg / "io.stat").splitlines():
        fields = dict(f.split("=") for f in line.split()[1:] if "=" in f)
        rbytes += int(fields.get("rbytes", 0))
        wbytes += int(fields.get("wbytes", 0))
    return {
        "cpu_usec": cpu.get("usage_usec", 0),
        "throttled_usec": cpu.get("throttled_usec", 0),
        "nr_throttled": cpu.get("nr_throttled", 0),
        "cpu_stall_usec": pressure(cg / "cpu.pressure").get("some", 0),
        "io_stall_usec": pressure(cg / "io.pressure").get("some", 0),
        "mem_stall_usec": pressure(cg / "memory.pressure").get("some", 0),
        "current": int(read(cg / "memory.current") or 0),
        "peak": int(read(cg / "memory.peak") or 0),
        "anon": mem.get("anon", 0),
        "file": mem.get("file", 0),
        "shmem": mem.get("shmem", 0),
        "swap": int(read(cg / "memory.swap.current") or 0),
        "oom_kill": keyed(cg / "memory.events").get("oom_kill", 0),
        "pids": int(read(cg / "pids.current") or 0),
        "rbytes": rbytes,
        "wbytes": wbytes,
    }


def host_row() -> dict:
    stat = read(Path("/proc/stat")).split("\n", 1)[0].split()[1:]
    user, nice, system, idle, iowait, irq, softirq, steal = [int(v) for v in stat[:8]]
    mem = {
        line.split(":")[0]: int(line.split()[1]) * 1024
        for line in read(Path("/proc/meminfo")).splitlines()
    }
    vm = keyed(Path("/proc/vmstat"))
    net = {}
    for line in read(Path("/proc/net/dev")).splitlines()[2:]:
        name, rest = line.split(":")
        fields = rest.split()
        net[name.strip()] = [int(fields[0]), int(fields[8])]
    disk = [0, 0]
    for line in read(Path("/proc/diskstats")).splitlines():
        fields = line.split()
        if fields[2] == "vda":
            disk = [int(fields[5]) * 512, int(fields[9]) * 512]
    return {
        "user": user,
        "nice": nice,
        "system": system + irq + softirq,
        "idle": idle,
        "iowait": iowait,
        "steal": steal,
        "available": mem["MemAvailable"],
        "free": mem["MemFree"],
        "cached": mem["Cached"] + mem["Buffers"],
        "anon": mem["AnonPages"],
        "swap_used": mem["SwapTotal"] - mem["SwapFree"],
        "pswpin": vm.get("pswpin", 0),
        "pswpout": vm.get("pswpout", 0),
        "oom_kill": vm.get("oom_kill", 0),
        "net": net,
        "disk": disk,
        "cpu_stall_usec": pressure(Path("/proc/pressure/cpu")).get("some", 0),
        "mem_stall_usec": pressure(Path("/proc/pressure/memory")).get("some", 0),
        "io_stall_usec": pressure(Path("/proc/pressure/io")).get("some", 0),
        "load1": float(read(Path("/proc/loadavg")).split()[0]),
    }


class Kinds:
    """The parser's CPU seconds and RSS by process kind, from /proc: Java, the
    parse children (font repair, flattening, refinement, page renders), the API
    process and LibreOffice."""

    def __init__(self) -> None:
        self.last: dict[str, float] = {}
        self.cpu: dict[str, float] = defaultdict(float)

    @staticmethod
    def kind(pid: str, comm: str) -> str:
        if comm == "java":
            return "java"
        if comm == "soffice.bin":
            return "office"
        if comm.startswith("python") or comm == "uvicorn":
            cmdline = read(Path(f"/proc/{pid}/cmdline"))
            return "child" if "spawn_main" in cmdline else "api"
        return "other"

    def update(self, cg: Path) -> dict:
        rss: dict[str, int] = defaultdict(int)
        for pid in read(cg / "cgroup.procs").split():
            raw = read(Path(f"/proc/{pid}/stat"))
            if not raw:
                continue
            end = raw.rindex(")")
            comm, fields = raw[raw.index("(") + 1 : end], raw[end + 2 :].split()
            cpu = (int(fields[11]) + int(fields[12])) / TICK
            kind = self.kind(pid, comm)
            self.cpu[kind] += max(0.0, cpu - self.last.get(pid, 0.0))
            self.last[pid] = cpu
            rss[kind] += int(fields[21]) * PAGE
        return {"cpu": dict(self.cpu), "rss": dict(rss)}


def uat_state() -> dict[str, str]:
    fmt = (
        "{{.Name}} {{.RestartCount}} {{.State.StartedAt}} {{.State.Status}} "
        "{{if .State.Health}}{{.State.Health.Status}}{{end}}"
    )
    out = docker("inspect", "-f", fmt, *UAT, check=False)
    return {line.split()[0].lstrip("/"): line for line in out.splitlines() if line}


class Sampler(threading.Thread):
    def __init__(self, out: Path, on_abort) -> None:
        super().__init__(daemon=True)
        self.out, self.on_abort = out, on_abort
        self.halt = threading.Event()
        self.ids: dict[str, str] = {}
        self.kinds = Kinds()
        self.uat0 = uat_state()
        self.aborted = ""
        self.ticks = 0

    def refresh(self) -> None:
        self.ids = dict(
            line.split()
            for line in docker(
                "ps", "--no-trunc", "--format", "{{.Names}} {{.ID}}"
            ).splitlines()
        )

    def disk_used(self) -> dict[str, int]:
        out = {}
        for volume in (SPOOL, WORK):
            path = Path(f"/var/lib/docker/volumes/{volume}/_data")
            if path.exists():
                got = subprocess.run(
                    ["du", "-sb", str(path)],
                    capture_output=True,
                    text=True,
                    check=False,
                ).stdout
                out[volume] = int(got.split()[0]) if got else 0
        return out

    def run(self) -> None:
        with self.out.open("w", buffering=1) as log:
            while not self.halt.is_set():
                began = time.time()
                if self.ticks % 5 == 0:
                    self.refresh()
                row: dict = {"t": began, "host": host_row(), "containers": {}}
                for name, cid in self.ids.items():
                    cg = Path(f"/sys/fs/cgroup/system.slice/docker-{cid}.scope")
                    if cg.exists():
                        row["containers"][name] = container_row(cg)
                        if name == PARSER:
                            row["kinds"] = self.kinds.update(cg)
                if self.ticks % 10 == 0:
                    row["volumes"] = self.disk_used()
                log.write(json.dumps(row) + "\n")
                self.watch(row)
                self.ticks += 1
                self.halt.wait(max(0.0, 1.0 - (time.time() - began)))

    def watch(self, row: dict) -> None:
        reason = ""
        if row["host"]["swap_used"] > ABORT_SWAP:
            reason = f"host swap at {row['host']['swap_used'] / GIB:.2f} GiB"
        elif self.ticks % 5 == 0:
            now = uat_state()
            for name, line in self.uat0.items():
                if now.get(name) != line:
                    reason = f"UAT container changed: {line!r} -> {now.get(name)!r}"
        if reason and not self.aborted:
            self.aborted = reason
            self.on_abort(reason)


def cores_over(names: list[str], seconds: float) -> dict[str, float]:
    ids = dict(
        line.split()
        for line in docker(
            "ps", "--no-trunc", "--format", "{{.Names}} {{.ID}}"
        ).splitlines()
    )

    def usage() -> dict[str, int]:
        return {
            n: keyed(
                Path(f"/sys/fs/cgroup/system.slice/docker-{ids[n]}.scope/cpu.stat")
            ).get("usage_usec", 0)
            for n in names
            if n in ids
        }

    first = usage()
    time.sleep(seconds)
    last = usage()
    return {n: round((last[n] - first[n]) / 1e6 / seconds, 3) for n in first}


def wait_quiet() -> dict:
    """Wait until the shared containers are idle; note it if they stay busy."""
    for attempt in range(QUIET_TRIES):
        cores = cores_over(SHARED, 10)
        if sum(cores.values()) < QUIET_CORES:
            return {"quiet": True, "waited_tries": attempt, "cores": cores}
        print(f"  shared containers busy, waiting: {cores}", flush=True)
        time.sleep(20)
    return {"quiet": False, "waited_tries": QUIET_TRIES, "cores": cores}


# ---------------------------------------------------------------- containers


def remove_own() -> None:
    names = docker(
        "ps", "-a", "--filter", f"name=^/{PREFIX}-", "--format", "{{.Names}}"
    )
    for name in names.split():
        docker("rm", "-f", name, check=False)
    for volume in (SPOOL, WORK):
        docker("volume", "rm", volume, check=False)


def start_parser(workers: str) -> tuple[str, str]:
    """A fresh parser in the production shape, without a network."""
    token = secrets.token_urlsafe(48)
    docker("volume", "create", SPOOL)
    docker("volume", "create", WORK)
    docker(
        "run", "--rm", "--network", "none",
        "-v", f"{SPOOL}:/var/lib/capy-parse", "-v", f"{WORK}:/run/capy-parser/work",
        "alpine:3.20", "sh", "-c",
        "mkdir -p /var/lib/capy-parse/sources /var/lib/capy-parse/artifacts "
        "/var/lib/capy-parse/quarantine && chown -R 10001:10001 /var/lib/capy-parse "
        "&& chmod 2770 /var/lib/capy-parse /var/lib/capy-parse/sources "
        "/var/lib/capy-parse/artifacts /var/lib/capy-parse/quarantine "
        "&& chown 10001:10001 /run/capy-parser/work && chmod 0700 /run/capy-parser/work",
    )  # fmt: skip
    env = {**PARSER_ENV, "CAPY_PARSE_WORKERS": workers}
    args = [
        "run", "-d", "--name", PARSER,
        # The image carries the UAT stack's compose labels, and the release check
        # and the ingest watchdog count parsers by them: a container left with
        # them fails the check (2026-11-04 report, What this run disturbed).
        "--label",
        f"com.docker.compose.project={PREFIX}",
        "--label",
        "com.docker.compose.service=throwaway-parser", "--network", "none",
        "--cpus", "8", "--memory", "14g", "--memory-swap", "18g", "--pids-limit", "512",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--tmpfs", "/run/capy-parser/home:noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
        "-v", f"{SPOOL}:/var/lib/capy-parse", "-v", f"{WORK}:/run/capy-parser/work",
        "-e", "PARSER_TOKEN",
    ]  # fmt: skip
    for key, value in env.items():
        args += ["-e", f"{key}={value}"]
    args += [PARSER_IMAGE, "uvicorn", "app:app", "--app-dir", "/app/parser",
             "--host", "127.0.0.1", "--port", "8090", "--workers", "1"]  # fmt: skip
    docker(*args, env={"PARSER_TOKEN": token})
    return token, docker("inspect", "-f", "{{.State.Pid}}", PARSER)


def start_layouts(spec: dict, run: Path) -> list[str]:
    names = []
    for n in range(1, spec["instances"] + 1):
        name = f"{PREFIX}-layout-{n}"
        args = [
            "run", "-d", "--name", name, "--network", "none",
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "64",
            "--tmpfs", "/tmp:size=16m", "-e", "PYTHONDONTWRITEBYTECODE=1",
            "-v", f"{D}/venv:/venv:ro",
            "-v", f"{D}/models/PP-DocLayout_plus-L_onnx:/models/plus-l:ro",
            "-v", f"{D}/pages:/pages:ro", "-v", f"{D}/scripts:/scripts:ro",
            "-v", f"{run}:/run-dir",
        ]  # fmt: skip
        if spec.get("cpus"):
            args += ["--cpus", str(spec["cpus"])]
        if spec.get("shares"):
            args += ["--cpu-shares", str(spec["shares"])]
        args += [
            LAYOUT_IMAGE, "/venv/bin/python", "/scripts/layout_burst.py",
            "--name", f"layout-{n}", "--threads", str(spec["threads"]),
            "--model", "/models/plus-l", "--pages", "/pages", "--run", "/run-dir",
        ]  # fmt: skip
        if spec.get("nice"):
            args += ["--nice", str(spec["nice"])]
        if spec.get("no_spin"):
            args.append("--no-spin")
        docker(*args)
        names.append(name)
    deadline = time.time() + 120
    while not all(
        (run / f"layout-{n}.ready").exists() for n in range(1, len(names) + 1)
    ):
        if time.time() > deadline:
            raise SystemExit("a layout instance never became ready")
        time.sleep(0.2)
    return names


def run_pass(spec: dict) -> bool:
    """Runs one pass; False when the plan must stop."""
    name = spec["name"]
    out = D / "results" / name
    (out / "run").mkdir(parents=True)
    run = out / "run"
    (run / "counter").write_text("0")
    print(f"=== {name} {time.strftime('%H:%M:%S')} {json.dumps(spec)}", flush=True)
    meta: dict = {"spec": spec, "before": wait_quiet()}
    remove_own()

    def on_abort(reason: str) -> None:
        (out / "abort.txt").write_text(f"{time.strftime('%H:%M:%S')} {reason}\n")
        print(f"ABORT {name}: {reason}", flush=True)
        (run / "stop").touch()
        names = docker("ps", "--filter", f"name=^/{PREFIX}-", "--format", "{{.Names}}")
        for container in names.split():
            docker("kill", container, check=False)

    sampler = Sampler(out / "samples.jsonl", on_abort)
    scenario = spec.get("scenario")
    token, pid = ("", "")
    if scenario:
        token, pid = start_parser(str(spec.get("workers", 7)))
    sampler.start()
    time.sleep(3)
    layouts = start_layouts(spec["layout"], run) if spec.get("layout") else []
    meta["t_go"] = time.time()
    (run / "go").touch()
    if scenario:
        mode = spec.get("mode", "burst")
        command = [
            "nsenter", "-t", pid, "-n", "python3", str(D / "scripts/stress_parser.py"),
            mode, "--manifest", str(D / "manifests" / f"{scenario}.json"),
            "--out", str(out / "parser"), "--container", PARSER,
            "--url", "http://127.0.0.1:8090", "--tag", f"{name}-{secrets.token_hex(4)}",
            "--watch", ",".join(UAT), "--abort-swap-gib", "8",
        ]  # fmt: skip
        with (out / "parser.log").open("w") as log:
            subprocess.run(
                command,
                stdout=log,
                stderr=subprocess.STDOUT,
                env={**os.environ, "PARSER_TOKEN": token},
                check=False,
            )
    else:
        deadline = time.time() + spec.get("duration", 60)
        while time.time() < deadline and not sampler.aborted:
            time.sleep(0.5)
    meta["t_end"] = time.time()
    # The cgroup's lifetime peak, before the containers go.
    meta["peaks"] = {}
    for container in [*layouts, *([PARSER] if scenario else [])]:
        cid = docker("inspect", "-f", "{{.Id}}", container, check=False)
        meta["peaks"][container] = {
            "memory_peak": int(
                read(
                    Path(f"/sys/fs/cgroup/system.slice/docker-{cid}.scope/memory.peak")
                )
                or 0
            ),
            "cpu_weight": read(
                Path(f"/sys/fs/cgroup/system.slice/docker-{cid}.scope/cpu.weight")
            ).strip(),
            "cpu_max": read(
                Path(f"/sys/fs/cgroup/system.slice/docker-{cid}.scope/cpu.max")
            ).strip(),
        }
    (run / "stop").touch()
    deadline = time.time() + 60
    while time.time() < deadline and any(
        docker("ps", "-q", "--filter", f"name=^/{c}$", check=False) for c in layouts
    ):
        time.sleep(0.5)
    for container in [*layouts, *([PARSER] if scenario else [])]:
        logs = subprocess.run(
            ["docker", "logs", "--tail", "400", container],
            capture_output=True,
            text=True,
            check=False,
        )
        (out / f"{container}.log").write_text(
            logs.stdout[-200_000:] + logs.stderr[-200_000:]
        )
        meta.setdefault("exit", {})[container] = docker(
            "inspect",
            "-f",
            "{{.State.ExitCode}} oom={{.State.OOMKilled}}",
            container,
            check=False,
        )
    sampler.halt.set()
    sampler.join()
    meta["uat_after"] = uat_state()
    meta["aborted"] = sampler.aborted
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    remove_own()
    return not sampler.aborted


# ------------------------------------------------------------------- summary


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[min(len(ordered) - 1, round(q * (len(ordered) - 1)))]


def layout_stats(run: Path) -> dict | None:
    rows, done = [], {}
    for path in sorted(run.glob("layout-*.jsonl")):
        rows += [json.loads(line) for line in path.read_text().splitlines()]
    for path in sorted(run.glob("layout-*.done")):
        done[path.stem] = json.loads(path.read_text())
    if not rows:
        return None
    walls = [r["end"] - r["start"] for r in rows]
    bursts: dict[int, list[dict]] = defaultdict(list)
    for r in rows:
        bursts[r["burst"]].append(r)
    whole = [
        max(r["end"] for r in pages) - min(r["start"] for r in pages)
        for pages in bursts.values()
        if len(pages) == 40
    ]
    span = max(r["end"] for r in rows) - min(r["start"] for r in rows)
    return {
        "pages": len(rows),
        "span_s": round(span, 1),
        "pages_per_s": round(len(rows) / span, 2),
        "page_p50_s": round(percentile(walls, 0.5), 3),
        "page_p95_s": round(percentile(walls, 0.95), 3),
        "page_max_s": round(max(walls), 3),
        "page_cpu_p50_s": round(percentile([r["cpu"] for r in rows], 0.5), 3),
        "bursts": len(whole),
        "burst_p50_s": round(percentile(whole, 0.5), 1) if whole else None,
        "burst_max_s": round(max(whole), 1) if whole else None,
        "bursts_per_hour": round(3600 * len(rows) / span / 40),
        "instances": done,
    }


def window_stats(samples: list[dict]) -> dict:
    first, last = samples[0], samples[-1]
    span = last["t"] - first["t"]
    h0, h1 = first["host"], last["host"]
    jiffies = sum(
        h1[k] - h0[k] for k in ("user", "nice", "system", "idle", "iowait", "steal")
    )
    ncpu = os.cpu_count() or 8

    def host_cores(*keys: str) -> float:
        return round(ncpu * sum(h1[k] - h0[k] for k in keys) / max(jiffies, 1), 2)

    containers = {}
    for name in last["containers"]:
        rows = [s["containers"][name] for s in samples if name in s["containers"]]
        c0, c1 = rows[0], rows[-1]
        seconds = max(span, 1e-6)
        containers[name] = {
            "cores": round((c1["cpu_usec"] - c0["cpu_usec"]) / 1e6 / seconds, 3),
            "cpu_s": round((c1["cpu_usec"] - c0["cpu_usec"]) / 1e6, 1),
            "cpu_stall_share": round(
                (c1["cpu_stall_usec"] - c0["cpu_stall_usec"]) / 1e6 / seconds, 3
            ),
            "throttled_s": round(
                (c1["throttled_usec"] - c0["throttled_usec"]) / 1e6, 1
            ),
            "peak_current_gib": round(max(r["current"] for r in rows) / GIB, 3),
            "peak_anon_gib": round(max(r["anon"] for r in rows) / GIB, 3),
            "peak_file_gib": round(max(r["file"] for r in rows) / GIB, 3),
            "peak_swap_gib": round(max(r["swap"] for r in rows) / GIB, 3),
            "read_mib": round((c1["rbytes"] - c0["rbytes"]) / 2**20, 1),
            "write_mib": round((c1["wbytes"] - c0["wbytes"]) / 2**20, 1),
            "oom_kills": c1["oom_kill"] - c0["oom_kill"],
            "peak_pids": max(r["pids"] for r in rows),
        }
    net = {
        iface: [
            round((h1["net"][iface][i] - h0["net"][iface][i]) / 2**20, 1)
            for i in (0, 1)
        ]
        for iface in h1["net"]
        if iface in h0["net"]
    }
    out = {
        "span_s": round(span, 1),
        "host": {
            "busy_cores": host_cores("user", "nice", "system", "steal"),
            "user_cores": host_cores("user"),
            "nice_cores": host_cores("nice"),
            "system_cores": host_cores("system"),
            "iowait_cores": host_cores("iowait"),
            "steal_cores": host_cores("steal"),
            "idle_cores": host_cores("idle"),
            "min_available_gib": round(
                min(s["host"]["available"] for s in samples) / GIB, 2
            ),
            "min_free_gib": round(min(s["host"]["free"] for s in samples) / GIB, 2),
            "max_cached_gib": round(max(s["host"]["cached"] for s in samples) / GIB, 2),
            "min_cached_gib": round(min(s["host"]["cached"] for s in samples) / GIB, 2),
            "max_anon_gib": round(max(s["host"]["anon"] for s in samples) / GIB, 2),
            "swap_start_gib": round(h0["swap_used"] / GIB, 3),
            "swap_peak_gib": round(
                max(s["host"]["swap_used"] for s in samples) / GIB, 3
            ),
            "pswpin": h1["pswpin"] - h0["pswpin"],
            "pswpout": h1["pswpout"] - h0["pswpout"],
            "oom_kills": h1["oom_kill"] - h0["oom_kill"],
            "disk_read_mib": round((h1["disk"][0] - h0["disk"][0]) / 2**20, 1),
            "disk_write_mib": round((h1["disk"][1] - h0["disk"][1]) / 2**20, 1),
            "cpu_stall_share": round(
                (h1["cpu_stall_usec"] - h0["cpu_stall_usec"]) / 1e6 / max(span, 1e-6), 3
            ),
            "io_stall_share": round(
                (h1["io_stall_usec"] - h0["io_stall_usec"]) / 1e6 / max(span, 1e-6), 3
            ),
            "mem_stall_share": round(
                (h1["mem_stall_usec"] - h0["mem_stall_usec"]) / 1e6 / max(span, 1e-6), 3
            ),
            "net_rx_tx_mib": net,
            "peak_load1": max(s["host"]["load1"] for s in samples),
        },
        "containers": containers,
    }
    kinds = [s["kinds"] for s in samples if "kinds" in s]
    if kinds:
        out["parser_kinds"] = {
            kind: {
                "cpu_s": round(
                    kinds[-1]["cpu"].get(kind, 0) - kinds[0]["cpu"].get(kind, 0), 1
                ),
                "cores": round(
                    (kinds[-1]["cpu"].get(kind, 0) - kinds[0]["cpu"].get(kind, 0))
                    / max(span, 1e-6),
                    2,
                ),
                "peak_rss_gib": round(
                    max(k["rss"].get(kind, 0) for k in kinds) / GIB, 2
                ),
            }
            for kind in set().union(*(k["cpu"] for k in kinds))
        }
    volumes = [s["volumes"] for s in samples if "volumes" in s]
    if volumes:
        out["peak_volumes_mib"] = {
            v: round(max(x.get(v, 0) for x in volumes) / 2**20, 1)
            for v in (SPOOL, WORK)
        }
    return out


def summarize(results: Path) -> dict:
    out = {}
    for path in sorted(results.iterdir()):
        meta_path = path / "meta.json"
        if not meta_path.exists():
            continue
        meta = json.loads(meta_path.read_text())
        samples = [
            json.loads(line)
            for line in (path / "samples.jsonl").read_text().splitlines()
        ]
        inside = [
            s for s in samples if meta["t_go"] <= s["t"] <= meta["t_end"]
        ] or samples
        entry: dict = {
            "spec": meta["spec"],
            "before": meta["before"],
            "aborted": meta.get("aborted"),
            "peaks": meta.get("peaks"),
            "exit": meta.get("exit"),
            "window": window_stats(inside),
        }
        layout = layout_stats(path / "run")
        if layout:
            entry["layout"] = layout
        for mode in ("burst", "solo"):
            jsonl = path / "parser" / f"{mode}.jsonl"
            if jsonl.exists():
                docs = [json.loads(line) for line in jsonl.read_text().splitlines()]
                entry["documents"] = [
                    {
                        **{
                            k: d.get(k)
                            for k in (
                                "id",
                                "pages",
                                "status",
                                "code",
                                "client_s",
                                "queue_s",
                                "execution_s",
                                "phases_s",
                                "avg_cores",
                                "peak_current_gib",
                                "peak_anon_gib",
                                "peak_swap_gib",
                                "peak_host_swap_gib",
                                "min_host_available_gib",
                                "oom_kills",
                            )
                        },
                        "phases": d.get("phases"),
                    }
                    for d in docs
                ]
                entry["parser"] = json.loads(
                    (path / "parser" / f"{mode}-summary.json").read_text()
                )
        out[path.name] = entry
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run")
    r.add_argument("plan", type=Path)
    s = sub.add_parser("summarize")
    s.add_argument("results", type=Path)
    args = parser.parse_args()
    if args.command == "summarize":
        print(json.dumps(summarize(args.results), indent=1))
        return
    for spec in json.loads(args.plan.read_text()):
        if (D / "results" / spec["name"] / "meta.json").exists():
            print(f"=== {spec['name']} already done", flush=True)
            continue
        if not run_pass(spec):
            print("PLAN STOPPED", flush=True)
            raise SystemExit(1)
        time.sleep(15)
    print("PLAN DONE", flush=True)


if __name__ == "__main__":
    main()
