# CPU parser bench — can the `fast` route leave the GPU?

Yo. This little dojo exists to answer one question with numbers instead of vibes:

> If we drop MinerU-on-Modal for the `fast` parse route and run a parser on plain
> CPU, how many pages per second per vCPU do we get, and how much of our
> `content_list` survives?

It benchmarks **Marker v2** and **Docling** against the contract that
`retrieval/chunking.py` and `parse/figures.py` already depend on, with
**MinerU-on-CPU as the control** so every number has something to beat.
`run_bench.py` is the historical backend comparison and does not score accuracy.

The Netcup cutover uses `accuracy_report.py`. It calls the production VM endpoint
in all three modes, renders source pages, overlays returned bounding boxes,
places extracted text beside each page, checks trusted native text and explicit
visual canaries, and runs the agreed 1/2/4/6/8 concurrency sweep:

```sh
python accuracy_report.py \
  --url http://10.77.0.2:8090/file_parse \
  --docs docs \
  --canaries canaries.example.json \
  --sweep 1,2,4,6,8 \
  --out out/netcup
```

It writes `report.html` for visual review and `report.json` for the decision
record. A mode is rejected if it loses most of a healthy native-text page,
misses a required canary, drops too many bounding boxes, duplicates large
amounts of text, degrades a native table, or makes all-page OCR substantially
slower without meaningful recovery. Smaller OCR inaccuracies remain visible in
the side-by-side report and do not automatically reject a mode.

`build_office_fixtures.py docs` creates the deterministic DOCX, PPTX, and XLSX
canaries used by the VM smoke run. The measured Netcup decision record is
[`netcup-2026-08-28.md`](netcup-2026-08-28.md): generous selective OCR won;
all-page OCR was rejected on native and mixed documents because it recovered no
additional text while taking 84–127% longer.

## Read this before you trust a number

**The Marker release notes are narrower than they sound.** The claim is:

- `balanced` — 76.0 olmOCR-bench, **needs a GPU**
- `fast` — 66.6, still makes "minimal, surgical VLM use" (so still wants the
  surya inference server)
- `fast --disable_ocr` — 43.6 overall / 55.8 digital-only, and this is the _only_
  mode the notes describe as needing "no GPU and no inference server"

So "100% CPU" and "good results" are two different modes. Fully CPU with no
server is the 43.6 tier. Whether `fast` degrades gracefully on CPU or just runs
the VLM slowly is exactly what the `marker-fast` backend here is for.

**Their 23.7 pg/s no-OCR figure was measured on the host of a B200 box** — a
many-core server CPU. Divide by the core ratio before comparing it to a 4-vCPU
VM. Measured here: 1.10 pg/s warm on four cores, ~21× off. That is why this
harness reports `pg/s/cpu` as the headline number.

**Unlimited-OCR is not in here on purpose.** It needs vLLM/SGLang with the fa3
attention backend and decodes up to 32k tokens per document. It is a GPU VLM. If
you want it evaluated, it belongs in a GPU VLM comparison. The old Modal
`accurate` (MinerU hybrid VLM) route is gone.

## Results — mixed corpus, 4 vCPU, 42 pages

marker-pdf 2.0.0, docling 2.120.3, mineru 3.4.4, torch 2.13.0+cpu. Five
documents capped to 10 pages each: two arXiv papers, a dense textbook chapter, a
figure-heavy lecture deck, and a 2-page scanned newspaper. **MinerU runs the same
`pipeline` backend as production, just with `MINERU_DEVICE_MODE=cpu`** — it is
the control, not a candidate.

Model load is measured separately on a blank page and excluded, so `pg/s` is the
marginal rate a warm worker sustains. Startup is listed beside it because Marker
pays it per process. **Each backend was run in its own container** — see the
warning below, this matters more than it sounds.

| Backend                            | warm pg/s | per vCPU  | vs MinerU | startup | Depth | Eq  | Scan      |
| ---------------------------------- | --------- | --------- | --------- | ------- | ----- | --- | --------- |
| marker `fast --disable_ocr`        | **1.10**  | **0.275** | **13.5×** | 17.2s   | **4** | 7   | ✗ nothing |
| docling + TableFormer              | 0.39      | 0.097     | 4.8×      | 6.1s    | 1     | 0   | ✗ nothing |
| **marker no-OCR + routed RapidOCR** | **0.27**  | **0.066** | **3.4×**  | 18.3s   | **4** | 7   | **✓**     |
| docling + full-page OCR            | 0.14      | 0.036     | 1.8×      | 8.0s    | 1     | 0   | ✓         |
| mineru `pipeline` (CPU, control)   | 0.08      | 0.020     | 1.0×      | 52.5s   | 2     | 8   | ✓         |
| marker `fast` (CPU VLM)            | —         | —         | —         | 135.6s  | 4     | 5   | 0 @ 1500s |

The bolded hybrid row is the recommendation, composed from separately measured
parts rather than run as one backend — see "The answer for scans" below. It is
the only row that recovers scan text *and* keeps heading depth 4 and equations.

**On born-digital pages the CPU box beats your GPU.** marker no-OCR does
metabolic_pathway at 1.31 pg/s on 4 cores; the Modal GPU container does the same
10 pages at 0.85 pg/s. MinerU runs layout, OCR and formula models over every page
while marker skips OCR entirely, so the GPU loses a straight race on exactly the
document class you care most about.

Every backend hit 100% bbox coverage, so `normalize.py` works for all three.

**Marker no-OCR is ~13× faster than MinerU-on-CPU and loses nothing on
born-digital pages.** Stripped of markup, the two extract the same text: 91k vs
89k characters across the four born-digital documents. Marker also returns 4
heading levels to MinerU's 2. On this corpus it is not a downgrade — it is
faster *and* structurally richer.

**`--disable_ocr` returns literally zero characters on the scan.** 19 blocks, no
text, no error, 23.6s burned. MinerU pulled 28,557 characters off the same two
pages. A CPU route must detect a missing text layer up front and send those
documents elsewhere, because this failure is otherwise completely silent.

**Marker `fast` (the 66.6 tier) is dead on CPU.** 133s just to start, 79s for 10
clean pages, then it blew past a 600s budget on the textbook and got killed —
same result when re-run in isolation, so this is not a measurement artifact. It
is not GPU-locked either: it serves the surya VLM through **llama.cpp**, and
hard-fails with `SpawnError: llama-server binary not found` when the binary is
missing (the Dockerfile installs it). But "runs" and "usable" are different
claims. On born-digital pages it returns *identical* structure to
`--disable_ocr` at 11× the cost, so its block-OCR only earns its keep when the
text layer is garbled.

### Why marker's OCR is unusable on CPU — the actual mechanism

Worth writing down, because "OCR doesn't work" is the wrong mental model. It
works fine. It is just not an OCR engine any more.

Marker v2 dropped surya's old detect-plus-recognize CNN pair. Surya 2 is one
**Qwen-VL** checkpoint, and `surya/inference/__init__.py` routes by device:
NVIDIA GPU → vLLM, **everything else → `llamacpp`**. On CPU it spawns the
`llama-server` binary against `surya-2.gguf` + `surya-2-mmproj.gguf`, so every
OCR'd region is a token-by-token generation. From
`~/.cache/datalab/surya/llamacpp_server.log` on a 4-vCPU box:

```
init: llama threadpool init, n_threads = 8          # oversubscribes --cpus=4
load_model: initializing, n_slots = 8, n_ctx_slot = 12288
slot print_timing: id 6 | n_gen = 2138, tg = 6.14 t/s
```

**6.14 tokens/sec**, and on newspaper page 1 a single slot sailed past **2,141
generated tokens** and kept going — a runaway generation heading for the
12,288-token context wall. Only 2 of 8 slots were ever busy, so slot parallelism
does not rescue it.

Run alone against nothing but the 2-page scan, with a 1500s budget and all four
cores to itself, the recorded result is:

```
marker-fast  model_load_s 135.6
  newspaper-scan-sample.pdf  2 pages  1500.21s  "timed out after 1500s"
  blocks 0   chars 0   bbox_coverage 0.0
```

**25 minutes, four cores, two pages, zero characters.** RapidOCR does the same
two pages in 75.8s with 28,496 characters. That is the whole argument.

Two more details that kill the workarounds before you try them:

- It warns `Qwen-VL models require at minimum 1024 image tokens to function
  correctly on grounding tasks`, so dropping render DPI to go faster degrades
  the bboxes you need for citations.
- `LLAMA_CPP_EXTRA_ARGS` exists and forwards to `llama-server`, so you *can*
  pass `--threads 4` to stop the oversubscription. It buys a few percent, not
  the 40× you need.

`surya.detection.DetectionPredictor` and `surya.recognition.RecognitionPredictor`
do still exist in surya 0.22.1, so a classic path is technically reachable — but
it is torch-on-CPU, and marker's fast mode does not wire it up. Reimplementing
that plumbing to land slower than an off-the-shelf ONNX engine is not a good
trade.

### The answer for scans: route per page, then hand off to RapidOCR

Detecting which pages need OCR is nearly free. A `pypdfium2` per-page character
count costs **17.2 ms/page** — about 2% of the ~0.9 s/page parse it protects.
On the real set:

| Document                      | Pages | Pages with no text layer | Note                              |
| ----------------------------- | ----- | ------------------------ | --------------------------------- |
| attention-is-all-you-need.pdf | 10    | none                     | born-digital                      |
| etextbook.pdf                 | 10    | 0, 1, 8                  | scanned cover + interleaves       |
| metabolic_pathway.pdf         | 10    | 0, 1, 5, 6               | **every** page is thin, 10-363 ch |
| newspaper-scan-sample.pdf     | 2     | 0, 1                     | fully scanned                     |
| resnet.pdf                    | 10    | none                     | born-digital                      |

RapidOCR (PP-OCRv6-small, onnxruntime) on those flagged pages, 4 vCPU:

| Page                     | Rendered size | Time  | Lines | Chars  | Mean conf |
| ------------------------ | ------------- | ----- | ----- | ------ | --------- |
| newspaper p0             | 2857×4296     | 42.0s | 483   | 15,778 | 0.990     |
| newspaper p1             | 2857×4296     | 33.8s | 320   | 12,718 | 0.989     |
| metabolic p5             | 2200×1700     | 11.1s | 161   | 942    | 0.947     |
| metabolic p0             | 2200×1700     | 7.4s  | 61    | 359    | 0.953     |
| etextbook p0             | 1367×1967     | 5.0s  | 9     | 101    | 0.993     |

Model load is **1.1s** — three small ONNX graphs, not a 4-bit LLM. Same
newspaper page marker never finished: RapidOCR does it in 42s at 0.990 mean line
confidence. Budget by rendered pixels, not page count; the spread is 3s to 42s.

**Composed hybrid: 0.27 pg/s warm** (38.2s marker + 119.5s RapidOCR on the 9
flagged pages + 0.7s routing = 158.4s / 42 pages), recovering **123,573
characters** — more than any single backend measured here, while keeping heading
depth 4 and equations. That is **3.4× MinerU-on-CPU**.

**Your lecture decks are the hard case, not the newspaper.** metabolic_pathway's
entire 10-page text layer is ~1,900 characters. RapidOCR pulled 2,114 characters
from just 4 of those pages — more than the whole text layer. For slide decks OCR
is the primary text source, not a fallback, and a flat "zero characters" trigger
misses pages sitting at 146-363 chars. Use characters-per-page-area, or lean on
`surya.ocr_error` — a purpose-built cheap classifier for "is this text layer
broken" that ships in the surya already installed.

**Docling is a real option, just a worse one.** It is 4.8× MinerU with tables
on, and unlike Marker's no-OCR mode it can be pushed to handle scans while still
beating MinerU by 1.8×. What it will not give you is structure: heading depth 1
on papers that plainly nest, and zero equation blocks. Its full-page OCR also
gains nothing on the lecture deck (1,330 chars vs 1,305 without) because OCR
output still gets filtered through layout clusters, so text outside a recognised
cluster is dropped twice over.

**Cost multipliers, measured:** Docling full-page OCR over TableFormer 2.7×,
Marker CPU-VLM block OCR over no-OCR 11×.

### ⚠ Run one backend per container

The first pass ran four backends in one container and produced numbers that were
wrong by up to **5×**. Docling came out at 0.08 pg/s; run alone it is 0.39. The
same 2-page scan took 15.6s in the shared run and 3.5s alone, on byte-identical
input. The container was sitting at 10.3 GiB on a 15.6 GiB host by the time the
later backends ran, and everything after the first backend was paying for it.

Backends that ran first (`marker-fast-noocr`, `marker-fast`) were unaffected,
which is exactly what makes this dangerous: the contamination is ordered, so it
looks like a clean ranking. Anything that runs late looks slow. If you add a
backend, give it its own `docker run`.

### The incumbent is mangling the most representative document

Structure and text are unaffected by the contamination above — only timings
were — so these output comparisons stand.


MinerU looks like it wins on the lecture deck — 5,134 characters against
Marker's 1,464. It does not. **40 of its 68 blocks are polluted with spurious
`<sub>`/`<sup>` markup**, and stripping the tags leaves 1,625 real characters.
The slide title comes back as:

```
M<sub>e</sub>t<sub>a</sub>b<sub>o</sub>li<sub>c</sub> P<sub>a</sub>th<sub>ways</sub>
```

instead of `Metabolic Pathways`. MinerU's inline-formula classifier is misfiring
on this deck's fonts and shredding ordinary words into subscript runs. That text
is what gets embedded and served as citations today, on exactly the document
class that represents most of the expected corpus.

**This is a live production defect, independent of the CPU question**, and it
argues for moving off MinerU on quality grounds rather than only on cost. It is
not confined to the deck either — 9 blocks in one arXiv paper and 6 in another
carry the same markup, so grep existing `content_list` artifacts for `<sub>`
density before assuming it is rare.

**Confirmed upstream and reproduced on all three routes.** It is not a CPU
artifact, not a version skew, and the VLM route does not save you:

| Route                            | Blocks | With sub/sup | Raw chars | Usable | Noise |
| -------------------------------- | ------ | ------------ | --------- | ------ | ----- |
| Modal `fast` (GPU pipeline)      | 69     | 41           | 5,170     | 1,628  | 68.5% |
| Modal `accurate` (GPU hybrid VLM)| 71     | 40           | 5,164     | 1,633  | 68.4% |
| mineru `pipeline` on CPU         | 68     | 40           | 5,134     | 1,625  | 68.3% |
| marker `fast --disable_ocr`      | 41     | 0            | 1,464     | 1,464  | 0.0%  |

Both Modal routes parse 10 pages in ~11.8s of server time, so `accurate` is not
even slower — it is the same GPU spend for the same broken text. The maintainers
have the issue; the deck reproduces it on their own hosted platform.

### `parse_method=ocr` fixes it on both routes

The pollution comes from trusting a broken text layer, so forcing MinerU to read
pixels instead clears it completely. Same deck, same 10 pages:

| Route      | method | parse_s | blocks | tagged | raw chars | clean | noise |
| ---------- | ------ | ------- | ------ | ------ | --------- | ----- | ----- |
| `fast`     | `auto` | 11.76   | 69     | 41     | 5,170     | 1,628 | 68.5% |
| `fast`     | `txt`  | 28.55   | 69     | 41     | 5,170     | 1,628 | 68.5% |
| **`fast`** | **`ocr`** | **10.84** | **69** | **0** | **1,627** | **1,627** | **0.0%** |
| `accurate` | `auto` | 11.78   | 71     | 40     | 5,164     | 1,633 | 68.4% |
| `accurate` | `txt`  | 10.30   | 71     | 40     | 5,164     | 1,633 | 68.4% |
| **`accurate`** | **`ocr`** | **8.38** | **71** | **0** | **1,623** | **1,623** | **0.0%** |

Read that carefully. `auto` produces byte-identical output to `txt`, so on this
deck **`auto` is silently choosing the broken path** — it finds a text layer and
trusts it. `ocr` is not just cleaner, on this document it is *faster* than either
(10.8s vs 11.8s and 28.6s), because the layout model no longer fights a
pathological character stream.

OCR mode also repairs two defects the `<sub>` noise was masking:

| Page text        | `auto` / `txt`          | `ocr`                     |
| ---------------- | ----------------------- | ------------------------- |
| slide 2 title    | `Last Week�`            | `Last Week...`            |
| heading          | `It Ain\ufffdt Always Glucose!` | `It Ain't Always Glucose!` |
| heading          | `Glycolysis S tep 1`    | `Glycolysis Step 1`       |

So the deck's embedded font has a broken cmap: U+FFFD replacement characters and
spurious intra-word spaces. Reading pixels sidesteps the whole mess.

**The VLM can do it too.** A first try of `accurate` + `ocr` on 10 pages died at
**542s with Modal's HTTP 500 / upstream timeout** — that looked like a
capability gap, and it was not. MinerU's hybrid backend honours
`parse_method=ocr` via `ocr_classify()`: it forces `_ocr_enable=True`, drops
`batch_ratio` to 1, and has the VLM extract every block instead of trusting the
text layer. Retried on a restored container:

| pages | wall clock | `_server_parse_s` | `_uptime_s` | noise |
| ----- | ---------- | ----------------- | ----------- | ----- |
| 3     | 158s       | **2.86s**         | 3.0         | 0.0%  |
| 10    | 177s       | **8.38s**         | 9.2         | 0.0%  |

Same structure as `auto` (71 blocks, same headings, the ΔG equation survives),
zero `<sub>` tags, and the broken-cmap repairs (`Last Week...`, `Ain't`,
`Glycolysis Step 1`) match the pipeline-OCR route. GPU parse time is even a
touch *faster* than `auto` (8.4s vs 11.8s) once the container is up. The 150s+
of wall clock is snapshot restore, not OCR. The 542s failure was a cold boot
that overran Modal's HTTP gateway (~9 min); the function timeout is 1800s, so
the GPU was probably still working when the proxy gave up.

The official hosted platform succeeding with VLM+OCR is the same code path. Our
Modal wrapping is what made it look broken.

### Is `ocr` safe as an always-on default? Nearly.

Same route, same page caps, born-digital documents where the text layer is good:

| Document                      | method | parse_s | blocks | tagged | chars  | word similarity |
| ----------------------------- | ------ | ------- | ------ | ------ | ------ | --------------- |
| attention-is-all-you-need.pdf | `auto` | 17.81   | 131    | 14     | 34,082 | —               |
| attention-is-all-you-need.pdf | `ocr`  | 22.70   | 131    | 0      | 34,060 | 99.6%           |
| etextbook.pdf                 | `auto` | 5.41    | 38     | 0      | 9,682  | —               |
| etextbook.pdf                 | `ocr`  | 4.81    | 38     | 0      | 9,664  | 95.4%           |

Identical block-type histograms, identical 5 equations with byte-identical LaTeX,
identical 25 headings. The cost is **at worst ~28% more time** and sometimes less.
Even on a clean paper `auto` had 14 tagged blocks that `ocr` cleared.

The differences are cosmetic with one exception worth knowing:

```
Vaswani∗          -> Vaswani\*        # asterisk escaping, harmless
Section V         -> SECTION V        # small-caps read as caps
Screening....... -> Screening.....    # TOC dot-leader run length
llion@google.com  -> 1lion@google.com # a real OCR error: l -> 1
```

That last one is the whole risk of OCR mode: with no text layer to cross-check,
identifiers (emails, DOIs, accession numbers, code) can take a character hit.
For prose retrieval that is noise; if you ever index code or IDs, keep `auto`
for documents whose text layer passes a sanity check.

### Verdict on MinerU after this

- **Both routes are salvageable on quality** if `parse_method=ocr`: zero markup
  noise, same block structure, and on this deck OCR is even slightly faster
  than `auto` once warm. The CPU plan still wins on price (marker 1.10-1.31
  pg/s on four cores vs ~0.9-1.2 pg/s on a rented L4).
- **Both routes default to `ocr` now.** Warmup, request fallbacks, and
  `EVO_PARSE_METHOD` all use `ocr`. Redeploy so the CPU memory snapshot is rebuilt with
  the OCR sidecar path inside it — an `auto` snapshot is how an 8s parse became
  a 542s gateway timeout.

### MinerU OCR on CPU, and Marker has no Paddle plugin

MinerU's pipeline **does** run on CPU (`MINERU_DEVICE_MODE=cpu`, same PP-OCRv6
torch models). Same 10 pages of the lecture deck, `parse_method=ocr`:

| Where                         | Wall     | pg/s | noise |
| ----------------------------- | -------- | ---- | ----- |
| Modal L4, pipeline + ocr      | 10.8s    | 0.92 | 0%    |
| marker `--disable_ocr`, 4 vCPU | 22.5s   | 0.44 | 0%    |
| MinerU pipeline + ocr, 4 vCPU | 54.9s    | 0.20 | 0%    |
| MinerU pipeline + auto, 4 vCPU | 75.6s   | 0.13 | 68%   |

CPU MinerU OCR is ~5× the GPU, and ~2.4× marker-with-no-OCR. A 100-page deck is
~8-9 minutes on 4 vCPU vs ~2 minutes on the L4. That is the whole argument
against "just run the same MinerU container without a GPU".

**Marker 2 cannot swap in PaddleOCR.** OCR is Surya 2 (Qwen-VL / llama.cpp).
`OcrBuilder` → `RecognitionPredictor` → Surya inference server, no plugin flag.
`--disable_ocr` is the only supported way to keep the 1.10 pg/s rate, and it
returns zero characters on scans.

The cheap OCR that *does* fit is RapidOCR (PP-OCRv6-small, onnxruntime) **next
to** marker, not inside it. Route per page, marker `--disable_ocr` on
text-layer pages, RapidOCR on the rest. That is the CPU fast route.

### Live chunker bugs found while diffing Modal responses (now fixed)

`chunk_content_list` branched on `text` / `table` / `equation` / `image` with **no
`else`**, so every other block type vanished with no log line. Probing the real
responses turned up five more types in active use:

| Type            | Real content? | Example found                                          |
| --------------- | ------------- | ------------------------------------------------------ |
| `list`          | **yes**       | the paper's entire references section, in `list_items`  |
| `chart`         | **yes**       | a plot with a real `img_path`                           |
| `header`        | **yes**       | slide titles, and a book's `"Contents"`                 |
| `page_footnote` | **yes**       | `"†Work performed while at Google Brain."`              |
| `footer`        | no            | `"31st Conference on ... (NIPS 2017)"`, repeats         |
| `page_number`   | no            | `"2"`                                                   |
| `aside_text`    | no            | `"r00[:0:::02"` — a rotated margin stamp, read as noise |

`list` was the worst of them: it stores its text under `list_items` rather than
`text`, so **every citation in every paper was being dropped**. `chart` was
dropped twice over, because `figures.py` also required `type == "image"` — so a
plot was neither captioned nor indexed and left the corpus entirely.

`header` is the interesting judgement call. Its name says furniture, but measured
on this corpus it is content more often than not, so it is now indexed as body
text — deliberately *not* promoted to a heading, since MinerU gives it no
`text_level` and a genuine running header would otherwise overwrite the section
path on every page of a book.

Fixed in `retrieval/chunking.py` (`_IMAGE_TYPES`, `_BODY_TEXT_TYPES`,
`_LIST_TYPES`, `_FURNITURE_TYPES`) and `parse/figures.py`, with anything still
unrecognised counted and logged so the next upstream schema change is loud
instead of silent.

### What this still does not cover

English only, no CJK, no handwriting. Docling's strongest claim — native
`.pptx`/`.docx` with no OCR and no LibreOffice hop — was never exercised, though
its PDF showing is weak enough that it barely matters now. The scan sample is 2
pages, so the ~59 s/page full-page-OCR figure rests on a thin sample. Nothing
here is scored against ground truth.

## Run it

Docker, so the core count is pinned and comparable to a VM:

```bash
# 1. get something to parse
python bench/parsers/fetch_samples.py --dest bench/parsers/docs
#    then add YOUR files: a .pptx deck, a scan, a dense-table chapter

# 2. build (large — CPU torch + both model stacks)
docker build -t evo-parse-bench bench/parsers

# 3. sanity-check the install and Marker's real CLI flags before a long run
docker run --rm evo-parse-bench --probe

# 4. benchmark at 4 cores — ONE backend per container, see the warning above
for b in marker-fast-noocr docling-tables docling-ocr-fullpage; do
  docker run --rm --cpus=4 \
    -v "$PWD/bench/parsers/docs:/bench/docs:ro" \
    -v "$PWD/bench/parsers/out/$b:/out" \
    -v evo-parse-models:/models \
    evo-parse-bench --threads 4 --max-pages 10 --backends "$b"
done
```

`--threads` must match `--cpus` or the per-vCPU column is meaningless. Keep the
`evo-parse-models` volume between runs so model weights download once.

Sweep core counts to find where throughput stops scaling — that is the VM size
worth renting:

```bash
for n in 2 4 8; do
  docker run --rm --cpus=$n -v "$PWD/bench/parsers/docs:/bench/docs:ro" \
    -v "$PWD/bench/parsers/out/cpu$n:/out" -v evo-parse-models:/models \
    evo-parse-bench --threads $n --backends marker-fast-noocr
done
```

`--max-pages N` clips every PDF to its first N pages into `out/_capped/` before
anything runs, so a 125-page textbook does not turn a comparison into an
overnight job. Every backend then parses byte-identical input.

`--doc-timeout` (default 420s) caps each document. Marker is killed at the
limit; the in-process backends finish the document and then stop that backend.
Without it a single pathological file stalls the whole run — `marker-fast` on a
scanned newspaper sat at 394% CPU for over half an hour with no output, which is
how that limit came to exist.

MinerU lives in its own image, because it pins surya and transformers versions
that conflict with Marker's. Point it at the capped directory the first image
wrote so both provably see the same bytes:

```bash
docker build -f bench/parsers/Dockerfile.mineru -t evo-parse-bench-mineru bench/parsers
docker run --rm --cpus=4 \
  -v "$PWD/bench/parsers/out/_capped:/bench/docs:ro" \
  -v "$PWD/bench/parsers/out/mineru:/out" \
  -v evo-mineru-models:/models \
  evo-parse-bench-mineru --threads 4 --backends mineru-pipeline-cpu
```

## Backends

| Backend                | What it proves                                                       |
| ---------------------- | -------------------------------------------------------------------- |
| `mineru-pipeline-cpu`  | The control: production's parser, same version, `DEVICE_MODE=cpu`.   |
| `marker-fast-noocr`    | Marker's cheapest tier. The 43.6 olmOCR-bench mode.                  |
| `marker-fast`          | The 66.6 tier, VLM served by llama.cpp on CPU.                       |
| `docling-textonly`     | Layout + reading order only. Fast but fragments tables into lines.   |
| `docling-tables`       | Adds TableFormer. Docling's cheapest genuinely usable config.        |
| `docling-ocr`          | OCR on bitmap regions only — on born-digital PDFs this barely fires. |
| `docling-ocr-fullpage` | Forces OCR on every page. This is the scanned-document price.        |
| `docling-formula`      | Adds formula-to-LaTeX. Recovers equations, costs more than the rest. |

`docling-ocr` and `docling-ocr-fullpage` are separate on purpose: Docling only
OCRs bitmap areas by default, so `do_ocr=True` alone measures almost nothing on
a text-layer PDF. Forcing it needs `OcrMode.FULL_PAGE` — the older
`force_full_page_ocr` flag is deprecated and setting it no longer switches the
mode, which silently produced a meaningless "OCR is basically free" result the
first time round.

## Output

- `out/summary.json` — every metric, per backend and per document
- `out/<backend>/content_list/<doc>.json` — normalized blocks, ready to diff
- a comparison table on stdout

Columns worth staring at:

- **`pg/s/cpu`** — the only throughput number that transfers between machines
- **`depth`** — distinct `text_level` values. If this is 1, `section_path`
  collapses and retrieval quality drops corpus-wide with nothing failing loudly
- **`infer`** — headings whose level had to be guessed. Lower is better
- **`bbox%`** — blocks carrying a box. Anything below ~90% means citations
  degrade to page-level jumps
- **`model_load_s`** — measured on a blank page, so per-document seconds can be
  read as parse work. Marker is invoked once per document and re-pays this every
  time; subtract it to get the rate a warm worker would sustain

Marker gets one CLI call per document rather than one for the whole directory.
Batching is faster, but the only observable number it yields is batch wall time
split by page share — fiction on a mixed corpus, where one scanned page can cost
more than a whole born-digital chapter. Per-document calls also mean a timeout
contains one bad file instead of the run.

Sanity-check `bbox` by eye at least once. `normalize.py` flips Docling's
bottom-left origin to top-left; if that flip is ever wrong, every highlight in
the reader lands mirrored vertically and no assertion in this repo notices.

## Why `normalize.py` is a separate module

It is not bench scaffolding — it is the actual adapter a real migration needs,
and if a candidate wins it moves to `pipeline/pipeline/parse/` roughly as-is. It
targets `BBOX_SPACE = "mineru-1000-topleft"` so a new backend can reuse the
existing `chunking.py` region model and the existing citation viewer untouched.

Whatever ships will need a fresh `parser_version`. That is already safe:
`artifact_identity()` keys the B2 parse cache on `(source_sha256, parse_method,
route, parser_version)`, so a new parser cannot collide with cached MinerU zips.

## Not measured here

- **Cost.** Depends on volume, not on parser speed. The decision write-up lives in
  the `cpu-parser-decision` canvas.
- **Cold start.** Irrelevant for an always-on VM, which is the whole point.
- **Accuracy vs ground truth.** Use the published benchmarks, then eyeball the
  normalized `content_list` for the documents you actually care about.
