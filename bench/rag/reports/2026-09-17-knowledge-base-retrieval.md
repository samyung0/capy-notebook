# Knowledge-base retrieval experiment on the published library

Date: 2026-09-17. Requested by the developer before designing library
retrieval: does role-phrased querying, the kind a curate prompt would make the
chat model issue, change what search returns, and what do the topic and role
tags add? Runs against library version `lib-2026-09-16-stats-v4` over the 22
answerable frozen questions, scored against their expected topics and roles.
Labels score every arm, and the `filtered` and `library` arms also apply them
as SQL predicates inside the search (see the table footnote). Runner:
[`knowledge_base_retrieval_eval.py`](../scripts/knowledge_base_retrieval_eval.py).
Receipt: `data/knowledge-base-pilot-v4/run/library-retrieval-eval-lib-2026-09-16-stats-v4.json`.
Rerun on 2026-09-17 after the library moved to per-book versions (three books at
version 1, one live workspace): identical numbers, receipt
`data/knowledge-base-pilot-v4/run/library-retrieval-eval.json`.

## Result

Similarity search already lands on the right topic and does not hear roles.
Phrasing the role into the query ("worked example of Linear regression")
leaves role match where the plain question left it. Applying verified tags as
a filter is what delivers role-specific excerpts, and it also exposes where
the library has nothing to give. The taxonomy is useful as a filter and a
listing, not as query wording or a score nudge.

| Arm | Unit | Top-5 hits on an expected topic | Top-5 hits with an expected role | First hit has an expected role |
| --- | --- | ---: | ---: | ---: |
| plain question, production search | chunk | 106/110 | 58/110 | 12/22 |
| same hits grouped by excerpt | excerpt | 105/110 | 52/110 | 12/22 |
| role-phrased rewrites, fused | excerpt | 110/110 | 54/110 | 13/22 |
| plain question, verified-tag filter | excerpt | 102/102 † | 102/102 † | 21/22 |
| production module `library.search`, predicates in SQL | excerpt | 105/105 † | 105/105 † | 21/22 |

† true by construction: these two arms were given the expected topics and roles
as arguments. Read their denominators, not their ratios.

The last two arms take the expected topics and roles as their arguments — the
filtered arm applies them after the search, the library arm as SQL predicates
inside it — so their topic and role columns are true by construction and say
nothing about ranking. Their information is in the denominators: how many
excerpts qualify at all, and which requests the corpus cannot fill. The
filtered arm returned five excerpts for 20
questions, two for `stat-19`, and none for `stat-22`, whose topic
`bayesian-inference` has no verified excerpt tagged `exercise` in these three
books. Browsing the tags alone (no query) finds a median of 141 verified
excerpts per question's topics across all three books, and covers every
expected role for 21 of 22 questions; the exception is the same Bayesian
exercise gap. 1,547 of 1,894 excerpts pass the tag bar (evidence quote found
in the body, confidence at least 0.8).

## What each arm shows

- **Plain search is a topic finder.** 22 of 22 first hits sit on an expected
  topic. Roles are hit about half the time, which is the base rate of the
  corpus, not a retrieval signal.
- **Excerpt grouping costs nothing on topic and slightly lowers role match**,
  because the duplicates it removes were often the extra chunks of the one
  matching worked example. It is still the right unit for the agent: a
  section arrives whole, with its synopsis, roles and figure ids, and the
  coherence rule already forbids splitting a worked example.
- **Role wording does not steer the embedding or the lexical leg.** Fusing
  "introduction to Sampling and bias" and similar rewrites moved role match
  from 58 to 54 of 110 and topic match to 110 of 110. Prompts can decide
  which roles to ask for; they cannot make the ranker honor them.
- **Filters make the request explicit and honest.** With `topics` and
  `roles` as arguments, the result is either the matching excerpts ranked by
  the same fusion, or an empty answer that names the gap. An agent that
  learns "no exercises on Bayesian inference in this library" can say so or
  choose a worked example instead. Without the filter it receives five
  formal passages and cannot tell.
- **Browsing is planning, not reading.** Counts per role and book for a topic
  (for `stat-01`: 23 introductions, 34 worked examples, 22 exercises across
  three books) let the agent decide what to fetch. The lists are far too
  long to read; ranking within the filter is the search.

## The production module

`pipeline/retrieval/library.py` implements the filtered shape with the tag
predicate inside the hybrid search statement (store gained a `chunk_filter`
hook and connection injection for it). Run as a sixth arm with the labels as
its arguments and the same cached query vectors, it returns five excerpts for
21 of 22 questions. Every one is on an expected topic with an expected role,
which is true by construction: the labels were the predicates. The
non-tautological findings are the count (five of five for 21 of 22 questions,
so the corpus fills nearly every request) and the one that comes back empty. It
reports for `stat-22` that the topic holds 15 formal, 20 introduction, 9
reference, 5 summary and 5 worked-example excerpts and no exercise. It beats
the post-hoc filtered arm on `stat-19` (five excerpts instead of two)
because the predicate applies before the candidate cut, so the whole
40-candidate budget goes to qualifying chunks. Remaining differences from the
post-hoc arm are rank swaps inside the same sets. Six integration tests cover
the filters, folding, empty-result counts, browsing and the missing pin.

## Decided shape

- `search_knowledge(query, topics=[], roles=[])`: production hybrid search
  with the tag predicates inside the SQL, excerpt unit, best chunk decides
  rank, verified tags only. Empty result stays empty with the counts that
  would have matched without the role filter, so the model can relax on
  purpose rather than silently.
- `browse_knowledge(topic)`: verified excerpt counts by role and book, plus
  the excerpts' section paths and synopses page by page. The 32-topic
  catalog with aliases goes into the tool description, so the model maps a
  learner's words to topic ids itself; the pilot's alias matcher stays as a
  fallback check.
- The curate prompt owns the plan: which roles a learning request needs, in
  which order, from one book where notation matters. That is the room for
  adjustment. Wording of the search string matters little; the arguments
  matter.
- Regression set: these 22 questions with their labels, scored the same way.

## Limits

Twenty-two questions with agent-authored labels, one corpus, one draw. The
filtered arm used the labels as if they were the user's stated intent, which
in production comes from the model's tool arguments; mapping a learner's
phrasing to topic ids is untested here. Ranking quality inside a filter is
not measured by these labels. Timings ran through the SSH tunnel and say
nothing about in-datacenter latency.
