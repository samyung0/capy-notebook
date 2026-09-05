# Fresh RAG evaluation, 5 September 2026

Freeze the current local reference-following instruction and document locations
against the earlier baseline. This experiment evaluates transfer; it does not
select new production settings from its evaluation scores.

- Run only in the existing isolated `capy-rag-curated` VM lab, using new workspace
  IDs and a new `broad/` results directory. Preserve the earlier corpus and runs.
- Use native MIRACL questions and judged passages in en, de, es, fr, ja, ko, zh.
  Select 40 questions per language with a fixed seed before any retrieval call.
  Retrieve over the pooled judged passages, including judged negatives. These
  smaller candidate pools are not official full-corpus MIRACL results.
- Add English scientific claims and arguments from BEIR SciFact and ArguAna,
  with 40 fixed questions per dataset and their full corpora. Keep their original
  relevance labels. Exclude the corpus item with the query's own ID from every
  arm, following BEIR's standard convention, using the real file-scope filter.
- Embed source text with the actual workspace Qwen3-Embedding-4B pin. Use the
  application chunker, language detection, lexical index, SQL search, and result
  cap. Benchmark documents are installed directly into the isolated index; this
  component test does not measure the upload or parser pipeline.
- Measure first-search labeled passage hit rate, document recall, nDCG, and
  detected source language. Report every dataset/language separately. Compare
  current hybrid search with a frozen dense-only diagnostic, using identical
  query vectors. Do not treat this diagnostic as authorization to change ranking.
- Run fresh chat conversations under the frozen baseline and current candidate.
  Include native questions, MLQA cross-language cases, HotpotQA multi-document
  evidence, and explicit missing-source controls. Freeze the final case manifest,
  source hashes, model identities, and runner hashes before these turns.
- Review final answers against source evidence. Report answer correctness,
  evidence retrieved, citation support, missing-source behavior, and latency
  separately. Source relevance labels alone do not certify answer correctness.
- Keep all related sources and translated variants together. Cases used to
  diagnose a new change become development data; any subsequent claim of
  improvement requires a new untouched evaluation.

The chat comparison retains the same model, tool budget, search settings, and
index for both arms. No model weight training or embedding-model change is part
of this experiment. Public benchmark familiarity and smaller candidate pools
limit how far the results generalize.

Chat manifest: 14 native MIRACL questions over the seven component indexes,
eight MLQA cross-language cases, eight HotpotQA cases, and six source-removal
controls. Run both conditions twice, 144 turns total. The MLQA and HotpotQA
sources use normal Markdown upload and ingest. MIRACL chat reuses the component
fixtures and does not measure ingestion. Account locale is Chinese for Chinese
questions and English for the others, matching the application's two supported
response languages. This evaluates seven input/source languages, not seven UI
locales. MLQA questions gain only their source article title because the original
task supplied a paragraph directly. The HotpotQA university case retains its
original label alongside a source-checked answer naming Aligarh Muslim University.

Answer review records three separate booleans. Correctness checks the answer's
meaning against the source-checked rubric, allowing translation and paraphrase.
Grounding requires the material claims to follow from the tool results actually
seen during that turn. Citation support additionally requires the attached
citations to support those claims. Missing-source success requires an explicit,
accurate statement of insufficient source evidence; correctly labeled outside
knowledge is allowed by the existing system prompt and is recorded separately.
An incomplete stream or empty/non-answer is a failure. Labeled source-span
coverage remains a separate automatic metric because another passage can supply
an equally valid proof. Every answer gets a Codex review, with no claim of an
independent or blinded human judge.
