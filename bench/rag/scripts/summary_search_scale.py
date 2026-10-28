"""Account chat's summary search at scale (bench/rag/reports/2026-10-28-summary-search-scale.md).

Four ways to match a query against the names and ~50-word summaries of the
items one user reaches, over a database holding many users' items:
A builds a text vector for every item in reach on each call (the first
version of search_files_summary, in SQL), B narrows to the items in reach and
matches a stored column on each shared summary (built), C uses one GIN index
over every summary, D copies name and summary onto each item under a
(workspace_id, tsv) GIN index.

Synthetic: N_WS workspaces of 100 items plus N_LOOSE items with no workspace,
each summary 50 words drawn Zipf-like from 20,000; one user reaches 50 full
workspaces and 2,000 of their own (the account chat scope at the workspace
cap). Timings are server-side (EXPLAIN ANALYZE), warm, median of 5.

Run against an empty, throwaway pgvector/pgvector:pg16 (it drops and creates
the tables items and summaries); give the container --shm-size=1g:
    uv run python -I bench/rag/scripts/summary_search_scale.py postgresql://...
"""
import os, statistics, sys, time
import psycopg

DSN = sys.argv[1]
N_WS = int(os.environ.get("N_WS", "10000"))      # 100 items each
N_LOOSE = int(os.environ.get("N_LOOSE", "200000"))  # standalone items, many users
SCOPE_WS = 50
SCOPE_LOOSE = 2000

def run(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        try:
            return cur.fetchall()
        except psycopg.ProgrammingError:
            return None

def timed(conn, sql, params):
    times = []
    for _ in range(5):
        rows = run(conn, "EXPLAIN (ANALYZE, FORMAT JSON) " + sql, params)
        times.append(rows[0][0][0]["Execution Time"])
    return statistics.median(times)

with psycopg.connect(DSN, autocommit=True) as conn:
    t0 = time.time()
    run(conn, "CREATE EXTENSION IF NOT EXISTS btree_gin")
    run(conn, """
    DROP TABLE IF EXISTS items, summaries;
    CREATE TABLE summaries (content_id text PRIMARY KEY, descriptor text NOT NULL, tsv tsvector);
    CREATE TABLE items (id text PRIMARY KEY, workspace_id text, owner text NOT NULL,
        name text NOT NULL, content_id text, tsv tsvector);
    """)
    # A vocabulary with Zipf-like use: word k is picked with weight ~1/k.
    run(conn, """
    CREATE TEMP TABLE vocab AS SELECT k, 'w' || k AS w FROM generate_series(1, 20000) k;
    """)
    total = N_WS * 100 + N_LOOSE
    run(conn, f"""
    INSERT INTO summaries (content_id, descriptor)
    SELECT 'c' || i, (SELECT string_agg('w' || (floor(exp(random() * ln(20000))))::int, ' ')
                      FROM generate_series(1, 50) g WHERE g > 0 * i)
    FROM generate_series(1, {total}) i
    """)
    run(conn, f"""
    INSERT INTO items (id, workspace_id, owner, name, content_id)
    SELECT 'f' || i,
           CASE WHEN i <= {N_WS * 100} THEN 'ws' || ((i - 1) / 100) END,
           CASE WHEN i <= {N_WS * 100} THEN 'u' || ((i - 1) / 1000) ELSE 'u' || (i % 50000) END,
           'Lecture ' || i || ' w' || (floor(exp(random() * ln(20000))))::int || '.pdf',
           'c' || i
    FROM generate_series(1, {total}) i
    """)
    # Our user: owner of SCOPE_LOOSE standalone items.
    run(conn, f"UPDATE items SET owner = 'me' WHERE workspace_id IS NULL AND id IN (SELECT id FROM items WHERE workspace_id IS NULL LIMIT {SCOPE_LOOSE})")
    print(f"generated {total} items in {time.time() - t0:.0f}s", flush=True)

    t0 = time.time()
    run(conn, "UPDATE summaries SET tsv = to_tsvector('simple', descriptor)")
    t_tsv = time.time() - t0
    run(conn, "CREATE INDEX ON items (workspace_id)")
    run(conn, "CREATE INDEX ON items (owner) WHERE workspace_id IS NULL")
    t0 = time.time()
    run(conn, "CREATE INDEX summaries_tsv_gin ON summaries USING gin (tsv)")
    t_gin = time.time() - t0
    # Per-item copy for a workspace-keyed index (summaries carry no workspace).
    t0 = time.time()
    run(conn, "UPDATE items i SET tsv = to_tsvector('simple', i.name) || s.tsv FROM summaries s WHERE s.content_id = i.content_id")
    run(conn, "CREATE INDEX items_ws_tsv ON items USING gin (workspace_id, tsv)")
    t_ws = time.time() - t0
    run(conn, "VACUUM ANALYZE")
    size = run(conn, """SELECT pg_size_pretty(pg_relation_size('summaries_tsv_gin')),
        pg_size_pretty(pg_relation_size('items_ws_tsv')),
        pg_size_pretty(pg_total_relation_size('summaries'))""")[0]
    print(f"tsv column {t_tsv:.0f}s, global GIN {t_gin:.0f}s ({size[0]}), "
          f"per-item ws GIN {t_ws:.0f}s ({size[1]}); summaries table {size[2]}", flush=True)

    ws = [f"ws{i}" for i in range(SCOPE_WS)]
    # The scope's items through their two indexes: the workspaces', then the
    # user's own with no workspace.
    scoped = """(SELECT * FROM items WHERE workspace_id = ANY(%(ws)s)
                 UNION ALL SELECT * FROM items WHERE workspace_id IS NULL AND owner = 'me') i"""
    queries = {
        "rare word (w15000)": "w15000",
        "common word (w2)": "w2",
        "two words (w40 | w900)": "w40 | w900",
    }
    print("\nms per call (median of 5), scope = 50 workspaces x 100 + 2,000 own items", flush=True)
    for label, q in queries.items():
        p = {"ws": ws, "q": q}
        # A: today: a text vector built for every name and summary in reach, every call.
        a = timed(conn, f"""
            SELECT i.id FROM {scoped} LEFT JOIN summaries s ON s.content_id = i.content_id
            WHERE to_tsvector('simple', i.name || ' ' || coalesce(s.descriptor, '')) @@ to_tsquery('simple', %(q)s)
            ORDER BY ts_rank(to_tsvector('simple', i.name || ' ' || coalesce(s.descriptor, '')), to_tsquery('simple', %(q)s)) DESC LIMIT 10""", p)
        # B: the scope first, then the stored column on each shared summary row.
        b = timed(conn, f"""
            SELECT i.id FROM {scoped} JOIN summaries s ON s.content_id = i.content_id
            WHERE s.tsv @@ to_tsquery('simple', %(q)s)
            ORDER BY ts_rank(s.tsv, to_tsquery('simple', %(q)s)) DESC LIMIT 10""", p)
        # C: the global GIN index on summaries first, then the scope.
        c = timed(conn, f"""
            SELECT i.id FROM summaries s JOIN {scoped} ON i.content_id = s.content_id
            WHERE s.tsv @@ to_tsquery('simple', %(q)s)
            ORDER BY ts_rank(s.tsv, to_tsquery('simple', %(q)s)) DESC LIMIT 10""", p)
        # D: a per-item copy (name + summary) indexed by (workspace_id, tsv).
        d = timed(conn, f"""
            SELECT i.id FROM {scoped}
            WHERE i.tsv @@ to_tsquery('simple', %(q)s)
            ORDER BY ts_rank(i.tsv, to_tsquery('simple', %(q)s)) DESC LIMIT 10""", p)
        hits = run(conn, "SELECT count(*) FROM summaries s WHERE s.tsv @@ to_tsquery('simple', %(q)s)", p)[0][0]
        print(f"{label:24} A today {a:7.1f}  B scope+column {b:6.1f}  C global GIN {c:7.1f}  D ws GIN {d:6.1f}   (global matches {hits:,})", flush=True)
