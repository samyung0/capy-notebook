"""Workflow 2: ingestion. One book at a time through the pilot stages, each a
subprocess writing data/knowledge-base/logs/<book_id>/<stage>.log.

parse -> figures -> topics -> transcribe -> tag -> index -> publish

Pause is checked between stages (the current stage finishes). A non-zero exit
marks the book failed with the stage and its log; retry resumes from that
stage. A stage whose dependency is down pauses the workflow with the reason
instead of failing the book. The transcribe and tag stages exit 3 while their
Alibaba Batch task is in flight: the book is `waiting`, the worker polls the
task every ten minutes and re-queues the book at that stage once the task is
terminal.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batches
import store
import topics
import transcribe

sys.path.insert(0, str(store.REPO / "lab/playground/scripts"))
from common import KNOWLEDGE_B2_KEYS, LIBRARY_PORT, ensure_tunnel

ROOT = Path(__file__).resolve().parent
PILOT = store.REPO / "bench/rag/scripts/knowledge_base_pilot.py"
LOADER = store.REPO / "bench/rag/scripts/knowledge_base_library.py"
SECRETS = store.REPO / ".env.local"
STAGES = ("parse", "figures", "topics", "transcribe", "tag", "index", "publish")
BATCH_STAGES = ("transcribe", "tag")
WAITING = batches.WAITING
POLL_SECONDS = 600
CONTAINERS = {
    "postgres": "capy-kb-postgres-v4-pilot",
    "parser": "capy-kb-parser-v4-pilot",
}
NEEDS = {
    "parse": ("postgres", "parser"),
    "figures": (),
    "topics": ("ollama", "tunnel"),
    "transcribe": ("alibaba", "bucket"),
    "tag": ("alibaba",),
    "index": ("postgres",),
    "publish": ("postgres", "tunnel", "bucket"),
}
FRONT_MATTER = re.compile(
    r"\b(contents|preface|foreword|copyright|acknowledg|about th|dedication|title page|licen[cs]e|attribution|how to use)",
    re.IGNORECASE,
)
SECTION_NUMBER = re.compile(r"^\d+\.\d+\b")


# --- dependencies -------------------------------------------------------------


def running_containers() -> set[str]:
    try:
        out = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    return set(out.stdout.split())


def start_container(name: str) -> str:
    if name not in CONTAINERS.values():
        raise ValueError(f"unknown container {name}")
    out = subprocess.run(
        ["docker", "start", name],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    return (out.stdout + out.stderr).strip()


def ollama_up() -> bool:
    try:
        return (
            httpx.get("http://127.0.0.1:11434/api/tags", timeout=3).status_code == 200
        )
    except httpx.HTTPError:
        return False


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def dependencies() -> dict[str, bool]:
    running = running_containers()
    return {
        "postgres": CONTAINERS["postgres"] in running,
        "parser": CONTAINERS["parser"] in running,
        "ollama": ollama_up(),
        "tunnel": port_open(LIBRARY_PORT),
        "bucket": all(os.environ.get(k) for k in KNOWLEDGE_B2_KEYS),
        "alibaba": bool(
            os.environ.get("ALIBABA_API_KEY") and os.environ.get("ALIBABA_BASE_URL")
        ),
    }


def check_dependencies(stage: str) -> str | None:
    """The refusal message when something the stage needs is down, else None."""
    needs = NEEDS[stage]
    if stage == "transcribe" and store.setting("live_endpoint") == "1":
        needs = ("alibaba",)  # the live path sends page images inline
    if "tunnel" in needs:
        try:
            ensure_tunnel((LIBRARY_PORT,))
        except (RuntimeError, OSError) as exc:
            return f"{stage} needs the library tunnel: {exc}"
    state = dependencies()
    down = [name for name in needs if not state[name]]
    if not down:
        return None
    names = {
        "postgres": CONTAINERS["postgres"],
        "parser": CONTAINERS["parser"],
        "ollama": "Ollama on 127.0.0.1:11434",
        "tunnel": f"the library tunnel on {LIBRARY_PORT}",
        "bucket": "KNOWLEDGE_BASE_B2_* in .env.local",
        "alibaba": "ALIBABA_API_KEY and ALIBABA_BASE_URL in .env.local",
    }
    return f"{stage} refused: {', '.join(names[d] for d in down)} down"


# --- commands -----------------------------------------------------------------


def pilot(command: str, run_dir: Path, *extra: str) -> list[str]:
    return [
        sys.executable,
        str(PILOT),
        command,
        "--manifest",
        str(run_dir / "manifest.json"),
        "--config",
        str(store.CONFIG),
        "--run",
        str(run_dir),
        "--secrets",
        str(SECRETS),
        *extra,
    ]


def log_line(log: Path, text: str) -> None:
    with log.open("a", encoding="utf-8") as out:
        out.write(f"[{time.strftime('%H:%M:%S')}] {text}\n")


def run_command(cmd: list[str], log: Path) -> int:
    log.parent.mkdir(parents=True, exist_ok=True)
    log_line(log, "$ " + " ".join(cmd))
    with log.open("a", encoding="utf-8") as out:
        proc = subprocess.Popen(
            cmd,
            stdout=out,
            stderr=subprocess.STDOUT,
            cwd=store.REPO,
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"},
        )
        code = proc.wait()
    log_line(log, f"exit {code}")
    return code


def first_content_page(chunks: list[dict]) -> int | None:
    """The first page of the chapter holding the first numbered section
    ("1.1 ...") outside front matter, None when no chunk has one."""
    prefix = topics.shared_prefix([c["section_path"] for c in chunks])
    outline = [topics.stripped(c["section_path"], prefix) for c in chunks]
    for parts in outline:
        if (
            len(parts) >= 2
            and SECTION_NUMBER.match(parts[-1])
            and not FRONT_MATTER.search(" › ".join(parts))
        ):
            chapter = parts[0]
            pages = [
                c["page_start"]
                for c, p in zip(chunks, outline)
                if p and p[0] == chapter and c.get("page_start")
            ]
            return min(pages) if pages else None
    return None


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


def run_parse(book: dict, run_dir: Path, log: Path) -> int:
    code = run_command(pilot("parse", run_dir, "--book", book["book_id"]), log)
    if code:
        return code
    manifest = read_json(run_dir / "manifest.json")
    entry = manifest["books"][0]
    if entry.get("first_content_page"):
        return 0
    corpus_path = run_dir / "books" / book["book_id"] / "corpus.json"
    corpus = read_json(corpus_path)
    page = first_content_page(corpus["chunks"])
    if page is None:
        log_line(
            log,
            "first_content_page: no chunk looked like body matter; leaving 1, review the manifest",
        )
        page = 1
    else:
        log_line(
            log,
            f"first_content_page: {page} ({corpus['chunks'][0]['section_path'][:60]!r} and earlier are front matter)",
        )
    entry["first_content_page"] = page
    corpus["book"]["first_content_page"] = page
    write_json(run_dir / "manifest.json", manifest)
    write_json(corpus_path, corpus)
    store.set_book(book["sha256"], manifest=entry)
    export_book(entry)
    return 0


def export_book(entry: dict) -> None:
    """Merge one book into lab/knowledge/books.json by sha256: on add, after
    parse fills first_content_page and after publish records the version."""
    data = (
        json.loads(store.BOOKS_JSON.read_text(encoding="utf-8"))
        if store.BOOKS_JSON.exists()
        else {"books": []}
    )
    books = [b for b in data.get("books", []) if b.get("sha256") != entry["sha256"]] + [
        entry
    ]
    data["books"] = sorted(books, key=lambda b: b["id"])
    # LF endings: the file is committed and biome formats JSON.
    store.BOOKS_JSON.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def run_figures(book: dict, run_dir: Path, log: Path) -> int:
    return run_command(pilot("refresh-figures", run_dir), log)


def run_topics(book: dict, run_dir: Path, log: Path) -> int:
    return run_command(
        [
            sys.executable,
            str(ROOT / "topics.py"),
            "--run",
            str(run_dir),
            "--book",
            book["book_id"],
        ],
        log,
    )


def run_batch_stage(stage: str):
    """Exit 0 when applied, 3 (WAITING) while the batch task is in flight."""

    def run_stage(book: dict, run_dir: Path, log: Path) -> int:
        live = ["--live"] if store.setting("live_endpoint") == "1" else []
        return run_command(
            [
                sys.executable,
                str(ROOT / f"{stage}.py"),
                "--run",
                str(run_dir),
                "--book",
                book["book_id"],
                *live,
            ],
            log,
        )

    return run_stage


def run_index(book: dict, run_dir: Path, log: Path) -> int:
    return run_command(pilot("index", run_dir), log)


def upload_source(book: dict, log: Path) -> None:
    """books/<sha256>.pdf into the knowledge-base bucket when head_object misses."""
    sys.path.insert(0, str(store.REPO / "pipeline"))
    from pipeline.config import cfg
    from pipeline.store import blobstore

    key = f"books/{book['sha256']}.pdf"
    if blobstore.library_object_info(key) is not None:
        log_line(log, f"{key} already in the bucket")
        return
    pdf = store.REPO / book["manifest"]["pdf_path"]
    log_line(log, f"uploading {pdf.name} ({pdf.stat().st_size} bytes) as {key}")
    blobstore.library_client().upload_file(
        str(pdf),
        cfg.knowledge_base_b2_bucket,
        key,
        ExtraArgs={"ContentType": "application/pdf"},
    )
    log_line(log, "uploaded")


def run_publish(book: dict, run_dir: Path, log: Path) -> int:
    held = transcribe.undecided(run_dir)
    if held:
        log_line(
            log,
            f"{len(held)} held chunks undecided ({', '.join(h['chunk_id'] for h in held[:20])}"
            f"{', ...' if len(held) > 20 else ''}); decide on the dashboard",
        )
        return 1
    try:
        upload_source(book, log)
    except Exception as exc:  # noqa: BLE001 - the stage log is the receipt
        log_line(log, f"upload failed: {type(exc).__name__}: {str(exc)[:300]}")
        return 1
    return run_command(
        [
            sys.executable,
            str(LOADER),
            "publish",
            "--run",
            str(run_dir),
            "--manifest",
            str(run_dir / "manifest.json"),
            "--config",
            str(store.CONFIG),
            "--book",
            book["book_id"],
            "--note",
            f"builder {time.strftime('%Y-%m-%d')}",
        ],
        log,
    )


STAGE_RUNNERS = {
    "parse": run_parse,
    "figures": run_figures,
    "topics": run_topics,
    "transcribe": run_batch_stage("transcribe"),
    "tag": run_batch_stage("tag"),
    "index": run_index,
    "publish": run_publish,
}


def published_version(run_dir: Path, book_id: str) -> int | None:
    versions = [
        read_json(path)["version"]
        for path in run_dir.glob(f"library-publish-{book_id}-v*.json")
    ]
    return max(versions) if versions else None


def stage_usage(book: dict, stage: str, started: float) -> dict | None:
    usage = store.llm_usage(started, sha256=book["sha256"], stage=stage)
    return usage or None


def paused() -> bool:
    return store.setting("ingest") != "running"


def run_book(book: dict) -> None:
    sha, run_dir = book["sha256"], Path(book["run_dir"])
    start = STAGES.index(book["stage"]) if book["stage"] in STAGES else 0
    store.set_book(sha, status="running", error=None)
    for i, stage in enumerate(STAGES[start:], start):
        store.set_book(sha, stage=stage)
        refusal = check_dependencies(stage)
        if refusal:
            # The next book would refuse on the same dependency: pause instead.
            store.set_setting("ingest", "paused")
            store.set_setting("ingest_notice", refusal)
            store.set_book(sha, status="queued")
            return
        log = store.LOGS / book["book_id"] / f"{stage}.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        started = time.time()
        run_id = store.start_stage_run(sha, stage, str(log))
        try:
            code = STAGE_RUNNERS[stage](store.book(sha), run_dir, log)
        except Exception as exc:  # noqa: BLE001 - the runner itself failed; the book records it
            log_line(log, f"runner error: {type(exc).__name__}: {str(exc)[:300]}")
            code = 1
        store.finish_stage_run(run_id, code, stage_usage(book, stage, started))
        if code == WAITING and stage in BATCH_STAGES:
            store.set_book(sha, status="waiting")
            return
        if code:
            store.set_book(
                sha, status="failed", error=f"{stage} exited {code}; see {log}"
            )
            return
        if stage == "publish":
            version = published_version(run_dir, book["book_id"])
            store.set_book(
                sha,
                status="published",
                stage=None,
                published_at=time.time(),
                version=version,
            )
            export_book({**store.book(sha)["manifest"], "version": version})
            return
        if paused():
            store.set_book(sha, status="queued", stage=STAGES[i + 1])
            return


def poll_waiting() -> bool:
    """Check one waiting book's batch task when its poll is due; a terminal
    task re-queues the book at its stage so the stage collects and applies.
    True when a check happened."""
    book = store.waiting_book_due(POLL_SECONDS)
    if book is None:
        return False
    if batches.poll(book["sha256"], book["stage"]) in batches.TERMINAL:
        store.set_book(book["sha256"], status="queued")
    return True


def worker(stop=None) -> None:
    while not (stop and stop.is_set()):
        if paused():
            time.sleep(1)
            continue
        book = store.next_queued_book()
        if book is not None:
            try:
                run_book(book)
            except Exception as exc:  # noqa: BLE001 - one book's crash must not stop the queue
                store.set_book(
                    book["sha256"],
                    status="failed",
                    error=f"worker error: {type(exc).__name__}: {str(exc)[:200]}",
                )
        elif not poll_waiting():
            time.sleep(2)
