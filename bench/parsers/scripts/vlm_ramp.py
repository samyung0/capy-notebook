"""Capacity ramp for the VLM page read (the captioning slot's page reads).

Sends real page renders (the parser's ``vlm/<page>.jpg``) in the production
request shape from inside an ingest worker container, so the call uses that
container's code, catalog row, prompt, routing and key. Nothing is written
inside the container: the driver arrives on stdin with its pages and prints
one JSON record per call.

    # ingest host: page renders out of kept parse bundles (stress_parser --keep)
    python3 vlm_ramp.py pool --bundles DIR --map map.json --out POOL
    # ingest host: one level, closed loop, no retries
    python3 vlm_ramp.py feed --pool POOL --ids level-20.txt \\
      | docker exec -i WORKER python -c "$(python3 vlm_ramp.py boot)" drive --mode level --inflight 20
    # one burst through the worker's retry policy and job re-pend
    ... drive --mode burst --jobs 2 --per-job 10 --gate 20
    # developer machine: text-layer truth (PyMuPDF) and the tables
    uv run --with pymupdf==1.28.2 python vlm_ramp.py truth --map map.json --out truth.json
    python vlm_ramp.py score --truth truth.json [--keys keys.json] RUN.jsonl...

``level`` keeps ``--inflight`` calls open until its pages run out and stops
early once 429s pass ``--stop-429`` of at least 30 answers. ``burst`` replays
``models.read_page`` and ``ingest.worker._read_vlm_pages``: each page is one
read of up to three attempts within a 120 s budget (busy answers wait for
Retry-After or a jittered backoff, other failures 0.25 s doubling, a 400, 401,
403, 404 or 422 ends the read), every attempt holds a slot of the shared gate,
each job reads ``--per-job`` pages at once, and a job whose read stays busy is
cancelled and re-pended once after 2 s, when a still-busy page is left unread.
The driver stops when the summed ``usage.cost`` passes ``--max-spend``.
``--order`` replaces the pin's provider list (fallbacks stay off), to probe
another provider; every other run uses the container's own routing.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import random
import re
import statistics
import sys
import time
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path

BOOT = (
    "import sys;b=sys.stdin.buffer;n=int(b.readline());"
    "exec(compile(b.read(n),'vlm_ramp.py','exec'),{'__name__':'__vlm_drive__'})"
)


# ------------------------------------------------------------ host: pages


def pool(args) -> None:
    """Copy every render out of the kept bundles as ``<book>-p<page>.jpg``,
    the page numbered in its source book (``map.json``: bundle id -> book and
    first source page)."""
    mapping = json.loads(Path(args.map).read_text())
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    index = []
    for bundle_id, source in mapping.items():
        with zipfile.ZipFile(Path(args.bundles) / f"{bundle_id}.zip") as archive:
            for name in archive.namelist():
                match = re.fullmatch(r"vlm/(\d+)\.jpg", name)
                if not match:
                    continue
                page = source["first"] + int(match.group(1))
                item = f"{source['book']}-p{page}"
                data = archive.read(name)
                (out / f"{item}.jpg").write_bytes(data)
                index.append({"id": item, "book": source["book"], "page": page, "bytes": len(data)})
    (out / "pool.json").write_text(json.dumps(index, indent=0), encoding="utf-8")
    print(len(index), "renders in", out)


def feed(args) -> None:
    """The driver source, then one frame per page: a JSON header line and
    the JPEG bytes."""
    sink = sys.stdout.buffer
    code = Path(__file__).read_bytes()
    sink.write(f"{len(code)}\n".encode() + code)
    for item in Path(args.ids).read_text().split():
        data = (Path(args.pool) / f"{item}.jpg").read_bytes()
        sink.write(json.dumps({"id": item, "len": len(data)}).encode() + b"\n" + data)
    sink.write(b'{"end": true}\n')
    sink.flush()


# ------------------------------------------------- container: the driver


def read_frames() -> list[tuple[str, bytes]]:
    source = sys.stdin.buffer
    frames = []
    while True:
        header = json.loads(source.readline())
        if header.get("end"):
            return frames
        frames.append((header["id"], source.read(header["len"])))


class Driver:
    """Production request shape from the container's own modules."""

    def __init__(self, args) -> None:
        import httpx
        from pipeline import registry
        from pipeline.elitellm.client import (
            BUSY_STATUSES,
            OPENROUTER_CHAT_URL,
            _retry_after,
            openrouter_request,
        )
        from pipeline.prompts.captioning import VLM_PAGE_PROMPT
        from pipeline.retrieval.models import (
            DEFINITIVE_CLIENT_ERRORS,
            INGEST_RETRY,
            VLM_PAGE_MAX_TOKENS,
        )

        registry.registry.refresh()  # one SELECT of the catalog
        self.spec = registry.registry.default("captioning")
        if self.spec.provider_slug != "openrouter":
            raise SystemExit(f"captioning default is {self.spec.provider_slug}, not openrouter")
        self.url = OPENROUTER_CHAT_URL
        self.build = openrouter_request
        self.retry_after = _retry_after
        self.prompt = VLM_PAGE_PROMPT
        self.max_tokens = VLM_PAGE_MAX_TOKENS
        self.busy = set(BUSY_STATUSES)
        self.definitive = set(DEFINITIVE_CLIENT_ERRORS)
        self.attempts, self.budget = INGEST_RETRY.attempts, INGEST_RETRY.budget_s
        self.key = os.environ["OPENROUTER_API_KEY"].strip()
        # The client's pool settings (elitellm.client._client).
        self.client = httpx.AsyncClient(
            limits=httpx.Limits(max_connections=None, max_keepalive_connections=32)
        )
        self.httpx = httpx
        self.timeout = float(os.environ.get("CAPY_INGEST_PROVIDER_TIMEOUT_S", "120"))
        self.spend = 0.0
        self.max_spend = args.max_spend
        self.order = [p for p in (args.order or "").split(",") if p]
        self.started = time.monotonic()

    def describe(self) -> dict:
        body = self.body(b"")
        body["messages"][1]["content"][0]["image_url"]["url"] = "data:image/jpeg;base64,..."
        return {
            "model": self.spec.model_slug,
            "version": self.spec.version,
            "params": self.spec.params,
            "body": body,
            "timeout_s": self.timeout,
            "attempts": self.attempts,
            "budget_s": self.budget,
        }

    def body(self, jpeg: bytes) -> dict:
        messages = [
            {"role": "system", "content": self.prompt},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()},
                    }
                ],
            },
        ]
        body = self.build(
            self.spec,
            messages,
            temperature=self.spec.temperature(),
            tools=None,
            response_format=None,
            max_tokens=self.max_tokens,
            stream=False,
            tool_choice=None,
        )
        if self.order:  # an experiment: another vetted provider, fallbacks still off
            body["provider"] = {**body["provider"], "order": self.order}
        return body

    async def call(self, item: str, jpeg: bytes, **tags) -> dict:
        rec = {"id": item, **tags, "t0": round(time.monotonic() - self.started, 2)}
        started = time.monotonic()
        try:
            resp = await self.client.post(
                self.url,
                headers={"authorization": f"Bearer {self.key}", "content-type": "application/json"},
                json=self.body(jpeg),
                timeout=self.httpx.Timeout(self.timeout),
            )
        except Exception as exc:  # noqa: BLE001 - recorded, classified as transient
            rec.update(seconds=round(time.monotonic() - started, 2), status=None,
                       error=f"{type(exc).__name__}: {exc}"[:300])
            return rec
        rec["seconds"] = round(time.monotonic() - started, 2)
        rec["status"] = resp.status_code
        limits = {k: v for k, v in resp.headers.items() if k.lower().startswith("x-ratelimit")}
        if limits:
            rec["ratelimit"] = limits
        if resp.headers.get("retry-after"):
            rec["retry_after"] = resp.headers.get("retry-after")
            # The client's own parse: seconds or an HTTP date.
            rec["retry_after_s"] = self.retry_after(resp.headers)
        try:
            raw = resp.json()
        except ValueError:
            raw = {}
        if resp.status_code >= 400 or "error" in raw:
            error = raw.get("error") if isinstance(raw.get("error"), dict) else {}
            rec["error"] = (json.dumps(error)[:400] if error else resp.text[:400])
            if resp.status_code < 400:
                # A 200 carrying an error is an unusable answer to the client,
                # not a busy one, whatever code the body names.
                rec["body_error_code"] = error.get("code")
            return rec
        choice = (raw.get("choices") or [{}])[0]
        usage = raw.get("usage") or {}
        cost = usage.get("cost") or 0.0
        self.spend += float(cost)
        rec.update(
            provider=raw.get("provider"),
            model=raw.get("model"),
            finish=choice.get("finish_reason"),
            text=((choice.get("message") or {}).get("content") or ""),
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            cached_tokens=(usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
            reasoning_tokens=(usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
            cost=cost,
        )
        return rec

    @staticmethod
    def usable(rec: dict) -> bool:
        return rec.get("status") == 200 and bool((rec.get("text") or "").strip()) and rec.get("finish") != "length"

    def over_budget(self) -> bool:
        return self.spend > self.max_spend


def emit(rec: dict) -> None:
    print(json.dumps(rec, ensure_ascii=False), flush=True)


async def run_level(driver: Driver, frames, inflight: int, stop_429: float, tag: str) -> None:
    """Closed loop: ``inflight`` calls open until the pages run out."""
    queue = list(frames)
    answers = {"n": 0, "429": 0, "stopped": ""}

    async def lane() -> None:
        while queue and not answers["stopped"]:
            item, jpeg = queue.pop(0)
            rec = await driver.call(item, jpeg, mode="level", inflight=inflight, tag=tag)
            rec["usable"] = driver.usable(rec)
            emit(rec)
            answers["n"] += 1
            answers["429"] += rec.get("status") == 429
            if answers["n"] >= 30 and answers["429"] / answers["n"] > stop_429:
                answers["stopped"] = f"429 share {answers['429']}/{answers['n']}"
            if driver.over_budget():
                answers["stopped"] = f"spend {driver.spend:.3f}"

    started = time.monotonic()
    await asyncio.gather(*(lane() for _ in range(inflight)))
    emit({"summary": "level", "tag": tag, "inflight": inflight, "calls": answers["n"],
          "wall_s": round(time.monotonic() - started, 1), "stopped": answers["stopped"] or None,
          "spend": round(driver.spend, 4)})


class Busy(Exception):
    pass


async def run_burst(driver: Driver, frames, jobs: int, per_job: int, gate: int, tag: str) -> None:
    """The worker's page reads for ``jobs`` jobs sharing the gate."""
    slots = asyncio.Semaphore(gate)
    pages = [frames[i::jobs] for i in range(jobs)]
    calling = [0] * jobs  # calls in flight per job, for the cancelled count

    async def read_page(item: str, jpeg: bytes, job: int, last_wait: bool) -> str:
        # models.read_page: one read, INGEST_RETRY attempts, 120 s budget.
        deadline = time.monotonic() + driver.budget
        for attempt in range(driver.attempts):
            async with slots:  # one gate lease per attempt
                calling[job] += 1
                try:
                    rec = await driver.call(item, jpeg, mode="burst", tag=tag, job=job,
                                            attempt=attempt, last_wait=last_wait)
                finally:
                    calling[job] -= 1
            ok = driver.usable(rec)
            rec["usable"] = ok
            emit(rec)
            if ok:
                return "read"
            status = rec.get("status")
            last = attempt >= driver.attempts - 1
            if status in driver.busy:
                # models._busy_wait_s: the provider's Retry-After, else a
                # jittered backoff.
                wait = rec.get("retry_after_s")
                if wait is None:
                    wait = 0.5 * (2**attempt) * random.uniform(0.75, 1.25)
                if last or time.monotonic() + wait > deadline:
                    if last_wait:
                        return "unread_busy"
                    raise Busy(item)
            else:
                if status in driver.definitive:
                    return "unread_definitive"
                wait = 0.25 * (2**attempt)
                if last or time.monotonic() + wait > deadline:
                    return "unread"
            await asyncio.sleep(wait)
        return "unread"

    async def job(index: int) -> None:
        todo = list(pages[index])
        outcome: dict[str, str] = {}
        for last_wait in (False, True):
            limit = asyncio.Semaphore(per_job)

            async def one(item: str, jpeg: bytes) -> None:
                async with limit:
                    outcome[item] = await read_page(item, jpeg, index, last_wait)

            # A re-pended job reads again every page without a cached read.
            tasks = [asyncio.ensure_future(one(i, j)) for i, j in todo if outcome.get(i) != "read"]
            try:
                await asyncio.gather(*tasks)
                break
            except Busy:
                # _read_vlm_pages: cancel the job's reads, re-pend once.
                cancelled = calling[index]
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                emit({"event": "repend", "tag": tag, "job": index, "cancelled": cancelled,
                      "read_so_far": sum(v == "read" for v in outcome.values())})
                await asyncio.sleep(2.0)  # worker.YIELD_BACKOFF_S
        for item, result in outcome.items():
            emit({"page_outcome": result, "id": item, "job": index, "tag": tag})

    started = time.monotonic()
    await asyncio.gather(*(job(i) for i in range(jobs)))
    emit({"summary": "burst", "tag": tag, "jobs": jobs, "per_job": per_job, "gate": gate,
          "pages": len(frames), "wall_s": round(time.monotonic() - started, 1),
          "spend": round(driver.spend, 4)})


def drive(args) -> None:
    frames = read_frames()
    driver = Driver(args)
    emit({"setup": driver.describe(), "pages": len(frames), "tag": args.tag})

    async def go() -> None:
        try:
            if args.mode == "level":
                await run_level(driver, frames, args.inflight, args.stop_429, args.tag)
            else:
                await run_burst(driver, frames, args.jobs, args.per_job, args.gate, args.tag)
        finally:
            await driver.client.aclose()

    asyncio.run(go())


# --------------------------------------------- developer machine: scoring


def truth(args) -> None:
    """Text layer of every source page the pool uses (``map.json`` books)."""
    import pymupdf

    books = json.loads(Path(args.map).read_text(encoding="utf-8"))
    seen: dict[str, str] = {}
    for source in books.values():
        if source["book"] in seen:
            continue
        seen[source["book"]] = source["pdf"]
    out = {}
    for book, pdf in seen.items():
        document = pymupdf.open(pdf)
        for page in document:
            out[f"{book}-p{page.number}"] = page.get_text()
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(len(out), "pages of text")


def norm(text: str) -> str:
    """Lower case letters and digits only, single-spaced: punctuation,
    Markdown and line breaks differ between a text layer and a read."""
    text = unicodedata.normalize("NFKC", text).lower()
    return " ".join(re.findall(r"[^\W_]+", text))


def _wordy(token: str) -> bool:
    return sum(ch.isalpha() for ch in token) >= 2


def key_phrases(page_text: str, count: int = 8, words: int = 4) -> list[str]:
    """Up to ``count`` four-word phrases from evenly spaced text-layer lines
    of at least six words, each word with two letters or more (no glyphs the
    text layer cannot name, no letter-spaced titles): the window nearest the
    middle of the line, away from hyphenation."""
    lines = [ln.split() for ln in (norm(raw) for raw in page_text.splitlines())]
    lines = [tokens for tokens in lines if len(tokens) >= 6 and "�" not in " ".join(tokens)]
    if not lines:
        return []
    step = max(1, len(lines) / count)
    phrases = []
    for i in range(min(count, len(lines))):
        tokens = lines[int(i * step)]
        mid = max(0, len(tokens) // 2 - words // 2)
        starts = sorted(range(len(tokens) - words + 1), key=lambda s: abs(s - mid))
        for start in starts:
            window = tokens[start : start + words]
            if all(_wordy(t) for t in window):
                phrases.append(" ".join(window))
                break
    return phrases


def recall(phrases: list[str], text: str) -> float | None:
    if not phrases:
        return None
    # Plain containment: a text layer that lost a ligature ("de?ciency")
    # still matches the read's whole word.
    hay = norm(text or "")
    return sum(norm(p) in hay for p in phrases) / len(phrases)


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))], 2)


def score(args) -> None:
    pages = json.loads(Path(args.truth).read_text(encoding="utf-8")) if args.truth else {}
    keys = json.loads(Path(args.keys).read_text(encoding="utf-8")) if args.keys else {}
    calls = defaultdict(list)
    outcomes = defaultdict(lambda: defaultdict(int))
    summaries = {}
    for path in args.runs:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if not line.startswith("{"):
                continue
            rec = json.loads(line)
            if "summary" in rec:
                summaries[rec["tag"]] = rec
            elif "page_outcome" in rec:
                outcomes[rec["tag"]][rec["page_outcome"]] += 1
            elif "status" in rec:
                calls[rec["tag"]].append(rec)
    def stats(recs: list[dict], wall: float | None) -> dict:
        ok = [r for r in recs if r.get("usable")]
        lat = [r["seconds"] for r in ok]
        by_status = defaultdict(int)
        for r in recs:
            if not r.get("usable"):
                by_status[str(r.get("status")) + ("/cut" if r.get("finish") == "length" else "")] += 1
        rec_vals = []
        for r in ok:
            phrases = keys.get(r["id"]) or key_phrases(pages.get(r["id"], ""))
            value = recall(phrases, r.get("text"))
            if value is not None:
                rec_vals.append(value)
        tokens = [r.get("completion_tokens") or 0 for r in ok]
        speeds = [(r.get("completion_tokens") or 0) / r["seconds"] for r in ok if r["seconds"] > 0.5]
        return {
            "calls": len(recs),
            "usable": len(ok),
            "429": sum(r.get("status") == 429 for r in recs),
            "failures": dict(by_status),
            "median_s": pct(lat, 0.5),
            "p95_s": pct(lat, 0.95),
            "max_s": max(lat) if lat else None,
            "reads_per_min": round(60 * len(ok) / wall, 1) if wall else None,
            "wall_s": round(wall, 1) if wall else None,
            "tokens_median": pct(tokens, 0.5),
            "tokens_p95": pct(tokens, 0.95),
            "tokens_max": max(tokens) if tokens else None,
            "near_cap": sum(t >= 1900 for t in tokens),
            "tok_per_s_median": pct(speeds, 0.5),
            "cached_calls": sum(bool(r.get("cached_tokens")) for r in ok),
            "preface": sum(bool(re.match(r"\s*(here is|here's|the page)", r.get("text") or "", re.I)) for r in ok),
            "providers": sorted({str(r.get("provider")) for r in ok}),
            "recall_mean": round(statistics.mean(rec_vals), 3) if rec_vals else None,
            "recall_p10": pct(rec_vals, 0.1),
            "recall_n": len(rec_vals),
            "spend": round(sum(float(r.get("cost") or 0) for r in recs), 4),
        }

    rows = []
    for tag, recs in calls.items():
        wall = summaries.get(tag, {}).get("wall_s") or (
            max(r["t0"] + r["seconds"] for r in recs) - min(r["t0"] for r in recs)
        )
        rows.append({"tag": tag, **stats(recs, wall), "outcomes": dict(outcomes.get(tag, {})) or None})
        if args.by_book:
            books = defaultdict(list)
            for r in recs:
                books[r["id"].split("-p")[0]].append(r)
            for book, group in sorted(books.items()):
                rows.append({"tag": f"{tag}/{book}", **stats(group, None)})
    print(json.dumps(rows, indent=1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pool")
    p.add_argument("--bundles", required=True)
    p.add_argument("--map", required=True)
    p.add_argument("--out", required=True)
    f = sub.add_parser("feed")
    f.add_argument("--pool", required=True)
    f.add_argument("--ids", required=True)
    sub.add_parser("boot")
    d = sub.add_parser("drive")
    d.add_argument("--mode", choices=("level", "burst"), required=True)
    d.add_argument("--tag", required=True)
    d.add_argument("--inflight", type=int, default=20)
    d.add_argument("--stop-429", type=float, default=0.2)
    d.add_argument("--jobs", type=int, default=2)
    d.add_argument("--per-job", type=int, default=10)
    d.add_argument("--gate", type=int, default=20)
    d.add_argument("--max-spend", type=float, default=2.0)
    d.add_argument("--order", help="override the pin's provider order (experiments only)")
    t = sub.add_parser("truth")
    t.add_argument("--map", required=True)
    t.add_argument("--out", required=True)
    s = sub.add_parser("score")
    s.add_argument("--truth")
    s.add_argument("--keys")
    s.add_argument("--by-book", action="store_true")
    s.add_argument("runs", nargs="+")
    args = parser.parse_args(sys.argv[1:] if sys.argv[0] != "-c" else sys.argv[1:])
    if args.cmd == "pool":
        pool(args)
    elif args.cmd == "feed":
        feed(args)
    elif args.cmd == "boot":
        print(BOOT)
    elif args.cmd == "drive":
        drive(args)
    elif args.cmd == "truth":
        truth(args)
    else:
        score(args)


if __name__ in ("__main__", "__vlm_drive__"):
    main()
