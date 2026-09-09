# MinerU CPU performance investigation

September 9, 2026, local date. Read-only inspection of Capy's integration,
MinerU 3.4.5 source, retained benchmark artifacts and ingest VM
`159.195.61.195`. This report proposes experiments; it does not report a new
optimization benchmark or change parser behavior.

Keep investigating MinerU before considering a full Rust port. Existing logs
put most elapsed time inside layout, formula, table and OCR stages. Those
stages use PyTorch and ONNX Runtime. Changing the calling language leaves the
models and their numerical work in place. Smaller processing windows, CPU
thread allocation, model execution and image lifetimes are better first targets.

## Evidence and limits

The inspected VM exposes eight AMD EPYC 9645 vCPUs, about 15 GiB usable RAM,
about 24 GiB swap and no GPU in the recorded parser configuration. No Docker
containers were present at inspection. Retained images, models and benchmark
directories remain. No service was started, stopped or reconfigured.

Capy pins MinerU 3.4.5 and CPU PyTorch in
[`parser/requirements.in`](../../../parser/requirements.in). The upstream
release inspected is `fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883`. This is a
release-source review, not a byte-for-byte attestation of every installed file
in the retained image.

The local September 8 capacity logs match their VM copies by SHA-256:

| Log under `/opt/capy-parser-eval-20260908/logs/` | SHA-256 |
| --- | --- |
| `capacity-mineru-auto-digital-p1.log` | `2016bc82e46561074e5c7bf8eae1f483a87cf6ed5813eac84d94061578c8325b` |
| `capacity-mineru-auto-ocr-p1.log` | `debfb175b7b4ba7a9e73dca25b8d34f2192064a27d2742ca5f037b4cf6faefb5` |

Local copies are under
[`local/2026-09-08-opendataloader/logs/`](local/2026-09-08-opendataloader/logs/).
The following stage times come from progress bars and timestamped logs, after
one warmup. They include each stage's preprocessing and postprocessing and are
rounded. They are not a native CPU profile or a complete additive breakdown.

| Work in a single 26-page parse | Digital biology fixture | Scanned newspaper fixture |
| --- | ---: | ---: |
| Complete conversion, three warm trials | 78.59, 79.02, 81.55 s | 117.11, 117.21, 116.85 s |
| Layout prediction | about 25 to 26 s | about 25 to 26 s |
| Formula recognition | about 13 to 15 s | no formula prediction reported |
| General text-region detection | about 15 to 16 s | about 12 to 13 s |
| General text recognition | less than 1 s | about 72 to 74 s |
| Table orientation, OCR and structure | about 15 to 16 s | no table prediction work reported |
| Page rendering before the analysis window | about 3 s | about 2.3 s |

The digital fixture still detects hundreds of text regions and recognizes
table contents and formulas. An empty `ocr_pages` list does not mean zero OCR
model work.

The [August 31 capacity report](2026-08-31-worker-stress.md) measured 0.845
pages/second at four active slices versus 0.656 at eight. Eight filled the
14 GiB parser cgroup and used 5.32 GiB swap. The fresh September 8 warm tests
again give about 0.85 pages/second for four digital requests and 0.52 for four
scan requests. They reach roughly 12 GiB sampled cgroup memory without swap.
Four is the best tested configuration, not a mathematical optimum. These
tests do not establish that four parsers plus all ingest workloads fit at
their simultaneous maximum on the shared host.
The benchmark allowed 28 GiB total RAM plus swap; the current production
Compose file allows 18 GiB total with the same 14 GiB RAM ceiling. The
eight-lane survival result therefore also exceeds today's swap allowance.

## Why OpenDataLoader is faster

The [matched comparison](2026-09-08-opendataloader-vs-mineru.md) gives the
following conversion totals for the 430-page intact corpus:

| Parser path | Seconds | Sampled peak cgroup GiB |
| --- | ---: | ---: |
| MinerU auto | 964.1 | 11.78 |
| OpenDataLoader Java with cluster tables | 53.4 | 0.59 |
| OpenDataLoader full hybrid with RapidOCR | 919.8 | 10.71 |

Java's direct PDF content extraction performs different work from MinerU's neural
layout, OCR and formula pipeline. Adding the full hybrid backend brings
execution time close to MinerU while retaining measured quality defects.
These observations do not measure Java versus Python language overhead.

[Java with selective recovery](2026-09-08-java-recovery.md) took 62.9 to 63.6
seconds and 0.91 to 1.06 GiB for extraction, inspection, selective OCR and physical
image deduplication. Captions and application indexing are excluded. It
preserved fewer raw source probes and failed different examples from MinerU.
The subsequent [Qwen experiments](2026-09-08-qwen-java-recovery.md) also found
selection and fidelity problems. A fast Java path remains promising, but its
quality has not been shown equivalent.

## Concrete source findings

- Capy already keeps models warm in one process and shares them across thread
  lanes. Adding ordinary parser processes would duplicate runtime state and
  models. See [`parser/app.py`](../../../parser/app.py).
- The CPU layout batch is one page. MinerU derives batch sizes from a GPU
  memory ratio, whose normal CPU value is one. This is a candidate for a
  separate CPU batch experiment, not evidence that a larger batch is faster.
  See [batch selection](https://github.com/opendatalab/MinerU/blob/fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883/mineru/backend/pipeline/pipeline_analyze.py#L353).
- MinerU retains PIL pages, NumPy page representations and collections of
  region crops within a window. Four 26-page windows can have up to 104 pages
  in analysis together. This makes processing-window size and crop lifetimes
  direct memory targets. See [page representations](https://github.com/opendatalab/MinerU/blob/fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883/mineru/backend/pipeline/batch_analyze.py#L421).
- Digital mode still detects text lines, then fills them from native PDF text.
  Blindly skipping detection changes segmentation. Tables still have OCR
  work. See [text detection](https://github.com/opendatalab/MinerU/blob/fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883/mineru/backend/pipeline/batch_analyze.py#L702) and [recognition gating](https://github.com/opendatalab/MinerU/blob/fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883/mineru/utils/ocr_utils.py#L386).
- OCR already batches work. Recognition uses batches of six and sorts crops
  by aspect ratio. Generic OCR batching is therefore already implemented.
  See [recognition batch configuration](https://github.com/opendatalab/MinerU/blob/fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883/mineru/model/ocr/pytorch_paddle.py#L87)
  and [crop sorting](https://github.com/opendatalab/MinerU/blob/fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883/mineru/model/utils/tools/infer/predict_rec.py#L298).
- `MINERU_INTRA_OP_NUM_THREADS` and `MINERU_INTER_OP_NUM_THREADS` configure
  specific ONNX table sessions, not all model execution. Capy's image also
  sets OMP and MKL to two. A sweep must verify actual PyTorch, ONNX, OpenCV and
  BLAS thread pools. See [`parser/Dockerfile`](../../../parser/Dockerfile),
  [Unet ONNX setup](https://github.com/opendatalab/MinerU/blob/fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883/mineru/model/table/rec/unet_table/utils.py),
  and [ONNX threading documentation](https://onnxruntime.ai/docs/performance/tune-performance/threading.html).
- `clean_vram` runs garbage collection on CPU too. Its three logged calls
  total about one second per warm fixture parse; another final collection
  is outside those log entries. It is worth measuring, but cannot explain
  the Java gap. Removing collection can increase memory pressure. See
  [cleanup implementation](https://github.com/opendatalab/MinerU/blob/fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883/mineru/utils/model_utils.py#L183).

## Recommended experiment order

1. **Record actual CPU and memory ownership.** Profile a warm digital parse,
   a scan and a four-request burst. Separate model operators, Python work,
   image conversion, rendering processes, allocation and queue wait. Record
   resident/anonymous memory, charged file cache, swap and CPU seconds
   separately. Existing stage logs locate the work but cannot assign all of
   it to native kernels.
2. **Sweep CPU allocation without changing extraction.** Compare one lane
   with eight native threads, two with four, four with two, and four with one.
   Retain one lane with two threads as the existing single-request control.
   Verify settings at runtime rather than trusting similarly named environment
   variables. Use the same warm fixtures and three repeats to screen candidates.
3. **Reduce the inner processing window.** Keep Capy's 26-page outer slices
   and test MinerU windows of 13 and 8 against 26 on the best CPU allocation.
   This isolates working-set size from changing Capy's slice boundaries.
   Smaller windows may add batching, rendering and collection overhead. Check
   source content and page boundaries as well as memory and throughput.
4. **Optimize the expensive models independently.** Start with scan OCR and
   layout. Compare the same weights and equivalent preprocessing in a CPU
   runtime such as ONNX before trying lower precision. Test CPU layout batch
   sizes independently of the global virtual-VRAM setting, which changes
   several batch sizes at once. INT8 or BF16 is an experiment with accuracy
   and operator-support risks, not an automatic improvement. ONNX provides
   [quantization and accuracy-debugging tools](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html).
   A concrete OCR comparison is MinerU's pinned PP-OCRv6 checkpoint in
   PyTorch versus an equivalent ONNX export. Sharing a model-family name with
   RapidOCR does not establish identical weights or preprocessing. Hold those
   constant and compare boxes, recognized text and model outputs before
   attributing a change to the runtime.
5. **Reduce measured allocation overhead.** Reuse or release page/crop
   representations earlier where profiling shows retained memory. Examine
   Capy's second PDF slicing/classification pass and image read/base64/write
   copies, but do not expect small wrapper changes to remove the dominant
   model stages. Preserve artifact integrity and OCR accounting.

Run benchmark configurations sequentially on the shared VM. Concurrent agents
can analyze code and outputs, but competing performance runs would contaminate
the measurements. Recheck the current host workloads before any new run.

Evaluate finalists on intact multilingual documents, the long textbook,
formulas, table row/header associations, reading order, page attribution and
figure crops through Capy's actual chunker. Existing targeted probes are
necessary checks, not representative accuracy scores. Include short uploads
arriving behind long documents before making a deployment recommendation.

Changing model choice, OCR language, resolution, formula/table extraction or
page routing belongs in a separate quality experiment. A Java path that sends
only difficult pages to MinerU may save much more work than a language rewrite,
but missed difficult pages are precisely the current unresolved quality risk.
A GPU comparison is also relevant if the same full model pipeline must become
much faster; there is no measured GPU result in this investigation.

## When Rust would be justified

Rust compiles code ahead of time and gives direct control over memory without
Python's interpreter. It can help a measured CPU loop, allocation-heavy
transformation or data-transfer boundary. It does not remove model weights,
activation buffers or matrix operations already executed by native libraries.

Use a small Rust extension only if profiling exposes substantial remaining
Python work and a simpler algorithm, NumPy operation or existing native API
does not solve it. Exporting a model to another runtime can be tested from
Python first; that does not require a full parser port.

For illustration, if 90% of runtime stays in unchanged model operations,
eliminating the other 10% entirely improves total speed by only 1.11 times.
That percentage is hypothetical, not a measured native-code fraction here.
A full port would also take ownership of reading order, multilingual OCR,
tables, formulas, image geometry and upstream compatibility. The evidence
does not justify that commitment.

Three bounded investigations were useful here: Capy's scheduling and artifact
path, benchmark comparability and quality, and upstream model/runtime code.
Further agents should own a specific measured hypothesis or quality review.
More unprofiled code reading cannot establish a speedup.
