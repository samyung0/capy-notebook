# Parser: old Office files converted to the new formats

2026-11-11. An uploaded `.doc`, `.xls` or `.ppt` is converted on the ingest
host to `.docx`, `.xlsx` or `.pptx` and replaces the upload
([the route](../../../openwiki/agentic-retrieval.md)). This is what was run on
the ingest host to see that LibreOffice in the parser image does that inside
the parser's sandbox, and what the worker's picture step costs in memory.

## Answers

- **The conversion runs under the sandbox as it is.** All ten files converted
  with the pinned import filter and LibreOffice's OOXML export filter, with no
  change to the sandbox, the profile or the limits, in 0.9 to 4.2 s each.
- **Through the parser service too.** The ten files converted through
  `/file_parse` with `convert_to`, each converted file then took the ordinary
  parse, and four requests that must be refused were.
- **Pages and words survive on these files.** Old and converted file, each
  turned to PDF by the parser's own conversion: nine of ten have the same page
  count (one handbook 72 and 71), and 96% to 100% of the words are shared.
- **The picture step fits the nonprod coordinator for a 20 MiB deck, with
  little to spare beyond it.** It peaked at 158 MiB for a 20.7 MiB deck with 69
  pictures. The nonprod coordinator idles at 117 MiB of 384 MiB and takes one
  job at a time. Production's coordinator runs eight jobs inside a limit with
  about 110 MiB to spare, which one such deck passes.
- **The coordinator's limits stay as they are** (developer's decision,
  2026-11-11): swap takes a peak and the container restarts if it is killed.
  The picture step is not a new cost. The import worker has run it on every
  Office upload inside 256 MiB; about 100 MiB of the peak is one short-lived
  decoder process.

## What ran

- **Host and images.** The ingest host (AMD EPYC 9645, 8 vCPU). The parser
  image at main `050b011a0` (LibreOffice 7.4.7, Debian bookworm) for the
  sandbox run; a thin layer over the parser image with this change's
  `parser/app.py` and `parser/odl/document.py` for the service run (the
  change's final code, over the image at main `1ea200285`); the pipeline
  image at main `1ea200285` for the picture step.
- **Files.** Ten old-format files made from this repository's Office fixtures
  with LibreOffice 26.8 on a Mac (`e2e/fixtures/files/`,
  `bench/editor/fixtures/office/`, `bench/gateway/fixtures/`,
  `bench/parsers/fixtures/docs/`): five `.doc`, three `.xls`, two `.ppt`, from
  7 KiB to 21 MiB. None was written by an old version of Microsoft Office.
- **Sandbox run.** `scripts/legacy_convert_sandbox.py` in a throwaway
  container with the parser's hardening and no network: the parser's own
  `_convert` (sandbox, fresh profile, limits, 180 s) with the suffix's import
  filter and the OOXML export filter, then the old and the converted file each
  through `normalize_document` to PDF, and their pages and words compared.
- **Service run.** `scripts/capacity_pass.sh` in the nonprod shape (one parse
  child, depth 2, 2 CPUs, 6 GiB) with `DRIVER=legacy_convert_probe.py`: each
  file through `/file_parse` with `convert_to`, four refusals, then each
  converted file through an ordinary parse.
- **Picture step.** `scripts/office_pictures_memory.py` in the pipeline image
  with the coordinator's limit (384 MiB, no swap): `images.compress_office`
  with the 2 MiB picture cap and `image_check.check_office`, as the worker runs
  them on a converted file, on three of the converted files. The container's
  peak is the cgroup's.

## Results

**Sandbox run** (old file, converted file):

| File | Bytes | Convert | Pages | Words | Words shared |
|---|---|---|---|---|---|
| `course-guide.xls` | 282,624 → 155,502 | 1.1 s | 150, 150 | 9,231, 9,269 | 8,907 |
| `exchange-plan-comments.doc` | 97,280 → 48,084 | 1.2 s | 17, 17 | 818, 818 | 818 |
| `grades.xls` | 6,656 → 6,407 | 1.0 s | 3, 3 | 22, 22 | 22 |
| `jp_llm2.ppt` | 22,233,600 → 20,659,871 | 4.2 s | 84, 84 | 5,311, 5,389 | 5,202 |
| `large-gradebook.xls` | 3,583,488 → 1,461,519 | 1.8 s | 705, 705 | 256,246, 256,246 | 256,246 |
| `lesson.doc` | 19,456 → 8,242 | 1.0 s | 1, 1 | 32, 32 | 32 |
| `lesson.ppt` | 652,800 → 247,349 | 1.6 s | 2, 2 | 32, 32 | 32 |
| `long-handbook.doc` | 418,304 → 37,268 | 1.5 s | 72, 71 | 15,412, 15,402 | 15,331 |
| `report.doc` | 9,728 → 4,783 | 0.9 s | 1, 1 | 18, 18 | 18 |
| `two-pictures.doc` | 9,728 → 5,092 | 1.0 s | 1, 1 | 4, 4 | 4 |

Words are runs of word characters in the PDF's text, counted with repeats;
shared is the overlap of the two counts.

**Service run.** All ten conversions answered `200` with `converted` true: a
ZIP at the output key whose size and SHA-256 are the ones the answer names.
The ten converted files then parsed (1 to 705 pages, 1.6 to 40 s). The four
refusals:

| Request | Answer |
|---|---|
| A `.docx` file's bytes named `.doc` | `422 parse_format_mismatch` |
| 8 KiB of random bytes in an OLE2 container, named `.doc` | `422 parse_unreadable` |
| A `.doc` with `convert_to` `xlsx` | `422 parse_format_mismatch` |
| A `.doc` with `convert_to` `pdf` | `400` |

**Picture step, 384 MiB container:**

| Converted file | Bytes | Time | Stored bytes | Container peak |
|---|---|---|---|---|
| `jp_llm2.pptx` (69 pictures) | 20,659,871 | 13.5 s | 8,548,112 | 158 MiB |
| `long-handbook.docx` | 37,268 | 0.2 s | 37,268 | 43 MiB |
| `large-gradebook.xlsx` | 1,461,519 | 0.0 s | 1,461,519 | 36 MiB |

The container held 21 MiB once the modules were loaded. No picture was
removed from any of the three.

## Limits

- **No file from a real old Office.** The ten were written by LibreOffice 26.8
  from new-format fixtures, so what Word 97 to 2003, Excel or PowerPoint files
  bring (WMF and EMF pictures, old equations, embedded objects, macros,
  passwords) was not converted. A password-protected file was not tried.
- **Fidelity is seen through LibreOffice.** Both PDFs come from the same
  LibreOffice, so a loss it makes on import shows in neither. No converted
  file was opened in the Office editor.
- **One run a file**, on a shared host with the live nonprod stack idle.
- **The picture step ran alone**, not inside a coordinator: the worker also
  holds the converted bytes it read from the spool and the body it puts, which
  the script holds too, but not the coordinator's own 117 MiB or a second job.
  One deck is not a bound: a 100 MiB file with large pictures was not run.
- **Production's coordinator was not run.** By the compose file's own budget
  it has about 110 MiB of its 1,280 MiB to spare with eight jobs, and the
  picture step of one 20 MiB deck needs more. Past that the container has the
  256 MiB of swap its own limit allows (`memswap_limit` 1,536 MiB), whatever
  the host's swap, then the kernel kills a process in it; `restart:
  unless-stopped` brings the container back if that process is the
  coordinator itself. Both limits are environment values. No production stack
  is deployed, so none of this was seen.
- **The hand-over was not run.** The bucket, the gateway endpoint and the swap
  are covered by the Go and Python tests only.

## Reproduce

[bench/parsers/README.md](../README.md#old-office-files-converted-to-the-new-formats).
