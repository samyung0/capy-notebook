"""Manually drive the Modal parse endpoint to test the GPU memory snapshot.

The GPU snapshot's whole job is to make a *cold* boot fast: instead of
re-importing torch, reloading weights and re-starting vLLM (accurate MinerU),
a cold container restores straight into a ready-to-serve state. Fast (Marker)
does not use GPU snapshots — restore died with SIGSEGV — so its first call
after scale-from-zero still pays model load. This script measures that from
the outside so you can cross-check against the per-container duration Modal
shows in the dashboard.

What it measures
----------------
* ``/healthz`` round-trip  -> when hit cold, this is ~restore-to-ready only
  (no parse). ``uptime_s`` in the reply is how long the container has been
  ready since restore; a value near 0 means you just triggered a cold boot.
* ``/file_parse`` round-trip -> total = cold-boot (if any) + parse + network.
  The reply carries ``_server_parse_s`` (parse-only, measured in-container)
  so you can subtract it out.

If the snapshot works, the FIRST call after a cold start returns in a few
seconds and its ``uptime_s`` is small. If it's broken, that first call blocks
for minutes while the container reloads models, and the Modal logs will show
the ``[snapshot-build] warmup`` lines on an ordinary boot.

Forcing a cold start
--------------------
A deployed container lingers ``scaledown_window`` seconds (300 = 5 min) after
the last request. To guarantee a cold boot either:
  * pass ``--wait-cold 330`` (sleeps past the window, then measures), or
  * run this once, wait >5 min idle, run again, or
  * redeploy (``modal deploy modal/mineru_app.py``) right before running.

Usage
-----
    # env: MODAL_PARSE_URL=https://<org>--evo-mineru-mineruaccurate-web.modal.run/file_parse
    #      MODAL_FAST_PARSE_URL=https://<org>--evo-mineru-minerufast-web.modal.run/file_parse
    #      MODAL_PARSE_TOKEN=<token in the evo-mineru-token secret>
    python modal/test_snapshot.py                 # 3 parses, warm-ish
    python modal/test_snapshot.py --wait-cold 330 # force a cold boot first
    python modal/test_snapshot.py -n 5 --file some.pdf
    python modal/test_snapshot.py --healthz-only  # restore-only probe

Requires only ``requests`` (already in the pipeline venv).
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time

import requests


def _make_sample_pdf() -> bytes:
    """Build a tiny but structurally valid one-page PDF (correct xref offsets).

    Avoids a Pillow/repo-file dependency so the script is self-contained.
    """
    stream_body = b"BT /F1 24 Tf 72 700 Td (Marker snapshot test page) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        ),
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream_body), stream_body),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref_pos = len(pdf)
    n = len(objects) + 1
    pdf += b"xref\n0 %d\n" % n
    pdf += b"0000000000 65535 f \n"
    for off in offsets:
        pdf += b"%010d 00000 n \n" % off
    pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % n
    pdf += b"startxref\n%d\n%%%%EOF" % xref_pos
    return bytes(pdf)


def _file_parse_url(url: str) -> str:
    url = url.rstrip("/")
    return url if url.endswith("/file_parse") else url + "/file_parse"


def _healthz_url(parse_url: str) -> str:
    return parse_url.rsplit("/file_parse", 1)[0] + "/healthz"


def _fmt(x: float | None) -> str:
    return "   n/a" if x is None else f"{x:7.2f}"


def ping_healthz(url: str, token: str | None, timeout: float) -> tuple[float, dict]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    t0 = time.perf_counter()
    resp = requests.get(url, headers=headers, timeout=timeout)
    elapsed = time.perf_counter() - t0
    resp.raise_for_status()
    return elapsed, resp.json()


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
        raise RuntimeError(f"parse {resp.status_code}: {resp.text[:500]}")
    return elapsed, resp.json()


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--url",
        default=os.environ.get("MODAL_PARSE_URL", ""),
        help="full /file_parse URL (default: $MODAL_PARSE_URL)",
    )
    ap.add_argument(
        "--token",
        default=os.environ.get("MODAL_PARSE_TOKEN", ""),
        help="bearer token (default: $MODAL_PARSE_TOKEN)",
    )
    ap.add_argument(
        "--file", help="document to parse (default: a generated 1-page PDF)"
    )
    ap.add_argument(
        "-n", "--num", type=int, default=3, help="number of parse requests (default 3)"
    )
    ap.add_argument("--parse-method", default="ocr")
    ap.add_argument(
        "--wait-cold",
        type=int,
        default=0,
        help="sleep N seconds first to force a cold boot (use ~330 to clear the 300s scaledown window)",
    )
    ap.add_argument(
        "--timeout", type=float, default=900.0, help="per-request timeout seconds"
    )
    ap.add_argument(
        "--healthz-only",
        action="store_true",
        help="only probe /healthz (restore-only signal)",
    )
    ap.add_argument(
        "--skip-healthz",
        action="store_true",
        help="don't ping /healthz first, so the FIRST parse pays (and measures) the cold boot"
        " — the real end-user first-request latency",
    )
    args = ap.parse_args()

    if not args.url:
        ap.error("no URL: pass --url or set MODAL_PARSE_URL")
    args.url = _file_parse_url(args.url)
    token = args.token or None

    if args.file:
        with open(args.file, "rb") as fh:
            data = fh.read()
        name = os.path.basename(args.file)
    else:
        data = _make_sample_pdf()
        name = "snapshot_test.pdf"

    health_url = _healthz_url(args.url)

    if args.wait_cold > 0:
        print(
            f"waiting {args.wait_cold}s to let the container scale to zero "
            f"(scaledown_window is 300s)...",
            flush=True,
        )
        time.sleep(args.wait_cold)

    print(f"endpoint : {args.url}")
    print(f"payload  : {name} ({len(data)} bytes)")
    print("-" * 64)

    # First /healthz is the cleanest cold-boot probe: it needs a live container
    # (=> snapshot restore) but does no parsing. NOTE: it also *wakes* the
    # container, so the parse rows below are then warm. Use --skip-healthz to
    # instead let the first parse absorb (and measure) the cold boot.
    if not args.skip_healthz:
        try:
            h_elapsed, h_body = ping_healthz(health_url, token, args.timeout)
            print(
                f"healthz  : {h_elapsed:7.2f}s  (server uptime_s={h_body.get('uptime_s')})"
            )
            if (
                isinstance(h_body.get("uptime_s"), (int, float))
                and h_body["uptime_s"] < 5
            ):
                print(
                    "           ^ uptime_s < 5s => this was a fresh cold boot / restore"
                )
        except Exception as e:  # noqa: BLE001
            print(f"healthz  : FAILED ({e})")

        if args.healthz_only:
            return 0
    elif args.healthz_only:
        ap.error("--healthz-only and --skip-healthz are mutually exclusive")

    print("-" * 64)
    print("  #   total(s)  server_parse(s)  overhead(s)  uptime_s")
    totals: list[float] = []
    for i in range(args.num):
        try:
            elapsed, body = do_parse(
                args.url, token, data, name, args.parse_method, args.timeout
            )
        except Exception as e:  # noqa: BLE001
            print(f"{i:3d}   FAILED: {e}")
            return 1
        server = body.get("_server_parse_s")
        uptime = body.get("_uptime_s")
        overhead = None if server is None else elapsed - server
        totals.append(elapsed)
        tag = (
            "  <- cold boot?"
            if i == 0 and isinstance(uptime, (int, float)) and uptime < 15
            else ""
        )
        print(
            f"{i:3d}   {_fmt(elapsed)}   {_fmt(server)}       {_fmt(overhead)}   {_fmt(uptime)}{tag}"
        )

    print("-" * 64)
    if len(totals) >= 2:
        cold = totals[0]
        warm = statistics.median(totals[1:])
        print(f"first (cold?) total : {cold:.2f}s")
        print(f"warm median total   : {warm:.2f}s")
        print(f"cold-boot penalty   : {cold - warm:.2f}s")
        print()
        print("Interpretation:")
        print(
            "  * small penalty (seconds) + first uptime_s near 0 => snapshot restore works."
        )
        print(
            "  * penalty in the minutes  => snapshot NOT restoring; check Modal logs for"
        )
        print("    '[snapshot-build] warmup' lines appearing on an ordinary cold boot.")
    print()
    print("Now compare against Modal: `modal app logs evo-mineru` and the dashboard's")
    print("per-container 'up' duration / cold-start timing for this same run.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
