# Structure-aware chunking experiment

## Decision

Do not adopt either candidate as a global chunking rule. Native list and table
boundaries fix the observed JLPT passage contamination and improve its Japanese
dense lookup, but the blanket rule creates too many small chunks: `+41.3%` for
hard boundaries and `+31.0%` when validated continuations are rejoined. The
relationship arm also drops a useful counterevidence page for one unanswerable
question.

The next candidate should preserve the useful transition boundary—do not pack an
answer-choice list together with the following prose—while allowing sibling
lists or table fragments under one parent to remain together. That narrower rule
is proposed, not measured here.

No parser, ingest worker, database, or application behavior changed in this run.

## Frozen protocol

The fixture was frozen before either candidate ran. It contains 11 real PDFs in
English, French, German, Japanese, Simplified Chinese, Hong Kong Chinese, and
Taiwan Chinese; 21 pre-existing retrieval questions; and six exact source-span
probes. There was no real Korean or Spanish source in the preserved corpus, so
this experiment makes no claim about those languages.

The fixture calls six sources `heldout`. That label means withheld from this
candidate's design. Those source families had already been inspected in earlier
parser work and are not new unseen evaluation data. The questions also predate
this experiment, but their page labels are coarse. Dense and lexical metrics
therefore measure whether any returned chunk overlaps a labelled page. They do
not establish that the answer text was returned.

The three packing arms are:

1. **Current**: the current `pack_blocks` behavior over the frozen blocks.
2. **Hard boundaries**: flush before and after every native ODL list or table.
3. **Validated relationships**: the same boundaries, except adjacent same-type
   list/table nodes can remain together only when ODL records a reciprocal
   continuation, the level matches, and the nodes are at most one page apart.
   Native captions are associated only with a same-page table or image.

These reciprocal and geometric checks produce rule-accepted candidate
relationships; the relationships were not individually validated by a person.

This is document-structure handling. It contains no phrase-specific or
language-specific repair.

The current arm is a packing-stage baseline over frozen blocks. Its direct call
to `pack_blocks` omits later full-ingest steps such as heading retention and
chunk scoring. The JLPT source was freshly converted and has the same 439-character
target body as the full replay, but this arm produces 53 JLPT chunks while the
full current pipeline produces 56. Hong Kong and Taiwan controls were freshly
parsed locally with the frozen ODL jar and flags. The remaining controls re-pack
retained native/raw ODL artifacts from the earlier parser experiment. None of
the arms is a complete current-ingest replay.

## Packing and completeness

| Measure | Current | Hard boundaries | Validated relationships |
| --- | ---: | ---: | ---: |
| Chunks | 830 | 1,173 (`+41.3%`) | 1,087 (`+31.0%`) |
| Mean estimated tokens | 225.7 | 153.5 | 165.7 |
| Median estimated tokens | 243.5 | 116 | 131 |
| 95th percentile | 398 | 388 | 390 |
| Cross-page chunks | 47 | 37 | 41 |
| Mean source regions per chunk | 4.38 | 2.98 | 3.19 |
| Chunks mixing list and prose | 169 | 0 | 0 |
| Chunks containing multiple lists/tables | 52 | 0 | 14 |
| Exact probes complete | 5/6 | 5/6 | 5/6 |
| Exact probes clean | 4/6 | 5/6 | 5/6 |

The missing Taiwan probe is absent from every arm's frozen native/raw blocks, so
packing cannot repair it. This preparation omits the full current refinement and
font-repair path; the miss is evidence about this artifact, not a confirmed
current production-parser failure. The 12 longer evidence labels have mean
maximum unique-term coverage `0.6766`, `0.6752`, and `0.6752`; no arm contains a
complete label in one chunk. This is only an unordered unique-term coverage
proxy. It ignores word order and repeated terms and must not be read as literal
span completeness.

The cost is uneven. The ResNet PDF grows from 62 chunks to 184 with hard
boundaries because ODL emits many native list/table sequences. Validated
continuations reduce it to 101, still `+62.9%` over current. A native list is
useful structure, but its identity alone is not a reliable semantic chunk.

## JLPT incident

The current Question 10 chunk combines the preceding Question 57 answer choices
with the new passage. Both candidates separate the list from the passage without
changing parser output:

| Measure | Current | Hard / relationships |
| --- | ---: | ---: |
| Passage complete | Yes | Yes |
| Previous-choice contamination | Yes | No |
| Estimated tokens | 353 | 250 |
| Citation regions | 2 | 1 |
| Passage region | page 10, `[151.220, 365.661, 848.861, 528.146]` | same |
| Extra preceding region | page 10, `[151.220, 291.509, 786.165, 361.385]` | absent |

The single clean region covers the Question 10 opening and excludes the preceding
choices. It is a block-level candidate box from existing ODL geometry, not a
precise cited-text or glyph box. The runtime citation locator still needs to
resolve the cited substring within that region before this can be called an
accurate citation box.

All 1,366 distinct passage/query inputs in the three arms were freshly embedded
with the pinned `Qwen/Qwen3-Embedding-4B` model at 2,560 dimensions. Passages
were embedded as stored; questions used the exact production `qwen3_query`
instruction. Offline scoring serializes to six significant digits and half
precision, takes the dense top 40, applies the production soft per-file cap of
four, and returns five.

The five original JLPT query vectors came from the earlier frozen request with
the same model pin and exact query wrapper. They were reused, so the incident
replay made no additional provider call. Relevance is fixed before scoring: one
chunk must contain all three Question 10 anchors. Cleanliness is separate.

| Query | Current dense rank | Hard rank | Relationships rank | Current returned | Hard returned | Relationships returned |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| English locator | 22 | 19 | 18 | — | — | — |
| Japanese locator with `読解` | 14 | 5 | 4 | — | 5 | 4 |
| Japanese locator without `読解` | 11 | 6 | 5 | — | — | 5 |
| `問題 10` | 19 | 13 | 13 | — | — | — |
| Subject question | 1 | 1 | 1 | 1 | 1 | 1 |

The Japanese locator distance improves from `0.510570` to `0.464723`; without
`読解` it improves from `0.492592` to `0.464062`. The subject distance improves
from `0.424214` to `0.317323`. Removing unrelated choices helps this incident,
although generic locator queries still remain much weaker than a content query.

This replay ranks a packing-stage baseline over the controlled 11-source corpus,
not the original three-file UAT workspace or a full current-ingest output. It
isolates the candidate chunk texts with fresh passage vectors and must not be
presented as an exact UAT output replay. Any future adoption test must repeat the
comparison through the full pipeline, including heading retention and scoring.

## Broader dense retrieval

| Measure | Current | Hard boundaries | Validated relationships |
| --- | ---: | ---: | ---: |
| Gold-page Hit@5, all 21 | 19 | 20 | 19 |
| Gold-page Hit@5, 19 answerable | 18 | 19 | 19 |
| Gold-page MRR@5, all 21 | 0.7817 | 0.7849 | 0.7754 |

The answerable gain is one Japanese question, `odl-agentic-021`, which changes
from a miss to gold page 20 at rank 4 in both candidates. Chinese question 023
improves from rank 4 to 2. Chinese question 027 regresses from rank 3 to 5 but
remains returned.

Question 061 asks for a 2025 statistic from a 2024 publication and is
unanswerable; its labelled page is counterevidence, not an answer. It remains a
miss in all arms. Unanswerable Question 064 asks for a standard deviation that
Table 2 does not provide. Its useful table page falls from current rank 2 to hard
rank 5 and is absent from the relationship arm. That regression is why the
relationship arm's answerable total looks better while its all-question total
does not.

All 13 questions whose ordered top-five source/page signature changed were
reviewed against their question and labelled pages. The remaining answerable
questions keep their gold page in the top five. This source review does not add
answer-span labels after seeing results.

The original in-memory lexical diagnostic is retained only as an exploratory
signal. It is not PostgreSQL BM25 and its relevance is the same gold-page proxy.
It reported 17/21 Hit@5 in every arm, with MRR `0.644`, `0.709`, and `0.685`.
The proper BM25/fusion experiment is a separate retrieval benchmark.

## Citation geometry feasibility

A post-hoc diagnostic tested whether existing native ODL cell geometry could be
attached after conversion without changing ODL itself. Of 356 table cells with
usable text and boxes, 303 unique cell IDs were attached as candidate metadata
to indexed table chunks. The heuristic checks text uniqueness within a native
table and normalized substring membership in the chunk. It abstained on 16
repeated-text encounters; other cells belonged to table nodes that were not
members of an indexed chunk. Short substring collisions remain possible, such
as `10` matching `100`. No attachment-accuracy rate was measured or manually
verified, so these attachments do not establish accurate cell citations.

Because this validation was tightened after the primary results were inspected,
it is recorded as a post-hoc feasibility check and not used to select the
chunking arm.

## Research context

Docling's official chunking design keeps document items and provenance, splits
oversized chunks, and merges undersized peers only when headings and captions
match. It also repeats table headers when tables split. That is consistent with
the measured need for structure plus bounded recombination, rather than an
unconditional boundary around every parser node:
[Docling chunking](https://github.com/docling-project/docling/blob/main/docs/concepts/chunking.md).

The paper *Is Semantic Chunking Worth the Computational Cost?* evaluates
document, evidence, and answer retrieval separately and reports no consistent
advantage for semantic chunking across its tested settings. Its useful lesson
here is methodological: measure evidence completeness and downstream retrieval
instead of assuming that finer chunks are better:
[arXiv:2410.13070](https://arxiv.org/abs/2410.13070).

## Reproduction and artifacts

Tracked runners:

```bash
PYTHONPATH=pipeline uv run --with pymupdf \
  python bench/parsers/scripts/structure_chunking_eval.py evaluate
uv run --with numpy --with httpx \
  python bench/parsers/scripts/structure_chunking_embed.py score
uv run --with numpy \
  python bench/parsers/scripts/structure_chunking_jlpt_eval.py score
```

Run `prepare` and `freeze` before those stages for a new isolated run. The
tracked fixture and runners reject changed source/question hashes. Raw PDFs,
blocks, chunks, vectors, provider receipts, exact top-five records, source review,
and amendment receipts remain in ignored
`bench/parsers/reports/local/2026-09-13-structure-chunking/`.

The embedding run made 22 successful requests, embedded 1,366 unique inputs, and
reported 340,477 provider tokens. No request was retried. An initial float32,
full-corpus hard-cap score was preserved as exploratory before the offline scorer
was corrected; no passage embeddings were repeated.

Closing review added an actual prepared-input hash check to the JLPT runner.
The executed pre-fix runner and a validation-only amendment are preserved in
`embedding/jlpt-diagnostic/`. A changed-input check now fails explicitly, and
replaying the existing vectors produced byte-identical scores with no provider
calls or new experiment arms.

| Artifact | SHA-256 |
| --- | --- |
| Packing freeze | `c574196443330e99758da30aa1e2fada50d4059e628bcfc3b7b7ca8b5fbf08db` |
| Primary packing result | `66ffc8c1cf58887b5f1c727e1257c53681109ad44aa5069f13ddbc2f4edc84ae` |
| Frozen embedding inputs | `ed08669736b66e015cd797847c72ab47ed201f83c311121505b8ade0d26f72b4` |
| Provider request receipts | `ae730650c1e29b5057afd400b53940820199eb9ac4059e5da28608bdf3acc0d5` |
| Corrected dense scores | `57555df74c4c170bea537d5be31e71d8ae757ba87b1568dd3891355e524c4965` |
| Top-five source review | `1ff708a2ba2d5e2b1634288b3fc1711f5eab5e1bca2062258a67fc4d3fd4bf2a` |
| JLPT diagnostic freeze | `a390d694ad3f049fb892e6c72a978f2f86bafc1e6f3cc8dd2567349320b7abf0` |
| JLPT diagnostic scores | `4173262bb383ac3a9395e1d27d19c1dd08192312c8e1b2329c90eb874fcb8b47` |
