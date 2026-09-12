# Qwen3.5-OCR on a digital mathematics paper, a Japanese deck and a textbook

September 12, 2026. First successful Qwen3.5-OCR runs after the September 9
Beijing entitlement failures ([receipts](2026-09-09-beijing-ocr.md)). A 19-page
arXiv paper on both request routes (41 requests, about USD 0.025), then two
files near Capy's 30 MiB upload limit: an 84-slide Japanese PPTX on both routes
(168 requests, USD 0.07) and the 610-page IB biology textbook on the
`document_parsing` route, stopped by the developer at 182 pages (USD 0.13).
Benchmark only; production parsing is unchanged.

The DashScope-native `document_parsing` task transcribes every display
equation and equation number on this paper, at a median 5.4 seconds per page
with no local CPU. The OpenAI-compatible chat route with Capy's RAG prompt
drops all display equations on three pages and every equation number on every
page, deterministically. Neither route returns bounding boxes or figure
descriptions, so this is a page-level text/formula transcriber, not a layout
parser replacement.

The messier files reverse part of that picture. On the slide deck and the
textbook, `document_parsing` uploads every figure-like region to an Alibaba
DocMind OSS bucket in Hangzhou and returns signed URLs with STS tokens inside
the text, and the text inside those regions is not transcribed. The chat route
keeps figure text but returns a one-line file description instead of the slide
on three agenda copies. Both routes clip or skip the simplest slide in the deck.

## Mathematics paper: input and method

- Source: `2604.03051v1.pdf`, 19 pages, digital text, no raster images, no
  tables, dense display mathematics on pages 2–17, references on 18–19.
  SHA-256 `bb4850028bb7a3cc7880014a78f9aaea1c399aafa661367f7276abc2ba5674dc`.
- Model: `qwen3.5-ocr` on a `cn-beijing.maas.aliyuncs.com` workspace. No
  thinking mode, no caching, 48k input / 16k output token limits. List price
  USD 0.069 per million input and 0.275 per million output tokens.
- Each page rendered with PyMuPDF to a 2560-pixel long edge JPEG (quality 80,
  1811×2560), sent as a data URL, concurrency four, `max_tokens` 16384, no
  retries.
- Arm `chat`: `/compatible-mode/v1/chat/completions` with the production
  RAG image prompt ("Describe this file from a study document so a student's
  search can find the information it carries…").
- Arm `docparse`: `/api/v1/services/aigc/multimodal-generation/generation`
  with `ocr_options.task = document_parsing`. This route accepts no custom
  prompt.
- Scoring compares OCR output with the PDF's embedded text after stripping
  LaTeX control words. Word recall and ordered similarity are diagnostics
  against PyMuPDF extraction, not human accuracy. PyMuPDF splits formulas into
  fragments such as `lim N→∞ E(|Λ(k)`, so on formula-heavy pages both arms
  score 0.6–0.85 even when their LaTeX is correct. Prose-only pages (1, 18,
  19) are the honest text-accuracy read.

Runner and scorer: [`bench_qwen_ocr_pdf.py`](../scripts/bench_qwen_ocr_pdf.py).

## Mathematics paper results

| | Chat route, RAG prompt | `document_parsing` |
| --- | ---: | ---: |
| Requests, all HTTP 200 and `finish_reason: stop` | 19 | 19 |
| Input tokens per page | 4,658 (4,562 image + 96 text) | 4,480 (image only) |
| Output tokens, 19 pages | 20,160 | 23,000 |
| Median seconds per page | 8.1 | 5.4 |
| Estimated cost, 19 pages | USD 0.0117 | USD 0.0122 |
| Word recall, prose-only pages 1/18/19 | 0.947 / 0.990 / 0.978 | 0.968 / 0.993 / 0.971 |
| Mean word recall, all pages | 0.739 | 0.805 |
| Display equations on pages 10, 11, 12 | 0 / 0 / 0 | 7 / 8 / 10 |
| Equation numbers retained, 96 in source | 0 | 96 |

Image tokens are a flat ~4.5k per page at this resolution regardless of
content; the 19-page paper costs about 85k input tokens either way.

### Chat route failures

Pages 10, 11 and 12 return the prose with every display equation removed:
`…for any k ∈ N,` followed directly by `where` and then `Proof.` A retry of
those three pages produced byte-identical output with identical token counts.
Replacing the RAG prompt with "Transcribe this page to Markdown. Write all
formulas in LaTeX." on page 10 also produced the identical 374-token answer.
The omission is the model's chat-route behavior on these pages, not a prompt
effect and not sampling noise. Adjacent pages 8, 9, 13 keep their display
math as LaTeX, so the failure is page-dependent and there is no signal in the
response that marks it.

Equation labels `(2.28)`, `(3.15)` and so on are absent from all 19 chat
outputs. A question such as "what does equation 2.28 state" cannot be answered
from that text. Inline delimiters also alternate between `$…$` and `\(…\)`
across pages.

### `document_parsing` accuracy

Equations (2.28) and (2.29) on page 10 were checked against the rendered page:
the limit, sum bounds, binomials and both two-factor fraction structures are
transcribed exactly. All 96 equation numbers appear on their own line after
the `$$` block. The output is Markdown with bold headings.

Prose is complete apart from hyphenation joins (`uncondition-ally`,
`inte-grable`) and one systematic clip: the last word before a display
equation is truncated twice in 19 pages, "merging is" → "mergir" (page 10) and
"which gives," → "which give" (page 6).

## Limits of this run

- No scans. The NIST accelerometer scan and the Hong Kong tables in
  [`java-new-documents-sources.json`](../fixtures/java-new-documents-sources.json)
  are the obvious next inputs. The deck's three description-only pages are the
  same shape as the Qwen3.8-Flash empty responses in the
  [September 8 report](2026-09-08-qwen-java-recovery.md): HTTP 200,
  `finish_reason: stop`, no usable content.
- No bounding boxes. Citations from this output can only be whole-page.
  Capy's chunker and citation UI expect region boxes from the parser
  ([agentic-retrieval](../../../openwiki/agentic-retrieval.md)).
- No figure descriptions. The model transcribes text; it does not caption.
  This paper has no figures, so figure behavior is untested.
- Single pass per page. Latency and the two clipped words are one observation
  each, not a rate.

## Larger files: direct upload limits

The OCR API accepts images and PDF only. PDF input goes through the Responses
API, not chat completions, with a 100 MB size limit and **50 pages** for
`document_parsing` (10 pages for other tasks). PPTX and other Office formats
are not accepted. Both larger files would therefore need splitting for direct
PDF upload (two chunks for the deck, thirteen for the textbook), and the PPTX
needs Capy's LibreOffice normalization first regardless. The per-page image
route used here has no page limit (20 MB and 15.68 megapixels per image), and
none of the 388 page requests across the three files was rejected.
[OCR API documentation](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen-vl-ocr).

The deck was converted with the same `soffice --headless --convert-to pdf`
call as [`parser/mineru_worker.py`](../../../parser/mineru_worker.py) in a
throwaway `debian:bookworm-slim` container with `libreoffice-impress`,
`fonts-dejavu-core`, `fonts-noto-core` and `fonts-noto-cjk`, matching the
parser image's packages: 84 pages, 960×540 pt, 7.9 MB from a 24.4 MB PPTX.

## Japanese slide deck, 84 pages

`jp_llm2.pptx`, a University of Tokyo LLM lecture deck: Japanese text boxes,
diagrams built from shapes, paper screenshots with English tables, and one
four-bullet agenda slide repeated eight times. Scoring is character recall
against the converted PDF's text layer (`score --cjk`); ordered similarity is
meaningless here because slide text order is arbitrary. Native slide text does
not include text inside pasted screenshots, so output longer than native is not
by itself an error.

| | Chat route, RAG prompt | `document_parsing` |
| --- | ---: | ---: |
| Requests, all HTTP 200 | 84 | 84 |
| Median seconds per page | 3.6 | 11.2 |
| Output tokens | 32,703 | 64,862 |
| Estimated cost | USD 0.031 | USD 0.039 |
| Mean character recall vs slide text | 0.926 | 0.843 |
| Pages with OSS image links | 0 | 48 |
| Pages returning a one-line description instead of the slide | 3 | 0 |

### `document_parsing` sends regions to DocMind and drops their text

Forty-eight deck pages contain Markdown image links of the form
`![<hash>.jpeg](http://docmind-api-cn-hangzhou.oss-cn-hangzhou.aliyuncs.com/…/publicDocStreamStructure/…?Expires=…&OSSAccessKeyId=STS.…&Signature=…&security-token=…)`.
The math paper produced none. Each link is a crop of the page that the service
stored in an OSS bucket in the Hangzhou region and signed with a temporary STS
credential. Three consequences:

- Page pixels leave the Beijing endpoint for a second Alibaba service and are
  retained there for at least the signed URL's lifetime. This is a data
  residency and retention question to settle before any production use.
- The output contains credentials. It cannot be indexed or shown without
  stripping the links; `score` strips them before counting.
- Link markup is 50% of the deck output by characters and 36% of the textbook
  output, so the `document_parsing` output-token cost is inflated by URLs.
- The text inside those regions is gone. Slide 17 is a three-box diagram whose
  labels (計算量, パラメータ数, データ and their explanations) are all in the
  slide's text layer; `document_parsing` returns one image link and the footer.
  The chat route transcribes all three boxes.

### Both routes fail the agenda slide

The agenda is four plain bullets in a large font on a white 16:9 slide, the
simplest content in the deck, repeated on pages 15/16, 22/23, 41/42 and 58/59.
`document_parsing` clips bullets two and four mid-line on every copy:
`-ルするための技術：パラメータ数 (N) に関連する耳` (leading スケー lost, 取り組み
misread as 耳) and `ケールするための技術：データ (D) に関連する取り`. The chat route
returns only `このファイルは「LLM 大規模言語モデル講座 講義資料」です。` ("this file is
the LLM lecture materials") on pages 16, 23 and 42, and prepends a
"このファイルは…" preamble on eleven pages despite the prompt, sometimes in
simplified Chinese (标题, 这些, 发挥). Neither failure has a marker in the
response; only comparison with the slide text reveals it.

### Screenshot tables

Slide 28 pastes the BigBird results table as a screenshot. The chat route
transcribes it as one value per line, flattened but numerically correct on
every visible cell checked against the render (84.4/90.3, 79.1/86.6, 84.5/92.4,
82.3). `document_parsing` returns an image link for the same region.

## Biology textbook, first 182 of 610 pages

`Biology_for_the_IB_Diploma.pdf`, the same 610-page textbook used in the
September 8 comparison (25.7 MB, 17,602 embedded images). Only the
`document_parsing` arm ran and it was stopped at 182 pages after about 50
minutes; the queued chat arm never started. Pages at 638×799 pt render to
2043×2560 and cost 5,040 image tokens each.

| | `document_parsing`, 182 pages |
| --- | ---: |
| Requests, all HTTP 200 | 182 |
| Median / mean seconds per page | 14.1 / 16.8 (max 95) |
| Tokens | 917,280 in, 240,501 out |
| Cost, and projected for 610 pages | USD 0.129, about USD 0.43 |
| Pages with OSS image links | 126 |

The rate is the reason it was stopped: at four concurrent requests the
textbook needs about 45 minutes per arm, against 12.5 minutes for MinerU's
four slice lanes on the ingest host. Throughput would need higher concurrency
than this run tested.

The frozen textbook probes from [`opendataloader-checks.json`](../fixtures/opendataloader-checks.json)
apply to seven source pages; only page 11 falls inside the completed range.
Its four probes pass (`probe` subcommand): the west/east tree-height table
comes back as an HTML table with `rowspan=8` on "Measurements", every
16/18, 12/20, 14/19, 13/10 pair intact, Total 120/120, Mean 15/15, and the
1.9 m / 5.0 m standard deviations in prose. This is the table that full-route
RapidOCR merged into `14 13 | 19 10` in the September 8 comparison. The seven
probes on pages 341–604 (hominid rows, enzyme, photosynthesis, index order)
remain untested.

## Read against the parser comparison

For text, formula and table transcription of digital pages, `document_parsing`
does what the September 9 ODL work could not do natively (display math,
equation labels, the measurement table) and what MinerU does at roughly 15
seconds of formula-model time per 26-page slice on the 8-CPU host, here at
5–14 seconds per page of provider time and no local memory. It fits the
page-level "route hard pages to a stronger model" option the earlier reports
left open, with the same unresolved problem of deciding which pages need it,
and two new ones: the DocMind upload has to be acceptable, and figure regions
lose their text. The chat route avoids both but silently returns descriptions
instead of content on some pages and cannot be told apart from a good answer
without the source text. Neither route is a drop-in for either parser on
mixed study material.

## Possible follow-up: a `capture_page` tool in the chat agent

Two of the gaps above, page-only citations and no captions, could be tested
from the other side. Instead of asking the parser to pre-produce boxes and
captions for every figure at ingest time, give the chat agent a
`capture_page(material, page, bbox?)` tool that renders the requested region
on demand and returns the pixels into the agentic loop. That would let the
agent:

- return a physical bounding box for a citation at answer time, by choosing
  the crop it actually read rather than inheriting a parser region;
- look at a figure or table directly when the question needs it, so the
  ingest pipeline could skip figure captioning for materials whose text
  transcription is already adequate.

Whether captions can be omitted is an empirical question: the September 8
Java recovery work showed captions add both useful graph relationships and
confident wrong statements. A `capture_page` experiment would measure whether
a vision-capable chat model reading pixels on demand answers the same 24
relational questions ([fixture](../fixtures/java-recovery-checks.json)) at
least as well as retrieval over pre-generated captions, and what it costs in
tokens and latency per answer. The ingest cost saved is bounded by the caption
counts recorded in the earlier reports (164 MinerU images versus 212 Java
whole pages on the 430-page corpus). This is a proposal, not a measured result.

## Artifacts

`reports/local/2026-09-12-qwen35-ocr/` holds the three source PDFs (the deck
as `jp_llm2.pdf` after LibreOffice), per-page JPEGs, native text, outputs and
`records.json` for `chat/`, `docparse/`, `jp-chat/`, `jp-docparse/` and the
partial `bio-docparse/` (records rebuilt from its log after the stop), the
byte-identical retry of paper pages 10–12 (`chat-retry-p10-12/`), the two
page-10 controls and `score.json`. The workspace API key appears in no
artifact; it was passed as an environment variable and is to be rotated. The
`document_parsing` outputs do contain the provider's own expiring STS tokens
inside OSS URLs.

```sh
export ALIBABA_API_KEY=…
uv run --with pymupdf==1.28.2 --with httpx --with pillow \
  python bench/parsers/scripts/bench_qwen_ocr_pdf.py run PAPER.pdf OUT/chat \
  --host https://WORKSPACE.cn-beijing.maas.aliyuncs.com --arm chat
uv run --with pymupdf==1.28.2 --with httpx --with pillow \
  python bench/parsers/scripts/bench_qwen_ocr_pdf.py run PAPER.pdf OUT/docparse \
  --host https://WORKSPACE.cn-beijing.maas.aliyuncs.com --arm docparse
uv run --with pymupdf==1.28.2 python bench/parsers/scripts/bench_qwen_ocr_pdf.py score OUT/chat OUT/docparse
uv run python bench/parsers/scripts/bench_qwen_ocr_pdf.py score OUT/jp-chat OUT/jp-docparse --cjk
uv run python bench/parsers/scripts/bench_qwen_ocr_pdf.py probe OUT/bio-docparse \
  --checks bench/parsers/fixtures/opendataloader-checks.json --mapping Biology_for_the_IB_Diploma
```
