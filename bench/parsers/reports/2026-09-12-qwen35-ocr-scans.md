# Qwen3.5-OCR on scanned pages

September 12, 2026, following the [digital-math report](2026-09-12-qwen35-ocr-digital-math.md)
with the scans that report left untested: the two synthetic scan fixtures and
the two NIST papers from the September 9 agentic corpus (OCR'd scans with a
hidden text layer). Same runner, same 2560-pixel renders, both routes.

## Synthetic fixtures

`newspaper_scan.pdf` (2 pages, no text layer) and `lecture_plus_scan.pdf`
(40 repeated digital deck pages plus the same two scans). Both routes read
the canary strings and headlines on all four scan pages and the deck canary
on every digital page. The pages repeat one body sentence, so they show only
that a scan is read at all: the chat route once doubled a word ("voted
voted"), `document_parsing` merged the repeated sentences with a stray
apostrophe between them. Scan pages cost 15–16 s on the chat route and
11 s on `document_parsing`; the trivial deck pages 3 s and 10 s.

## NIST papers

| | accelerometers, 11 pages | shot classifier, 8 pages |
| --- | --- | --- |
| `document_parsing` seconds per page, median (range) | 19 (4–35) | 20 (5–27) |
| `document_parsing` output tokens | 17,597 | 15,826 |
| chat route seconds per page, median (range) | 8 (4–13) | 10 (8–40) |
| chat route pages ending in `finish_reason: repeated` | 1 of 11 | 1 of 8 |

`document_parsing` transcribes the equations the September 9 agent needed
(accelerometers page 3: equation (1) `a = 14.2 g (S/1000)^r D` and equation (3)
in LaTeX with their numbers), the "30 c/s" values, and the ten data rows of
shot-classifier Table 2 with the right column structure (`rowspan` headers).
It drops the first-column cells of that table's three summary rows: the
`Average`, `Standard deviation` and `Coefficient of variation (%)` rows come
back with six cells for seven columns, so the mean 1.267, the deviation
0.0033 and the 0.3 % that question `odl-agentic-054` asks for are simply
absent, and a reader aligning the rows would attach the wrong values. The
page image shows them clearly.

The chat route fails harder on the same page: after the Table 2 header it
enters a repetition loop and returns 15,087 characters ending in repeated CJK
glyphs. The accelerometers paper has the same failure on one page. Nothing in
the response marks either failure apart from `finish_reason`.

## Read against the recovery question

For a scan, `document_parsing` is a usable page-level transcriber for prose,
equations and regular table bodies, at 10–35 s per page and no local CPU. It
cannot be trusted alone for the summary cells of a ruled table, and the chat
route is not usable for scans at all. Where the question is one cell,
handing the rendered crop to a vision chat model did better in the
[playground runs](../../rag/reports/2026-09-12-capture-page-playground.md):
GLM-5.3-flash read the three dropped cells correctly, DeepSeek did not.

Artifacts: `reports/local/2026-09-12-qwen35-ocr/{newspaper_scan,lecture_plus_scan,nist-accelerometers,nist-shot}-{chat,docparse}/`.
