# Duplicate textbook passages: bounded recommendation

Research on 2026-09-21. No deduplication implementation or provider calls were
added. The developer deferred agentic scope selection and runtime writing work.

## What existing systems do

- Exact text hashes catch copies. MinHash with locality-sensitive hashing finds
  passages with substantial textual overlap. Embeddings find semantic neighbors.
  These are separate stages in [NVIDIA NeMo Curator's deduplication documentation](https://docs.nvidia.com/nemo/curator/curate-text/process-data/deduplication).
  Its GPU infrastructure targets training-data curation; this is evidence for
  the methods, not a recommendation to adopt that infrastructure here.
- [SemDeDup](https://arxiv.org/abs/2303.09540) uses pretrained embeddings to find
  semantic duplicates in training datasets. It supports embedding-based candidate
  discovery, but does not establish when two textbook explanations are
  interchangeable for a learner.
- Search systems also reduce repetition without deleting source records.
  [Elasticsearch field collapse](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/collapse-search-results)
  returns a top result for each group and can expose other group members.
  This assumes the group identity is already known; it does not discover duplicates.
- [Qdrant's MMR search](https://qdrant.tech/documentation/search/search-relevance/)
  balances query relevance with difference from already selected results.
  [Its MMR guidance](https://qdrant.tech/course/beginners/module-6/diversity-mmr/)
  explains why the candidate pool must exceed the returned count for selection
  to change. This is retrieval diversification, not proof of semantic equivalence.

These sources establish widely implemented approaches, not a survey showing
that most teams use an LLM as a duplicate judge.

## Recommendation for this library

Start with the repeated Elmhurst example and a small contrast set. The immediate
problem is several near-identical examples occupying the limited returned
positions. Keep source records and citations; group confirmed equivalents and
select a useful representative for the request. A fixed one-result-per-book
limit would also discard distinct useful examples from one textbook.

1. Detect exact repeated source text, allowing only conservative whitespace and
   layout normalization. Do not erase numbers, signs, units, table boundaries or
   variable names. Boilerplate must not make otherwise different examples equal.
2. Use existing retrieval embeddings and text overlap to nominate cross-book
   candidate pairs. Initially restrict this work to demonstrated repeated results
   and related editions. Similarity is a reason to inspect a pair, not to merge it.
3. If the ambiguous cases justify it, send only those pairs to a separate offline
   reviewer. Give it the actual passage, role, scope, givens, dataset, model,
   question/solution and required linked context. Request one of: equivalent,
   complementary, different example/variant, or insufficient evidence, with
   exact supporting text and any differences. Cache accepted pair decisions by
   source version and text hash so unchanged pairs do not need repeated review.
4. Group only confirmed equivalents in search results, retaining all underlying
   sources. Fill the configured result count from the candidate pool. Evaluate
   MMR separately if results still repeat the same idea after known duplicates
   are grouped; diversity can otherwise demote useful supporting explanations.

Steps 2-3 are the proposed retrieval-plus-LLM approach. They can help distinguish
semantic equivalence from shared vocabulary, but the LLM can still merge
different examples incorrectly. This recommendation is an inference from the
methods above and the observed textbook failures, not a measured result here.
It requires neither a search-continuation cache nor an LLM call on every query.
There is no need to assign it to the optional Qwen book-artifact review.

## Cases and acceptance checks

- Same Elmhurst data, question and simple-regression explanation across books:
  one result position, with all source alternatives retained.
- Same topic and wording but changed dataset, variables, units or population:
  preserve both unless equivalence is established for that specific request.
- Simple versus multiple regression on a shared dataset: preserve the difference.
- Exercise versus its solution: link as complementary; do not collapse them as
  duplicate text merely because the question is repeated in the answer.
- Concept explanation versus implementation in R: distinguish a useful variant
  from duplication. Same method does not mean same applicability.
- Split table/question and continuation: reconstruct or link the coherent
  source unit before comparing; mark missing context as insufficient evidence.
- Different derivations or levels of explanation: related material can remain
  useful even when it reaches the same conclusion.

Measure false merges first, repeated-result positions second, retained answer
coverage third, and latency/token cost for any reviewer. Use separate held-out
pairs after choosing thresholds. Do not claim success from schema validity or
from suppressing more results alone.

Incomplete extraction is separate work. Grouping cannot recover a missing
formula or table. Sol should repair it from the source when assigned that work,
or record the unresolved limit in the text packet and excerpt scope.
