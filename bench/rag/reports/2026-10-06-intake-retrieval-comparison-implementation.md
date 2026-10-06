# Intake and retrieval comparison: implementation brief

Date: 2026-10-06. Hands the code work of the approved plan
(`2026-10-06-intake-retrieval-comparison-plan.md`, Parts 1, 2 and 5) to an
implementer. The developer's decisions are recorded in
`human/agentic-retrieval.md` (entries dated 2026-10-06); nothing here may
contradict them, and an implementation issue that needs a decision is
reported, not fixed on the implementer's own authority. Read
`openwiki/agentic-retrieval.md` (sections "Knowledge library", "Chat agent
workflow", "Tools") first. Keep to the `ponytail` style: the smallest change
that works, no new machinery. Line references are as of commit c51c3994 and
may have moved after the 2026-10-06 pull to c06677e9.

Files: `pipeline/pipeline/retrieval/library.py` (lib), `tools.py` (tools),
`chunking.py`, `config.py`, `limits.py`, `prompts/chat.py`,
`server/internal/agenttools/agenttools.go` (go, tool schemas and contract
version), `pipeline/pipeline/retrieval/contract.py`, `lab/playground/`.

## A. Six fixes to the current library tools (production)

1. `search_knowledge` gets optional `book` (book id) and `section` (section
   path prefix) arguments. `library.search` passes `file_ids=None` (lib:454);
   books are `files` rows and `store.hybrid_search` already filters by file
   ids, so `book` is a pass-through. `section` is one more `chunk_filter`
   predicate on `c.section_path` (equal, or `LIKE prefix || ' › %'` with `%`
   and `_` escaped). Both appear in the schema (go:526-546) with one-line
   descriptions; the result header already shows the book title and path.
2. `read_knowledge` continuation. At the end of an excerpt (tools:948-952)
   print the previous and next excerpt of the same book by chunk order, as
   id, section path and pages, instead of only "(end of excerpt)". Add
   `count` (1 to 12, default 12) like `read_document` (go:494-500).
3. `next_start` after the clip. It is computed (lib:596-602) before the
   8,192-token clip (tools:2250-2259); compute it from the chunks the clipped
   output actually shows, and say when the page was cut.
4. One hit per section. Extend the collapse (lib:479-493) so hits of the same
   book and `section_path` fold into one, keeping the highest-ranked chunk.
   Fold after reranking, before the top_k cut, so the five slots hold five
   sections.
5. Context links with names. Show each `context_excerpt_ids` entry
   (tools:795-798) as id, section path and pages, one line each, fetched in
   one query.
6. Repeated paragraphs. Packing carries 50 to 200 trailing tokens into the
   next chunk (chunking:371-383). At read time, when consecutive chunks are
   shown together, drop a chunk's leading text that equals the previous
   chunk's trailing text (longest common suffix/prefix on whitespace-normalised
   text, at least 40 characters). Stored text is unchanged.

Tests: one focused test per fix (filter predicate SQL and schema, the
continuation lines, next_start after a forced clip, the section fold, link
lines, the overlap trim). No smoke tests.

## B. Section reading (experiment arms B and C)

Behind one process flag, `CAPY_LIBRARY_SECTION_TOOLS` (default off). When off,
schemas and prompts are exactly as in A, so arm A is unaffected.

1. `browse_knowledge(book=<id>)`: the book's outline. From `library_chunks`
   of the current version: distinct `section_path` with min and max
   `chunk_idx`, first and last page, chunk count, ordered by min chunk_idx.
   Print up to two heading levels (split on " › "), deeper paths folded into
   their parent's counts, so a 500-page book stays under about 3k tokens.
   Header: book id, title, version, pages. Each line: the exact path string
   the read tool accepts, pages, chunk count.
2. `read_knowledge(book=<id>, section=<path>, start=<chunk_idx>, count=<n>)`:
   ordered chunks of a section. Range: from the first chunk whose path equals
   the section or starts with `section + " › "` to the last such chunk,
   inclusive, so a captioned table whose path is its caption
   (packing.py:246-248) stays inside its section. Default `count` 24, max 24;
   page from `start` (default the range's first chunk); `next_start` as in A3
   after the clip. Output is continuous text: one header (book, section,
   pages, chunk range), a `[p. N]` marker where the page changes, no per-chunk
   header; then the figures on those pages (same query as the excerpt read),
   then one footer line listing the excerpt ids covered. Record a read for
   every excerpt covered exactly as `read_knowledge` does today (tools:209-210
   write guard, `library_evidence.py:109`), so `create_material`'s
   `excerpt_ids` rule and provenance footers keep working. Apply fix A6 across
   the page.
3. Tag-free search: `CAPY_LIBRARY_REQUIRE_TAGS` (default on). Off removes the
   verified-tag predicate from eligibility (lib:139-157) and lets untagged
   excerpts (tag_status failed) be searched and read. `non_teaching` exclusion
   stays. Needed for arm B, whose excerpts are untagged.
4. Library rules variant for the playground: a second rules text next to
   `LIBRARY_RULES` in `prompts/chat.py` (or a playground `library_rules`
   override file under `lab/playground/configs/`): search or browse to locate,
   read the section in order before writing, take worked examples and
   practice from the same section or chapter, keep one book's notation, cite
   book and pages. The building skill text is unchanged.

Tests: the range query against a small fixture with a captioned table in the
middle; the outline fold; the page-marker rendering; the read guard covering
several excerpts; the eligibility SQL with the flag off.

## C. Run driver (experiment)

`bench/rag/intake/scripts/run_requests.py`: reads
`bench/rag/intake/fixtures/requests.json`, posts each request to a running
playground (`POST /api/turn`, SSE; one turn at a time per process) with a
named config, and for a two-turn request sends the second turn with the
first turn's history, checkpoint and ledger as the playground's API expects.
Writes `bench/rag/reports/local/2026-10-intake-eval/<arm>/<request-id>[-r2].json`
with the run id, the answer, materials, validator results and the counters
listed in `bench/rag/intake/fixtures/protocol.json` (tool calls, input and
cached tokens, wall time, captures, sections or excerpts read, distinct books
and sections cited, bank copies versus written questions). Resumable: skips a
request whose output file exists. Three playground configs,
`lab/playground/configs/intake-a.json`, `intake-b.json`, `intake-c.json`,
differing only in library rules and the two flags (set per process through
the environment, documented in the README).

## Constraints

- Contract: new tool arguments bump the contract version as previous changes
  did; keep tool descriptions to one or two lines (contract v12 rule).
- Docs: update the tool table and the library section in
  `openwiki/agentic-retrieval.md`, the playground README for the configs and
  flags, and `openwiki/test-catalog.md` for new tests.
- Formatting: `pnpm run fmt:py` for pipeline, `pnpm run fmt:go` for Go.
- Do not commit. When done, write a short summary of what changed, what was
  tested and anything that needs a decision to
  `bench/rag/reports/local/2026-10-intake-eval/implementation-summary.md`
  (the directory is ignored) and stop.
