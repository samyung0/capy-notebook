# JLPT numbered-section lookup diagnostic

## Frozen plan

User authorized this isolated diagnostic on the ingest VM after the initial
read-only UAT investigation. The experiment does not change UAT data, service
configuration, parser code, application code, or the model registry.

The target is the opening of reading-comprehension section question 10 in
`N1 7-2019.pdf`. Its stored indexed passage includes the previous question's
answer options and an unrelated question-55 heading. Freeze a read-only snapshot
of all 223 current workspace chunks and their original vectors before any new
embedding calls. Retain source identities and vectors only in ignored local
artifacts and the VM scratch directory.

Use the workspace's exact model, DeepInfra Qwen3-Embedding-4B v1, 2560 dimensions,
and the production query instruction. One provider request contains five queries
and four target document inputs. Do not retry or discard a failed request.

The queries are the three historical searches, literal `問題 10`, and a Japanese
question about the passage's subject:

1. `question 10 reading comprehension passage N1`
2. `問題10 次の文章を読んで 読解`
3. `問題 10 次の文章を読んで`
4. `問題 10`
5. `シアノバクテリアと藻類による大気環境の変化と現代人による環境変化はどのように違うか`

Compare the stored original vector, a freshly embedded identical input, a repaired
heading only, previous answer options removed only, and both changes. The repaired
heading is `第二部分 読解 › 問題 10`; trimming starts at the unique `問題 10 次の文章`
in the current target text. Every other chunk/vector stays fixed. Existing lexical
ranks also stay fixed so these variants isolate embedding-input effects.

For each input variant compare five ranking conditions over the same snapshot:
current RRF, RRF without the short-lookup boost, lexical weight 1 for all matches,
full lexical weight for all-term matches regardless of query length, and dense-only.
Use the production 40 candidates, 5 outputs, per-file cap 4, and RRF k=60.
Compute exact cosine distance over all stored chunks. Convert fresh vectors through
the production six-significant-digit serialization and half precision before
distance calculations. Use chunk ID for numeric ties, since production SQL leaves
ties unspecified. Record every target rank, score, candidate list, and returned
list. This isolates ranking effects; it does not test ANN recall.

The source snapshot, complete provider payload, model identity, script hash, and
comparison list are frozen in `freeze.json` before the provider call. Raw responses,
request status, token usage, elapsed time, and artifact hashes are retained.

This is a diagnosis of one known failure, not a general retrieval benchmark or a
new parser implementation. The subject query and repaired inputs are manually
constructed with knowledge of the answer. Their results cannot estimate general
agent success or justify a global ranking default.

Runner: `bench/rag/scripts/jlpt_lookup_ablation.py` with sequential `freeze`,
`embed`, and `analyze` stages, each receiving the same fresh scratch directory.

## Results

The run reproduced the lookup failure and isolated the term-count exception.
Removing the preceding answer options helped the Japanese locator queries, but
replacing the heading made them worse. The unchanged target already ranked first
for the subject query. These results support treating section lookup as a distinct
retrieval need; they do not identify an embedding-model defect.

The snapshot froze at 2026-09-13 06:09:20 UTC. One request returned HTTP 200 in
1.58 seconds and reported 1,275 input tokens. All nine inputs and all 125 offline
ranking combinations completed. No failure was retried. Decoding both to half
precision, the freshly embedded original target exactly matches all 2,560 stored
components. Its ranks are identical to the stored-original control.

The first three rows below replay the historical queries with fresh query
embeddings against the frozen current index. They are new measurements, not
previously retained historical candidate ranks. Historical search 3 recorded
vector rank 13 and distance 0.492829; the fresh replay retains rank 13 with distance
0.492592. Current fusion reproduces the historical miss, miss, first sequence.
An independent check also confirmed that all five baseline output chunk IDs for
each of the three queries match historical telemetry in the same order.

| Query | Target vector rank | Target lexical rank | All-term match | Current fused rank | Returned position |
| --- | ---: | ---: | --- | ---: | ---: |
| 1, English locator | 24 | 22 | No | 12 | Absent |
| 2, Japanese locator with `読解` | 16 | 1 | Yes | 8 | Absent |
| 3, Japanese locator without `読解` | 13 | 1 | Yes | 1 | 1 |
| 4, `問題 10` | 19 | 2 | Yes | 2 | 2 |
| 5, subject query | 1 | 2 | No | 1 | 1 |

### Fusion effects with original inputs

The cells are the target's full fused rank before the final output cap. Positions
above five are absent from the returned five in these comparisons. Both lexical
ranking conditions use the identical lexical candidates; the dense leg is also
fixed within each query.

| Query | Current rule | No lookup boost | Every lexical match at weight 1 | All-term boost without length cutoff | Dense-only |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 12 | 12 | 12 | 12 | 24 |
| 2 | 8 | 8 | 7 | 1 | 16 |
| 3 | 1 | 7 | 4 | 1 | 13 |
| 4 | 2 | 9 | 8 | 2 | 19 |
| 5 | 1 | 1 | 1 | 1 | 1 |

Query 2's target matches every lexical term and ranks first lexically, but its
four-term query receives half lexical weight. The current score puts it eighth.
Giving full weight only to all-term matches puts it first. Giving full weight to
every lexical match also promotes competing passages and leaves the target
seventh. This distinguishes an exact-match exception from a global lexical-weight
increase.

The `読解` omission changes four counted terms to three. The counter counts CJK
runs, so `次の文章を読んで` is one term. The space around `10` is not the trigger.
This creates a discontinuity where adding relevant context can remove the lookup
boost. `all_terms` is a diagnostic arm, not a selected production fix: token
co-occurrence does not guarantee that a passage contains the requested heading.

### Target-input effects

These are exact vector ranks against the same 222 other chunks. Fresh-original
results equal stored-original results throughout.

| Query | Original | Heading replaced only | Previous options removed only | Both changes |
| --- | ---: | ---: | ---: | ---: |
| 1, English locator | 24 | 28 | 17 | 51 |
| 2, Japanese with `読解` | 16 | 28 | 3 | 46 |
| 3, Japanese without `読解` | 13 | 17 | 5 | 42 |
| 4, `問題 10` | 19 | 16 | 14 | 21 |
| 5, subject query | 1 | 1 | 1 | 1 |

Removing the previous options while keeping the old heading moves query 2 from
vector rank 16 to 3 and into the first current-fusion output. Query 3 moves from
13 to 5. This establishes a passage-mixing effect for those fixed inputs.

It does not establish that cleaning both heading and body is better. The combined
change lowers the ordinal-query ranks to 46 and 42, outside the forty vector
candidates. Its lexical leg is unchanged in this experiment; even full weight on
a lexical-only rank 1 cannot beat enough passages that receive both legs' scores.

For the subject query, the target's cosine distance improves from 0.424215 to
0.304321 with heading replacement, to 0.317323 with option removal, and to 0.225196
with both. It remains first in every condition. The cleaner target is better
aligned with its subject but worse aligned with generic exam-locator language.
The remaining, incorrect heading contains question/author/reading language that
can help that generic similarity. This is a plausible explanation of the observed
direction, not an interpretation of the model's internal features.

No heading or parser change is selected from this experiment. No agent answered
these variants, and the document continuation was not re-chunked. Replacing one
embedding while holding lexical ranks fixed isolates one effect; it does not
simulate a complete ingest change.

## Relation to earlier evidence

The implementation follows the saved RRF decision. Its original code comment
cites 19 biology questions, where expected passages found improved from 22/28
with equal weights to 26/28 with half lexical weight. The current source still
contains that justification and the two-to-three-term exception in
[`store.py`](../../../pipeline/pipeline/retrieval/store.py#L851).

The later [broad evaluation](../broad/reports/2026-09-05-broad.md) found hybrid
318/360 versus dense 342/360, with dense nDCG higher in all nine cohorts. Hybrid
uniquely succeeded on five queries, dense uniquely on 29. It called fusion ranking
the strongest next investigation and expressly did not justify replacing hybrid
globally. The present incident is an example where dense-only also fails.

The [embedding comparison](../embedding/reports/2026-09-06-embedding.md) kept
the same fusion and did not justify changing from Qwen3-Embedding-4B. The
[curated development screen](../curated/reports/2026-09-05-curated.md) also found
no improvement from universally doubling lexical weight or returning eight
results on its small selected sample. These are historical experiments with
different sources and chunker v5. This snapshot uses ODL and chunker v9.

The [September 9 ODL evaluation](2026-09-09-odl-agentic-evaluation.md) said its
development variants did not justify changing retrieval defaults. It did not
resolve the earlier fusion gap or validate this numbered-section lookup.

Language-aware query handling is a reasonable next candidate. The index already
uses English/French/German/Spanish Postgres configurations and `simple` for
Chinese/Japanese/Korean, with application-side CJK bigrams. The fusion weight and
two-to-three-term lookup rule are shared across languages. For Japanese, a whole
instruction such as `次の文章を読んで` counts as one CJK run; the function-word test
only examines its non-CJK portion, `10`, under `simple`. It therefore cannot
distinguish the Japanese instruction from a content-only lookup. See
[`lang.py`](../../../pipeline/pipeline/retrieval/lang.py#L25) and
[`store.py`](../../../pipeline/pipeline/retrieval/store.py#L903).

Japanese-aware recognition of a numbered heading such as `問題 10` could address
this mechanism more directly than changing a universal term-count threshold.
This need not imply a separate model or independent retrieval stack per language.
Separate fusion weights could also be tested, but the existing reports do not
select them: Japanese broad hit@5 was 40/40 for both hybrid and dense, with nDCG
0.730 versus 0.804; German slightly favored hybrid hit@5 while dense nDCG was
higher in every cohort. Those comparisons mix language and question types and
never tune a Japanese-specific weight. This experiment shows that globally
raising lexical weight to 1 still misses query 2.

An exact locator within a known document is a reasonable next candidate to test.
This run supports examining selective exact-heading handling before changing the
embedding model or all lexical weights. It does not establish the best general
locator design, and no production behavior was changed.

## Artifacts and verification

The runtime was an independent script process in the ingest VM's existing UAT
worker image at revision `711e3fe6007f0ae44b129e868f7f486699694fcc`, using its
existing DeepInfra credential. No worker service was restarted or modified.
Database access was limited to the read-only freeze; embedding and analysis made
no application/database writes. VM scratch files are at
`/tmp/capy-jlpt-lookup-20260913-r1`, with a copy under the same path inside the
worker container. A preliminary pre-format freeze made no provider request;
only the final manifest below was used.

Local raw artifacts are in ignored
`bench/rag/reports/local/2026-09-13-jlpt-lookup/`. They include the complete
snapshot, freeze, exact request payload, raw provider response, receipt, all
candidate/output lists, results, hashes, and the script as run. The report omits
unrelated source contents and workspace/account identities.

| Artifact | SHA-256 |
| --- | --- |
| Frozen manifest | `be48e1121547497266f6c7b44f6ebeeb9f63099e76673e02ec2f73214967fc51` |
| Source snapshot | `0fb5faa79e0ff11128d75bb58179602d3184c11bd16589a6ad01beadf2b1dc5b` |
| Provider response | `f1c5894e1dc07d123de2e75c839c9912fd4d59580d5d7028e3e54aac4605bb6a` |
| Results | `dafded6a2d0f4fed71a263138c121159dd5889e9b84a1b756399f3e9a3291ec1` |

`pnpm run fmt:py` passed with no unrelated edits. The benchmark file additionally
passed explicit Ruff formatting/lint and Python compilation. Its completed
analysis checked the per-file overflow rule and the observed RRF inequality.
The manual-diagnostic inventory in `openwiki/test-catalog.md` includes the runner.
