"""Time both Modal parse routes: one job, then a full container (4 fast / 2 accurate).

Warm the container first (a cheap /healthz), then:

  1. one multipart parse
  2. N concurrent parses of the same file (N = --jobs, default = route max)

Prints wall clock, in-container ``_server_parse_s``, block/char counts, and
which pages the fast probe sent to RapidOCR.

    python modal/bench_parse.py --file bench/parsers/docs/metabolic_pathway.pdf
    python modal/bench_parse.py --route fast --jobs 4 --file ...
    python modal/bench_parse.py --route accurate --jobs 2 --file ...
    python modal/bench_parse.py --both --file ...

Needs ``requests``. URLs/token from env (MODAL_PARSE_URL / MODAL_FAST_PARSE_URL /
MODAL_PARSE_TOKEN) or flags.
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

ROUTE_MAX = {"fast": 4, "accurate": 2}


def _file_parse_url(url: str) -> str:
    url = url.rstrip("/")
    return url if url.endswith("/file_parse") else url + "/file_parse"


def _parse_url(route: str, args: argparse.Namespace) -> str:
    if args.url:
        return args.url
    if route == "accurate":
        url = os.environ.get("MODAL_PARSE_URL", "")
    else:
        url = os.environ.get("MODAL_FAST_PARSE_URL", "")
    if not url:
        raise SystemExit(f"no URL for {route}: pass --url or set the env var")
    return _file_parse_url(url)


def _healthz_url(parse_url: str) -> str:
    return parse_url.rsplit("/file_parse", 1)[0] + "/healthz"


def _summarize(body: dict) -> str:
    items = body.get("content_list") or []
    chars = 0
    headings = 0
    for item in items:
        if item.get("type") == "text":
            chars += len(str(item.get("text") or ""))
            if item.get("text_level"):
                headings += 1
        elif item.get("type") in {"equation", "table"}:
            chars += len(str(item.get("text") or item.get("table_body") or ""))
    images = body.get("images") or {}
    ocr_pages = body.get("_ocr_pages")
    lane = body.get("_fast_lane")
    extra = ""
    if ocr_pages is not None:
        extra += f"  ocr_pages={ocr_pages}"
    if lane:
        extra += f"  lane={lane}"
    return (
        f"blocks={len(items)} chars={chars} headings={headings} "
        f"images={len(images)}{extra}"
    )


def do_parse(
    url: str,
    token: str | None,
    data: bytes,
    name: str,
    parse_method: str,
    timeout: float,
) -> tuple[float, dict]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    t0 = time.perf_counter()
    resp = requests.post(
        url,
        headers=headers,
        files={"file": (name, data)},
        data={"parse_method": parse_method, "filename": name},
        timeout=timeout,
    )
    elapsed = time.perf_counter() - t0
    if resp.status_code >= 300:
        raise RuntimeError(f"parse {resp.status_code}: {resp.text[:800]}")
    return elapsed, resp.json()


def run_route(
    route: str,
    url: str,
    token: str | None,
    data: bytes,
    name: str,
    jobs: int,
    parse_method: str,
    timeout: float,
) -> None:
    health = _healthz_url(url)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    print(f"\n=== {route}  {url}")
    print(f"payload: {name} ({len(data)} bytes)  jobs={jobs}")
    try:
        t0 = time.perf_counter()
        hz = requests.get(health, headers=headers, timeout=timeout)
        hz.raise_for_status()
        body = hz.json()
        print(
            f"healthz: {time.perf_counter() - t0:.2f}s  "
            f"uptime_s={body.get('uptime_s')}  version={body.get('parser_version')}"
        )
    except Exception as exc:  # noqa: BLE001
        print(f"healthz: FAILED ({exc})")

    print("-- one job --")
    elapsed, body = do_parse(url, token, data, name, parse_method, timeout)
    server = body.get("_server_parse_s")
    print(
        f"  wall={elapsed:.2f}s  server_parse={server}  "
        f"uptime_s={body.get('_uptime_s')}  {_summarize(body)}"
    )

    if jobs <= 1:
        return

    print(f"-- {jobs} jobs at once --")
    t0 = time.perf_counter()
    walls: list[float] = []
    servers: list[float] = []
    errors = 0
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futs = [
            pool.submit(do_parse, url, token, data, name, parse_method, timeout)
            for _ in range(jobs)
        ]
        for fut in as_completed(futs):
            try:
                wall, payload = fut.result()
            except Exception as exc:  # noqa: BLE001
                errors += 1
                print(f"  FAILED: {exc}")
                continue
            walls.append(wall)
            if isinstance(payload.get("_server_parse_s"), (int, float)):
                servers.append(float(payload["_server_parse_s"]))
            print(
                f"  wall={wall:.2f}s  server_parse={payload.get('_server_parse_s')}  "
                f"{_summarize(payload)}"
            )
    burst = time.perf_counter() - t0
    print(f"burst wall (all done): {burst:.2f}s  errors={errors}")
    if walls:
        print(
            f"per-job wall median={statistics.median(walls):.2f}s  "
            f"max={max(walls):.2f}s"
        )
    if servers:
        print(
            f"per-job server_parse median={statistics.median(servers):.2f}s  "
            f"max={max(servers):.2f}s  sum={sum(servers):.2f}s"
        )


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--route", choices=("fast", "accurate"), default="fast")
    ap.add_argument("--both", action="store_true", help="run fast then accurate")
    ap.add_argument("--url", default="", help="override /file_parse URL")
    ap.add_argument("--token", default=os.environ.get("MODAL_PARSE_TOKEN", ""))
    ap.add_argument("--file", required=True, help="PDF to parse")
    ap.add_argument(
        "--jobs", type=int, default=0, help="0 = route max (6 fast / 2 accurate)"
    )
    ap.add_argument("--parse-method", default="ocr")
    ap.add_argument("--timeout", type=float, default=900.0)
    args = ap.parse_args()

    path = Path(args.file)
    data = path.read_bytes()
    name = path.name
    token = args.token or None
    routes = ("fast", "accurate") if args.both else (args.route,)

    for route in routes:
        url = _parse_url(route, args)
        jobs = args.jobs or ROUTE_MAX[route]
        run_route(route, url, token, data, name, jobs, args.parse_method, args.timeout)

    return 0


if __name__ == "__main__":
    sys.exit(main())
