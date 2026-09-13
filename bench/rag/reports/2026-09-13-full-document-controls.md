# Real-document locator controls

The follow-up experiments use conversation context and explicit source references.
The user rejected an active-file hint, so UI state is absent from these controls.
No runtime behavior changes in this benchmark round.

The [fixture](../fixtures/full-document-controls.json) supplies eight complete
PDFs as one mixed-language candidate pool: English, Japanese, Korean, Simplified
Chinese, Taiwan Chinese, Hong Kong Chinese, Spanish and French. It has 15
positive locator cases and 13 cases where a single-locator promotion should
abstain. Source IDs, locator numbers, pages and anchors in `expected` are labels,
never retrieval inputs. Positive queries name an exact filename in user text;
this tests explicit source resolution and does not test anaphora understanding.

The controls are agent-authored from source-page inspection before the new
candidate scores were computed. Seven sources were used in earlier parser work.
The Korean source is a newly downloaded 11-page paper from the institutional
[ETRI journal](https://ettrends.etri.re.kr/ettrends/204/0905204001/001-011.%20%EC%A0%84%EC%9B%90_204%ED%98%B8.pdf).
These are neither natural user queries nor unseen validation across source
families. Each locale has one source, so counts do not estimate language-wide
quality. PDFs and rendered inspection pages remain in ignored local directories.

The cases distinguish typed locators from percentages, dates, durations, dataset
identifiers and question counts. They also include repeated subsection numbers,
Roman numbering, missing sources, multiple requested sources or units, and
training-phase labels that are semantic content. A bare Japanese question marker
tests the limit of assuming that every numbered list is a question.

Printed and physical pages are separate labels. Hong Kong printed page 6 is
physical page 7. The Taiwan control explicitly requests PDF page 14, which has
no printed page number. The Hong Kong table caption also has a duplicated glyph
in its text layer; its visible label and raw glyph string are both retained,
without treating text repair as part of retrieval normalization.

The [source checker](../scripts/full_document_controls_check.py) verifies every
PDF hash and all 15 target page anchors with NFKC and whitespace normalization.
Its raw-glyph check is explicit. The checker does not validate negative-query
semantics, resolve a locator, or measure answer accuracy. Positive labels identify
the requested unit's opening or caption, not all evidence needed to answer a
question about that unit.

```sh
uv run python bench/rag/scripts/full_document_controls_check.py
```

The input fixture SHA-256 is
`5138e7255ea97c4d19c818b52437481773326fcafa94a86465a95aceee8312ff`.
Both experiment workers freeze this hash before scoring; candidate extraction
and ranking results belong in their separate reports.
