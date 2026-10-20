# Pending-hints eval (2026-10-20)

What it measures: whether the per-message hints in `pipeline/pipeline/retrieval/pending_hints.py` (main fe4d2274c: the hints, `for_read` in `pending.py`, the 2026-10-20 hint lines in `human/agentic-retrieval.md`) pick up real signal or noise, and how far GLM and DeepSeek tolerate noisy hints.

Fixtures: `bench/rag/fixtures/hints-eval/`. Scripts: `bench/rag/scripts/hints_eval_*.py`. Raw runs: `bench/rag/reports/local/2026-10-20-hints-eval/` (ignored). See bench/README.md for how to run them.

## Summary

1. **Most message hints are noise.**
   - On a realistic workspace with 40 pending changes:
     - 70 of the 106 hints shown for 70 messages are noise (precision 0.22);
     - 21 of the 24 messages about an edit get that edit (recall 0.79);
     - a message carries 1.0 noise hint on average.
   - With 80 changes the noise rises to 1.9 per message.
   - Almost all noise is a single shared word. Hints that match one message word are 5% relevant; hints that match two or more are 73% relevant.
2. **Two query-parsing defects.**
   - A message word starting with "-" ("-5", "-ve") becomes a NOT term. It matched 37 and 40 of 40 candidates, so the message gets five arbitrary hints.
   - Quotes swallow the " or " joiner into a phrase.
   - Search's lexical leg uses the same string.
3. **Injected junk barely moves either model.**
   - GLM-5.3-Flash on Z.AI and DeepSeek V4.1 Flash:
     - no answer quoted a junk hint in 352 junk turns;
     - correctness outside the XLSX questions stayed at 22/22 under 1, 3 and 5 junk hints;
     - only DeepSeek opened a junk document: in 2 question turns, and in 4 turns of an open "plan my revision" request.
   - **The misleading noise is real noise** that shares a word with the question. "Which indicator am I using for the titration?" hints the to-do list's "titration report" edit:
     - both models opened the to-do list in all 4 real-hint turns;
     - only one of those turns also opened the spreadsheet, and it was the only right answer.
4. **Spreadsheet cell edits are invisible to every path.**
   - A cell effect carries its value only, so neither message hints nor search tails find it.
   - Search then returns the stale indexed cell, which reads like a complete answer.
   - Across the two XLSX questions, 13 of 48 turns were right in the six main conditions.
   - **One extra line under search results fixed it:** "this passage's document has N edits not indexed yet; read it". With it, both models got 26/26 edit questions, including 8/8 on the XLSX pair, with the same or fewer tokens.
5. **Hints buy speed more than accuracy.**
   - Outside the XLSX pair, search tails alone matched message hints at 22/22 for both models. Without any hint or tail, GLM fell to 18/22, answering from stale passages.
   - Message hints let the model skip a search:
     - DeepSeek: 2.93 → 2.32 tool calls and 19.7 → 15.0 s median;
     - GLM: 26.3 → 23.3 s.
   - Search tails are much more precise than message hints: 64-66% of listed edits come from the right document, because the model's search query is focused keywords.
6. **The models almost never stated an edit without reading its document.** 0 of 26 per cell with real or junk hints: they follow "Read the document".
7. **GLM tried to edit the user's documents in 4 of 352 turns with message hints** (0 of 88 without). Examples:
   - re-inserting a deleted to-do line;
   - restoring the coursework's old conclusion;
   - writing invented text into the reading list.

   The write guard refused, but its refusal invites a retry, which could succeed in production.
8. **Cost:** 880 agent turns plus 6 pilot turns, $4.27, an upper bound. DeepSeek is counted at DeepInfra's list price with its 92-94% cached input charged as fresh. GLM's per-turn price follows Z.AI cache hits, which varied by run (46-72%), so compare conditions by tokens rather than dollars.

## Recommendations, ranked

| # | Change | Measured effect | Cost or risk |
|---|---|---|---|
| 1 | **Flag search passages whose document has unindexed edits**: one line per document after the passages, no edit text ("Some passages above may be out of date … Read the document": `hints_eval_agent.py` condition `flag`) | Edit questions 26/26 for both models (real hints: GLM 25/26, DeepSeek 23/26). XLSX pair 8/8 (real: 4/8; all six main conditions: 13/48). Tool calls and tokens unchanged (GLM) or lower (DeepSeek 2.32 → 2.07 calls, 29.9k → 24.8k input). | A pointer, not effects, but it is "with search results": Epo's 2026-10-20 read-only line needs a yes. A few dozen tokens per search. |
| 2 | **Hint only edits that match ≥ 2 distinct message words, match the document name with the change text, show at most 3** (one rule in `match`, so search tails get it too) | Part 1: noise per message 1.00 → 0.16 (busy pool 1.86 → 0.20), precision 0.22 → 0.55 (lenient 0.74), same 21/24 edit messages found. Part 2: edit correctness unchanged (22/22 outside XLSX for both strict variants and both models). Without the name, DeepSeek's off-question reads 0.32 → 0.00 per turn and input tokens −19%. It removes the P07-style misdirection: no to-do list reads under `strict`. | Loses one-word-only matches such as `sin(3x²)` (the name brings most back). Postgres cost: one `@@` per candidate and word (2,000 × 40) on vectors built once. |
| 3 | **Strip websearch operators from query words** (a leading `-`/`!` and `"`) in `search_query_terms` before `websearch_to_tsquery` | "-5" and "-ve" messages: 37/40 and 40/40 candidates matched → 5 and 0. An unbalanced quote: 0 → 2 matches. No change on the 70 messages. | Changes search's lexical leg too (store.py:1189); its owner should confirm. Loses deliberate phrase search, which the " or " join already breaks. |
| 4 | **Stop unrequested edits after a read with pending changes.** Word the read evidence as the user's own edits, the current text, not to be applied or undone unless asked (today: "Apply replacements and removals when using indexed passages"). Optionally make the write guard's retry invitation depend on the user asking for an edit. | Not measured (4 GLM attempts in 352 turns with message hints, 0 in 88 without; too rare for a cheap A/B). | Wording in `pending._evidence`; a guard change is a product decision. |
| 5 | **Give spreadsheet cell effects header context** (row label and column header in the label or text, office-service) | Part 1: would recover 3 of the 6 recall misses. Not measured end to end; #1 already fixes the agent symptom. | Rust change in the fork. |
| 6 | **Hint heading that says most hints are word matches and to read before relying** (`WORDING` in `hints_eval_agent.py`) | With 3 junk hints, DeepSeek's off-question reads per turn 0.25 → 0.05 and junk reads 0.07 → 0. Correctness unchanged; GLM unchanged. | Cheap. Low value while junk tolerance is already at ceiling. |

Not recommended:
- **A ts_rank floor:** the rank of an OR query falls with message length.
- **Top 3 alone:** −13% noise.
- **Generic-word lists:** −27% noise, and they cost recall.
- **Dropping message hints:** tails carry accuracy, but message hints save a search and 2 to 5 s per turn.

## Part 2: model tolerance through the real agent loop

### Setup

- **Agent loop.** Each turn is one `lab/playground` Turn: production `agent.run_agent` with the playground's patches, production prompt, tools and citations, Library off. `hints_eval_agent.py` adds four patches:
  - `pending.load` returns the fixture's 40 pending changes;
  - `inspect_document` reads the fixture's current documents (the playground has no gateway);
  - the condition's hint patch;
  - a recorder of the shown hints.
- **Search and reads are production code** on the scratch database:
  - `search_workspace` with real Qwen3 embeddings and rerank, its tail included;
  - `read_document` with `for_read`.
- **Models:**
  - GLM-5.3-Flash on Z.AI's production route, high thinking, at most 4 concurrent.
  - DeepSeek: V4.1 Flash ran on DeepInfra (`deepseek-ai/DeepSeek-V4.1-Flash`) through the playground's transport override, with production's deepseek request body and high thinking.
- **Questions** (`questions.json`, 22 in all):
  - 13 whose answer exists only in a pending edit (the index holds the old text);
  - 7 that the index answers;
  - 2 small talk.
  - Keys are regexes. Every failure and a sample of passes were checked by hand; the scorer flattens LaTeX first.
- **Conditions:**
  - `none`: no message hints and no search tail (effects only on read: the behaviour before hints);
  - `tail`: search tail only;
  - `real`: production;
  - `junkN`: production's hints plus N real pending edits from documents off the question's subject, at seeded positions. The 400-token cap is lifted so all show (up to 10 lines; production shows at most 5). Both models get the same junk.
  - Follow-ups:
    - `strict`: ≥ 2 matched words;
    - `strict-name`: plus the document name, top 3;
    - `junk3-wording`: rec. 6's heading over the same 3 junk hints;
    - `flag`: rec. 1.
- **Volume:** 2 repeats per cell. 22 questions × 10 conditions × 2 models × 2 repeats = 880 turns.

### Results (44 turns per cell: 26 edit, 14 indexed, 4 small talk)

| Model | Condition | Edit Qs right (stale) | Indexed right | Read the edited doc | Stated an edit unread | Off-question reads / Q&A turn | Junk docs read (Q&A / small talk) | Turns quoting junk | Tool calls | Input tokens | Output tokens | Median s | $ / turn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GLM | none | 19/26 (7) | 14/14 | 19/26 | 0 | 0.00 | – | – | 2.70 | 34.3k | 556 | 26.3 | 0.0028 |
| GLM | tail | 22/26 (4) | 14/14 | 22/26 | 0 | 0.00 | – | – | 2.89 | 37.3k | 615 | 25.6 | 0.0031 |
| GLM | real | 25/26 (1) | 14/14 | 25/26 | 0 | 0.05 | – | – | 2.75 | 34.3k | 625 | 23.3 | 0.0025 |
| GLM | junk1 | 24/26 (2) | 14/14 | 24/26 | 0 | 0.03 | 0 / 0 | 0/44 | 2.16 | 28.0k | 573 | 21.7 | 0.0025 |
| GLM | junk3 | 23/26 (3) | 14/14 | 23/26 | 0 | 0.00 | 0 / 0 | 0/44 | 2.16 | 28.5k | 489 | 22.7 | 0.0021 |
| GLM | junk5 | 22/26 (4) | 14/14 | 22/26 | 0 | 0.00 | 0 / 0 | 0/44 | 2.07 | 28.1k | 513 | 22.0 | 0.0024 |
| DeepSeek | none | 21/26 (5) | 14/14 | 21/26 | 0 | 0.03 | – | – | 2.93 | 31.7k | 1,199 | 19.7 | 0.0072 |
| DeepSeek | tail | 23/26 (3) | 14/14 | 23/26 | 0 | 0.00 | – | – | 3.20 | 35.8k | 1,288 | 20.3 | 0.0081 |
| DeepSeek | real | 23/26 (3) | 14/14 | 23/26 | 0 | 0.15 | – | – | 2.32 | 29.9k | 1,412 | 15.0 | 0.0069 |
| DeepSeek | junk1 | 23/26 (3) | 14/14 | 23/26 | 0 | 0.10 | 2 / 0 | 0/44 | 2.43 | 31.1k | 1,208 | 17.0 | 0.0070 |
| DeepSeek | junk3 | 23/26 (3) | 14/14 | 23/26 | 0 | 0.10 | 0 / 2 | 0/44 | 2.64 | 29.5k | 1,398 | 18.5 | 0.0068 |
| DeepSeek | junk5 | 24/26 (2) | 14/14 | 24/26 | 0 | 0.03 | 0 / 2 | 0/44 | 2.77 | 35.4k | 2,381 | 17.4 | 0.0086 |

Follow-ups. Latency, and GLM's dollars, are not comparable here: these turns ran at another time and load, and Z.AI's cache hit share varied by run.

| Model | Condition | Edit Qs right | Outside the XLSX pair | XLSX pair | Off-question reads / turn (all) | Tool calls | Input tokens | $ / turn |
|---|---|---|---|---|---|---|---|---|
| GLM | real (reference) | 25/26 | 22/22 | 3/4 | 0.11 | 2.75 | 34.3k | 0.0025 |
| GLM | strict | 24/26 | 22/22 | 2/4 | 0.00 | 2.66 | 33.4k | 0.0030 |
| GLM | strict-name | 22/26 | 22/22 | 0/4 | 0.00 | 2.41 | 30.9k | 0.0029 |
| GLM | junk3-wording (vs junk3 23/26) | 22/26 | 22/22 | 0/4 | 0.00 | 2.27 | 31.7k | 0.0031 |
| GLM | **flag** | **26/26** | 22/22 | **4/4** | 0.11 | 2.68 | 34.6k | 0.0036 |
| DeepSeek | real (reference) | 23/26 | 22/22 | 1/4 | 0.32 | 2.32 | 29.9k | 0.0069 |
| DeepSeek | strict | 24/26 | 22/22 | 2/4 | 0.00 | 2.18 | 24.2k | 0.0057 |
| DeepSeek | strict-name | 23/26 | 22/22 | 1/4 | 0.27 | 2.30 | 27.7k | 0.0066 |
| DeepSeek | junk3-wording (vs junk3 23/26, 0.25 reads) | 23/26 | 22/22 | 1/4 | 0.05 | 2.32 | 26.2k | 0.0060 |
| DeepSeek | **flag** | **26/26** | 22/22 | **4/4** | 0.14 | 2.07 | 24.8k | 0.0057 |

Reading the tables:
- **Outside the two XLSX questions**, every condition with hints or tails is 22/22 for both models, and every indexed question is right everywhere.
- **The differences between conditions are the XLSX pair** (each answer is a coin flip on whether the model opens the spreadsheet) **and GLM without hints**: it answered P02, P04 and P12 from stale passages in 4 of 6 turns.
- **GLM's slide from 25 to 22 of 26 under junk is all on the XLSX pair** (n = 2 per cell; P06 alone went 1/2, 0/2, 2/2 across none, tail and real). I do not read it as a junk effect.
- **Junk tolerance:**
  - no answer quoted a junk hint (0 of 352 junk turns);
  - no answer to a question named a junk document;
  - GLM made fewer tool calls as junk grew (2.75 → 2.07);
  - DeepSeek opened junk documents only on P17 junk1 (both repeats: a lone junk hint about the calculus note, on an economics question) and on the open revision-plan request.
- **On "plan my revision" (P21), DeepSeek surveys every hinted document.** With 5 junk hints it read 5.8 documents and wrote 14.7k output tokens per small-talk turn, against 0 reads and 1.1k tokens without hints. GLM did not.

### Examples

**Misled by real noise (P07, "Which indicator am I using for the titration?").**
- The only hint is the to-do list's `changed "Submit the titration report by Monday 3 November"`, matched on *titration*.
- DeepSeek (real, both repeats; junk1, one of two) read the to-do list, then answered from the stale search passage: "You are using **phenolphthalein** … Note the report deadline has moved: it now reads 'Submit the titration report by Monday 3 November' rather than Friday."
- GLM real read the to-do list in both repeats as well. Only the repeat that also opened the spreadsheet answered right.
- The spreadsheet's edit (methyl orange) is never hinted.
- With `flag`, both models read the sheet and answered methyl orange 4/4.

**Real noise as a wrong first read (P14, "What is the induced-fit model of enzyme action?").**
- The only hint is the Chinese note's "温度过高时酶 (enzyme) 会变性".
- DeepSeek real r1 opened the Chinese note instead of the textbook. It still answered right after a search.

**A lone junk hint obeyed (P17, "What is a negative externality?").**
- The junk hint is `"Calculus: derivatives" … changed "Differentiation rules"`.
- DeepSeek opened the calculus note in both repeats, as the heading says "Read the document to see what they say now". The answer was still right.
- With 3 junk hints, rec. 6's wording cut DeepSeek's off-question reads from 0.25 to 0.05 per turn. Most of those reads were the revision-plan request's survey of hinted documents.

**Unrequested edits to the user's documents (GLM).** The write guard refused all four; its first refusal says the skill "now counts as read … send it again".
- P05 real r2, "Do I still need to print the lab manual?":
  - It tried `replace_text` on block b3 with "Print the lab manual (pages 12–20)", then `insert_markdown` "- Print the lab manual (pages 12–20)" after b3. That re-adds the line the user deleted.
  - The final insert was stopped only by the playground's own guard ("not a material this conversation created"). In production, the user's note is editable.
- P08 junk1 r2:
  - It tried `replace_text` on the coursework's conclusion with the old text "Inflation was mainly demand-pull, so higher interest rates were the right response.".
  - It then opened its answer with "No edit was made — your coursework stays as it is."
- P11 real r2: it tried `insert_markdown` into the Chinese note.
- P21 junk3 r1: it tried `replace_text` on reading-list.md with invented text, "The autumn term begins on Monday 8 September 2025, with induction for new students in the main hall."
- These happened in 4 of 352 GLM turns with message hints, against 0 of 88 without (none and tail). That is too rare to pin on the hints with confidence, but the read evidence's "Apply replacements and removals…" is a plausible trigger for the first two.

**Removed text.**
- In the GLM pilot (P01 real), the answer said "The note also flags the classic slip…", which is the block the hint marked removed.
- In the 880 measured turns, the models described removals correctly ("that warning is no longer in the note").

### Search tails seen in Part 2

Share of the edits a search tail lists that come from the question's own document:

| Condition | GLM | DeepSeek |
|---|---|---|
| `tail` (no message hints) | 52 of 79 (66%) | 44 of 69 (64%) |
| With message hints | Few tails (hinted edits are skipped) | Few tails (hinted edits are skipped) |

Model-written search queries are focused keywords, which is why tails beat message hints (22% precision).

### Other observations (not caused by hints)

- **DeepSeek created placeholder notes in two Q&A turns**, one of them with no hints at all (P05 none r1: create "x", then remove its block; P03 junk1 r1: four "placeholder" notes). These are worth their own look.
- **Reranker timeouts.** DeepInfra's reranker timed out in 39 of 882 turns (4%), spread across conditions; search kept its fused order, as production does.
- **Two DeepSeek turns hit the 600 s stream backstop.** They were rerun.

## Part 1: the matcher's signal and noise (no model)

### Setup

- Production code at fe4d2274c: `candidates`, `_prepare`, `match`, `snippet` and `message` with its 400-token cap. For every message I also asked Postgres which of its words each candidate matched.
- Workspace (`bench/rag/fixtures/hints-eval/workspace.json`): a Year 12 revision workspace with 13 documents, of which 8 have edits since their last index, 40 pending changes in all:
  - three English notes being edited: a maths note with formulas, a prose essay plan, a to-do list;
  - a Chinese note with English terms;
  - an XLSX with 7 cell edits, a DOCX with paragraph edits, a PPTX with slide edits, a text file with line edits;
  - heading and bullet edits among them;
  - 5 documents that are indexed only.
- Effects are derived the way Go (notes) and Rust (Office) derive them: a replacement keeps 40 characters of context on each side.
- The busy pool adds a draft note with 40 added paragraphs (auto processing off, a pasted revision guide): 80 changes.
- 70 messages (`messages.json`): 24 about a pending edit, 23 about indexed content only, 23 small talk or unrelated. The labels were written before the first run:
  - `relevant`: the edit the message is about;
  - `topical`: same subject, fine context;
  - everything else is noise.

### Results (production)

| Pool | Candidates | Hints/msg | Precision (lenient) | Recall | Edit msgs that got their edit | Noise/msg (edit / indexed / small talk) | Msgs with noise | Block tokens when shown |
|---|---|---|---|---|---|---|---|---|
| base | 40 | 1.51 | 0.22 (0.34) | 0.79 | 21/24 | 1.00 (1.04 / 1.17 / 0.78) | 39/70 | 137 |
| busy | 80 | 2.40 | 0.14 (0.23) | 0.77 | 22/26 | 1.86 (1.96 / 1.83 / 1.78) | 46/70 | 182 |

- **On the base pool, 70 of the 106 shown hints are noise.**
  - 13 of 23 indexed-only messages and 11 of 23 small-talk messages carry a hint block, and every hint in those blocks is noise by construction.
  - Doubling the pending pool nearly doubles the noise. Recall does not move.
- **The number of message words a candidate matched separates signal from noise:**

| Matched words | Shown (base) | Relevant | Topical | Noise | Shown (busy) | Relevant | Noise |
|---|---|---|---|---|---|---|---|
| 1 | 80 | 4 (5%) | 11 | 65 | 139 | 4 (3%) | 123 |
| 2 or more | 26 | 19 (73%) | 2 | 5 | 29 | 20 (69%) | 7 |

### Where the noise comes from (base pool, 70 noise hints)

| Cause | Count | Examples (message → hinted edit, via) |
|---|---|---|
| One shared content word, other subject or sense | 44 | "Why did Stalin blockade **Berlin** in 1948?" → WWI conclusion "decisions taken in Vienna and **Berlin**"; "How did the Cuban Missile **Crisis** end?" → the July Crisis line and "overshot the **end** point"; "When did the Berlin **Wall** fall?" → "a ball hitting a **wall**"; "What is the **power** rule for derivatives?" → "all the great **powers**"; "What was CPI **inflation** at its peak?" → three other inflation paragraphs; "the rate of reaction **practical**" → "**Practice**: find the stationary points" (both stem to *practic*) |
| Generic study or chat word | 11 | "do I **need** to…" → "**needs** a resultant force" (3 messages); "worked **example**" → two calculus examples; "I have an **exam** on Monday" → the slide's "**Exam** tip"; "make the **answer** shorter" → "**Answer**: (1, 5) is a maximum"; "Give me three **tips**" → "Exam **tip**" |
| Number | 4 | "… + **1**?" → "Final draft — **1**,980 words" (Postgres splits 1,980 into 1 and 980); "trial **2**" → "2 m/s²"; "What's **15**% of 80?" → "at **15** m/s" |
| Several shared words | 4 | "causes of the **First World War** essay" → the reading list's "Strachan, The First World War: A New History" |
| English word in the Chinese note | 3 | "induced-fit model of **enzyme** action" → "温度过高时酶 (**enzyme**) 会变性"; "S phase of the cell **cycle**" → "卡尔文循环 (Calvin **cycle**)" |
| CJK bigram | 3 | "我们应该怎么**进行**复习？" (how should we revise?) → two photosynthesis edits containing 进行; "**叶绿**素主要吸收什么光？" (chlorophyll) → 叶绿体基质 (chloroplast stroma) |
| One or two letters | 1 | "**I'm** feeling stressed" → "Safety goggles (size **M**)" |

- **Short edits are not the problem.**
  - Edits under 40 characters (headings, bullets, cell values) are 18 of the 40 candidates but give 6 of the 70 noise hints.
  - Paragraph edits and 40-character context excerpts give 64: more words, more chances to share one.
- **In the busy pool, common verbs fill the five slots:**
  - "Can you make me a quiz on this?" → four guide paragraphs via *make* ("makes lactic acid", "make antibodies"…);
  - "Give me three tips for staying focused" → four via *gives*;
  - "How do alkenes react with bromine water?" → four via *water*.
- **Stopwords are already handled.** None of the noise comes from a stopword: English documents drop them through the english configuration, and CJK or undetermined documents drop the English list (the 2026-10-20 refinement).

### What it misses (base pool: 6 relevant edits)

| Cause | Miss |
|---|---|
| A cell edit carries only its value | "What concentration of NaOH did I get in my titration spreadsheet?" ↛ `Summary!B4` → **0.0941**. "Which indicator am I using…?" ↛ `Summary!B5` → **methyl orange**. "Why did I exclude trial 2 from the mean titre?" ↛ `Titration!D8` → **=AVERAGE(D4,D6)**. The user's words sit in the row or column header cell, which the effect does not carry. |
| The words are only in the document's name | "Which books are on my reading list now?" ↛ both reading-list.md line edits |
| Word form under the English stemmer | "**mitotic** and **meiotic** division" ↛ "**Mitosis** vs **meiosis**" (stems *mitot* and *mitosi*). The exam tip was found only through "difference"/"different". |

Recall by message type:

| Message type | Found |
|---|---|
| Same words | 11/12 |
| Synonym | 3/4 |
| Other word form | 3/3 (one by luck) |
| Removed text | 2/2 |
| Chinese | 1/1 |
| English question about the Chinese note | 1/1 |
| Number-only cell | 0/1 |

### Query parsing defects (the same string feeds search's lexical leg)

`search_query_terms(text).any_of` joins the raw words with " or " for `websearch_to_tsquery`, so two of its operators survive. The rows below are against the 40 base candidates:

| Message | Parsed (english) | Matches | After stripping quotes and a leading - |
|---|---|---|---|
| What is -5 + 3? | `!'5' \| '3'` | **37** | 5 |
| Is the -ve charge on the anion? | `!'ve' \| 'charg' \| 'anion'` | **40** | 0 |
| What did I write about the "Sleepwalkers book? | `'write' \| 'sleepwalk' <2> 'book'` | 0 | 2 |
| What is the "lock and key" model? | `'lock' <4> 'key' \| 'model'` (simple config: `'lock' <-> 'or' <-> 'and' <-> 'or' <-> 'key'`) | 0 | 0 |

- **A leading "-" makes a word NOT.** In a maths or chemistry message ("-5", "-ve", "x = -2"), OR'd with the rest, this matches every edit without that token, and the message gets five arbitrary hints.
- **A quote swallows the " or " joiner.**
  - An unbalanced quote turns the rest of the message into one phrase.
  - In a simple-config document, a quoted phrase contains the literal word "or" and can never match.
- **Search has the same behaviour.** `store.hybrid_search` uses the same `any_of` (store.py:1189), so its lexical leg treats a leading "-" as NOT and quotes as phrases. That predates the hints.

### Candidate rules, scored on the same matches (each followed by production's 400-token cap)

Base pool:

| Rule | Hints/msg | Precision (lenient) | Recall | Edit msgs found | Noise/msg | Msgs with noise |
|---|---|---|---|---|---|---|
| Production (top 5) | 1.51 | 0.22 (0.34) | 0.79 | 21/24 | 1.00 | 39/70 |
| Top 3 | 1.33 | 0.25 (0.34) | 0.79 | 21/24 | 0.87 | 39/70 |
| Top 1 | 0.70 | 0.43 (0.45) | 0.72 | 21/24 | 0.39 | 27/70 |
| ts_rank ≥ 0.02 | 0.67 | 0.43 (0.53) | 0.69 | 19/24 | 0.31 | 14/70 |
| ts_rank ≥ 0.03 | 0.30 | 0.67 (0.67) | 0.48 | 14/24 | 0.10 | 5/70 |
| Drop a hint whose only matches are generic words, numbers or 1-2 letters (list fixed before the run) | 1.17 | 0.26 (0.38) | 0.72 | 19/24 | 0.73 | 28/70 |
| **≥ 2 matched words** | 0.37 | **0.73 (0.81)** | 0.66 | 18/24 | **0.07** | **4/70** |
| Name + change text, ≥ 2 matched words | 0.77 | 0.43 (0.59) | 0.79 | 21/24 | 0.31 | 9/70 |
| **Name + change text, ≥ 2 matched words, top 3** | 0.60 | **0.55 (0.74)** | **0.79** | **21/24** | **0.16** | 8/70 |

Busy pool:

| Rule | Hints/msg | Precision (lenient) | Recall | Edit msgs found | Noise/msg | Msgs with noise |
|---|---|---|---|---|---|---|
| Production | 2.40 | 0.14 (0.23) | 0.77 | 22/26 | 1.86 | 46/70 |
| ≥ 2 matched words | 0.46 | 0.63 (0.69) | 0.65 | 19/26 | 0.14 | 6/70 |
| Name + change text, ≥ 2 words, top 3 | 0.69 | 0.50 (0.71) | 0.77 | 22/26 | 0.20 | 10/70 |

- **"≥ 2 matched words"** counts the distinct message words a candidate matches, or requires all of them when the message has only one content word.
  - It cuts noise by 93%.
  - It loses three edit messages whose only overlap is one word: `sin(3x²)`, "words", "difference".
- **Matching the document name too** gives those messages their second word back ("my **calculus** note", "my economics **coursework**") and finds the reading-list question.
  - Recall returns to production's 21/24, at a sixth of the noise.
  - Top 3 keeps the extra same-document edits short.
- **A ts_rank floor does not transfer.** The rank of an OR query falls with message length: one match among 15 words ranks 0.006, one among 3 ranks 0.03.
- **Top 3 alone, and word lists, barely help.** Most noisy messages have only one or two matches.

## Further findings

- **Rec. 1 and the read-only route.** The pointer carries no edit text, but it
  sits in the search result, while the 2026-10-20 line routes pending effects
  to the agent through reads only.
- **Rec. 3 touches search.** It changes `search_query_terms`, which search's
  lexical leg shares, and fixes search's NOT and phrase behaviour with it.
- **Rec. 5** (header context in spreadsheet cell effects) is a fork change;
  rec. 1 covers much of its value.
- **Unrequested edits (rec. 4).** A write guard could refuse document edits
  in a turn where the user asked a question, or the read evidence's wording
  could change; the guard's "now counts as read, send it again" makes a
  refused edit easy to retry.
- **DeepSeek** created placeholder notes in Q&A turns (also without hints)
  and wrote a full survey for "plan my revision" (14.7k output tokens with
  10 hints shown); both are worth their own look.
- **DeepSeek's own endpoint** (`deepseek-flash`, max thinking per the
  2026-10-19 line) was not tested. Results are for V4.1 Flash on DeepInfra at
  high thinking. Rerunning with a key is `hints_eval_agent.py launch --workers
  deepseek=4` after pointing `MODELS["deepseek"]` at the production route.

## Deviations and limits

- **The playground has no gateway:**
  - `inspect_document` returns the fixture's current blocks in Go's shape;
  - `list_sources` is the playground's local listing;
  - `capture_page` has no PDFs;
  - Library was off.
- **The fixture is small** (40 changes, 13 documents). The busy pool shows noise growing with the pool, so production workspaces with auto processing off will be noisier than the base numbers.
- **Repeats and labels.**
  - 2 repeats per cell, so a 1-2 turn difference is noise.
  - Labels were written before the runs by one person. Precision is given strict and lenient to bracket the "topical" judgement.
- **Junk is off-topic real edits**, so it measures tolerance of unrelated noise. The harmful noise is on-topic-looking (shares a word), and that comes from the real matcher.
- **The 5-junk condition shows up to 10 hint lines**, twice production's maximum.
- **Database.** A scratch `pgvector/pgvector:pg16` container, migrated and loaded by `hints_eval_db.py`; Part 1 and the model runs queried only it.

## Files

- **Committed** (measured against main at fe4d2274c):
  - `bench/rag/fixtures/hints-eval/`:
    - `workspace.json`: 13 documents and their edits;
    - `busy.json`: the 40-paragraph draft;
    - `messages.json`: 70 labelled messages;
    - `questions.json`: 22 questions, keys and junk markers.
  - `bench/rag/scripts/`:
    - `hints_eval_fixture.py`: effects as Go and Rust trim them, and the PendingSources;
    - `hints_eval_db.py`: migrate and load the scratch database;
    - `hints_eval_matcher.py`: Part 1;
    - `hints_eval_agent.py`: Part 2 `plan` / `run` / `launch` / `score`, all conditions.
  - `bench/rag/reports/2026-10-20-hints-eval.md`: this report.
  - `bench/README.md`: a paragraph in the rag section.
- **Raw data**, ignored:
  - `bench/rag/reports/local/2026-10-20-hints-eval/`: Part 1 JSON, Part 2 results, scored.json, logs;
  - `lab/playground/local/runs/`: every turn's run.json and requests.
- **Spend:** $4.27 at list price (GLM $1.24, DeepSeek $3.04), plus about $0.0001 of embeddings. Z.AI ran at most 4 concurrent.
