"""Knowledge-base builder dashboard: one page on 127.0.0.1:18766.

Two workflows run as threads in this process: scraping and download
(scrape.py) and ingestion (ingest.py); both start paused and are switched from
the page. Secrets come from the repository-root .env.local; PDFs, SQLite, runs
and logs live under the ignored data/knowledge-base/.

  uv run --project pipeline python lab/knowledge/server.py --port 18766
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

# Module-level so FastAPI can resolve the postponed `Request` annotations.
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store

sys.path.insert(0, str(store.REPO / "lab/playground/scripts"))
from common import (
    KNOWLEDGE_B2_KEYS,
    LIBRARY_PORT,
    ensure_tunnel,
    env_file,
)

ENV_KEYS = (
    "ALIBABA_API_KEY",
    "ALIBABA_BASE_URL",
    "LIBRARY_DATABASE_URL",
    "DEEPINFRA_API_KEY",
    *KNOWLEDGE_B2_KEYS,
)
LOG = logging.getLogger("builder")
PILOT_CONFIG = store.REPO / "data/knowledge-base-pilot-v4/config.json"
UI = Path(__file__).resolve().parent / "ui.html"
SUBJECTS = json.loads(
    (Path(__file__).resolve().parent / "subjects.json").read_text(encoding="utf-8")
)["subjects"]
# Required at the manual gate; `edition` is optional and the licence evidence
# is either a URL or a PDF page, as in the manifest.
MANIFEST_FIELDS = (
    "title",
    "source_url",
    "license",
    "license_url",
    "subject_id",
)


def load_env() -> None:
    """Lift the builder's secrets into the environment before pipeline imports;
    the stage subprocesses inherit them."""
    local = env_file(store.REPO / ".env.local")
    for key in ENV_KEYS:
        if local.get(key):
            os.environ.setdefault(key, local[key])


def ensure_config() -> None:
    """The pilot config, copied on first start. spool_path stays the pilot's:
    the parser container bind-mounts that directory."""
    if store.CONFIG.exists():
        return
    if not PILOT_CONFIG.exists():
        raise SystemExit(
            f"{PILOT_CONFIG} is missing; the builder copies the pilot config on first start"
        )
    config = json.loads(PILOT_CONFIG.read_text(encoding="utf-8"))
    config["model_provider"] = "ollama"
    store.DATA.mkdir(parents=True, exist_ok=True)
    store.CONFIG.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


# --- library ------------------------------------------------------------------

_keys: tuple[float, set[str] | None] = (0.0, None)


def library_query(sql: str) -> set[str] | None:
    """First column of one read-only library query; None when the library
    cannot be reached."""
    url = os.environ.get("LIBRARY_DATABASE_URL")
    if not url:
        return None
    try:
        import psycopg

        ensure_tunnel((LIBRARY_PORT,))
        with psycopg.connect(url, connect_timeout=5) as conn:
            return {r[0] for r in conn.execute(sql).fetchall()}
    except Exception:  # noqa: BLE001 - the dashboard shows the library as unreachable
        return None


def library_object_keys() -> set[str] | None:
    """Object keys of every current or retained library book version; None
    when the library cannot be reached. Cached for a minute."""
    global _keys
    if time.time() - _keys[0] < 60:
        return _keys[1]
    keys = library_query(
        "SELECT object_key FROM library_book_versions WHERE object_key IS NOT NULL AND status IN ('current','retained')"
    )
    _keys = (time.time(), keys)
    return keys


# --- sources ------------------------------------------------------------------


def sources() -> list[dict]:
    keys = library_object_keys()
    by_sha = {d["sha256"]: d for d in store.downloads(10_000) if d.get("sha256")}
    books = {b["sha256"]: b for b in store.books()}
    out = []
    for pdf in sorted(
        store.SOURCES.glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True
    ):
        sha = pdf.stem
        download, book = by_sha.get(sha), books.get(sha)
        out.append(
            {
                "sha256": sha,
                "bytes": pdf.stat().st_size,
                "pages": download["pages"] if download else None,
                "title": download["title"] if download else None,
                "licence": download["licence"] if download else None,
                "download": download,
                "book": {k: book[k] for k in ("book_id", "status", "stage", "version")}
                if book
                else None,
                "processed_before": (book is not None and book["status"] == "published")
                or (keys is not None and f"books/{sha}.pdf" in keys),
                "library_checked": keys is not None,
            }
        )
    return out


def slug(title: str) -> str:
    """A book id no builder row, books.json entry or live library book holds."""
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60] or "book"
    library = library_query("SELECT id FROM library_books")
    if library is None:
        raise ValueError("the library is unreachable, so the book id cannot be checked")
    committed = (
        {
            b["id"]
            for b in json.loads(store.BOOKS_JSON.read_text(encoding="utf-8"))["books"]
        }
        if store.BOOKS_JSON.exists()
        else set()
    )
    taken = store.book_ids() | committed | library
    candidate, n = base, 2
    while candidate in taken:
        candidate, n = f"{base}-{n}", n + 1
    return candidate


def add_book(payload: dict) -> dict:
    """The manual gate: a downloaded PDF plus its checked metadata becomes a
    books row, a one-book run directory and an entry in books.json."""
    sha = payload.get("sha256") or ""
    pdf = store.SOURCES / f"{sha}.pdf"
    if not re.fullmatch(r"[0-9a-f]{64}", sha) or not pdf.exists():
        raise ValueError("no such PDF under data/knowledge-base/sources")
    if store.book(sha):
        raise ValueError("this PDF is already in the ingestion queue")
    authors = [a.strip() for a in payload.get("authors") or [] if a.strip()]
    attribution = str(payload.get("attribution") or "").strip()
    if not authors and (
        payload.get("attribution_reviewed") is not True or not attribution
    ):
        raise ValueError(
            "With no authors, check the source and PDF, confirm attribution review, and enter the attribution with any supplied credits and notices"
        )
    missing = [
        f
        for f in MANIFEST_FIELDS
        if not (authors if f == "authors" else str(payload.get(f) or "").strip())
    ]
    if missing:
        raise ValueError("fill in " + ", ".join(missing))
    evidence_url = str(payload.get("license_evidence_url") or "").strip()
    evidence_page = str(payload.get("license_evidence_pdf_page") or "").strip()
    if not evidence_url and not evidence_page.isdigit():
        raise ValueError(
            "give a licence evidence URL or the PDF page stating the licence"
        )
    if payload["subject_id"] not in {s["id"] for s in SUBJECTS}:
        raise ValueError(f"unknown subject_id {payload['subject_id']!r}")
    import scrape

    if scrape.excluded_title_or_filename(
        payload["title"],
        str(payload.get("download_url") or "").split("?")[0].rsplit("/", 1)[-1],
    ):
        raise ValueError("Free Courseware in title or filename")

    try:
        pages = scrape.page_count(pdf)
    except Exception as exc:
        raise ValueError(f"unreadable PDF: {type(exc).__name__}") from exc
    title = payload["title"].strip()
    edition = str(payload.get("edition") or "").strip()
    book_id = slug(title)
    entry = {
        "id": book_id,
        "title": title,
        "authors": authors,
        "edition": edition,
        "source_url": payload["source_url"].strip(),
        "download_url": (payload.get("download_url") or payload["source_url"]).strip(),
        "license": payload["license"].strip(),
        "license_url": payload["license_url"].strip(),
        "license_evidence_url": evidence_url,
        "license_evidence_quote": (payload.get("license_evidence_quote") or "").strip(),
        "attribution_reviewed": payload.get("attribution_reviewed") is True,
        "attribution": attribution
        or ", ".join([title, ", ".join(authors), *([edition] if edition else [])])
        + f". {payload['license'].strip()}. {payload['source_url'].strip()}",
        "pdf_path": f"data/knowledge-base/sources/{sha}.pdf",
        "sha256": sha,
        "bytes": pdf.stat().st_size,
        "pages": pages,
        "first_content_page": None,
        "figure_exclusions": [],
        "rights_notes": [],
        "subject_id": payload["subject_id"],
    }
    if evidence_page.isdigit():
        entry["license_evidence_pdf_page"] = int(evidence_page)
    run_dir = store.RUNS / book_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "manifest.json").write_text(
        json.dumps({"books": [entry]}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    book = store.add_book(sha, book_id, entry, str(run_dir))
    import ingest

    ingest.export_book(entry)
    return book


# --- state --------------------------------------------------------------------


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def transcribe_view(run_dir: Path, with_held: bool) -> dict | None:
    """The latest transcribe receipt; the held ledger only for the book the
    dashboard selected (each item carries a page transcription)."""
    import batches
    import transcribe

    latest = batches.latest_receipt(run_dir, "transcribe")
    if latest is None:
        return None
    held = transcribe.ledger(run_dir)["held"]
    return {
        **{
            k: v
            for k, v in latest.items()
            if not k.endswith("_ids") and k != "held_items"
        },
        "undecided": sum(1 for h in held if h["decision"] is None),
        "held_items": held if with_held else None,
    }


def book_view(book: dict, with_held: bool = False) -> dict:
    import batches

    run_dir = Path(book["run_dir"])
    topics = read_json(run_dir / "topics.json")
    manifest = book["manifest"]
    return {
        **{
            k: book[k]
            for k in (
                "sha256",
                "book_id",
                "status",
                "stage",
                "queue_position",
                "error",
                "version",
                "added_at",
                "published_at",
            )
        },
        "title": manifest["title"],
        "subject_id": manifest["subject_id"],
        "pages": manifest["pages"],
        "first_content_page": manifest.get("first_content_page"),
        "stage_runs": store.stage_runs(book["sha256"]),
        "topics": topics
        and {
            **{k: topics[k] for k in ("reused", "proposed", "mapped", "subject_total")},
            "excerpts": topics.get("excerpts"),
            "over": sorted(
                t for t, n in (topics.get("excerpts") or {}).items() if n > 60
            ),
        },
        "transcribe": transcribe_view(run_dir, with_held),
        "tag": batches.latest_receipt(run_dir, "tag"),
        "tasks": store.review_tasks(book["sha256"]),
    }


def state(held_for: str | None = None) -> dict:
    """The dashboard's state; held items ride along for `held_for` only."""
    import ingest
    import llm

    midnight = time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1))
    return {
        "settings": {k: store.setting(k) for k in store.DEFAULT_SETTINGS},
        "deps": ingest.dependencies(),
        "containers": ingest.CONTAINERS,
        "model": {
            "ollama": {"endpoint": llm.OLLAMA, "model": llm.OLLAMA_MODEL},
            "alibaba": {
                "endpoint": os.environ.get("ALIBABA_BASE_URL", ""),
                "model": llm.ALIBABA_MODEL,
                "configured": bool(
                    os.environ.get("ALIBABA_API_KEY")
                    and os.environ.get("ALIBABA_BASE_URL")
                ),
            },
            "today": store.llm_usage(midnight),
            "batches": store.open_review_tasks(),
        },
        "sources": sources(),
        "scrape": {"urls": store.url_counts(), "downloads": store.downloads(2_000)},
        "ingest": {
            "books": [book_view(b, b["sha256"] == held_for) for b in store.books()]
        },
        "subjects": [{k: s[k] for k in ("id", "label", "area")} for s in SUBJECTS],
        "paths": {"data": str(store.DATA), "books_json": str(store.BOOKS_JSON)},
    }


# --- app ----------------------------------------------------------------------


def supervised(target, stop: threading.Event) -> None:
    """Run a worker loop; log a death and start it again after a pause."""
    while not stop.is_set():
        try:
            target(stop)
            return
        except Exception:
            LOG.exception("%s died; restarting in 5 s", target.__name__)
            with (store.LOGS / "workers.log").open("a", encoding="utf-8") as out:
                out.write(f"[{time.strftime('%H:%M:%S')}] {target.__name__} died\n")
            stop.wait(5)


def build_app():
    import ingest
    import scrape
    import transcribe

    stop = threading.Event()

    @asynccontextmanager
    async def lifespan(app):
        for target in (
            *([scrape.scrape_worker] * 10),
            scrape.download_worker,
            scrape.download_worker,
            ingest.worker,
        ):
            threading.Thread(
                target=supervised, args=(target, stop), daemon=True
            ).start()
        yield
        stop.set()

    app = FastAPI(lifespan=lifespan)

    @app.get("/")
    def index():
        return HTMLResponse(UI.read_text(encoding="utf-8"))

    @app.get("/api/state")
    def get_state(held: str | None = None):
        return state(held)

    @app.post("/api/workflows/{workflow}/{action}")
    def switch(workflow: str, action: str):
        if workflow not in ("scrape", "ingest") or action not in ("start", "pause"):
            raise HTTPException(404)
        store.set_setting(workflow, "running" if action == "start" else "paused")
        if workflow == "ingest" and action == "start":
            store.set_setting("ingest_notice", "")
        return {workflow: store.setting(workflow)}

    @app.post("/api/settings")
    async def settings(request: Request):
        body = await request.json()
        if "host_delay_seconds" in body:
            store.set_setting(
                "host_delay_seconds", str(float(body["host_delay_seconds"]))
            )
        if "live_endpoint" in body:
            if store.open_review_tasks():
                raise HTTPException(
                    409, "a batch task is open; wait for it or redo the stage"
                )
            store.set_setting("live_endpoint", "1" if body["live_endpoint"] else "0")
        return {k: store.setting(k) for k in store.DEFAULT_SETTINGS}

    @app.post("/api/urls")
    async def add_url(request: Request):
        url = scrape.normalise(str((await request.json()).get("url") or ""))
        if not url:
            raise HTTPException(400, "an absolute http(s) URL is needed")
        return {"queued": store.enqueue_url(url), "url": url}

    @app.delete("/api/urls")
    def delete_url(url: str):
        store.remove_url(url)
        return {"removed": url}

    @app.post("/api/books")
    async def post_book(request: Request):
        try:
            return add_book(await request.json())
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.post("/api/books/{sha}/{action}")
    def book_action(sha: str, action: str):
        book = store.book(sha)
        if not book:
            raise HTTPException(404)
        if action == "up":
            store.move_book(sha, -1)
        elif action == "down":
            store.move_book(sha, 1)
        elif action == "remove":
            try:
                store.remove_book(sha)
            except ValueError as exc:
                raise HTTPException(409, str(exc)) from exc
        elif action == "retry":
            if book["status"] not in ("failed", "waiting"):
                raise HTTPException(409, "only a failed or waiting book is retried")
            store.set_book(sha, status="queued", error=None)
        else:
            raise HTTPException(404)
        return {"ok": True}

    @app.post("/api/books/{sha}/held/{chunk_id}/{decision}")
    def decide_held(sha: str, chunk_id: str, decision: str):
        book = store.book(sha)
        if not book or decision not in ("accept", "reject"):
            raise HTTPException(404)
        if book["status"] in ("running", "waiting"):
            raise HTTPException(409, "the book is running; decide once it has stopped")
        try:
            item = transcribe.decide(
                Path(book["run_dir"]), book["book_id"], chunk_id, decision == "accept"
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        if decision == "accept" and book["stage"] == "publish":
            # The accepted text must reach the pilot index before it is published.
            store.set_book(sha, stage="index")
        return item

    @app.get("/api/books/{sha}/pages/{page}")
    def page_image(sha: str, page: int):
        book = store.book(sha)
        path = Path(book["run_dir"]) / "pages" / f"{page}.jpg" if book else None
        if not path or not path.exists():
            raise HTTPException(404)
        return FileResponse(path, media_type="image/jpeg")

    @app.post("/api/docker/start/{name}")
    def docker_start(name: str):
        try:
            return {"output": ingest.start_container(name)}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/books/{sha}/log/{stage}")
    async def log(sha: str, stage: str):
        book = store.book(sha)
        if not book or stage not in ingest.STAGES:
            raise HTTPException(404)
        path = store.LOGS / book["book_id"] / f"{stage}.log"

        async def tail():
            position = 0
            while True:
                if path.exists():
                    with path.open("rb") as handle:
                        handle.seek(position)
                        data = handle.read()
                        position = handle.tell()
                    if data:
                        yield (
                            "data: "
                            + json.dumps(data.decode("utf-8", "replace"))
                            + "\n\n"
                        )
                current = store.book(sha)
                if (
                    not current
                    or current["status"] != "running"
                    or current["stage"] != stage
                ):
                    yield "event: end\ndata: {}\n\n"
                    return
                await asyncio.sleep(0.7)

        return StreamingResponse(tail(), media_type="text/event-stream")

    @app.get("/api/books/{sha}/log/{stage}/text")
    def log_text(sha: str, stage: str):
        book = store.book(sha)
        if not book:
            raise HTTPException(404)
        path = store.LOGS / book["book_id"] / f"{stage}.log"
        return {
            "text": path.read_text(encoding="utf-8", errors="replace")[-200_000:]
            if path.exists()
            else ""
        }

    return app


def check() -> None:
    import scrape
    import topics
    import transcribe

    assert scrape.licence_accepted("CC BY 4.0", "https://x", "quote") == (True, "")
    assert scrape.licence_accepted("CC BY-NC-SA 4.0", "https://x", "quote")[0] is False
    assert (
        scrape.normalise("HTTPS://OpenStax.org/subjects/science#top")
        == "https://openstax.org/subjects/science"
    )
    merged = topics.merge(
        [
            {
                "id": "a",
                "label": "Alpha",
                "aliases": ["first"],
                "scope": "",
                "source_sections": "",
            }
        ],
        {
            "reused": ["a"],
            "proposed": [
                {
                    "id": "b",
                    "label": "First",
                    "aliases": [],
                    "scope": "",
                    "source_sections": "",
                }
            ],
        },
        "s",
    )
    assert merged["reused"] == ["a"] and merged["proposed"] == []
    page = "Header 12\n\nThe speed is 10 m/s and the time is 2 s, so the distance is 20 m.\n\nFooter"
    span, coverage = transcribe.align(
        "The speed is m/s and the time is s, so the distance is m.", page
    )
    assert span == "The speed is 10 m/s and the time is 2 s, so the distance is 20 m."
    assert coverage == 1
    assert transcribe.judge("Contents 1.1 Motion", page)["outcome"] == "short"
    assert transcribe.judge("x " * 40, page)["outcome"] == "hold"
    assert transcribe.label_number("FIGURE 4.3 Forces") == "4.3"
    assert UI.exists() and SUBJECTS
    print("builder checks passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18766)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    load_env()
    ensure_config()
    for path in (store.SOURCES, store.RUNS, store.LOGS):
        path.mkdir(parents=True, exist_ok=True)
    store.init()
    reset = store.startup_reset()
    if any(reset.values()):
        print(f"requeued after restart: {reset}", flush=True)
    # A killed stage leaves its batch lock; nothing of ours runs at startup.
    for lock in store.RUNS.glob("*/models/*/command.lock"):
        lock.unlink()
        print(f"removed stale {lock}", flush=True)
    import uvicorn

    print(
        f"data={store.DATA} library_port={LIBRARY_PORT} http://127.0.0.1:{args.port}",
        flush=True,
    )
    if sys.platform == "win32":
        # psycopg's async pool refuses the Proactor loop that uvicorn installs on
        # Windows, so serve on a selector loop of our own.
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    config = uvicorn.Config(
        build_app(), host="127.0.0.1", port=args.port, log_level="warning", loop="none"
    )
    asyncio.run(uvicorn.Server(config).serve())


if __name__ == "__main__":
    main()
