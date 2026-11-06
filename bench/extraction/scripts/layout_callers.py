"""Simulated callers of the layout prototype: a steady stream of 40-page bursts.

Runs in a container on the pool's private network, stdlib only:

    python layout_callers.py --pool layout --pages /pages --run /run-dir \
        --callers 2 --window 4 --timeout 10 --bound 60 --probe layout-1,layout-2

Each caller sends one burst at a time, ``--window`` pages in flight, one request
a page, and starts the next burst when the last one is complete. A page is tried
until it has an answer: on a 429, a refused or reset connection, a failed name
lookup or no answer within ``--timeout``, the caller waits about 2 s and tries
again at a random instance. Past ``--bound`` seconds for that page it gives up
and records ``use fallback``, as a real caller would take the box call instead.

``<run>/callers.jsonl`` holds one line per page: its outcome, every attempt and
how each ended, and a digest of its boxes, so a page answered with another
page's boxes shows. A probe per instance reads ``/healthz`` four times a second
and logs each change to ``<run>/probe.jsonl``. On ``<run>/stop`` a caller finishes
its burst and exits, so every burst it started can be checked whole.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import queue
import random
import socket
import threading
import time
from pathlib import Path

PORT = 80
BURST = 40
BACKOFF_S = 2.0


def digest(regions: list[dict]) -> str:
    """Boxes to the nearest 2% of the page: only a different page changes it."""
    rows = sorted((r["label"], *(round(v / 20) for v in r["box"])) for r in regions)
    return hashlib.sha1(repr(rows).encode()).hexdigest()[:10]


def attempt(
    pool: str, jpeg: bytes, page: str, request: str, timeout: float, avoid: str | None
) -> dict:
    """One request; how it ended, and against which address. An address that
    just failed this page is skipped while there is another."""
    try:
        addresses = {
            info[4][0] for info in socket.getaddrinfo(pool, PORT, socket.AF_INET)
        }
    except OSError:
        return {"end": "dns"}
    host = random.choice(sorted(addresses - {avoid}) or sorted(addresses))
    connection = http.client.HTTPConnection(host, PORT, timeout=timeout)
    deadline = time.monotonic() + timeout
    try:
        connection.request(
            "POST",
            "/boxes",
            body=jpeg,
            headers={
                "content-type": "image/jpeg",
                "x-page-id": page,
                "x-request-id": request,
            },
        )
        # A socket timeout bounds each read, not the whole answer.
        connection.sock.settimeout(max(0.05, deadline - time.monotonic()))
        response = connection.getresponse()
        body = response.read()
    except TimeoutError:
        return {"end": "timeout", "host": host}
    except ConnectionRefusedError:
        return {"end": "refused", "host": host}
    except (ConnectionError, http.client.HTTPException) as exc:
        return {"end": "reset", "host": host, "detail": type(exc).__name__}
    except OSError as exc:
        # No route to an address a stopped container just gave up.
        return {"end": "unreachable", "host": host, "detail": type(exc).__name__}
    finally:
        connection.close()
    if response.status == 429:
        return {
            "end": "429",
            "host": host,
            "instance": json.loads(body).get("instance"),
        }
    if response.status != 200:
        return {"end": f"http{response.status}", "host": host}
    payload = json.loads(body)
    return {
        "end": "ok",
        "host": host,
        "instance": payload["instance"],
        "seconds": payload["seconds"],
        "page": payload["page"],
        "regions": payload["regions"],
    }


def fetch(args, jpeg: bytes, page: str, tag: str) -> dict:
    began = time.time()
    tries: list[dict] = []
    avoid = None
    while True:
        started = time.time()
        # The bound is hard: the last try gets only what is left of it.
        left = args.bound - (started - began)
        got = attempt(
            args.pool,
            jpeg,
            page,
            f"{tag}/{len(tries)}",
            min(args.timeout, left),
            avoid if args.avoid_failed else None,
        )
        regions = got.pop("regions", None)
        got.update(start=started, stop=time.time())
        tries.append(got)
        if got["end"] == "ok":
            return {
                "outcome": "boxes" if got["page"] == page else "wrong_page",
                "digest": digest(regions),
                "start": began,
                "end": got["stop"],
                "tries": tries,
            }
        avoid = got.get("host") if got["end"] != "429" else None
        wait = BACKOFF_S * random.uniform(0.9, 1.1)
        if time.time() + wait - began >= args.bound:
            return {
                "outcome": "use_fallback",
                "start": began,
                "end": time.time(),
                "tries": tries,
            }
        time.sleep(wait)


class Probe(threading.Thread):
    def __init__(self, host: str, log, lock) -> None:
        super().__init__(daemon=True)
        self.host, self.log, self.lock = host, log, lock

    def up(self) -> bool:
        connection = http.client.HTTPConnection(self.host, PORT, timeout=1.0)
        try:
            connection.request("GET", "/healthz")
            return connection.getresponse().status == 200
        except (OSError, http.client.HTTPException):
            return False
        finally:
            connection.close()

    def run(self) -> None:
        state = None
        while True:
            now = self.up()
            if now != state:
                state = now
                with self.lock:
                    self.log.write(
                        json.dumps({"t": time.time(), "instance": self.host, "up": now})
                        + "\n"
                    )
            time.sleep(0.25)


def caller(
    args, number: int, images: list[tuple[str, bytes]], log, lock, stop: Path
) -> None:
    rng = random.Random(1000 + number)
    burst = 0
    while not stop.exists():
        pages = rng.sample(images, BURST)
        work: queue.Queue = queue.Queue()
        for index, item in enumerate(pages):
            work.put((index, item))

        def run() -> None:
            while True:
                try:
                    index, (page, jpeg) = work.get_nowait()
                except queue.Empty:
                    return
                row = fetch(args, jpeg, page, f"c{number}/b{burst}/{index}")
                row.update(caller=number, burst=burst, index=index, page=page)
                with lock:
                    log.write(json.dumps(row) + "\n")

        threads = [threading.Thread(target=run) for _ in range(args.window)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        burst += 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pool", default="layout")
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--callers", type=int, default=2)
    parser.add_argument("--window", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--bound", type=float, default=60.0)
    parser.add_argument("--probe", default="")
    parser.add_argument("--suffix", default="")
    parser.add_argument("--avoid-failed", action="store_true")
    args = parser.parse_args()
    images = [(p.stem, p.read_bytes()) for p in sorted(args.pages.glob("*.jpg"))]
    lock = threading.Lock()
    stop = args.run / f"callers-stop{args.suffix}"
    (args.run / f"callers-ready{args.suffix}").touch()
    with (
        (args.run / f"callers{args.suffix}.jsonl").open("a", buffering=1) as log,
        (args.run / f"probe{args.suffix}.jsonl").open("a", buffering=1) as probe_log,
    ):
        for host in filter(None, args.probe.split(",")):
            Probe(host, probe_log, lock).start()
        threads = [
            threading.Thread(target=caller, args=(args, n, images, log, lock, stop))
            for n in range(args.callers)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()


if __name__ == "__main__":
    main()
