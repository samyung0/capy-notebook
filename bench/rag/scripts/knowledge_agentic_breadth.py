"""Compare five versus ten library excerpts through the existing curate loop.

Requires explicit authorization for read-only access to the shared library.
Uses its reader role, Ollama GLM 5.3 Flash, and the existing playground writer.
All generated materials and traces stay under --output. No reranker is used.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "lab/playground/scripts"), str(ROOT / "pipeline")]
OUTPUT = ROOT / "bench/rag/reports/local/2026-09-21-knowledge-agentic-breadth"
CASES = (
    "distinct-regression-examples",
    "regression-by-hand",
    "paired-t-test",
    "regression-r",
    "mean-median",
    "quantum-surface-codes",
)
REPEATS = ("distinct-regression-examples", "paired-t-test")
INPUTS = (
    "bench/rag/scripts/knowledge_agentic_breadth.py",
    "bench/rag/scripts/knowledge_scope_agent_eval.py",
    "bench/rag/fixtures/knowledge-scope-cases.json",
    "lab/playground/scripts/playground.py",
    "lab/playground/configs/curate.json",
    "pipeline/pipeline/prompts/curate.py",
    "pipeline/pipeline/retrieval/agent.py",
    "pipeline/pipeline/retrieval/library.py",
    "pipeline/pipeline/retrieval/store.py",
    "pipeline/pipeline/retrieval/models.py",
    "pipeline/pipeline/retrieval/capture.py",
    "pipeline/pipeline/retrieval/tools.py",
    "pipeline/pipeline/retrieval/limits.py",
    "pipeline/pipeline/generated/agent_tools.json",
)


def save(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def hashes() -> dict[str, str]:
    return {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in INPUTS
    }


def schedule() -> list[dict]:
    runs = []
    for repeat, cases in ((1, CASES), (2, REPEATS)):
        for index, case in enumerate(cases):
            arms = (5, 10) if (index + repeat) % 2 else (10, 5)
            runs.extend({"case": case, "top_k": k, "repeat": repeat} for k in arms)
    return runs


def configure(*, b2_account: bool = False) -> None:
    from common import KNOWLEDGE_B2_KEYS, LIBRARY_PORT, ensure_tunnel, ssh, worker_env
    from dotenv import dotenv_values
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    if not os.environ.get("LIBRARY_DATABASE_URL"):
        ensure_tunnel((LIBRARY_PORT,))
        worker = worker_env()
        for key in ("DEEPINFRA_API_KEY", *KNOWLEDGE_B2_KEYS):
            if worker.get(key):
                os.environ[key] = worker[key]
        env = dotenv_values(stream=io.StringIO(ssh("cat /opt/capy-library-db/.env")))
        password = env.get("LIBRARY_DB_READER_PASSWORD")
        if not password:
            raise RuntimeError("Library reader credential is unavailable")
        os.environ["LIBRARY_DATABASE_URL"] = make_conninfo(
            host="127.0.0.1",
            port=LIBRARY_PORT,
            dbname="library",
            user="capy_library_reader",
            password=password,
        )
    dsn = os.environ["LIBRARY_DATABASE_URL"]
    if conninfo_to_dict(dsn).get("user") != "capy_library_reader":
        raise RuntimeError("This benchmark requires the library reader role")
    if not os.environ.get("DEEPINFRA_API_KEY"):
        raise RuntimeError("DeepInfra query-embedding credential is unavailable")
    if b2_account:
        account = json.loads(
            subprocess.run(
                ["b2", "account", "get"], check=True, capture_output=True, text=True
            ).stdout
        )
        bucket = "capy-notebook-knowledge-base"
        allowed = account["allowed"]
        if bucket not in {b["name"] for b in allowed.get("buckets", [])}:
            raise RuntimeError(
                "The B2 CLI account is not scoped to the knowledge bucket"
            )
        if "readFiles" not in allowed.get("capabilities", []):
            raise RuntimeError("The B2 CLI account cannot read source PDFs")
        endpoint = account["s3endpoint"]
        region = re.fullmatch(
            r"s3\.([a-z0-9-]+)\.backblazeb2\.com", urlsplit(endpoint).hostname or ""
        )
        if not region or urlsplit(endpoint).scheme != "https":
            raise RuntimeError("Unexpected B2 S3 endpoint")
        os.environ.update(
            KNOWLEDGE_BASE_B2_ENDPOINT=endpoint,
            KNOWLEDGE_BASE_B2_REGION=region.group(1),
            KNOWLEDGE_BASE_B2_BUCKET=bucket,
            KNOWLEDGE_BASE_B2_KEY_ID=account["applicationKeyId"],
            KNOWLEDGE_BASE_B2_APP_KEY=account["applicationKey"],
        )
    if not all(os.environ.get(key) for key in KNOWLEDGE_B2_KEYS):
        raise RuntimeError(
            "Source PDF credentials are required; use the authorized --b2-account when appropriate"
        )
    os.environ.update(
        DATABASE_URL=dsn,
        GATEWAY_URL="http://127.0.0.1:1",
        PIPELINE_SECRET="local-benchmark-only",
        OLLAMA_BENCH_KEY="ollama",
        SENTRY_DSN="",
        CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S="180",
    )


async def snapshot(db) -> dict:
    async with db.connection() as conn:
        identity = await conn.execute(
            "SELECT current_user AS role, current_setting('transaction_read_only') AS read_only"
        )
        identity = dict(await identity.fetchone())
        if identity != {"role": "capy_library_reader", "read_only": "on"}:
            raise RuntimeError("Expected a read-only library reader session")
        books = await conn.execute(
            "SELECT id,title,version,content_id FROM library_books ORDER BY id"
        )
        books = [dict(row) for row in await books.fetchall()]
        metadata = await conn.execute(
            "SELECT e.book_id, count(*) AS excerpts, "
            "count(*) FILTER (WHERE e.retrieval IS NOT NULL) AS reviewed, "
            "md5(string_agg(md5(e::text), '' ORDER BY e.id)) AS metadata_hash "
            "FROM library_excerpts e JOIN rag_file_contents fc ON fc.content_id=e.content_id "
            "WHERE fc.workspace_id='library' GROUP BY e.book_id ORDER BY e.book_id"
        )
        metadata = [dict(row) for row in await metadata.fetchall()]
    return {**identity, "books": books, "metadata": metadata}


async def run_case(args) -> None:
    import knowledge_scope_agent_eval as existing
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    from pipeline.config import cfg
    from pipeline.retrieval import library, store

    db = AsyncConnectionPool(
        cfg.library_dsn,
        min_size=1,
        max_size=4,
        open=False,
        timeout=10,
        kwargs={
            "row_factory": dict_row,
            "connect_timeout": 5,
            "options": "-c default_transaction_read_only=on -c statement_timeout=30000",
        },
    )
    await db.open()
    library._pool = db
    folder = args.output / f"k{args.top_k}" / f"repeat-{args.repeat}"
    record = folder / args.case / "baseline"
    if (record / "run.json").exists():
        raise RuntimeError("Refusing to overwrite a completed run")
    before = {"inputs": hashes(), "library": await snapshot(db)}
    save(record / "freeze-before.json", before)
    original_search = store.hybrid_search
    candidates = []

    async def tracked_candidates(**kwargs):
        rows = await original_search(**kwargs)
        candidates.append({"candidate_budget": kwargs["candidates"], "rows": rows})
        save(record / "candidates.json", candidates)
        return rows

    store.hybrid_search = tracked_candidates
    cfg.search_candidates = 40
    existing.PAGE_SIZE = args.top_k
    fixture = json.loads(existing.CASES.read_text())
    case = next(case for case in fixture["cases"] if case["id"] == args.case)
    # Both arms use production search rendering, reads, and tool limits. Only k changes.
    await existing.experiment(case, "baseline", folder, "low")
    # The reused runner closes its pool. Open this same read-only pool for the final receipt.
    db = AsyncConnectionPool(
        cfg.library_dsn,
        min_size=1,
        max_size=1,
        open=False,
        kwargs={
            "row_factory": dict_row,
            "connect_timeout": 5,
            "options": "-c default_transaction_read_only=on -c statement_timeout=30000",
        },
    )
    async with db:
        after = {"inputs": hashes(), "library": await snapshot(db)}
    save(record / "freeze-after.json", after)
    save(
        record / "comparison.json",
        {"top_k": args.top_k, "repeat": args.repeat, "stable_inputs": before == after},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--case", choices=CASES)
    parser.add_argument("--top-k", type=int, choices=(5, 10))
    parser.add_argument("--repeat", type=int, choices=(1, 2), default=1)
    parser.add_argument("--suite", action="store_true")
    parser.add_argument(
        "--b2-account",
        action="store_true",
        help="Use the locally authorized B2 CLI account for read-only source PDFs",
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        runs = schedule()
        assert len(runs) == 16
        assert len({tuple(run.values()) for run in runs}) == len(runs)
        assert all(sum(r["top_k"] == k for r in runs) == 8 for k in (5, 10))
        print("Schedule: six paired cases plus two paired repeats, balanced arm order.")
        return
    if not args.suite and (not args.case or not args.top_k):
        parser.error("Use --suite or both --case and --top-k")
    configure(b2_account=args.b2_account)
    if not args.suite:
        asyncio.run(run_case(args))
        return
    protocol = {
        "model": "glm-5.3-flash:cloud",
        "thinking": "low",
        "candidate_budget": 40,
        "tool_token_limit": 8192,
        "capture_knowledge_page_offered": True,
        "runs": schedule(),
        "inputs": hashes(),
        "primary": "Supported completed note, requested method/scope and example diversity",
        "secondary": "Compensating searches/reads, tokens, latency, truncation, failures",
        "limits": "Diagnostic sample, no reranker or global dedup; locally saved materials",
    }
    protocol_path = args.output / "protocol.json"
    if protocol_path.exists():
        raise RuntimeError("Use a new output directory for a new suite")
    save(protocol_path, protocol)
    for run in schedule():
        command = [
            sys.executable,
            __file__,
            "--case",
            run["case"],
            "--top-k",
            str(run["top_k"]),
            "--repeat",
            str(run["repeat"]),
            "--output",
            str(args.output),
        ]
        print(json.dumps({"starting": run}), flush=True)
        result = subprocess.run(command, check=False)
        if result.returncode:
            raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
