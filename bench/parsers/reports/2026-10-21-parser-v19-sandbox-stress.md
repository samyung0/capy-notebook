# Parser v19 with the decoder sandbox: concurrent parses on the ingest host

2026-10-21. Time and memory for `odl-2.5.7-refined-vlm-v19` with the decoder
sandbox (main `ce3550426`, the parser image the UAT ingest stack runs) in the
production parser shape, at 7 and 8 parse children. It repeats
[the v16 recalibration](2026-10-16-parser-v16-recalibration.md) on the same
host and inputs. Since v16 the parser gained figure flattening (v17, v18), a
new page-read prompt (v19) and the decoder sandbox (per-process rlimits,
seccomp, Landlock, an environment allowlist).

## Findings

None of these is a decision yet.

- **Seven children still fit, with less memory to spare.** Eight 1,400-page
  books at seven children took 552 s (v16: 553 s). Seven parsed together in
  293–301 s. The eighth waited 290 s and then parsed alone in 256 s, so its
  request took 549 s of the 1,320 s request timeout. Every parse stayed under
  half the 600 s document deadline. But the peak rose from 10.77 to 12.20 GiB
  of the 14 GiB limit (anon 9.78 → 12.01), and host memory available fell
  from 3.37 to 1.10 GiB. A UAT parse at that moment (its limit is 6 GiB) would
  push the host into swap.
- **The extra 2 GiB is v17's flattening, held during the Java phase.** Each
  parse child runs font repair and flattening (PyMuPDF over every page)
  before it starts its JVM. That leaves it at about 0.54 GiB, most of it heap
  that glibc keeps after Python frees it. The seven JVMs (8.1 GiB together)
  then run on top of 3.7 GiB of children; v16, without flattening, peaked at
  anon 9.78 GiB with about the same 8.4 GiB of JVMs. Alone, on the 1,400-page
  book, a child holds
  0.51 GiB after flattening and 0.22 GiB after `malloc_trim(0)`. MuPDF's store
  shrink and `gc.collect()` free almost nothing; 0.12 GiB of what is left is
  the source and flattened PDF bytes still in use.
- **A release before Java gives the 2 GiB back.** The parser already runs
  store shrink, gc and `malloc_trim` after each document. Running them once
  more between flattening and the JVM (a test image, five added lines in
  `parser/odl/refine.py`):
  - children at the peak: 3.69 → 1.71 GiB;
  - anon peak: 12.01 → 10.47 GiB;
  - host available: 1.10 → 3.62 GiB;
  - output: byte-identical;
  - time: no measurable cost (flattening took 30–35 s either way).
- **Eight children do not fit on the shared host as deployed.** At eight
  children, eight books drove host swap up by 1 GiB within 67 s, and the
  watchdog ended the pass. The container was at 13.25 GiB anon and still
  rising, with host available at 0.86 GiB. With the release before Java,
  eight children passed:
  - wall: 8 of 8 in 308 s;
  - each book: 300–305 s, against 281–301 s in the three seven-children runs;
  - peak: 13.08 GiB of 14 (anon 11.89);
  - host available: 2.27 GiB; host swap +0.02 GiB;
  - CPU: 7.82 of 8 cores on average.
- **CPU binds as well.** A parse child is one Python thread, so seven
  children keep seven of the eight cores busy through the long refinement
  phases. In the Java phase the JVMs contend: the phase took 11.8 s for a
  book alone, 24 s at four concurrent books, 29–31 s at five, 36–42 s at seven
  and 45–49 s at eight. Each JVM sizes its GC and compiler threads for all
  8 CPUs. In every pass the busiest 10 s used 7.7–8.0 cores, with almost no
  quota throttling (2.2 s at eight, at most 0.1 s otherwise).
- **The sandbox caps hold with room to spare, and nothing was killed.**
  - Java data (`RLIMIT_DATA` 2 GiB): at most 1.36 GiB.
  - Parse child address space (soft `RLIMIT_AS` 2 GiB): VmPeak at most 0.99 GiB.
  - LibreOffice address space (2 GiB): VmPeak 0.88 GiB, VmData 0.57 GiB.
  - Tasks: at most 291 at seven children and 323 at eight, of 512.

  No process was killed by an rlimit, the OOM killer or a deadline in any
  pass. The only kill was the watchdog's on the eight-children pass, by design.
- **Java no longer gets `MALLOC_ARENA_MAX=2`, which costs only address
  space.**
  - The cause: the sandbox passes the JVM only `PATH`, `HOME` and `LANG`, so
    glibc falls back to its default of up to 8 malloc arenas per CPU. A JVM
    running 26–37 threads opened 27–36 arenas, each reserving 64 MiB. That is
    why Java's VmPeak went from about 2.8 GiB to 4.2–4.9 GiB.
  - A test image that passes the variable through brought VmPeak back to
    2.68–2.81 GiB, but Java's VmData only went from 1.31 to 1.27 GiB.
  - Java RSS and the container peak did not move beyond run-to-run noise.
  - The reserved part of an arena is `PROT_NONE`: it counts in neither RSS nor
    `RLIMIT_DATA`. Only the arenas' writable parts count: 0.07–0.18 GiB per JVM
    with the default count, 0.05–0.08 GiB with two.
- **Office conversions are cheap beside books.**
  - Beside one book: DOCX 7–9 s, PPTX 18 s, XLSX 40–41 s.
  - Beside four books: DOCX 7 s, PPTX 14–15 s, XLSX 38 s.

  The worst is far below the 180 s conversion timeout and the conversion's
  180 s CPU cap.
- **Scanned pages cost the parser about 25 ms each.** It only renders them for
  the worker's page read. 50, 150 and 300 scanned pages parse in 1.9, 4.3 and
  7.7 s alone; 150 took 4.6 s beside five books.
- **Output.** Concurrency changes nothing: a 1,400-page book parsed alone,
  among seven, as the eighth, among eight and in both test images has the
  same `content_list.json` hash. On the Biology textbook, every difference
  from v16 comes from flattening (below).

## Scenarios

| Pass | Documents (sent 0.5 s apart) | Children |
| --- | --- | ---: |
| a7 | eight 1,400-page books (a full queue: seven parse, one waits) | 7 |
| d8 | the same eight books | 8 |
| b7 | the 150-page scan and five books (the v14 worst mix) | 7 |
| c7 | one book, three XLSX gradebooks, two PPTX decks, two DOCX handbooks | 7 |
| c4 | four books, an XLSX, a DOCX and two PPTX | 7 |
| a7trim, d8trim | a7 and d8 on a test image that releases memory before Java | 7, 8 |
| a7arena | a7 on a test image that passes `MALLOC_ARENA_MAX=2` to the JVM | 7 |
| solo | the 608- and 1,400-page books, the DOCX twice, scans of 50, 150 and 300 pages, one at a time | 7 |

## Results

| Pass | Wall | Pages/min | Longest wait | Longest parse | Peak (anon) | Java RSS | Children RSS | Host available | Busiest 10 s | Java VmData | Child VmPeak | Tasks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| a7 | 552 s | 1,217 | 290 s | 301 s | 12.20 (12.01) | 8.14 | 5.80 | 1.10 | 7.92 | 1.31 | 0.99 | 279 |
| d8 (aborted at 67 s) | — | — | — | — | 13.46 (13.25) | 8.86 | 4.27 | 0.86 | 7.95 | 1.32 | — | 305 |
| b7 | 282 s | 1,524 | 0 s | 278 s | 9.80 (9.07) | 6.19 | 4.35 | 5.26 | 7.89 | 1.36 | 0.99 | 212 |
| c7 | 250 s | 918 | 7 s | 248 s | 4.81 (4.38) | 2.86 | 1.48 | 9.93 | 7.72 | 1.33 | 0.99 | 175 |
| c4 | 273 s | 1,440 | 6 s | 270 s | 8.12 (7.33) | 4.93 | 3.66 | 7.03 | 7.81 | 1.34 | 0.99 | 178 |
| a7trim | 526 s | 1,276 | 283 s | 291 s | 11.46 (10.47) | 8.64 | 5.45 | 3.62 | 7.94 | 1.35 | 0.94 | 291 |
| a7arena | 528 s | 1,273 | 280 s | 286 s | 12.87 (12.19) | 8.32 | 5.81 | 1.96 | 7.90 | 1.27 | 0.99 | 280 |
| d8trim | 308 s | 2,183 | 0 s | 305 s | 13.08 (11.89) | 9.88 | 6.34 | 2.27 | 7.97 | 1.34 | 0.94 | 323 |

How to read the table:
- Memory is in GiB. RSS columns are each kind's largest sum over the pass.
- "Longest parse" is the parser's own time for a document, minus its queue
  wait.
- LibreOffice's VmPeak was 0.88 GiB in both Office passes.
- In every completed pass, every document succeeded. There was no container
  swap and no OOM kill, and host swap grew by at most 0.03 GiB.
- The test images change no output.

Against v16 (same inputs, same host):

| Pass | v16 | v19 + sandbox |
| --- | --- | --- |
| Eight books, 7 children | 553 s, peak 10.77 (9.78), host available 3.37 | 552 s, peak 12.20 (12.01), host available 1.10 |
| Scan and five books, 7 | 282 s, peak 7.80 (7.10) | 282 s, peak 9.80 (9.07) |
| Office-heavy, 7 | 270 s, peak 4.32 (4.12); DOCX 9–10 s, PPTX 19 s, XLSX 43 s | 250 s, peak 4.81 (4.38); DOCX 7–9 s, PPTX 18 s, XLSX 40–41 s |
| Java VmPeak | 2.80–2.83 GiB | 4.2–4.9 GiB (2.81 with `MALLOC_ARENA_MAX`) |
| Parse child VmPeak | 0.79–0.84 GiB | 0.94–0.99 GiB |

## Where a book's time goes

Phases of a 1,400-page book, in seconds:

| | Flatten | Java | Structure | Repairs | Parse |
| --- | ---: | ---: | ---: | ---: | ---: |
| Alone | 29.6 | 11.8 | 110.2 | 91.1 | 249.9 |
| Four at once (c4) | 31–32 | 24–25 | 108–110 | 94–96 | 265–270 |
| Seven at once (a7) | 31–34 | 39–42 | 111–121 | 93–100 | 293–301 |
| Eight at once (d8trim) | 33–37 | 45–49 | 112–116 | 98–100 | 300–305 |

Under load the refinement phases slow by 5–10 %, and the Java phase becomes
three to four times slower.

Memory over the a7 pass (anon, GiB):
- 0–40 s, font repair and flattening: the children grow to 3.4 (0.54 each).
- 45–81 s, Java: the JVMs add up to 8.1, and the peak of 12.0 comes at 79 s.
- After Java: the children grow to 5.3 (0.75 each), with no JVM running.

The parser's API process held 0.58 GiB from the first requests. It reached
1.0–1.5 GiB when the bundles came back together, after the JVMs had exited,
so it does not set the peak.

## Output against v16

The `Parser budget` workflow's hashes from v16 (`0cecfcd85`) to v19 with the
sandbox, one fixture at a time on the 4-CPU runner:

| Fixture | v16 → v19 + sandbox | Changed at |
| --- | --- | --- |
| paper-2col, mixed-scan, newspaper-scan, legal-prose, vector-drawings, inline-images, math-worked, scan-120p, xlsx-gradebook, pptx-84-slides | identical | — |
| textbook-26mib (Biology, 610 pages) | 26,216 → 25,112 blocks; text −845 of 1,536,753 characters | v17 (flattening) and v18 (flattening tuning) |
| logic-1016p, limit-1400p | one more block, 50 fewer characters | v17 and v18 |
| docx-handbook | same blocks and text, different hash | between runs of one version as well |

On the host, the Biology textbook without its two text-less pages (608
pages) was parsed alone on a v16 image built from `0cecfcd85` and on v19, and
compared with `bundle_identity.py`:
- **Blocks:** 26,214 → 25,110. 149 of 608 pages differ. ODL's element ids are
  left out of the comparison: they number elements through the whole
  document, so one change renumbers every later page.
- **Flattened figures:** 137 of the 149 pages carry one.
- **The other 12 pages:** list grouping changed (a list split into paragraphs,
  or the reverse). Those pages had no flattened region and no answer-blank tick
  merge. ODL gives the same elements on them for the PDF rewritten the way
  flattening rewrites it, with no page changed. So the change comes from
  flattening elsewhere in the document.
- **Chunks:** 1,444 of the 1,551 chunks the production packer makes are
  identical. 107 old chunks became 104 new ones, covering 115 pages, 103 of
  them on or next to a flattened page.
- **Flattening switched off:** v19 then reproduces v16 exactly (26,214 blocks,
  no page differs). Every difference on this book comes from flattening, and
  the other v17–v19 changes are output-neutral here.

The DOCX handbook gave the same `content_list.json` in two runs on the host
and on v16 and v19. The run-to-run hash change the CI shows did not happen
here.

## Setup

- **Image**: the UAT ingest deploy's parser image of `ce3550426`. Its health
  reports `odl-2.5.7-refined-vlm-v19+ce3550426…`.
- **Test images**: built `FROM` it, each with one changed file:
  - `refine.py`: store shrink, `gc.collect()` and `malloc_trim(0)` after
    flattening;
  - `java.py`: `MALLOC_ARENA_MAX` added to the JVM's environment allowlist.
- **Container**: one throwaway container per pass (`capacity_pass.sh`), as
  `deploy/docker-compose.ingest-host.yml` runs the production parser:
  - hardening: read-only root, `cap_drop ALL`, `no-new-privileges`, the
    64 MiB HOME tmpfs, no `/tmp` mount, its own spool and work volumes;
  - limits: 14 GiB, 18 GiB with swap, 8 CPUs, 512 pids;
  - env: `APP_ENV=production`, a throwaway `PARSER_TOKEN`, queue depth 8,
    the 600 s deadline, the 1,400-page and 500 text-less page caps, the 1g
    heap, `MALLOC_ARENA_MAX=2`, the 180 s Office timeout and the bundle
    limits;
  - published on loopback only, and removed with its volumes after each pass.

  The recorded rlimits show the caps in force: parse child soft
  `RLIMIT_AS` 2 GiB and 256 files; Java `RLIMIT_DATA` 2 GiB and 2,400 s CPU;
  LibreOffice soft `RLIMIT_AS` 2 GiB and 180 s CPU.
- **Host**: 8 vCPUs, 15.6 GiB RAM, 24 GiB swap, kernel 6.12. It is shared with
  the idle UAT ingest stack (parser 6 GiB and 2 CPUs, coordinator, workers)
  and a library database.
- **Driver**: `stress_parser.py` sends every document through the production
  artifact route with unique fingerprints and samples every 250 ms. A watchdog
  ends a pass if host swap grows by 1 GiB or another container restarts. A
  side probe read each JVM's `/proc/<pid>/maps` every 20 s to count its malloc
  arenas.
- **Inputs**: the 2026-09-28 stress inputs (the Biology textbook without its
  text-less pages, concatenated to 1,400 pages, and its clean 150 dpi scans)
  and the parser budget's Office fixtures (the 72-page handbook DOCX, the
  224k-cell gradebook XLSX, the 84-slide PPTX).

## Not covered

- A busy UAT parse or busy ingest workers beside the production-shaped parser.
  The UAT stack was idle; a UAT parse adds up to 2 CPUs and 6 GiB.
- Production's own host, which the plan does not have yet. The host figures
  above (memory left for other containers) are the ones that apply now.
- Real phone scans, and documents slower per page than the 1,400-page book.
- The ingest worker's page reads of the scanned pages, measured separately
  with the page-read route.

## Reproduction

On the ingest host, in a work folder with `scripts/` (`stress_parser.py`,
`capacity_pass.sh`, `bundle_identity.py`), `manifests/` and the inputs.
Manifests are JSON lists of `{"id", "pages", "path"}`:

```sh
IMG=capy-ingest-nonprod-parser:<40-char sha>
IMG=$IMG WORKERS=7 MODE=burst MANIFEST=manifests/a.json OUT=results/a7 KEEP=bundles/a7 KEEP_IDS=p1400-1 bash scripts/capacity_pass.sh
IMG=$IMG WORKERS=8 MODE=burst MANIFEST=manifests/a.json OUT=results/d8 bash scripts/capacity_pass.sh
IMG=$IMG WORKERS=7 MODE=solo MANIFEST=manifests/identity.json OUT=results/identity KEEP=bundles/v19 bash scripts/capacity_pass.sh
docker run --rm --network none --user 0 -v "$PWD/bundles:/b:ro" -v "$PWD/scripts:/s:ro" \
  capy-ingest-nonprod-pipeline:<sha> python /s/bundle_identity.py /b/v16/bio-608.zip /b/v19/bio-608.zip
```

Every pass writes these files:
- `burst.jsonl` or `solo.jsonl`: per document, with its phases;
- the 250 ms samples and a summary;
- `processes.json`: the command line and rlimits of each process kind;
- `parser.log`, `kernel.log` and `container-state.txt`.
