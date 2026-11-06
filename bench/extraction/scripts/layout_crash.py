"""Crash tests for the layout prototype (``layout_service.py``) on the ingest host:
two instances, simulated callers, faults one at a time.

Runs on the host, as root, with the stdlib only, beside ``layout_capacity.py``,
whose sampler, safety stops and parser it reuses:

    python3 layout_crash.py run NAME --cases kill9,docker_kill,kill_both ...
    python3 layout_crash.py summarize results/crash-NAME

The instances and the callers sit on a private ``--internal`` Docker network with
no published port. Instances run with ``--init``, ``--restart unless-stopped``
and a Docker health check, as the real stack would. Every fault is logged with
its time. The callers' page records, the probes and the instances' own logs then
give, per case: seconds until the instance answers again, what became of the
requests in flight, whether every page came back exactly once, how the other
instance coped, and how much work was done twice.

Only containers, volumes and the network named ``capy-layout-capacity-*`` are
touched.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

from layout_capacity import (
    D,
    LAYOUT_IMAGE,
    PARSER,
    PREFIX,
    UAT,
    Sampler,
    docker,
    percentile,
    read,
    remove_own,
    start_parser,
    wait_quiet,
)

NET = f"{PREFIX}-net"
CALLERS = f"{PREFIX}-callers"
HOLD_S = 15
# The ingest watchdog's numbers (deploy/ansible/ingest-host/files/capy_ingest_watchdog.py).
WATCHDOG_POLL_S = 15
WATCHDOG_FAILURES = 3


def container(n: int) -> str:
    return f"{PREFIX}-layout-{n}"


class Bench:
    def __init__(self, args) -> None:
        self.args = args
        self.out = D / "results" / f"crash-{args.name}"
        self.run_dir = self.out / "run"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.events = (self.out / "events.jsonl").open("a", buffering=1)
        self.aborted = ""
        self.suffix = ""

    def event(self, what: str, **values) -> float:
        now = time.time()
        self.events.write(json.dumps({"t": now, "what": what, **values}) + "\n")
        print(f"  {time.strftime('%H:%M:%S')} {what} {values or ''}", flush=True)
        return now

    def start_instance(
        self, n: int, memory: str = "2g", kill_after: int | None = None
    ) -> None:
        args = self.args
        kill_after = args.kill_after if kill_after is None else kill_after
        health = "/venv/bin/python /scripts/layout_health.py"
        if kill_after:
            health += f" --kill-after {kill_after}"
        command = [
            "run", "-d", "--name", container(n), "--network", NET,
            "--network-alias", "layout", "--network-alias", f"layout-{n}",
            "--init", "--restart", "unless-stopped",
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--memory", memory, "--memory-swap", memory, "--pids-limit", "64",
            "--tmpfs", "/tmp:size=16m", "-e", "PYTHONDONTWRITEBYTECODE=1",
            "--health-cmd", health, "--health-interval", f"{args.health_interval}s",
            "--health-timeout", "3s", "--health-retries", "3", "--health-start-period", "10s",
            "-v", f"{D}/venv:/venv:ro",
            "-v", f"{D}/models/PP-DocLayout_plus-L_onnx:/models/plus-l:ro",
            "-v", f"{D}/scripts:/scripts:ro", "-v", f"{self.run_dir}:/run-dir",
        ]  # fmt: skip
        if args.cpus:
            command += ["--cpus", str(args.cpus)]
        if args.shares:
            command += ["--cpu-shares", str(args.shares)]
        command += [
            LAYOUT_IMAGE, "/venv/bin/python", "/scripts/layout_service.py",
            "--name", f"layout-{n}", "--threads", str(args.threads), "--depth", str(args.depth),
            "--model", "/models/plus-l", "--log", f"/run-dir/layout-{n}.jsonl",
        ]  # fmt: skip
        if args.no_spin:
            command.append("--no-spin")
        if args.nice:
            command += ["--nice", str(args.nice)]
        docker(*command)

    def start_callers(self, timeout: float, bound: float, suffix: str = "") -> None:
        args = self.args
        self.suffix = suffix
        docker("rm", "-f", CALLERS, check=False)
        docker(
            "run", "-d", "--name", CALLERS, "--network", NET,
            "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--memory", "512m", "--memory-swap", "512m", "--pids-limit", "128",
            "-e", "PYTHONDONTWRITEBYTECODE=1",
            "-v", f"{D}/pages:/pages:ro", "-v", f"{D}/scripts:/scripts:ro",
            "-v", f"{self.run_dir}:/run-dir",
            LAYOUT_IMAGE, "python", "/scripts/layout_callers.py",
            "--pool", "layout", "--pages", "/pages", "--run", "/run-dir",
            "--callers", str(args.callers), "--window", str(args.window),
            "--timeout", str(timeout), "--bound", str(bound), f"--suffix={suffix}",
            *(["--avoid-failed"] if args.avoid_failed else []),
            "--probe", ",".join(f"layout-{n}" for n in (1, 2)[: args.instances]),
        )  # fmt: skip

    def stop_callers(self) -> None:
        (self.run_dir / f"callers-stop{self.suffix}").touch()
        deadline = time.time() + 180
        while time.time() < deadline and docker(
            "ps", "-q", "--filter", f"name=^/{CALLERS}$"
        ):
            time.sleep(0.5)
        docker("rm", "-f", CALLERS, check=False)

    def probe_rows(self) -> list[dict]:
        rows = []
        for path in self.run_dir.glob("probe*.jsonl"):
            rows += [json.loads(line) for line in read(path).splitlines()]
        return sorted(rows, key=lambda r: r["t"])

    def probe_state(self) -> dict[str, bool]:
        return {row["instance"]: row["up"] for row in self.probe_rows()}

    def probe_since(self, instance: str, since: float) -> list[dict]:
        return [
            r
            for r in self.probe_rows()
            if r["instance"] == instance and r["t"] >= since
        ]

    def set_memory(self, n: int, value: str) -> None:
        """A limit on a live or restarting instance; Docker may refuse mid-restart."""
        for _ in range(40):
            got = subprocess.run(
                [
                    "docker",
                    "update",
                    "--memory",
                    value,
                    "--memory-swap",
                    value,
                    container(n),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if got.returncode == 0:
                return
            time.sleep(0.5)
        self.event("update_failed", detail=got.stderr[:200])

    def wait_up(
        self, ns: list[int], since: float, limit: float = 180.0
    ) -> dict[int, float | None]:
        """Each instance's first answer after a time, seen by its probe."""
        deadline = time.time() + limit
        found: dict[int, float | None] = dict.fromkeys(ns)
        while time.time() < deadline and any(v is None for v in found.values()):
            if self.aborted:
                break
            for n in ns:
                if found[n] is None:
                    rows = self.probe_since(f"layout-{n}", since)
                    downed = False
                    for row in rows:
                        if not row["up"]:
                            downed = True
                        elif downed:
                            found[n] = row["t"]
                            break
            time.sleep(0.2)
        return found

    def wait_all_up(self, limit: float = 90.0) -> None:
        deadline = time.time() + limit
        want = {f"layout-{n}" for n in (1, 2)[: self.args.instances]}
        while time.time() < deadline and not self.aborted:
            state = self.probe_state()
            if all(state.get(i) for i in want):
                return
            time.sleep(0.2)
        raise SystemExit(f"instances not up after {limit}s: {self.probe_state()}")

    @staticmethod
    def serving_pid(n: int) -> int:
        cid = docker("inspect", "-f", "{{.Id}}", container(n))
        procs = read(
            Path(f"/sys/fs/cgroup/system.slice/docker-{cid}.scope/cgroup.procs")
        )
        for pid in procs.split():
            command = read(Path(f"/proc/{pid}/cmdline")).split("\0")
            # The init names the script too.
            if "python" in command[0] and "layout_service.py" in " ".join(command):
                return int(pid)
        raise RuntimeError(f"no serving process in {container(n)}")

    def state(self, n: int) -> str:
        return docker(
            "inspect", "-f",
            "{{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} "
            "exit={{.State.ExitCode}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}",
            container(n), check=False,
        )  # fmt: skip

    # ---------------------------------------------------------------- cases

    def settle(self) -> None:
        self.wait_all_up()
        time.sleep(self.args.settle)

    def case_steady(self, seconds: int = 60) -> None:
        self.event("case", case="steady")
        time.sleep(seconds)
        self.event("case_end", case="steady")

    def fault_and_recover(self, case: str, ns: list[int], act) -> None:
        self.settle()
        t = self.event("case", case=case, instances=ns)
        act()
        found = self.wait_up(ns, t)
        self.event("recovered", case=case, up={str(k): v for k, v in found.items()})
        time.sleep(HOLD_S)
        self.event("case_end", case=case, states={n: self.state(n) for n in ns})

    def case_kill9(self, rep: int = 1) -> None:
        def act() -> None:
            os.kill(self.serving_pid(1), signal.SIGKILL)

        self.fault_and_recover(f"kill9-{rep}", [1], act)

    def case_docker_kill(self) -> None:
        """``docker kill`` counts as a manual stop on some Docker versions: give
        the restart policy 30 s, then start it by hand and say so."""
        self.settle()
        t = self.event("case", case="docker_kill", instances=[2])
        docker("kill", container(2))
        found = {2: None}
        deadline = time.time() + 30
        while time.time() < deadline and found[2] is None:
            found = self.wait_up([2], t, limit=1.0)
        self.event(
            "policy_after_docker_kill",
            case="docker_kill",
            restarted=found[2] is not None,
            state=self.state(2),
        )
        if found[2] is None:
            self.event("manual_start", case="docker_kill")
            docker("start", container(2))
            found = self.wait_up([2], t)
        self.event("recovered", case="docker_kill", up={"2": found[2]})
        time.sleep(HOLD_S)
        self.event("case_end", case="docker_kill", states={2: self.state(2)})

    def case_kill_init(self) -> None:
        """The whole instance dies without Docker being asked: its PID 1 is killed."""

        def act() -> None:
            os.kill(
                int(docker("inspect", "-f", "{{.State.Pid}}", container(2))),
                signal.SIGKILL,
            )

        self.fault_and_recover("kill_init", [2], act)

    def case_oom_spike(self) -> None:
        """One allocation past a tight limit: the kernel kills the serving process."""
        self.settle()
        self.set_memory(1, "800m")
        t = self.event("case", case="oom_spike", instances=[1], limit="800m")
        subprocess.Popen(
            [
                "docker", "exec", CALLERS, "python", "-c",
                "import urllib.request as u;"
                "u.urlopen(u.Request('http://layout-1:80/debug/allocate?mib=1200',"
                "data=b''),timeout=60)",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )  # fmt: skip
        found = self.wait_up([1], t)
        self.event(
            "recovered", case="oom_spike", up={"1": found[1]}, state=self.state(1)
        )
        time.sleep(HOLD_S)
        self.set_memory(1, "2g")
        self.event("case_end", case="oom_spike", states={1: self.state(1)})

    def case_oom_loop(self) -> None:
        """A limit too small for the model's peak: killed on every page until
        someone raises it. How do callers fare, and what does Docker do?"""
        self.settle()
        t = self.event("case", case="oom_loop", instances=[1], limit="450m")
        self.set_memory(1, "450m")
        for _ in range(12):
            time.sleep(5)
            self.event("oom_loop_state", case="oom_loop", state=self.state(1))
        self.event("restore_limit", case="oom_loop")
        self.set_memory(1, "2g")
        deadline = time.time() + 120
        while time.time() < deadline and not self.probe_state().get("layout-1"):
            time.sleep(0.2)
        self.event("recovered", case="oom_loop", up={"1": time.time()}, since=t)
        time.sleep(HOLD_S)
        self.event("case_end", case="oom_loop", states={1: self.state(1)})

    def case_hang_nothing(self) -> None:
        """A stopped process under the restart policy alone: nothing restarts it."""
        self.settle()
        pid = self.serving_pid(1)
        self.event("case", case="hang_nothing", instances=[1])
        os.kill(pid, signal.SIGSTOP)
        deadline = time.time() + 45
        while time.time() < deadline:
            time.sleep(5)
            self.event("hang_state", case="hang_nothing", state=self.state(1))
        self.event("resume_by_hand", case="hang_nothing")
        os.kill(pid, signal.SIGCONT)
        time.sleep(HOLD_S)
        self.event("case_end", case="hang_nothing", states={1: self.state(1)})

    def case_hang_watchdog(self) -> None:
        """The ingest watchdog's logic: three polls 15 s apart that find the
        health check unhealthy, then ``docker restart``."""
        self.settle()
        t = self.event("case", case="hang_watchdog", instances=[1])
        os.kill(self.serving_pid(1), signal.SIGSTOP)
        failures = 0
        while failures < WATCHDOG_FAILURES:
            time.sleep(WATCHDOG_POLL_S)
            failures = failures + 1 if "health=unhealthy" in self.state(1) else 0
            self.event("watchdog_poll", case="hang_watchdog", failures=failures)
        self.event("watchdog_restart", case="hang_watchdog")
        docker("restart", container(1))
        self.event("restart_returned", case="hang_watchdog")
        found = self.wait_up([1], t)
        self.event("recovered", case="hang_watchdog", up={"1": found[1]})
        time.sleep(HOLD_S)
        self.event("case_end", case="hang_watchdog", states={1: self.state(1)})

    def case_hang_selfkill(self) -> None:
        """The health check itself kills the hung process after three failures."""
        self.settle()
        docker("rm", "-f", container(2))
        self.start_instance(2, kill_after=3)
        self.settle()
        t = self.event("case", case="hang_selfkill", instances=[2])
        os.kill(self.serving_pid(2), signal.SIGSTOP)
        found = self.wait_up([2], t)
        self.event(
            "recovered", case="hang_selfkill", up={"2": found[2]}, state=self.state(2)
        )
        time.sleep(HOLD_S)
        self.event("case_end", case="hang_selfkill", states={2: self.state(2)})

    def case_kill_both(self, rep: int = 1) -> None:
        def act() -> None:
            pids = [self.serving_pid(1), self.serving_pid(2)]
            for pid in pids:
                os.kill(pid, signal.SIGKILL)

        self.fault_and_recover(f"kill_both-{rep}", [1, 2], act)

    def case_restart_set(self) -> None:
        def act() -> None:
            docker("restart", container(1), container(2))

        self.fault_and_recover("restart_set", [1, 2], act)

    def fallback_case(self, case: str, down, up) -> None:
        """Callers with a short bound against a pool that gives no answer."""
        self.settle()
        self.stop_callers()
        self.start_callers(
            self.args.fallback_timeout, self.args.fallback_bound, f"-{case}"
        )
        self.wait_all_up()
        time.sleep(self.args.settle)
        t = self.event("case", case=case, instances=[1, 2])
        down()
        time.sleep(self.args.fallback_hold)
        restored = self.event("restored", case=case)
        up()
        found = self.wait_up([1, 2], t)
        self.event(
            "recovered",
            case=case,
            up={str(k): v for k, v in found.items()},
            since=restored,
        )
        time.sleep(HOLD_S)
        self.event("case_end", case=case)
        self.stop_callers()
        self.start_callers(self.args.timeout, self.args.bound, f"-after-{case}")

    def case_fallback_hung(self) -> None:
        pids: list[int] = []

        def down() -> None:
            pids.extend([self.serving_pid(1), self.serving_pid(2)])
            for pid in pids:
                os.kill(pid, signal.SIGSTOP)

        def up() -> None:
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGCONT)
                except ProcessLookupError:
                    # A self-killing health check got there first.
                    pass

        self.fallback_case("fallback_hung", down, up)

    def case_fallback_down(self) -> None:
        def down() -> None:
            docker("stop", container(1), container(2))

        def up() -> None:
            docker("start", container(1), container(2))

        self.fallback_case("fallback_down", down, up)


# ---------------------------------------------------------------------- run


def run(args) -> None:
    # A stop signal still cleans up (the finally below).
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    bench = Bench(args)
    bench.event("before", **wait_quiet())
    remove_own()
    docker("network", "rm", NET, check=False)
    docker("network", "create", "--internal", NET)
    # Docker's event history is short and health checks fill it: record it live.
    events_log = (bench.out / "docker-events.jsonl").open("a")
    follower = subprocess.Popen(
        ["docker", "events", "--filter", "type=container", "--format", "{{json .}}"],
        stdout=events_log,
        stderr=subprocess.DEVNULL,
    )

    def on_abort(reason: str) -> None:
        bench.aborted = reason
        (bench.out / "abort.txt").write_text(f"{time.strftime('%H:%M:%S')} {reason}\n")
        print(f"ABORT: {reason}", flush=True)
        remove_own()

    sampler = Sampler(bench.out / "samples.jsonl", on_abort)
    stress: subprocess.Popen | None = None
    if args.scenario:
        token, pid = start_parser("7")
        stress_log = (bench.out / "parser.log").open("w")
    sampler.start()
    try:
        for n in (1, 2)[: args.instances]:
            bench.start_instance(n)
        bench.start_callers(args.timeout, args.bound)
        bench.wait_all_up()
        if args.scenario:
            bench.event("parser_start", scenario=args.scenario)
            stress = subprocess.Popen(
                [
                    "nsenter", "-t", pid, "-n", "python3", str(D / "scripts/stress_parser.py"),
                    "burst", "--manifest", str(D / "manifests" / f"{args.scenario}.json"),
                    "--out", str(bench.out / "parser"), "--container", PARSER,
                    "--url", "http://127.0.0.1:8090", "--tag", f"crash-{args.name}-{int(time.time())}",
                    "--watch", ",".join(UAT), "--abort-swap-gib", "8",
                ],
                stdout=stress_log,
                stderr=subprocess.STDOUT,
                env={**os.environ, "PARSER_TOKEN": token},
            )  # fmt: skip
            time.sleep(20)
        for spec in args.cases:
            if bench.aborted:
                break
            name, _, value = spec.partition(":")
            print(f"=== {name} {value}", flush=True)
            method = getattr(bench, f"case_{name}")
            method(int(value)) if value else method()
        if stress:
            bench.event("waiting_for_parser")
            stress.wait()
            bench.event("parser_done")
        bench.stop_callers()
        bench.event("end")
    finally:
        sampler.halt.set()
        sampler.join()
        follower.terminate()
        remove_own()
        docker("network", "rm", NET, check=False)
    print("CRASH RUN DONE" if not bench.aborted else "CRASH RUN STOPPED", flush=True)


# ------------------------------------------------------------------ summary


def summarize(path: Path) -> dict:
    run_dir = path / "run"
    events = [json.loads(line) for line in read(path / "events.jsonl").splitlines()]
    rows = []
    for file in sorted(run_dir.glob("callers*.jsonl")):
        rows += [json.loads(line) for line in read(file).splitlines()]
    probes = []
    for file in sorted(run_dir.glob("probe*.jsonl")):
        probes += [json.loads(line) for line in read(file).splitlines()]
    probes.sort(key=lambda r: r["t"])
    logs = {}
    for file in sorted(run_dir.glob("layout-*.jsonl")):
        logs[file.stem] = [json.loads(line) for line in read(file).splitlines()]
    docker_events = []
    for line in read(path / "docker-events.jsonl").splitlines():
        row = json.loads(line)
        name = row.get("Actor", {}).get("Attributes", {}).get("name", "")
        action = row.get("Action", "")
        if name.startswith(f"{PREFIX}-layout") and not action.startswith("exec_"):
            docker_events.append(
                {
                    "t": row["timeNano"] / 1e9,
                    "name": name.rsplit("-", 2)[-2] + "-" + name.rsplit("-", 1)[-1],
                    "action": action,
                    "exit": row["Actor"]["Attributes"].get("exitCode"),
                }
            )
    host_instance: dict[str, str] = {}
    for row in rows:
        for attempt in row["tries"]:
            if attempt.get("instance") and attempt.get("host"):
                host_instance[attempt["host"]] = attempt["instance"]

    # Whole bursts, per callers run: every page once, the right page, one set of
    # boxes per page.
    digests: dict[str, set] = defaultdict(set)
    for row in rows:
        if row.get("digest"):
            digests[row["page"]].add(row["digest"])
    whole = lost = duplicated = total_bursts = 0
    for file in sorted(run_dir.glob("callers*.jsonl")):
        by_burst: dict[tuple, list[int]] = defaultdict(list)
        for line in read(file).splitlines():
            row = json.loads(line)
            by_burst[(row["caller"], row["burst"])].append(row["index"])
        for indices in by_burst.values():
            total_bursts += 1
            whole += len(set(indices)) == 40
            lost += 40 - len(set(indices))
            duplicated += len(indices) - len(set(indices))
    tags = Counter(
        p["request"].rsplit("/", 1)[0]
        for log in logs.values()
        for p in log
        if p["event"] == "page"
    )
    integrity = {
        "page_records": len(rows),
        "bursts": total_bursts,
        "bursts_whole": whole,
        "pages_lost": lost,
        "pages_answered_twice": duplicated,
        "outcomes": dict(Counter(r["outcome"] for r in rows)),
        "wrong_pages": sum(r["outcome"] == "wrong_page" for r in rows),
        "pages_with_more_than_one_digest": sum(len(v) > 1 for v in digests.values()),
        "server_pages_processed": sum(tags.values()),
        "server_pages_processed_twice_or_more": sum(v > 1 for v in tags.values()),
    }

    cases = []
    starts = [e for e in events if e["what"] == "case"]
    ends = {e["case"]: e for e in events if e["what"] == "case_end"}
    for event in starts:
        case = event["case"]
        t = event["t"]
        end = ends.get(case, {"t": events[-1]["t"]})["t"]
        faulted = [f"layout-{n}" for n in event.get("instances", [])]
        recovered = next(
            (e for e in events if e["what"] == "recovered" and e["case"] == case), None
        )
        ups = recovered.get("up", {}) if recovered else {}
        up_times = [v for v in ups.values() if v]
        out_s = {k: round(v - t, 2) for k, v in ups.items() if v}
        boots = {
            name: [
                b["load_s"] for b in log if b["event"] == "boot" and t <= b["t"] <= end
            ]
            for name, log in logs.items()
        }
        recovered_at = max(up_times) if up_times else end
        tries = [
            (r, a) for r in rows for a in r["tries"] if a["start"] <= t <= a["stop"]
        ]
        inflight = Counter(a["end"] for _, a in tries)
        inflight_faulted = Counter(
            a["end"] for _, a in tries if host_instance.get(a.get("host")) in faulted
        )
        inflight_outcome = Counter(r["outcome"] for r, _ in tries)
        inflight_wait = [r["end"] - t for r, _ in tries]
        during = [r for r in rows if t <= r["end"] <= recovered_at]
        walls = [r["end"] - r["start"] for r in during]
        try_ends = Counter(
            a["end"] for r in rows for a in r["tries"] if t <= a["stop"] <= recovered_at
        )
        served = Counter(
            a["instance"]
            for r in rows
            for a in r["tries"]
            if a["end"] == "ok" and t <= a["stop"] <= recovered_at
        )
        span = max(recovered_at - t, 1e-6)
        fallback_rows = [
            r for r in rows if r["outcome"] == "use_fallback" and t <= r["end"] <= end
        ]
        cases.append(
            {
                "case": case,
                "instances": faulted,
                "seconds_until_answering": out_s,
                "model_load_s": {k: v for k, v in boots.items() if v},
                "inflight_at_fault": dict(inflight),
                "inflight_on_faulted": dict(inflight_faulted),
                "inflight_page_outcomes": dict(inflight_outcome),
                "inflight_longest_page_s": round(max(inflight_wait), 1)
                if inflight_wait
                else None,
                "while_out": {
                    "seconds": round(span, 1),
                    "pages_done": len(during),
                    "pages_per_s": round(len(during) / span, 2),
                    "page_p50_s": round(percentile(walls, 0.5), 2),
                    "page_p95_s": round(percentile(walls, 0.95), 2),
                    "page_max_s": round(max(walls), 2) if walls else None,
                    "attempt_ends": dict(try_ends),
                    "served_by": dict(served),
                },
                "fallbacks": len(fallback_rows),
                "fallback_after_s": [
                    round(
                        percentile([r["end"] - r["start"] for r in fallback_rows], q), 1
                    )
                    for q in (0.0, 1.0)
                ]
                if fallback_rows
                else None,
                "events": [
                    {k: v for k, v in e.items() if k != "case"}
                    for e in events
                    if e.get("case") == case and e["what"] not in ("case", "case_end")
                ],
                "end_states": ends.get(case, {}).get("states"),
                "docker": [
                    {
                        "at_s": round(e["t"] - t, 1),
                        "name": e["name"],
                        "action": e["action"],
                        **({"exit": e["exit"]} if e["exit"] else {}),
                    }
                    for e in docker_events
                    if t <= e["t"] <= end
                ],
            }
        )
    healthy = [r for r in rows if r["outcome"] == "boxes"]
    walls = [r["end"] - r["start"] for r in healthy]
    # An earlier run's instances are removed as this one starts: not exits.
    first = starts[0]["t"] if starts else 0
    restarts = Counter(
        e["name"] for e in docker_events if e["action"] == "die" and e["t"] >= first
    )
    return {
        "integrity": integrity,
        "instance_exits": dict(restarts),
        "all_pages": {
            "page_p50_s": round(percentile(walls, 0.5), 2),
            "page_p95_s": round(percentile(walls, 0.95), 2),
            "attempts": dict(Counter(a["end"] for r in rows for a in r["tries"])),
        },
        "cases": cases,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run")
    r.add_argument("name")
    r.add_argument("--cases", type=lambda v: v.split(","), default=[])
    r.add_argument("--instances", type=int, default=2)
    r.add_argument("--threads", type=int, default=2)
    r.add_argument("--depth", type=int, default=4)
    r.add_argument("--cpus", type=float)
    r.add_argument("--shares", type=int)
    r.add_argument("--nice", type=int, default=0)
    r.add_argument("--no-spin", action="store_true")
    r.add_argument("--kill-after", type=int, default=0)
    r.add_argument("--health-interval", type=int, default=5)
    r.add_argument("--callers", type=int, default=2)
    r.add_argument("--window", type=int, default=4)
    r.add_argument("--timeout", type=float, default=10.0)
    r.add_argument("--bound", type=float, default=60.0)
    r.add_argument("--fallback-timeout", type=float, default=5.0)
    r.add_argument("--fallback-bound", type=float, default=20.0)
    r.add_argument("--fallback-hold", type=float, default=40.0)
    r.add_argument("--settle", type=float, default=15.0)
    r.add_argument("--scenario")
    r.add_argument("--avoid-failed", action="store_true")
    s = sub.add_parser("summarize")
    s.add_argument("path", type=Path)
    args = parser.parse_args()
    if args.command == "summarize":
        print(json.dumps(summarize(args.path), indent=1))
        return
    run(args)


if __name__ == "__main__":
    main()
