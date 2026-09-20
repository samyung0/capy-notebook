"""SQLite behind the builder: the URL queue and visited set, the download
queue, the ingestion queue and its receipts. The model never writes here; the
workers and the dashboard do, through the small functions below.

  uv run --project pipeline python lab/knowledge/store.py add-url <url>
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
DATA = REPO / "data/knowledge-base"
SOURCES = DATA / "sources"
RUNS = DATA / "runs"
LOGS = DATA / "logs"
CONFIG = DATA / "config.json"
DB = DATA / "builder.sqlite"
BOOKS_JSON = ROOT / "books.json"

SCHEMA = """
CREATE TABLE IF NOT EXISTS urls (
  url TEXT PRIMARY KEY, host TEXT NOT NULL, status TEXT NOT NULL,
  discovered_from TEXT, depth INTEGER NOT NULL, added_at REAL NOT NULL,
  visited_at REAL, verdict TEXT
);
CREATE INDEX IF NOT EXISTS urls_pending ON urls(status, added_at);
CREATE TABLE IF NOT EXISTS downloads (
  pdf_url TEXT PRIMARY KEY, host TEXT NOT NULL, landing_url TEXT, title TEXT, authors TEXT, edition TEXT,
  subject_id TEXT, level TEXT, language TEXT, licence TEXT, licence_url TEXT,
  licence_evidence_url TEXT, evidence_quote TEXT, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, sha256 TEXT, path TEXT,
  bytes INTEGER, pages INTEGER, duplicate_urls TEXT NOT NULL DEFAULT '[]',
  added_at REAL NOT NULL, finished_at REAL
);
CREATE TABLE IF NOT EXISTS books (
  sha256 TEXT PRIMARY KEY, book_id TEXT NOT NULL UNIQUE, manifest TEXT NOT NULL,
  status TEXT NOT NULL, stage TEXT, queue_position INTEGER, run_dir TEXT NOT NULL,
  error TEXT, added_at REAL NOT NULL, published_at REAL, version INTEGER
);
CREATE TABLE IF NOT EXISTS stage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sha256 TEXT NOT NULL, stage TEXT NOT NULL,
  started_at REAL NOT NULL, ended_at REAL, exit_code INTEGER, log_path TEXT NOT NULL,
  usage TEXT
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, stage TEXT NOT NULL,
  sha256 TEXT, model TEXT NOT NULL, endpoint TEXT NOT NULL, request_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER, elapsed_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS review_tasks (
  sha256 TEXT NOT NULL, stage TEXT NOT NULL, batch_id TEXT NOT NULL, input_file_id TEXT, status TEXT NOT NULL,
  submitted_at REAL NOT NULL, checked_at REAL, output_file_id TEXT, error_file_id TEXT,
  requests INTEGER NOT NULL, done INTEGER, failed INTEGER, error TEXT, PRIMARY KEY (sha256, stage)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

# Worker states and knobs live in `settings`; these are the values used when a
# key was never written. `live_endpoint` sends the transcribe and tag stages
# through the live endpoint instead of Alibaba Batch.
DEFAULT_SETTINGS = {
    "scrape": "paused",
    "ingest": "paused",
    "ingest_notice": "",
    "host_delay_seconds": "5",
    "live_endpoint": "0",
}


def init() -> None:
    """Create the file and the schema once, at server start (tests and the
    add-url command run it too); `db()` itself runs no DDL."""
    DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB, timeout=30)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
    finally:
        conn.close()


def startup_reset() -> dict:
    """Rows a dead process left behind: running books and claimed downloads go
    back to the queue at their current stage; waiting books keep waiting (the
    batch poll resumes)."""
    with db() as conn:
        books = conn.execute(
            "UPDATE books SET status='queued' WHERE status='running'"
        ).rowcount
        downloads = conn.execute(
            "UPDATE downloads SET status='queued' WHERE status='downloading'"
        ).rowcount
        urls = conn.execute(
            "UPDATE urls SET status='pending' WHERE status='scraping'"
        ).rowcount
    return {"books": books, "downloads": downloads, "urls": urls}


@contextlib.contextmanager
def db():
    """One connection per operation: cheap, thread-safe, and WAL lets the
    worker threads, the dashboard and the stage subprocesses share the file."""
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def host_of(url: str) -> str:
    return urlsplit(url).netloc.lower()


# --- settings ---------------------------------------------------------------


def setting(key: str) -> str:
    with db() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else DEFAULT_SETTINGS[key]


def set_setting(key: str, value: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


# --- urls ---------------------------------------------------------------------

PENDING_PER_HOST = 2000


def enqueue_url(url: str, depth: int = 0, discovered_from: str | None = None) -> bool:
    """False when the URL is already known or its host has 2,000 pending."""
    host = host_of(url)
    with db() as conn:
        # A numbered-page link may discover a URL before rel=next reaches it.
        # Keep the shortest pending route so pagination preserves crawl depth.
        conn.execute(
            "UPDATE urls SET depth=?, discovered_from=? WHERE url=? AND status='pending' AND depth>?",
            (depth, discovered_from, url, depth),
        )
        pending = conn.execute(
            "SELECT count(*) FROM urls WHERE host=? AND status='pending'", (host,)
        ).fetchone()[0]
        if pending >= PENDING_PER_HOST:
            return False
        cur = conn.execute(
            "INSERT OR IGNORE INTO urls(url,host,status,discovered_from,depth,added_at) VALUES(?,?,'pending',?,?,?)",
            (url, host, discovered_from, depth, time.time()),
        )
        return cur.rowcount == 1


def next_url(delay_seconds: float) -> sqlite3.Row | None:
    """Atomically claim a page and reserve its host delay before fetching."""
    now = time.time()
    with db() as conn:
        return conn.execute(
            "UPDATE urls SET status='scraping', visited_at=? WHERE url=("
            "SELECT u.url FROM urls u WHERE u.status='pending' AND NOT EXISTS "
            "(SELECT 1 FROM urls v WHERE v.host=u.host AND v.visited_at > ?) "
            "AND NOT EXISTS (SELECT 1 FROM downloads d WHERE d.host=u.host "
            "AND (d.status='downloading' OR d.finished_at > ?)) "
            "ORDER BY u.added_at, u.rowid LIMIT 1) RETURNING *",
            (now, now - delay_seconds, now - delay_seconds),
        ).fetchone()


def mark_url(url: str, status: str, verdict: dict | None = None) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE urls SET status=?, visited_at=?, verdict=? WHERE url=?",
            (
                status,
                time.time(),
                json.dumps(verdict, ensure_ascii=False) if verdict else None,
                url,
            ),
        )


def url_verdict(url: str | None) -> dict | None:
    if not url:
        return None
    with db() as conn:
        row = conn.execute("SELECT verdict FROM urls WHERE url=?", (url,)).fetchone()
    return json.loads(row["verdict"]) if row and row["verdict"] else None


def remove_url(url: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM urls WHERE url=? AND status='pending'", (url,))


def url_counts() -> dict:
    with db() as conn:
        by_status = dict(
            conn.execute("SELECT status, count(*) FROM urls GROUP BY status").fetchall()
        )
        by_host = conn.execute(
            "SELECT host, count(*) AS n FROM urls WHERE status='pending' GROUP BY host ORDER BY n DESC"
        ).fetchall()
        head = conn.execute(
            "SELECT url, depth, discovered_from FROM urls WHERE status='pending' ORDER BY added_at LIMIT 50"
        ).fetchall()
    return {
        "by_status": by_status,
        "pending_by_host": [dict(r) for r in by_host],
        "pending_head": [dict(r) for r in head],
    }


# --- downloads ----------------------------------------------------------------

DOWNLOAD_FIELDS = (
    "pdf_url",
    "landing_url",
    "title",
    "authors",
    "edition",
    "subject_id",
    "level",
    "language",
    "licence",
    "licence_url",
    "licence_evidence_url",
    "evidence_quote",
)


def add_download(row: dict, status: str, error: str | None = None) -> bool:
    """A candidate PDF: `queued` when the gate passed, `rejected` with the reason
    otherwise. False when the URL is already known."""
    values = {k: row.get(k) for k in DOWNLOAD_FIELDS}
    values["authors"] = json.dumps(values["authors"] or [], ensure_ascii=False)
    with db() as conn:
        cur = conn.execute(
            f"INSERT OR IGNORE INTO downloads({','.join(DOWNLOAD_FIELDS)},host,status,last_error,added_at) "
            f"VALUES({','.join('?' * len(DOWNLOAD_FIELDS))},?,?,?,?)",
            (*values.values(), host_of(row["pdf_url"]), status, error, time.time()),
        )
        return cur.rowcount == 1


def next_download(delay_seconds: float) -> dict | None:
    """Claim the oldest queued PDF on a host with no download in flight and
    nothing fetched (page or PDF) within the delay."""
    since = time.time() - delay_seconds
    with db() as conn:
        row = conn.execute(
            "UPDATE downloads SET status='downloading' WHERE pdf_url=("
            "SELECT d.pdf_url FROM downloads d WHERE d.status='queued' AND NOT EXISTS "
            "(SELECT 1 FROM downloads o WHERE o.host=d.host AND (o.status='downloading' OR o.finished_at > ?)) "
            "AND NOT EXISTS (SELECT 1 FROM urls v WHERE v.host=d.host AND v.visited_at > ?) "
            "ORDER BY d.added_at LIMIT 1) RETURNING *",
            (since, since),
        ).fetchone()
    return download_dict(row) if row else None


def download_dict(row: sqlite3.Row) -> dict:
    out = dict(row)
    out["authors"] = json.loads(out["authors"] or "[]")
    out["duplicate_urls"] = json.loads(out["duplicate_urls"] or "[]")
    return out


def finish_download(
    pdf_url: str, status: str, attempts: int, error: str | None = None, **fields
) -> None:
    sets = ", ".join(f"{k}=?" for k in fields)
    with db() as conn:
        conn.execute(
            f"UPDATE downloads SET status=?, attempts=?, last_error=?, finished_at=?{', ' + sets if sets else ''} WHERE pdf_url=?",
            (status, attempts, error, time.time(), *fields.values(), pdf_url),
        )


def download_by_sha(sha256: str) -> dict | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM downloads WHERE sha256=?", (sha256,)
        ).fetchone()
    return download_dict(row) if row else None


def reject_download_noncommercial(pdf_url: str) -> bool:
    """Record a manual decision without inventing licence metadata."""
    with db() as conn:
        return (
            conn.execute(
                "UPDATE downloads SET status='rejected', last_error=?, finished_at=? "
                "WHERE pdf_url=? AND status IN ('failed','rejected')",
                ("NonCommercial licence (manual review)", time.time(), pdf_url),
            ).rowcount
            == 1
        )


def mark_duplicate(pdf_url: str, existing_sha: str, attempts: int) -> None:
    """The new URL served bytes we already hold: note it on the existing row."""
    with db() as conn:
        row = conn.execute(
            "SELECT pdf_url, duplicate_urls FROM downloads WHERE sha256=? AND pdf_url<>?",
            (existing_sha, pdf_url),
        ).fetchone()
        if row:
            urls = json.loads(row["duplicate_urls"])
            if pdf_url not in urls:
                urls.append(pdf_url)
            conn.execute(
                "UPDATE downloads SET duplicate_urls=? WHERE pdf_url=?",
                (json.dumps(urls), row["pdf_url"]),
            )
        conn.execute(
            "UPDATE downloads SET status='rejected', attempts=?, last_error=?, sha256=?, finished_at=? WHERE pdf_url=?",
            (
                attempts,
                f"duplicate of {existing_sha}",
                existing_sha,
                time.time(),
                pdf_url,
            ),
        )


def downloads(limit: int = 200) -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM downloads ORDER BY added_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [download_dict(r) for r in rows]


# --- books --------------------------------------------------------------------


def book_dict(row: sqlite3.Row) -> dict:
    out = dict(row)
    out["manifest"] = json.loads(out["manifest"])
    return out


def add_book(sha256: str, book_id: str, manifest: dict, run_dir: str) -> dict:
    with db() as conn:
        position = conn.execute(
            "SELECT coalesce(max(queue_position), 0) + 1 FROM books"
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO books(sha256,book_id,manifest,status,queue_position,run_dir,added_at) VALUES(?,?,?,'queued',?,?,?)",
            (
                sha256,
                book_id,
                json.dumps(manifest, ensure_ascii=False),
                position,
                run_dir,
                time.time(),
            ),
        )
    return book(sha256)


def book(sha256: str) -> dict | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM books WHERE sha256=?", (sha256,)).fetchone()
    return book_dict(row) if row else None


def book_ids() -> set[str]:
    with db() as conn:
        return {r[0] for r in conn.execute("SELECT book_id FROM books")}


def books() -> list[dict]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM books ORDER BY queue_position").fetchall()
    return [book_dict(r) for r in rows]


def set_book(sha256: str, **fields) -> None:
    if "manifest" in fields:
        fields["manifest"] = json.dumps(fields["manifest"], ensure_ascii=False)
    with db() as conn:
        conn.execute(
            f"UPDATE books SET {', '.join(f'{k}=?' for k in fields)} WHERE sha256=?",
            (*fields.values(), sha256),
        )


def next_queued_book() -> dict | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM books WHERE status='queued' ORDER BY queue_position LIMIT 1"
        ).fetchone()
    return book_dict(row) if row else None


def waiting_book_due(poll_seconds: float) -> dict | None:
    """A book waiting on its current stage's batch whose task was not checked
    within the poll interval."""
    with db() as conn:
        row = conn.execute(
            "SELECT b.* FROM books b JOIN review_tasks t ON t.sha256=b.sha256 AND t.stage=b.stage "
            "WHERE b.status='waiting' AND coalesce(t.checked_at, 0) < ? ORDER BY b.queue_position LIMIT 1",
            (time.time() - poll_seconds,),
        ).fetchone()
    return book_dict(row) if row else None


def move_book(sha256: str, direction: int) -> None:
    """Swap queue positions with the neighbour above (-1) or below (+1)."""
    with db() as conn:
        me = conn.execute(
            "SELECT queue_position FROM books WHERE sha256=?", (sha256,)
        ).fetchone()
        if not me:
            return
        op, order = ("<", "DESC") if direction < 0 else (">", "ASC")
        other = conn.execute(
            f"SELECT sha256, queue_position FROM books WHERE queue_position {op} ? ORDER BY queue_position {order} LIMIT 1",
            (me[0],),
        ).fetchone()
        if not other:
            return
        conn.execute(
            "UPDATE books SET queue_position=? WHERE sha256=?", (other[1], sha256)
        )
        conn.execute(
            "UPDATE books SET queue_position=? WHERE sha256=?", (me[0], other[0])
        )


def remove_book(sha256: str) -> None:
    with db() as conn:
        row = conn.execute(
            "SELECT status FROM books WHERE sha256=?", (sha256,)
        ).fetchone()
        if row and row["status"] == "running":
            raise ValueError("the book is running; pause ingestion first")
        conn.execute("DELETE FROM books WHERE sha256=?", (sha256,))


# --- review tasks -------------------------------------------------------------


def set_review_task(sha256: str, stage: str, **fields) -> None:
    """One row per book and stage: inserted on submit (batch_id, requests,
    submitted_at, status), updated by every poll; a redo replaces it."""
    with db() as conn:
        if conn.execute(
            "SELECT 1 FROM review_tasks WHERE sha256=? AND stage=?", (sha256, stage)
        ).fetchone():
            conn.execute(
                f"UPDATE review_tasks SET {', '.join(f'{k}=?' for k in fields)} WHERE sha256=? AND stage=?",
                (*fields.values(), sha256, stage),
            )
        else:
            conn.execute(
                f"INSERT INTO review_tasks(sha256,stage,{','.join(fields)}) VALUES(?,?,{','.join('?' * len(fields))})",
                (sha256, stage, *fields.values()),
            )


def review_task(sha256: str, stage: str) -> dict | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM review_tasks WHERE sha256=? AND stage=?", (sha256, stage)
        ).fetchone()
    return dict(row) if row else None


def review_tasks(sha256: str) -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM review_tasks WHERE sha256=? ORDER BY submitted_at", (sha256,)
        ).fetchall()
    return [dict(r) for r in rows]


def open_review_tasks() -> list[dict]:
    """The current-stage batch task of every waiting book, for the model strip."""
    with db() as conn:
        rows = conn.execute(
            "SELECT t.*, b.book_id FROM review_tasks t JOIN books b ON b.sha256=t.sha256 AND b.stage=t.stage "
            "WHERE b.status='waiting' ORDER BY t.submitted_at"
        ).fetchall()
    return [dict(r) for r in rows]


# --- receipts -----------------------------------------------------------------


def start_stage_run(sha256: str, stage: str, log_path: str) -> int:
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO stage_runs(sha256,stage,started_at,log_path) VALUES(?,?,?,?)",
            (sha256, stage, time.time(), log_path),
        )
        return cur.lastrowid


def finish_stage_run(run_id: int, exit_code: int, usage: dict | None = None) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE stage_runs SET ended_at=?, exit_code=?, usage=? WHERE id=?",
            (time.time(), exit_code, json.dumps(usage) if usage else None, run_id),
        )


def stage_runs(sha256: str) -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM stage_runs WHERE sha256=? ORDER BY id", (sha256,)
        ).fetchall()
    out = [dict(r) for r in rows]
    for r in out:
        r["usage"] = json.loads(r["usage"]) if r["usage"] else None
    return out


def record_llm_call(**fields) -> None:
    fields.setdefault("at", time.time())
    with db() as conn:
        conn.execute(
            f"INSERT INTO llm_calls({','.join(fields)}) VALUES({','.join('?' * len(fields))})",
            tuple(fields.values()),
        )


def llm_usage(
    since: float, sha256: str | None = None, stage: str | None = None
) -> dict:
    where, args = ["at >= ?"], [since]
    if sha256:
        where.append("sha256 = ?")
        args.append(sha256)
    if stage:
        where.append("stage = ?")
        args.append(stage)
    with db() as conn:
        rows = conn.execute(
            "SELECT endpoint, count(*) AS calls, sum(ok) AS ok, coalesce(sum(input_tokens),0) AS input_tokens, "
            f"coalesce(sum(output_tokens),0) AS output_tokens FROM llm_calls WHERE {' AND '.join(where)} GROUP BY endpoint",
            args,
        ).fetchall()
    return {r["endpoint"]: dict(r) for r in rows}


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "add-url":
        init()
        print("queued" if enqueue_url(sys.argv[2]) else "already known or host full")
    else:
        print(__doc__)
