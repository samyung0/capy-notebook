# Local question-bank builder

No model calls, uploads or database writes happen on import or during `check`.
Each stage below is explicit. Question data stays under ignored
`data/question-bank`; private references never enter writer or solver input.

Round 2 (2026-10-02) replaces the per-topic `references` and `style` stages
with one private writer guide per exam, built from analyses of real papers
(`data/question-bank/style/`, `data/question-bank/analysis/`). Each topic's
`style.md` is a copy of its exam's guide, and `references/` holds copies of the
exam's private reference texts for the copy check. See
`question-bank-round-2-plan.md`.

IELTS passages are adapted to the difficulty of real Cambridge passages.
`readability.py check <passage.txt>` (run with
`uv run --no-project --with wordfreq`) reports mean sentence length, the share
of sentences over 35 words and the share of uncommon words (Zipf below 3), lists
those words and sentences, and fails above the 75th percentile of the 24
Cambridge IELTS 19 and 20 passages. `readability.py calibrate` rebuilds that band
from the private book texts.

Before a pilot, supply an official syllabus and a topic directory containing
`topic.json`. This contains `exam`, `subject`, and `topic` objects, each with
`id`, `label`, and integer `position`; `topic` also needs a verified
`syllabus_reference` URL. Verified HKDSE Mathematics Compulsory and IELTS Academic Reading catalogs
are in `syllabi/`. Preserve a distinct directory for each generation run.

The pilot uses fresh Claude Code Opus 5.5 subagents at medium reasoning effort,
as selected by Epo; each agent owns one topic per stage. Earlier GPT-6 Astra
packets remain as audit records. The stage driver makes no model API or Claude
CLI calls.
Each stage prepares frozen `input.json`, `schema.json`, and `prompt.md` files
under a content-hashed receipt directory, then exits pending until the assigned
subagent writes `output.json`. Dispatch with no conversation history. The writer
reads only its frozen packet; the solver reads only its learner packet. Only the
references stage may browse for source material. Other stages may use file tools
to read their packet and save output, without reading other run directories.
Solver and judge packets include `learner.png`, a local screenshot of the entire
question rendered by `QuestionView` without review. View this image offline;
graph/image blocks in the learner JSON refer to their figure in that screenshot,
with description and dimensions but no graph recipe, SVG or public asset URL.
Answers, marking schemes and worked solutions are excluded from the solver
projection. Ordering choices use the same stable permutation in JSON and PNG.
The judge receives its explicitly supplied scheme and model answer separately.

After dispatch, bind the returned subagent task identity:

```sh
uv run --project pipeline python lab/questions/run.py bind <receipt-dir> --agent-id <agent-task-name>
```

Run the original stage command again to validate and admit its output. Missing
solve/judge/fix outputs prepare all needed packets in one pass; a pending fix
never partly rewrites questions. Completed packet outputs are immutable. Invalid
outputs fail explicitly; there are no automatic retries or repair calls. Receipts
record the requested model, effort, agent identity and all hashes. Token usage
is explicitly unavailable because the subagent tool does not expose it.
The learner PNG hash is frozen in both input and receipt. Binding and admission
reject a missing or modified image, including old packets without image evidence.
Preserve unused older packets; rendering and solving again creates new packets.

From the repository root, replacing `<topic>` with the local directory:

```sh
uv run --project pipeline python lab/questions/run.py check
uv run --project pipeline python lab/questions/run.py references <topic>
uv run --project pipeline python lab/questions/run.py style <topic>
uv run --project pipeline python lab/questions/run.py write <topic> --count 50
# or, for reading comprehension on library passages listed in <topic>/passages.json:
uv run --project pipeline python lab/questions/run.py passage <topic>
pnpm exec tsx lab/questions/render.ts <topic> [question-id ...]
# From server/: go run ./cmd/bank validate <absolute-topic-directory>
uv run --project pipeline python lab/questions/run.py solve <topic>
uv run --project pipeline python lab/questions/run.py compare <topic>
uv run --project pipeline python lab/questions/run.py fix <topic>
# After a fix: render, validate, solve and compare again.
uv run --project pipeline python lab/questions/run.py copycheck <topic>
uv run --project pipeline python lab/questions/run.py prepare-publish <topic>
```

`references` downloads the returned HTTPS references once, capped at 20 MiB each,
and extracts PDF text with the existing PyMuPDF dependency. Scanned references
need an independently checked UTF-8 `.txt` extraction beside the private PDF.
References can instead be supplied manually with `references/sources.json`.
Review `style.md` before `write`, since clean-room isolation cannot certify that
style notes contain no copied passage. The author gets only topic metadata,
style notes and the output contract; the solver receives the learner projection.

Closed comparison is exact against the author's accepted representation, allowing
case and outside whitespace for text blanks. It performs no numerical or unit
conversion. A disagreement can be a defective question or a solver error and must
be inspected. Open comparison uses a separate judge packet,
with the current overall 0/0.5/1 part award. It does not install production Jev.

Every packet saves frozen input/schema/prompt hashes before dispatch, then
validated structured output and an admission receipt. Failed outputs are never
silently admitted. Fix keeps IDs and part count, invalidates
the old evidence, and requires solving/comparing again. Rendered graph changes
also require fresh matching evidence when the question JSON changes. Running
render before solve avoids that extra pass for initial graph exports.
The renderer saves both `<id>.png` for review and `<id>.learner.png` for solving.
`render/manifest.json` retains the question hashes used for publication;
`render/learner-manifest.json` binds each learner image to its question hash.
Unchanged question JSON is not rewritten on rerenders. Solve and judge refuse
stale learner renders. Only the learner PNG is copied into their frozen packets.
After a fix, pass the repaired question ids to the renderer: it re-renders only
those and merges them into both manifests, so the other questions keep their
blind evidence. A whole-topic rerender changes every learner PNG whenever the
components have changed, and every question then needs a fresh blind solve.

`passage` writes one full IELTS passage question per entry of `passages.json`.
Each entry names its `section` pattern (1, 2 or 3) and is either a library
excerpt (`kind: "library"`, `excerptId`, `bookId`, `version`, book, licence and
exact library text) or an openly licensed web page (`kind: "web"`, `url`,
`title`, `authors`, `publisher`, `license`, `licenseUrl`, `retrievedAt`, the
licence evidence and the exact text). `topic.json`'s subject must carry the
syllabus `question_types`. The writer may lightly adapt the passage but adds no
facts. Admission records each question's `sources.json` entry from its packet's
passage, never from the writer, and its task types in `question-types.json`,
which `prepare-publish` carries into `publish.json` as `questionTypes`.

Copy checking flags every shared 12-word run against extracted references.
`prepare-publish` rejects missing/stale evidence, drops unresolved disagreements
or overlaps into its log, and writes `publish.json` without sending anything.
The prepared questions still require the authoritative Go bank validator. For
library-sourced material, `sources.json` maps question IDs to arrays of
`{excerptId, bookId, version}` references (`passage` writes it). The publisher validates those records
and resolves each historical excerpt through `LIBRARY_DATABASE_URL` before any
upload; synthetic pilot questions carry an explicit empty array.

Publication is a separate explicit command from `server/`:

```sh
go run ./cmd/bank migrate
go run ./cmd/bank validate <absolute-topic-directory>
go run ./cmd/bank publish <absolute-topic-directory>
go run ./cmd/bank status
```

Configure `BANK_OWNER_DATABASE_URL` through the documented tunnel,
`BANK_ASSETS_URL`, and `BANK_PUBLIC_B2_*` / `BANK_PRIVATE_B2_*` values in
`.env.local`. Owner publication inserts new IDs and never overwrites existing
questions. Public assets use content hashes; references, style notes and receipts
go only to the private bucket. Run IDs must be unique. The tool does not provision tunnels, credentials or
buckets itself. Catalogs
under `syllabi/` record the verified pilot scope; live run state stays in `data/`.
