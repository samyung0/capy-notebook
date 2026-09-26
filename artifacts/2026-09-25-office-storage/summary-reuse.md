# Delta file summaries and the two summary tiers

2026-09-25. Code traced at HEAD `3758a0e2` plus the working tree. No production code, container or database was changed. Paid calls went through DeepInfra with the `DEEPINFRA_API_KEY` in `.env.local`. They cost $0.5437 of the $2.00 cap, over 187 calls (details under "Spend"). Scratch files are in `scratchpad\delta\`. The scratch parser container `delta-summary-parser` was started from the existing `capy-kb-parser:pilot-v11` image and then removed.

## Short answers

| Question | Answer |
| --- | --- |
| Can the summary be updated from the previous summary plus the changes? | Yes for insertions, no in general. With the chunk lists `index_file` has, the input is dominated by reflow: removed plus added chunk text came to 36-102% of the document on every chapter edit, and 142% on the book's first refresh after upload, which changed no text. A text diff cuts that to 0.01-15%. Every delta prompt I tried still mishandled deletions: it kept deleted topics, re-described deleted text, or dropped topics that were still there. On the book's chapter removal one prompt produced a runaway 4,000-token reply. An insert-only prompt gave valid, proportionate updates in all seven trials. |
| Does search depend on summaries? | No. The hybrid search SQL reads only chunks, their `tsvector` and the pin's vector table (`store.py:979-1053`). Only the query text is embedded (`search.py:156`). Chunk `indexed_text` is section path plus body (`chunking.py:149-152`). Summary drift cannot change which passages search returns, their order, citations, generate context, curate reads or the UI. I skipped end-to-end chat evaluation for that reason. |
| What can summary drift affect? | Two things. The 50-word descriptor printed per file by `list_sources`, which the agent used in 61 of 191 lab turns (32%). The detailed summary returned by `describe_documents`, which it used in 1 of 191 turns, plus 0 of 20 in a later experiment. |
| Does Capy need both tiers? | No. The descriptor covers every observed use. The detailed tier costs little money, because the whole-document input dominates, but it is the most drift-prone text and backs one tool the agent almost never calls. |
| Cost today vs a gate | A 442-page book summary is 336k provider input tokens, $0.051 off-peak and $0.101 peak at DeepSeek list prices, about 84 credits. A reuse gate at 2% cumulative text change cut summary spend over six edit rounds of the book from $0.293 to $0.093 (-68%), and over five rounds of the 40-page chapter from $0.021 to $0.013 (-39%), missing one 1.9% addition. At 5% the book cost $0.044 (-85%) with no quality difference I could measure, but the chapter served stale text on four of five refreshes. |

## Recommendation

1. **Don't build an LLM delta update.** Replace the refresh summary step with a reuse gate:
   - Keep the stored descriptor and summary while the net text change since the last full regeneration stays under a share of the document. I suggest 2%. 5% saves more on large files, but it let a 40-page chapter keep a deleted topic for three refreshes. The threshold needs your sign-off.
   - Store the running total next to the summary. At or above the threshold, or when `summary_version` differs from `SUMMARY_VERSION`, regenerate from the complete file exactly as today.
   - The gate needs a net-change number that ignores reflow. Measure it in the pipeline with the text diff tested here: about 70 lines, at most 0.4 s on the book. Collaboration's `net_tokens` is simpler but counts whole paragraphs. It reported 3,710 tokens for 20 one-word fixes that change 40 tokens of text, so a 40-page document would regenerate for typo fixes.
   - This changes the recorded decision at `human/agentic-retrieval.md:34`.
2. With the gate, a forced publication whose text did not change costs no summary call at all. That includes BetterOffice's page-break loss, which moved 69% of the book's chunks but only 0.2% of its text. The platform then pays only for embeddings of changed chunks: at most $0.0045 for the 442-page book in the worst measured case. Text sources benefit most, because they refresh every 15 s while edited and today every refresh re-summarizes the whole file (`collaboration/src/sourceDocuments.ts:858`).
3. **Drop the detailed tier.** Either remove `describe_documents`, or have it return the descriptor plus the file's heading outline, as notes already get (`tools.py:674-698`). This is a tool-contract change, so it needs your decision (Go contract, Python handler, prompt line at `prompts/chat.py:46-48`).
4. If you still want deltas, use only the insert-only prompt, and only for insertion-led changes. Send any deletion over 0.5% of the document, any change over 10%, five deltas in a row, and any invalid reply to full regeneration. On the chapter this served accurate summaries for $0.009 against $0.021. On the book it cost more than the plain gate, because 2,000-word deletions forced full runs that changed nothing visible.
5. Side fix, independent of the above. The 50-word hard cap cut 7 of 19 fresh descriptors mid-phrase, for example "...a malaria vaccine case study using simulation to assess". Ask for 45 words or cut at a clause.

## What reads the summaries

| Reader | Reads | Evidence |
| --- | --- | --- |
| `list_sources` (chat and curate) | descriptor, one per file | `tools.py:583-596` calls `store.workspace_outline` (`store.py:1191-1242`, columns at 1209-1210); `_file_line` prints it (`tools.py:712-721`). Contract text: "Source files include passage counts and short descriptors" (`agenttools.go:396-404`). |
| `describe_documents` (chat and curate) | summary, falling back to descriptor | `tools.py:638-668`, fallback at 662; `store.file_summaries` (`store.py:1261-1281`). Contract: "Call after list_sources when the short descriptors are not enough" (`agenttools.go:405-417`). |
| Chat system prompt | names both tools | "Prefer listing sources, then describing or searching the few documents that matter" (`prompts/chat.py:46-48`). The curate prompt names neither (`prompts/curate.py`), but both tools are offered in curate mode (`tools.py:1912-1938`, decision `human/agentic-retrieval.md:120`). |
| Empty search result | points at the descriptor | "No passages matched. Try different wording, or list_sources first." (`tools.py:527-529`) |
| Pending-change message | mentions them | "Apply replacements and removals when using indexed passages, descriptions or summaries" (`pending.py:57-59`). |
| Conversation history | keeps both results in full | Listing and description results have full retention (`human/agentic-retrieval.md:79`), so a stale descriptor can stay in a conversation after a refresh. |
| Copies | not readers | Donor copy (`store.py:722-739`) and workspace clone (`share.go:1230-1236`) copy the row. |

Things that never read them:
- Hybrid search, lexical or vector (`store.py:979-1129`, `search.py:135-180`).
- `read_document` and `capture_page`.
- The generate workflow. `gather_context` uses the outline only for file ids and chunk counts (`workflows.py:109-118`).
- Knowledge-library tools, quiz grading and Plate AI.
- The frontend. `src/` has no reference.
- The public workspace summary endpoint, which returns no file-content summaries (`openwiki/agentic-retrieval.md:39-45`).
- Operators. Both columns are on the ops roles' forbidden list (`server/internal/ops/privileges.go:437-438`, checked at 513 and 528).

The library's own `descriptor` and `summary` are separate, not model-written, and out of scope.

## How often the agent reads them

| Source | Turns | `list_sources` | `describe_documents` |
| --- | --- | --- | --- |
| 2026-09-09 ODL agentic evaluation, all 29 answer snapshots (`bench/rag/reports/local/2026-09-09-odl-agentic/snapshots/*/answers.jsonl`, Qwen3.8 Flash) | 191 | 61 turns | 1 turn |
| 2026-09-21 workspace opening (`bench/rag/reports/2026-09-21-workspace-opening-agentic.md:102,106`) | 20 | 2 calls | 0, "No turn used describe_documents" |
| 2026-09-21 workspace agentic retrieval (`...workspace-agentic-retrieval.md:86`) | 30 | 4-5 per arm | not reported |
| Playground curate config (`lab/playground/configs/curate.json`) | n/a | not offered | not offered |

The single `describe_documents` call came in the harbour-vote question (`odl-agentic-006`, heldout part 007). The agent had already read all six chunks of `newspaper_scan.pdf` when it asked for the description, so the description added nothing. Search ran in 189 of the 191 turns.

## Why a delta update is hard

1. **`index_file` does not know what changed in the text.**
   - It knows which new chunks lack a vector (`missing`, `indexing.py:125`). It does not know the removed chunks, because `existing_file_vectors` filters to matching texts (`store.py:135`).
   - Worse, the chunk difference is mostly reflow. ODL splits paragraphs at page boundaries, packing carries 50-token overlap blocks, heading retention repeats headings depending on where a chunk starts, and the parser re-spaces figure labels and ligatures when layout moves.
   - The first refresh after upload changed 69% of the book's chunks and 0.2% of its text (parser noise only). Inserting one 500-word subsection into the chapter changed chunks worth 102% of the chapter.
2. **The model cannot tell whether a deleted topic survives elsewhere.** It sees only the deleted text. Signals that might help are lossy. The chunk-path outline missed "2.1.1 Scatterplots", which the parser did not return as a heading, so the v2 prompt dropped scatterplots. Section-path sets change with packing: after one insertion, "2.2.6 Comparing numerical data" looked gone.
3. **Deleted text leaks back in.** With the text in front of it, the model summarized the deleted mosaic-plot subsection as current content in v1 and again in v2, despite "Never take content from deleted text".
4. **Deltas accumulate.** v1 grew to the 500-word cap by round 3. `_truncate_words` then cut the end, which removed the closing case study from the summary.
5. **Big deletions blow up.** Removing the book's chapter 3 made v3 write 4,000 tokens of reasoning inside its "dropped" list, and the JSON came back truncated. The same reasoning also wanted to drop the normal, binomial and Poisson distributions, which chapter 4 still covers. With thinking on (`reasoning_effort: low`), a 1,262-token book delta spent 8,000 reasoning tokens counting words and returned nothing after 121 s, past the pipeline's 120 s call timeout.
6. **At book scale there is little to update.** A 500-word summary of 177k words never mentioned the added 300-400-word sections, even when regenerated in full. Two full runs on identical input differ almost as much as a stale summary differs from a fresh one (cosine 0.75-0.92 against 0.63-0.87).

## Delta update design

### Inputs

| Refresh | Full summary input, estimated tokens | Chunk delta (removed + added chunk text) | Text diff (net change) |
| --- | --- | --- | --- |
| Chapter c1: insert 2.1.9 KDE and violin plots | 28,989 | 29,705 (102%) | 721 (2.5%) |
| Chapter c2: replace the malaria case study | 25,299 | 11,109 (44%) | 3,672 (14.5%) |
| Chapter c3: delete 2.2.4 mosaic plots and 2.2.5 pie charts | 24,624 | 12,311 (50%) | 776 (3.2%) |
| Chapter c4: 20 one-word fixes | 24,699 | 21,162 (86%) | 41 (0.17%) |
| Chapter c5: insert 2.2.7 Cramer's V | 25,067 | 9,001 (36%) | 433 (1.7%) |
| Book b1: insert 5.4 bootstrap | 325,512 | 5,434 (1.7%) | 604 (0.19%) |
| Book b2: replace 9.4 Mario Kart with home prices | 321,401 | 87,885 (27%) | 3,544 (1.1%) |
| Book b3: delete 4.4 negative binomial | 317,990 | 12,898 (4.1%) | 2,757 (0.87%) |
| Book b4: 20 one-word fixes | 317,923 | 22,369 (7.0%) | 40 (0.01%) |
| Book b5: insert 8.5 transformations | 318,429 | 506 (0.2%) | 433 (0.14%) |
| Book b6: delete chapter 3 | 280,503 | 59,492 (21%) | 30,024 (10.7%) |
| Probe: book upload to first export, no edit | 321,923 | 456,631 (142%) | 630 (0.2%, parser noise) |
| Probe: book one sentence / 12 paragraphs / 20 fixes | ~322k-327k | 3.5% / 16.7% / 8.5% | 23 / 3,447 / 40 tokens |
| Probe: chapter one sentence / 12 paragraphs / 20 fixes | ~29k-33k | 5.6% / 110% / 63% | 19 / 3,441 / 40 tokens |

The text diff is `delta.text_changes`, about 70 lines. It works in four steps:
1. It splits chunk text into lines and drops the overlap blocks a chunk repeats from the previous chunk.
2. It drops lines that repeat a heading from the section paths.
3. It aligns the two line sequences on NFKC-folded, whitespace-free keys.
4. It word-diffs inside each changed range and discards spans that differ only in spacing or glyph form.

Worst case 0.4 s on the book.

### Prompts tested (all in `delta.py`)

| Version | Input | Result |
| --- | --- | --- |
| v1 chunk / v1 diff | previous descriptor and summary, removed and added chunks or diff spans, document size and changed share | Grew to the cap, over-weighted insertions, kept or re-described deleted text |
| v2 chunk / v2 diff | v1 plus the current outline from chunk paths, explicit "deleted, no longer in the document", length and proportion rules | Length fixed. Stale deletions stayed, and the lossy outline caused false drops |
| v3 diff, thinking off and on | v2 without the outline, plus sections gone and new, plus a `dropped` list before the rewrite | Deletions handled on the chapter. False drops, runaway output on the chapter removal, thinking unusable |
| v4 insert-only | previous text plus inserted spans only, "do not remove or rewrite anything else" | Seven of seven valid (four edit rounds, three probe variants). Additions mentioned proportionately on the book, a little heavily on the chapter; trivial edits left the text alone |

### Fallback rules, if a delta is built anyway

- Reuse under 0.5% cumulative change.
- Insert-only delta when deleted text is under 0.5% of the document and the total change is under 10%.
- Full regeneration otherwise, and also when:
  - five deltas have run since the last full regeneration
  - `summary_version != SUMMARY_VERSION`
  - no published summary exists (first ingest, binary replacement, donor copy)
- Validate the reply: JSON with both fields, `finish_reason == "stop"`, descriptor at most about 80 words, summary at most 1.2 times the target. Cap `max_tokens` near 1,500 with thinking off. On any failure, regenerate fully in the same attempt instead of storing a blank or retrying the delta.
- The word-target tier needs no rule. Reuse and deltas keep the stored length.

### Failure handling for the recommended gate

The gate makes no provider call on the reuse path. If the published summary or chunks cannot be read, the step regenerates fully, which is today's behaviour. That fallback still needs your sign-off per `AGENTS.md`. Full regeneration keeps its current rules: raise on failure, never store a blank (`indexing.py:476-482`).

## Quality test

**Materials.**
- The chapter is OpenIntro Statistics chapter 2, "Summarizing data": 15k words, 41 pages, 87 chunks.
- The book is the reparse probe's 442-page, 177k-word DOCX: 1,008 chunks, 336k provider tokens.
- `make_rounds.py` applied cumulative HTML edits, and LibreOffice in the parser image converted each round to DOCX. Parser v11 parsed every round, and the worker's Office path chunked it (`chunks.py`).
- The rounds are listed in the input table above. `rounds.json` holds the ground truth given to the judge.

**Settings.**
- Summaries used the production prompt and code: `summary_messages`, `_parse_summary_payload`, `_truncate_words`, temperature 0.3, thinking off.
- The model was `deepseek-ai/DeepSeek-V4.1-Flash` on DeepInfra, the model behind the `deepseek-flash` pin. `.env.local` has no DeepSeek key, `deploy/.env` has an empty one, and I did not pull the UAT worker's key.
- The chapter crosses the 100k-character word-target boundary between rounds, 500 to 300 to 500 words. Every arm used 500 words so they stay comparable.
- `max_tokens` was 4,000, or 8,000 for the thinking arm, as a spend guard. Production sends none.

**Comparison method.** Three independent checks per summary, each scored against the same round's full regeneration:
- Term checks (`terms.py`) test whether added topics are named and removed ones are gone.
- Cosine similarity with Qwen3-Embedding-4B, the production embedding model, against the full regeneration of the same round. The noise floor is two or three full runs on identical input.
- A judge, DeepSeek V4 Pro 0813 at temperature 0. It saw the round's true heading outline with word counts, the edit history and one summary with the arm hidden. It returned stale claims, missing parts and 1-5 scores.

The judge has three caveats:
- It is unreliable at book scale. It flagged the resume study as stale, though 9.5 still contains it.
- The edit history biases it toward summaries that mention edits.
- It marks unmentioned exercise sections as missing coverage.

For the book, only the chapter-3 term check is clean. The book still mentions the negative binomial in its chapter 4 overview and answer key, and Mario Kart in 8.2.7.

### Chapter, five sequential rounds (c1-c5)

| Arm | Judge accuracy / usefulness, mean | Stale claims | Term-check failures | Summary words | Cosine to full at c5 |
| --- | --- | --- | --- | --- | --- |
| Full regeneration | 5.0 / 5.0 | 0 | 0 | 213-381 | (reference) |
| Reuse round-0 summary | 2.6 / 2.4 | 12 | 17 | 294 | 0.77 |
| v1 diff | 3.8 / 3.6 | 6 | 3 | 426-500, case study truncated at c5 | 0.66 |
| v1 chunk | 3.8 / 3.8 | 6 | 3 | 379-454 | 0.85 |
| v2 diff | 4.2 / 4.0 | 5 | 3 | 327-353 | 0.83 |
| v2 chunk | 3.8 / 3.8 | 7 | 3 | 323-389 | 0.82 |
| v3 diff | 5.0 / 4.8 | 0 | 0 | 328-458 | 0.80 |
| v3 diff, thinking | 5.0 / 4.4 | 0 | 0 | 354-490, cost 3-4x | 0.77 |

The floor between two full runs was 0.885-0.973. Every delta arm failed the same edit, the c3 deletion of mosaic plots and pie charts, except v3. v3 still wrongly dropped "comparing numerical data across groups" at c1 and "the mean as the balancing point" at c4.

### Book, six sequential rounds (b1-b6)

| Arm | Chapter 3 removed at b6? | Judge accuracy / usefulness, mean | Cosine to full at b6 |
| --- | --- | --- | --- |
| Full regeneration | yes, both runs | 3.7 / 3.7 | (reference; two b6 runs: 0.75) |
| Reuse b0 | no | 3.5 / 3.7 | 0.78 |
| v2 diff | no | 3.2 / 2.8 | 0.75 |
| v2 chunk | no | 4.5 / 4.2 | 0.76 |
| v3 diff | invalid output, runaway reply | 4.0 / 3.2 | 0.40 |

Other book observations:
- No full regeneration named the bootstrap, home-price or transformation sections, each 0.2-1.1% of the text. Those edits are below what a 500-word book summary shows.
- Full-run floor 0.75-0.92. Reuse against full over b1-b6: 0.63-0.87.

### Probe variants, one refresh each from `chapter-noedit`

For the one-sentence edit, the filler-extended paragraphs and the 20 fixes:
- Full regeneration rewrote the descriptor all three times.
- The v3 and insert-only deltas left it unchanged five times out of six.
- No arm mentioned the filler.

For no-op edits, reuse or deltas are more stable than regeneration.

### Policy replay

Costs in this table use DeepSeek's off-peak list prices on the measured tokens, with no prefix cache (`policy.py`, `policy-*.json`).

| Policy | Chapter cost, 5 refreshes | Chapter quality | Book cost, 6 refreshes | Book quality |
| --- | --- | --- | --- | --- |
| Full every refresh (today) | $0.0210 | all checks pass | $0.2934 | small sections absent; chapter 3 dropped |
| Reuse or full, 2% | $0.0129 (full at c1, c2, c3) | misses Cramer's V at c5 (1.9% change) | $0.0932 (full at b3, b6) | same as today |
| Reuse or full, 5% | $0.0043 (full at c2) | misses KDE at c1; stale mosaic and pie at c3-c5; misses Cramer's V | $0.0437 (full at b6) | same as today |
| Reuse, insert-only delta, or full | $0.0093 (delta c1 and c5, full c2 and c3) | all checks pass | $0.1435 (full at b2, b3, b6) | same as today |

## Cost per refresh

DeepSeek `deepseek-flash` list prices: $0.15 per million input tokens on a cache miss, $0.003 on a hit, $0.60 per million output tokens. Peak hours double all three.

| Document | Full summary, off-peak / peak | Measured on DeepInfra | Delta, diff mode | Reuse |
| --- | --- | --- | --- | --- |
| 442-page book, 336k tokens in, ~500 out | $0.051 / $0.101, about 84 credits | $0.047 uncached; $0.012-0.034 with 93k-252k tokens served from the prefix cache; 14-21 s | $0.0005-0.0012 | $0 |
| 40-page chapter, 28k in | $0.0045 / $0.009 | $0.0037-0.0041 uncached; $0.0009-0.0028 partly cached; 10-15 s | $0.0003-0.0009 | $0 |
| 33-slide deck, ~3.1k in | $0.0008 / $0.0016 | not run | n/a | $0 |

Embeddings are small by comparison. A refresh embeds 0.5k-30k tokens of changed chunks, at most $0.0006, or $0.0045 for the page-break first refresh. The summary is 90-99% of a book refresh's provider bill.

The DeepInfra cache hit only up to the first changed chunk, and not reliably: b1 got no hit right after b0. I did not measure DeepSeek's own cache or its latency on a 336k-token request.

## Side findings

1. **Descriptors lose their ending.** The model wrote more than 50 words in 7 of 19 full runs, and `_truncate_words` (`indexing.py:335-343,484`) found no sentence end inside 50 words, so it cut mid-phrase.
2. **Summaries run short.** They came in at 202-427 words for a 500-word target (median 285), with 346-800 output tokens.
3. **The length target flips.** `_summary_word_target` (`indexing.py:302-307`) moved the chapter from 500 to 300 and back to 500 words across small edits near 100k characters.
4. **Text files re-summarize constantly.** They refresh every 15 s while edited and re-summarize the whole file each time (`openwiki/agentic-retrieval.md:2439-2444`). A 20k-token Markdown file costs $0.0033 per refresh off-peak before caching.
5. **`net_tokens` overcounts.** It counts every changed paragraph before and after in full (`collaboration/src/sourceDocuments.ts:171-182`), which is why it is a poor gate input.

## Spend

| Category | Calls | USD |
| --- | --- | --- |
| Full summaries, book (7 rounds, 3 re-rolls) | 10 | 0.2644 |
| Full summaries, chapter (6 rounds, 3 re-rolls) | 9 | 0.0172 |
| Delta chains, all prompts and modes | 54 | 0.1048 |
| Insert-only deltas | 4 | 0.0015 |
| Probe variants (full and deltas) | 10 | 0.0163 |
| Judge, DeepSeek V4 Pro 0813 | 89 | 0.1383 |
| Embeddings | 4 | 0.0009 |
| Thinking-parameter probes | 7 | 0.0001 |
| **Total** | **187** | **0.5437** |

The total was 4.37M prompt tokens, 1.64M of them cached, and 91k output tokens. DeepInfra's `estimated_cost` field is the source, and it bills V4.1 Flash at 70% of list. Before each call the scripts refused the request if the ledger plus a worst-case estimate (input × 1.3 at list price plus `max_tokens` of output) passed $1.85.

## Open questions

1. Gate threshold: 2% of document tokens as suggested, 5% for the larger saving on big files, or a percentage with an absolute floor?
2. Gate input: the pipeline text diff (accurate, about 70 lines) or collaboration's `net_tokens` in the job payload (less code, overcounts)?
3. Detailed tier: remove `describe_documents`, or make it return the heading outline like notes? Either changes the tool contract.
4. How much staleness is acceptable in small documents? At 5% the chapter kept "mosaic plots" for three refreshes; at 2% it missed one added subsection for one refresh.
5. Should the lab rates be confirmed on real traffic? A read-only count of `list_sources` and `describe_documents` in UAT chat activity would do it. `rag_search_events` records only searches.
6. Do DeepSeek's own prefix cache and latency match DeepInfra's? This run had no DeepSeek key.
7. Fix the descriptor truncation now, independent of the rest?

## Reproduction

All scripts are in `scratchpad\delta\`. Run them with the repo `.venv`.

| Script | Purpose |
| --- | --- |
| `make_rounds.py` | builds the cumulative edit rounds and `rounds.json` |
| `chunks.py` | parses and chunks rounds with a scratch parser on port 18393 |
| `sizes.py` | measures delta input sizes (`sizes.json`) |
| `delta.py` | text diff and prompts v1-v4 |
| `llm.py` | capped client and ledger (`ledger.jsonl`, `calls/`) |
| `run.py` | full and delta chains (`results-*.json`) |
| `terms.py`, `similarity.py`, `judge.py` | the three comparison methods |
| `policy.py` | policy replay |
| `probe_variants.py` | the reparse probe's variants |
| `tool_usage.py` | lab tool-call counts |
| `aggregate.py` | the tables above |

Parsed outputs and round documents are in `work/`, and chunk pickles are in `chunk-cache/`.
