# Prince textbook heading experiment

Date: 2026-09-20. Local benchmark only. No parser, chunker, library, deployment,
or human-decision changes. This tests A1 and A2 from
[the parser handoff](../../../artifacts/2026-09-20-parser-handoff.md).

The combined candidate removes physics's repeated footer from 477 chunk paths
and removes `Contents` / `PREFACE` from all 3,033 affected chunks starting at the
first chapter or later. It preserves all 225 source-matched outline headings
and all 6,089 previously covered body-text blocks. Correcting the actual outline
roots is preferable to demoting front-matter names, which instead leaves a cover
advertisement parenting the book.

## What was measured

The baseline is the cached raw `parsed/content_list.json`, its frozen furniture,
and the current production `pack_blocks` followed by `retain_headings`. The
physics builder's corrected `corpus.json` is never read. Control corpora supply
only source-file metadata; their chunk arrays are replaced by fresh packing of
their raw blocks. The six source PDFs total 3,081 pages.

Physics's cached parser identity is
`odl-2.5.7-refined-rapidocr-v4+b3fa048946997fb598ed024fd4c2675b6d2e7139`.
The measured chunker is `v10`. The parser and chunker identities remain unchanged.
No Java reparse, model call, embedding, database write, or remote job ran.

The five controls are the complete cached final outputs from the
[September 16 shared fix](2026-09-16-odl-shared-fix.md). This is a new heading
comparison on those outputs, not a fresh validation of the Java parser or an
independent new textbook sample.

## Candidate rules

1. Extend the current source-backed banner test to headings without a folio.
   The whole block must match native source spans inside its box. Require the
   existing narrow top/bottom margin, identical normalized text, matching font,
   size and vertical band, and at least three distinct pages. Protect PDF-outline
   title matches. Mark the supported banner `discarded`, preserving its text and
   box in the block. This finds exactly 434 physics footer blocks on 434 pages.
2. Set source-confirmed PDF-outline roots to level 1. Preserve their text and
   heading role. Physics's outline already gives `Contents`, `Preface`, each
   chapter, the appendix and the index equal rank; ODL gives them visual ranks
   1, 3, 5, 3 and 3. The stack correctly follows those incorrect numeric ranks.
   There is no need for an English front-matter-name rule.

The root match must cover every root before this experiment changes any root
level in a document. Partial promotion caused a regression in the initial arm:
unmatched chapters became children of the newly promoted preceding chapter.
The initial summary and witnesses remain in the local receipts.

Physics requires two small matching cases. Chapter 3's `Acceleration` and Chapter
17's `Diffraction and Interference` also appear as sections on their opening
pages. Exact title matching, followed when needed by a direct PDF GoTo destination,
selects the chapter heading. An ambiguous destination match must be unique within
6.5% of page height. Named destinations do not use this coordinate rule. The
appendix's full outline title matches two adjacent literal heading blocks,
`APPENDIX A` and `Reference Tables`; the first becomes the root. All 27 physics
roots match, and 26 levels change. Rendered source pages 13, 17, 18, 109, 553 and
845 were visually checked.

## Physics results

| Arm | Chunks | Footer in path | Contents/Preface after first chapter | Canonical chunk strings removed / added |
| --- | ---: | ---: | ---: | ---: |
| Current baseline | 3,106 | 477 | 3,033 | 0 / 0 |
| Footer only | 2,934 | 0 | 2,864 | 490 / 318 |
| Outline roots only | 3,106 | 477 | 1 | 0 / 0 |
| Footer + outline roots | 2,934 | 0 | 0 | 490 / 318 |
| Footer + all matched outline levels | 2,920 | 0 | 0 | 504 / 318 |
| Footer + demote Contents/Preface | 2,933 | 0 | 0 | 493 / 320 |

The combined arm keeps 2,616 complete canonical chunk strings unchanged. Removing
false heading boundaries joins text into fewer chunks. No non-heading block
payload changes, and none of the 6,089 source-box-bound body-text matches in the
baseline disappear. The remaining 182 of 6,271 body-text blocks did not pass that
literal retention proxy in either arm; this experiment does not claim to fix or
classify them. Root correction alone preserves the entire canonical text sequence.

All 225 matched outline headings remain headings and remain readable in chunks
citing their own page. The complete PDF has 263 outline entries; the other 38
were not source-matched and are outside that retention claim. `Contents` and
`PREFACE` remain readable on their own pages. Stale prior outline roots in later
root sections fall from 3,046 chunk paths to zero.

| Source page | Combined candidate path examples |
| --- | --- |
| 17 | `What is Physics? › 1.1 Physics: Definitions and Applications` |
| 109 | `Acceleration › 3.1 Acceleration` |
| 553 | `Diffraction and Interference › 17.1 Understanding Diffraction and Interference` |
| 845 | `APPENDIX A › Reference Tables` |

Demoting only `Contents` and `PREFACE` removes those words from the metric while
leaving `Study where you want, what you want, when you want.` as an ancestor in
2,901 chunk paths. It also removes heading status from two genuine outline
headings. Reject this arm.

Mapping every matched outline level also removes the two reported defects, but
changes 14 additional canonical chunk strings without improving A1/A2. The
root-only rule is the narrower candidate; this run does not establish all nested
outline levels as the correct replacement for ODL's other heading levels.

## Textbook controls

| Book | Roots matched | Baseline → combined chunks | Original canonical strings lost | Added strings | Body matches lost |
| --- | ---: | ---: | ---: | ---: | ---: |
| OpenIntro Statistics | 12/12 | 1,255 → 1,263 | 0 | 8 | 0 |
| Advanced High School Statistics | 9/9 | 1,334 → 1,339 | 0 | 5 | 0 |
| Learning Statistics with jamovi | 5/11, abstain | 1,090 → 1,090 | 0 | 0 | 0 |
| Exo7 Analyse | 1/11, abstain | 426 → 426 | 0 | 0 | 0 |
| Hefferon Linear Algebra | 6/6 | 1,012 → 1,012 | 0 | 0 | 0 |

The footer rule alone produces identical complete chunk records on all five
controls. The combined arm also leaves LSJ and Exo7 completely unchanged because
root matching is incomplete. All 607 matched control outline headings retain
their role and page-visible text; no non-heading block payload changes.

The two OpenIntro controls contain appendix roots beneath the final chapter.
Correcting their roots removes stale ancestors from 136 and 116 paths. Existing
heading retention then exposes eight and five standalone `Chapter N` headings;
these are the only new canonical strings. Hefferon's corrected roots remove the
cover title `LINEAR ALGEBRA` from 970 paths, with no canonical text changes.

## Limits and next implementation boundary

- One mixed front-matter chunk still spans pages 15–17 under `PREFACE` and ends
  with the standalone body block `CHAPTER 1`. The actual chapter title and chapter
  prose get their correct root. The zero front-matter number above explicitly
  counts chunks **starting** on page 17 or later. Moving separate chapter-number
  prefix blocks to their title would be another source-boundary adjustment.
- This is a replay on fully refined cached blocks. A production change belongs
  in shared parsing before furniture freezing/table recovery and needs a fresh
  end-to-end parse before adoption. This run does not prove stage-order equivalence.
- The complete-root guard deliberately abstains on missing, ambiguous or
  unrecognized outline roots. No-outline books receive only the banner candidate.
  The coordinate window and two-block matching are measured here, not proven
  across arbitrary PDF producers.
- Body retention compares normalized literal text only against chunks carrying
  the same block's page and box. It is not a printed-page fidelity or math score.
  Tables, image captions and lists keep their raw payloads, but are not included
  in that body-text proxy. Existing reading-order, nested-heading and math losses
  remain. No retrieval-quality or confidence improvement is established.
- Production adoption would require its own parser identity bump and artifact
  invalidation. This experiment changes neither identity nor deployment.

## Reproduction and hashes

From the repository root, using the existing local PDFs and cached bundles:

```powershell
uv run --frozen python bench/parsers/scripts/experiment_prince_headings.py --self-check
uv run --frozen python bench/parsers/scripts/experiment_prince_headings.py
uv run --frozen --with ruff ruff check --no-force-exclude bench/parsers/scripts/experiment_prince_headings.py
```

`--book physics` reruns only physics. The self-check covers the repetition
threshold, source-evidence abstention, outline protection, sibling roots,
incomplete-root abstention, duplicate/split titles and body retention. It passed.
Ruff passed. Six-book retention assertions and all measured code hashes passed.

Full inputs, parser identities, code SHA-256 values and metrics are in
`bench/parsers/reports/local/2026-09-20-prince-headings/summary.json`.
Each book has `evidence.json`, `metrics.json`, and freshly generated chunk records
for each arm. `verification.json` records the final checks. These local artifacts
are ignored by Git.

Principal input SHA-256 values:

```text
physics PDF: a3f75487411ef13d0270c65fc801ceff2b28e6b339afed9b407fe477f7e8453e
raw physics blocks: a99e0056d5cdab1109871012686d90782f24bd3babba2423f4c3bdd3b1d52d5b
physics frozen refinement: a1d762f6ba620fefee97e12999de73402b3eb39a47906ea32e1369370ac31449
```

The report's recommended implementation scope is the folio-less banner extension
plus complete, source-confirmed outline-root correction. Keep front matter
readable and preserve its real heading roles.
