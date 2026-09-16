# Knowledge base discussion

Session export, 2026-09-16. Developer Epo with Claude (Fable 5.1) in Claude Code. User messages are quoted; tool activity is collapsed. Outcomes of this session: `knowledge-base-plan.md`, nine decisions in `human/agentic-retrieval.md`, the bench report `bench/rag/reports/2026-09-16-turn-fold-capacity.md`, and the capture-lifetime change in `pipeline/pipeline/retrieval/capture.py` and `agent.py`.

---

> can you assess the two bench/rag/reports/2026-09-15-external-knowledge-strategy.md
> bench/rag/reports/2026-09-15-topic-knowledge-base.md
> what is good and bad for building a custom knowledge base for capynotebook

<details><summary>Read both reports, the 2026-09-15 external-search spot-check, `human/agentic-retrieval.md`, and the retrieval and authorization wiki pages.</summary></details>

**Short verdict.** The strategy report is a good licensing and source survey, but it is not yet a strategy. The topic knowledge base report is intellectually sound but designs for a scale problem Capy does not have. Together they answer "where can we legally get material" well and "how does this show up in the product" almost not at all.

**External knowledge strategy report.** What is good:

- Textbook-first is the right call. A textbook already ties explanation, figure, worked example and exercise together.
- The licensing work is real. It catches that OpenStax is now CC BY-NC-SA with an explicit no-LLM-ingestion clause, that catalog licenses do not flow to the books, and that BCcampus figures can differ from the book license.
- Metadata-first, embed-later is consistent with the two decisions already on record: concept extraction removed, figure captioning removed in favour of capture_page.
- It is honest about evidence.

What is bad or missing:

- It never says who the learner is. Open Textbooks for Hong Kong is a tertiary catalog.
- Everything is English, while the search stack has invested in en/zh/ja/ko.
- Too many sources: around a dozen image collections and ten text sources.
- No product entry point. Citations resolve to a file the user can read, and capture_page renders from a copy of that file. A shared corpus needs shared file identity, read authz, and an answer to who pays.
- Live retrieval at question time fights the latency goal (Commons about 2 s, Openverse 10 s, Alibaba 10 to 24 s in the spot-check).
- No cost estimate, and ingest runs on the Netcup host shared by prod, UAT and local.
- The embedding pin problem is noted but glossed.

**Topic knowledge base report.** What is good:

- Separating topic resolution, duplicate detection and curation is the sharpest idea in either document.
- It picks the right option: keep passages, add topic mappings and duplicate groups, curate per request. Paraphrasing does not discharge CC obligations.
- Cheap-first dedup (hash, MinHash, embedding neighbourhood, LLM only on ambiguous pairs).
- It refuses to reopen concept extraction or add a graph store.
- The pilot is bounded with a control arm.

What is bad or missing:

- It is premature. Arm A of its own pilot is the whole first step, and the existing per-file cap of four already handles the "one book crowds results" cost it cites.
- The topic catalog is a content-ops burden disguised as engineering.
- Workspace assembly is a new orchestration (STORM), not a retrieval change.
- Curated outputs with revision pinning is a cache-invalidation system over LLM output nobody asked for.
- Dedup and licensing are the same problem: most open biology books are OpenStax forks.
- Same gaps: entry point, authz, quota, ingest host.

**What I would do instead.** Public workspaces already exist with chat. Decide the learner and language; pick two or three clean CC BY / BY-SA books in one subject; ingest them as a public library workspace on the lab; run about twenty questions; only then add a read-only second scope for the chat agent; defer topics, dedup, curated outputs, live Wikipedia and image collections.

---

> here is another review that I think provides new perspective (attached: knowledge-base-review.md)
>
> for your concerns: 1, 2: no specific learners or region, undergraduate and below, English. Goal like NotebookLM: "I want to learn cell mitosis", agentic loop fetches from the knowledge base and formulates materials and maybe a study plan. 3: ingest is fast (600 pages in ~2 min on 4 CPU / 16 GB); LLM calls during ingest may cost (GLM 5.3 Flash). 4: drop live retrieval, pre-ingest textbooks. 5: highest cost is LLM calls during ingest; maybe 100 to 200 GB DB; B2 for images; current ingest drops images. 6: consistent library embedding; if ingest embedding changes, dual embedding.

Your answers settle most of what I flagged. What the attached review adds that I agree with: do not mix pilot changes; the unit is a source excerpt with chunks pointing back; dedup records relationships rather than deleting. Where I disagree: its learner-adaptation loop is a separate project; the knowledge base only needs a topic id and a teaching-role tag per excerpt so it does not preclude it. Its offer to oversee topic curation means an LLM assigns topics from a candidate list and a human reviews only new-topic proposals, merges and conflicts.

Your specific points:

- Ingest-time LLM cost is negligible: about 0.10 USD per 600-page book; vectors about 10 MB per book; tens of GB for 1,000 books, not 100 to 200 GB.
- No dedicated image store for the pilot: the parser already emits page and bbox for image blocks and capture_page already renders from the PDF. Defer crops until materials embed images.
- Embedding is simpler than sketched: every index has its own pin and the query is embedded against whichever index is searched. Never change the library pin in place.
- Licensing is an admission check. Caution: the HK Concepts of Biology is a 2016 OpenStax snapshot.

The one thing still undecided was how the library enters the product. Suggested pilot: three books, public library workspace on the lab, 20 to 30 "I want to learn X" requests, arm A existing hybrid search, arm B adds topic and role tags, then design cross-scope tools only if B wins.

---

> one more clarification: I plan a "curate" mode toggle in the chat agentic loop. On, the agent can go into the knowledge base and generate files/materials into the user's workspace (generate tool moves in here); citation if needed comes after files exist in the workspace, so never cross-workspace scopes. Off, sources come only from workspace files. Price: might use qwen3.8-flash on Alibaba Beijing with batch pricing. Also: how do we manage overview and manual adjustment of catalogs, probably a dashboard. Summarize what we have in a new markdown file at repo root.

<details><summary>Loaded the `human` skill, checked the ops app under `ops/`, the agent tool contract, turn limits, the Generate workflow, the file status model, AGENTS.local.md, and fetched the Alibaba pricing page.</summary></details>

Wrote `knowledge-base-plan.md` and recorded three decisions in `human/agentic-retrieval.md`: library scope, curate mode, fixed library embedding pin.

**Curate mode** removes the cross-scope problem and fits the shared tool contract. Two things it still needs: provenance is not optional even if citations are (CC BY and BY-SA require attribution; smallest fix is an optional list of library excerpt ids on create_material that Go persists and renders), and the tool budget is tight (8 planning responses times 2 tools; create_material refuses to share a response with retrieval).

**Batch pricing**, verified on the Beijing page:

| Qwen3.8-Flash Beijing | Per million tokens |
| --- | --- |
| Input | 0.113 USD |
| Output | 0.382 USD |
| Batch discount | 50% |

Cost is a rounding error. Batch is asynchronous, so topic and role assignment and pair classification become jobs you submit and collect later.

**Catalog control.** There is already an ops app, so this is a new Library section there. Model-origin assignments are replaced on rerun; operator overrides live separately and apply last; merges leave redirects; uncertain items go to a review queue; only published books are searchable. Pages: Books, Batch jobs, Topics, Review queue, Excerpt browser, Try search. For the pilot, skip the UI and use SQL plus the playground.

---

> curate mode tool budget: possible to completely drop the tool cap? Tool output is retained only when a citation references it, and in curate mode there are no citations; we can drop citations server-side. Feasible?
> attribution should be a visible footer; if sources come from different books, all attributions in the footer?
> qwen3 embedding 4b is fine probably (0.02 per 1M, DeepInfra latency whatever)
> what is the use of image captions for figures? the description is already in the book
> fine with db and b2

<details><summary>Read the agent loop's compaction call site and the wiki rules on live compaction.</summary></details>

**Dropping the tool cap is feasible, but not because of retention.** Retention decides what survives into later turns. Within a turn every live tool result is protected and cannot be compacted, so what stops a runaway turn is the input budget (a hard context-too-large failure) and credit exhaustion (a graceful tools-off final call). Proposal: remove the counts in curate mode, keep a planning-response ceiling, make "next response would exceed the budget" trigger the graceful final call, ignore the final answer's passages server-side. One recorded decision touches this: at most one search_workspace per response.

**Footer with multiple books.** Yes, one footer, one line per book, plus an "adapted from" line. If any source is ShareAlike the material is BY-SA and the footer states it. Render the footer from the provenance record.

**Figure captions.** No use in the baseline. Textbook captions are author-written and the excerpt already carries the referring sentence. Only a bare-number caption would ever justify a generated description.

**Embedding.** Recorded as Qwen3-Embedding-4B, same as the workspace default.

---

> "Make the next response would exceed the input budget trigger the graceful call": don't we have built-in compaction?
> we won't combine knowledge base search into search_workspace; make a new tool like search_knowledge and allow multiple calls
> footer should not be a deletable block (a new column on the file/material, rendered in the frontend)

<details><summary>Read `compact_messages` in compact.py.</summary></details>

There is built-in compaction, but it never touches the current turn. It summarizes only history before the current user message; everything from the query onward is protected. If that block alone exceeds the budget, the turn fails. Two options: (A) graceful stop near the budget, (B) fold older tool results within the turn. Recommended A.

Recorded: the `search_knowledge` / `read_knowledge` / `capture_knowledge_page` tool family offered only in curate mode with several calls per response; the footer as a provenance column rendered by the frontend outside the editable document.

---

> I just made changes to the compaction, there is now a current-turn compaction mechanism, please check again

<details><summary>Read the diff of compact.py, prompts/chat.py, the new test, the wiki and decision entries; ran the 18 compaction tests (pass).</summary></details>

My earlier claim is now wrong. Compaction folds completed history into memory first; if the request still does not fit, it groups the current turn into exchanges (assistant tool-calls message plus its tool results), keeps the last two exact, and folds older ones into one turn note after the query, chained through earlier notes, under the 12k ceiling. Citation numbers survive because the number-to-chunk map lives on the tool context.

For curate mode: the live chain is now bounded, so the graceful-stop idea is unnecessary and the per-turn count can go. Two limits still matter: the per-response count (the fold drops whole exchanges and cannot split one), and a planning-response ceiling as a runaway guard. One ordering consequence: exact excerpt text survives only in the last two exchanges, so read-then-create must be adjacent, or re-read before writing.

Noticed, no action: the query-index fallback could treat a turn note as the query if the query marker were ever missing (production always sets it); the wiki caveat about providers binding reasoning items to prior history applies to the DashScope Responses API.

---

> how does work one section at a time work?

It is a prompt pattern, not code. The response that writes a material comes within two responses of the reads it depends on. Per section: search, read, write. Create the note after the first section and grow it with edit_document. Materials spanning sections (quiz, flashcards) re-read what they need in one response and create in the next; the turn note keeps excerpt ids and what each supports, so the model knows what to re-read. Reads are database fetches, so re-reading is cheaper than raising the keep count for the whole turn.

---

> is it possible to test this beforehand? create a simple test case to check how many sections/files this mechanism can go through (use an opus xhigh subagent), roughly 6-8 files each with 3-4 sections, 600-800 words each, sometimes an image
>
> (mid-turn) i was thinking you can literally mock the text/responses and only test the compaction mechanism

<details><summary>Spawned an Opus xhigh implementer subagent; redirected it to mock everything with no model calls. It produced `bench/rag/scripts/turn_fold_capacity.py`, twelve JSON run records, one focused pytest, a test-catalog entry, and `bench/rag/reports/2026-09-16-turn-fold-capacity.md`. Verified: 19 compaction tests pass.</summary></details>

The fold is not the limit. On a 64k window or wider, a simulated curate turn walked 96 sections across 24 files without context-too-large.

| Corpus | Window | Sections done | Folds | Peak request | Read facts still in note |
| --- | --- | --- | --- | --- | --- |
| 8x4 | 32k | 8 of 32, failed | 7 | 22k | all |
| 8x4 | 64k | 32 of 32 | 9 | 55k | all |
| 16x4 | 64k | 64 of 64 | 23 | 55k | 47 of 64 |
| 24x4 | 64k | 96 of 96 | 34 | 55k | 47 of 96 |
| 24x4 | 200k | 96 of 96 | 5 | 191k | 46 of 96 |

Two other things limit it: 32k models cannot do curate mode at all, and the note saturates at about 46 sections, silently dropping its oldest lines. Steps that re-read before acting are unaffected. Two things to act on: captures accumulate as a standing charge, and excerpt ids are a misleading survival signal (fact codes planted past snippet length are the true signal). Housekeeping: the developer's commit "frontend part 29" swept the in-progress bench files; nothing was committed by me or the subagent.

---

> no worries on model context window, 200k is like the minimum
> on keeping track of curation progress: 1. increase the 12k ceiling in curate mode? 2. a small internal plan file that does not compress, sent on each turn?
> for captures: drop the capture result completely on compaction (both modes); the captured image serves no more purpose once its numbers are in the answer or the written sections
> not sure on the excerpt id

Build the ledger, leave the note ceiling alone, let captures follow their exchange.

- A bigger note is still lossy prose, re-summarized on every fold; it delays saturation without changing what saturates.
- The cheap ledger: the loop maintains it deterministically from tool events, rides outside the messages like captures, never compacted, about 30 tokens per entry. A loop-maintained ledger cannot be wrong about what was created because it is built from receipts.
- Captures: drop a capture when the exchange that produced it folds, not at first compaction, because the model may still be writing from a capture taken in the previous exchange. Same rule for both modes.
- Excerpt ids: only about reading the bench. The ledger should record "read and used", not "seen in a search result".

Plan updated with the bench findings and the three proposals.

---

> ok on your suggestion, i think no more open items?
> whats the theoretical number of sections that can be created with this? all the agent has to do, even with zero previous work summaries, is read the ledger and continue with new sections, right?

Recorded the ledger, the capture rule, and the caps (no per-turn count, 4 knowledge calls per response, 200k minimum). One number remained: the planning-response ceiling.

Yes, that is what the ledger buys. A fresh section needs no memory of earlier work; the turn note only matters mid-section. Per-response context is bounded by things that do not grow with section count except the ledger (about 7k prompt and schemas, up to 64k for two exchanges, at most 12k note, 30 tokens per ledger entry), which leaves room for thousands of sections on a 200k model. What limits it in practice is time and money: roughly 150k input tokens and 15 to 60 seconds per section, so a 1,000-section turn is hours of a single turn and would be ended by the credit guard, a rate limit, or the client disconnecting first. Thousand-section curation should be a resumable background job reusing the same loop and ledger.

---

> ok we dont have Qwen3.5-Plus, not important
> I think we can do the caption change now? for the existing agentic loop?

> yes, the capture rule

<details><summary>Loaded the `ponytail` skill; read capture.py, the agent loop call site, tools.py, the capture tests, and the wiki paragraph.</summary></details>

The image bytes already dropped on fold: captures attach by matching their tool-call id against tool messages present, so once the fold replaces an exchange the image was no longer injected. Only the budget accounting was stale: the loop summed every capture of the turn.

The change, three files: `capture.image_tokens` takes the current messages and counts only captures whose tool result is still present (no messages counts all, so the bench is unaffected); the agent loop passes the messages, with a noted corner that the fit check inside compaction reuses the count so the folding step over-counts once; one assertion in the capture tests. Wiki paragraph, test catalog, decision code references and plan updated. Verified: 37 capture and compaction tests plus 69 agent tests pass.

---

> do we really still need a response ceiling? (like 99?) we might not be so rigid as to structure everything into sections; if a user wants 200 practice questions in a single quiz, sections make no sense

No, not a ceiling. It guards against a model looping without progress, and a count is a bad proxy: it cuts off legitimate long work and still lets a stuck model burn 98 responses. The better guard falls out of the ledger: stall detection, tools off after a handful of consecutive responses that change nothing in the ledger.

On sections, agreed: the ledger is an event log the loop derives from receipts and reads (materials created or appended with id, kind, title and size; excerpts read and which material used them; the request on top), with no declared sections. For 200 questions the model creates the quiz and appends batches through edit_document, and the ledger shows the running count. Assumption to check: appending a batch of questions to an existing quiz via edit_document.

> yes

Recorded: the ledger as an event log with no sections, and no planning-response ceiling with a stall guard and the credit guard as the cost bound. The plan file has no open items; next step is the three-book pilot.

---

## Decisions recorded this session (`human/agentic-retrieval.md`)

1. Library scope: pre-ingested open textbooks, undergraduate and below, English, no region or exam targeting; external retrieval only at ingest time.
2. Curate mode: user toggle; on, dedicated library tools and material creation into the user's workspace, generate lives here; off, workspace files only; library is never a workspace scope; attribution attaches after materials exist.
3. Library embedding pin fixed and independent; query embedded once per index searched; re-embed is rebuild and swap.
4. Visible attribution footer per curated material, one line per source book, material licence stated when any source is ShareAlike.
5. Library embeds with Qwen3-Embedding-4B.
6. Knowledge tool family (`search_knowledge`, `read_knowledge`, `capture_knowledge_page`), curate mode only, several calls per response.
7. Footer is a provenance column rendered by the frontend outside the editable document.
8. Progress ledger: event log derived from tool events, never compacted, no declared sections; note ceiling stays 12k.
9. Captures live as long as their exchange is verbatim and drop when it folds (implemented).
10. Curate mode: no per-turn tool count, 4 knowledge calls per response, 200k window minimum.
11. No planning-response ceiling; stall guard on the ledger; credit guard bounds cost.
