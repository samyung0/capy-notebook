"""A throwaway prototype of the layout pool's service, for the capacity and crash
benches: page image in, boxes out, nothing stored. It follows the parser's
pattern: a depth limit counts the page running plus the pages waiting, and one
request more is answered 429 for the caller to try again after about 2 s.

    python layout_service.py --name layout-1 --model /models/plus-l --threads 2 \
        --depth 4 --log /run-dir/layout-1.jsonl

``POST /boxes`` takes one JPEG and answers the figure and caption regions at
score 0.5 or more on the 0-1000 grid, echoing ``X-Page-Id``. The port opens
only after the model has loaded, so a caller or probe sees an instance as up
only when it can answer. ``GET /healthz`` answers from its own thread: 200,
or 503 once a page has been running for ``STUCK_S``.
``POST /debug/allocate?mib=N`` exists for the out-of-memory test.

The log is the bench's, not part of the design: one line for each boot and each
page, so a test can count work done twice.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layout_detect import PaddleOnnx

# The host firewall's forward chain (policy drop) also filters traffic between
# containers on a Docker bridge and passes only ports 53, 80 and 443.
PORT = 80
MAX_BODY = 8 << 20
THRESHOLD = 0.5
LABELS = {"image", "chart", "figure_title", "chart_title"}
STUCK_S = 60.0


class Service:
    def __init__(self, args) -> None:
        self.name = args.name
        self.model = None
        self.slots = threading.BoundedSemaphore(args.depth)
        self.turn = threading.Lock()
        self.running_since = 0.0
        self.write_lock = threading.Lock()
        self.log = open(args.log, "a", buffering=1) if args.log else None  # noqa: SIM115

    def note(self, **row) -> None:
        if self.log:
            with self.write_lock:
                self.log.write(json.dumps({"t": time.time(), **row}) + "\n")

    def boxes(self, jpeg: bytes) -> list[dict]:
        from PIL import Image

        with self.turn:
            self.running_since = time.time()
            try:
                with Image.open(io.BytesIO(jpeg)) as opened:
                    image = opened.convert("RGB")
                width, height = image.size
                return [
                    {
                        "label": r["label"],
                        "score": round(r["score"], 4),
                        "box": [
                            round(r["px"][0] / width * 1000, 1),
                            round(r["px"][1] / height * 1000, 1),
                            round(r["px"][2] / width * 1000, 1),
                            round(r["px"][3] / height * 1000, 1),
                        ],
                    }
                    for r in self.model(image)
                    if r["label"] in LABELS and r["score"] >= THRESHOLD
                ]
            finally:
                self.running_since = 0.0


def handler(service: Service):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        # A client that stops sending must not hold a thread for ever.
        timeout = 30

        def reply(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def log_message(self, *args) -> None:
            pass

        def do_GET(self) -> None:
            if self.path != "/healthz":
                self.reply(404, {"code": "not_found"})
                return
            since = service.running_since
            stuck = bool(since) and time.time() - since > STUCK_S
            self.reply(
                503 if stuck else 200, {"ok": not stuck, "instance": service.name}
            )

        def do_POST(self) -> None:
            url = urlparse(self.path)
            length = int(self.headers.get("content-length") or 0)
            if url.path == "/debug/allocate":
                mib = int(parse_qs(url.query).get("mib", ["0"])[0])
                self.rfile.read(length)
                held = bytearray(mib << 20)
                for i in range(0, len(held), 4096):
                    held[i] = 1
                self.reply(200, {"held_mib": mib})
                return
            if url.path != "/boxes" or length > MAX_BODY:
                self.rfile.read(min(length, MAX_BODY))
                self.reply(400, {"code": "bad_request"})
                return
            jpeg = self.rfile.read(length)
            request = self.headers.get("x-request-id", "")
            page = self.headers.get("x-page-id", "")
            if not service.slots.acquire(blocking=False):
                self.reply(429, {"code": "layout_capacity", "instance": service.name})
                return
            try:
                started = time.time()
                regions = service.boxes(jpeg)
                ended = time.time()
                service.note(
                    event="page", request=request, page=page, start=started, end=ended
                )
                self.reply(
                    200,
                    {
                        "page": page,
                        "regions": regions,
                        "instance": service.name,
                        "seconds": round(ended - started, 3),
                    },
                )
            finally:
                service.slots.release()

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128
    allow_reuse_address = True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--name", required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--depth", type=int, required=True)
    parser.add_argument("--log", type=Path)
    parser.add_argument("--no-spin", action="store_true")
    parser.add_argument("--nice", type=int, default=0)
    args = parser.parse_args()
    if args.nice:
        os.nice(args.nice)
    started = time.time()
    service = Service(args)
    service.model = PaddleOnnx(args.model, args.threads, spin=not args.no_spin)
    server = Server(("0.0.0.0", PORT), handler(service))
    service.note(event="boot", pid=os.getpid(), load_s=round(time.time() - started, 3))
    server.serve_forever()


if __name__ == "__main__":
    main()
