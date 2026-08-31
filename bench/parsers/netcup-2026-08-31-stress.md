# Netcup MinerU stress and failure test: 2026-08-31

## Decision

Keep production at four active 26-page MinerU slices on this host.

Run four ingest-worker replicas for the usual saturated shape of four parsing
jobs plus four ingest jobs. Keep each worker at 1 CPU, 1 GiB RAM, and 1.25 GiB
total memory plus swap. Keep `EVO_CAPTION_CONCURRENCY=4`. It caps the embedded
figure-caption fan-out inside one job, so four workers can issue at most sixteen
uncached figure-caption calls at once. Other ingest model stages make one call
at a time per worker.

Eight concurrent slices completed, but that is a survival result, not usable
capacity. Four slices produced the best measured throughput. At eight slices,
the parser filled its 14 GiB memory cgroup, consumed 5.32 GiB of swap, and left
only about 450 MiB of host memory available. Five, six, and eight slices all
processed fewer pages per second than four.

The failure tests also found two recovery gaps that should be fixed before the
host is treated as self-healing:

1. Killing a MinerU multiprocessing child poisoned its internal process pool,
   but the parser kept returning HTTP 200 from `/healthz`.
2. Freezing the Uvicorn process made Docker mark the container unhealthy, but
   Docker did not restart it. A Docker health check changes status only.

The parser's four logical lanes are asyncio tasks backed by threads. They are
not four independently killable operating-system processes. If one parse is
stuck in MinerU native code, the safe recovery on this machine is to terminate
and restart the whole parser container. The existing hard-timeout path already
does this.

## Scope and setup

The test used the current working-tree parser, including the in-progress ingest
host changes. The image was labelled with Git SHA
`2725da1cbe39407786c9b3bdcd40fe68e0149046` for traceability, but the source was
not a clean checkout of that commit.

Host:

- Debian 13
- 8 AMD EPYC 9645 vCPUs
- 15 GiB visible RAM, sold as 16 GB
- 24 GiB persistent swap
- Docker cgroup v2

The machine specification and imported raw results are stored under
[`results/evo-ingest-1-netcup-rs-2000-g12-2026-08-31/`](results/evo-ingest-1-netcup-rs-2000-g12-2026-08-31/).

Parser container:

- MinerU 3.4.5, CPU pipeline backend
- 8 CPU limit
- 14 GiB memory limit
- Docker's default total memory-plus-swap limit of 28 GiB
- one Uvicorn process
- 26 pages per slice
- fresh container for each run above four lanes
- one warm parse before each concurrent burst

The production, UAT, and local stacks were not running on the host. No database
or production data was used. The measurements therefore describe parser-only
capacity, not the combined parser plus four ingest workers.

## Capacity results

The native-text fixture was the same 26-page, 19.5 MB biology PDF for every
request. Each successful result contained 330 blocks, 57,173 characters, and
34 images. MinerU selected its digital lane.

| Active slices | Burst wall | Median request |        Throughput | Peak parser RAM | Parser swap | Minimum host available | Errors |
| ------------: | ---------: | -------------: | ----------------: | --------------: | ----------: | ---------------------: | -----: |
|             1 |    82.86 s |        82.86 s |     0.314 pages/s |    not isolated |           0 |           not isolated |      0 |
|             2 |    95.10 s |        92.35 s |     0.547 pages/s |    not isolated |           0 |           not isolated |      0 |
|             3 |   102.24 s |        97.62 s |     0.763 pages/s |    not isolated |           0 |           not isolated |      0 |
|             4 |   123.11 s |       116.37 s | **0.845 pages/s** |       11.62 GiB |           0 |           not isolated |      0 |
|             5 |   173.92 s |       168.92 s |     0.748 pages/s |       11.55 GiB |           0 |               3.55 GiB |      0 |
|             6 |   263.66 s |       255.43 s |     0.592 pages/s |       13.27 GiB |           0 |               1.49 GiB |      0 |
|             8 |   317.20 s |       313.77 s |     0.656 pages/s |       14.00 GiB |    5.32 GiB |               0.44 GiB |      0 |

The first four rows were one continuous sweep, so the sampler's 11.62 GiB
maximum cannot be attributed to an individual row below four. The five, six,
and eight rows each used an isolated fresh container.

Relative to four slices, throughput fell about 12 percent at five, 30 percent
at six, and 22 percent at eight. More admitted work increased latency and
resource risk without adding capacity.

### OCR check

A two-page scanned newspaper was repeated to make one 26-page scan. With
explicit `ocr` mode:

| Active slices | Burst wall | Median request |    Throughput | Peak parser RAM | Parser swap | Minimum host available | Errors |
| ------------: | ---------: | -------------: | ------------: | --------------: | ----------: | ---------------------: | -----: |
|             1 |   143.11 s |       143.11 s | 0.182 pages/s |    not isolated |           0 |           not isolated |      0 |
|             4 |   218.81 s |       212.59 s | 0.475 pages/s |       10.71 GiB |           0 |               4.37 GiB |      0 |

The four-job OCR burst achieved 3.90 times effective parallelism, used at most
49 cgroup processes, and recorded no OOM event. OCR was slower, but it did not
need a lower concurrency setting for this fixture.

## Failure injection results

| Fault                                                              | Observed behavior                                                                                                                                                                                                          | Recovery result                                                                                                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIGKILL` one busy MinerU multiprocessing child during four parses | All four in-flight requests completed. The next parse failed immediately with `A child process terminated abruptly, the process pool is not usable anymore`. `/healthz` still returned 200 and Docker recorded no restart. | **Broken.** The service remained permanently poisoned until manually restarted.                                                                                |
| `SIGKILL` Uvicorn PID 1                                            | Active connections would be lost.                                                                                                                                                                                          | `restart: unless-stopped` restored HTTP in 1.52 s. Models were cold after restart.                                                                             |
| `SIGSTOP` one MinerU child                                         | In-flight and later parses still completed. MinerU avoided that child.                                                                                                                                                     | Useful negative control, but it does not simulate a stuck logical parse lane.                                                                                  |
| Set a 30-second parser hard timeout                                | The request returned structured HTTP 422 `parse_hard_timeout`; PID 1 exited.                                                                                                                                               | Docker restarted the container once. Models were cold. This is whole-container recovery.                                                                       |
| `SIGSTOP` Uvicorn PID 1                                            | The health check became unhealthy in 18 s and HTTP stopped responding.                                                                                                                                                     | **Broken.** Restart count stayed zero. Docker does not restart a container merely because it is unhealthy. A subsequent `SIGKILL` restored it.                 |
| Reduce the cgroup to 4 GiB with no swap, then submit four jobs     | The cgroup hit exactly 4 GiB in 3.36 s, all four clients disconnected, and `memory.events` recorded 374 OOM events and two OOM kills.                                                                                      | Docker restarted PID 1 once and restored HTTP. Models were cold.                                                                                               |
| Restart the Docker daemon                                          | The running parser stopped and its in-memory work was lost.                                                                                                                                                                | `unless-stopped` restored HTTP in 2.18 s. Models were cold.                                                                                                    |
| Reboot the VM with an isolated parser running                      | The boot ID changed and in-memory work was lost.                                                                                                                                                                           | Docker started automatically and restored the parser. SSH and parser health succeeded on the first probe about 32 s after reboot was issued. Models were cold. |

Docker is enabled at boot. At test time, `evo-ingest.service` was installed but
disabled because the host inventory still contained an unset repository URL.
The reboot therefore validates Docker and `unless-stopped`, but not the service
that recreates a missing production Compose stack.

## What the worker already handles

The parser publishes a completed bundle by atomic rename before replying. If
the connection drops after publication, the client checks the shared spool and
recovers that artifact. If publication did not happen, an ordinary connection
error is retryable. Other retryable ingest errors now get one retry after a
30-second backoff.

The worker releases its Redis parse slot in `finally`, including failed parser
calls. The final configuration gives the slot a 45-minute lease as a backstop.

## Implemented follow-up

The accepted follow-up keeps production at four parser slices and four Redis
parse slots. Local and UAT are hard-capped at one job and one slice per stack.
Production parser resources are capped at 14 GiB RAM, 18 GiB total memory plus
swap, and 256 processes. Each production worker is capped at 1 CPU, 1 GiB RAM,
1.25 GiB total memory plus swap, and 128 processes.

The parser now treats a broken MinerU process pool or dead slice-worker task as
fatal. It changes `/healthz` to 503 and exits so Docker replaces the process.
It also watches the cgroup `oom_kill` counter. An OOM marks fingerprints with an
executing slice as terminal before the parser exits. Files that were only
queued are not marked.

Each slice now has a 600-second execution limit that starts when a lane takes
that slice. A timeout quarantines the whole document and restarts the parser so
sibling slices stop too. Hard-timeout and OOM markers are terminal without a
retry. Other retryable ingest failures get one retry.

The Ansible role installs a systemd watchdog. It restarts the parser after
three failed health checks and skips planned release cutovers. Per-slice
timeouts, not the watchdog, detect stuck parsing. Parser health and permanent host samples now
include active and queued slice ages, last-completion age, and the cgroup OOM
kill count.

## Ingest-worker resource test

The worker follow-up used four separate pipeline containers and the same
four-lane parser. Every input was exactly 26 pages. The digital lane had no
scanned pages, mixed had 13, mostly OCR had 24, and OCR had 26 with explicit
`ocr` mode. Each worker imported the full ingest service, used the production
shared-spool client, verified and extracted the artifact, preprocessed selected
figures with caption concurrency eight, and chunked the content list. Caption
and embedding provider calls were intentionally omitted so the test incurred
no provider cost; their network clients remain part of the imported worker.

Building the real worker image also exposed a startup defect in the
non-editable wheel install: repository-owned JSON paths resolved under
`site-packages` and the worker failed during import. The pipeline image now puts
`/app/pipeline` on `PYTHONPATH`, so imports use the copied source tree beside the
server contract files. The rebuilt image imported
`/app/pipeline/pipeline/ingest/worker.py` locally and on the VM.

| Lane                  | Workers | Median job | Max worker RSS | Max worker cgroup | Peak parser current | Minimum host available | Peak host swap | Errors |
| --------------------- | ------: | ---------: | -------------: | ----------------: | ------------------: | ---------------------: | -------------: | -----: |
| digital               |       4 |   134.48 s |        81.4 MB |           70.9 MB |            10.98 GB |                6.25 GB |              0 |      0 |
| 13 digital / 13 scan  |       4 |   193.94 s |        68.3 MB |           56.4 MB |            12.04 GB |                5.25 GB |              0 |      0 |
| 2 digital / 24 scan   |       4 |   182.60 s |        59.0 MB |           51.1 MB |            13.77 GB |                3.65 GB |              0 |      0 |
| 26 scan, explicit OCR |       4 |   215.23 s |        59.0 MB |           51.8 MB |            15.02 GB |                2.36 GB |        0.27 MB |      0 |

The all-OCR pass touched the parser's exact 14 GiB cgroup ceiling without an
OOM kill. Worker memory was not the limiting resource. The digital fixture was
the worker-heavy edge because it returned 15 caption inputs per worker; the OCR
fixtures returned none.

A 512 MiB RAM, 768 MiB total memory-plus-swap, 1 CPU, and 128-process candidate
was then tested at both edges. Four digital jobs peaked at 83 MB worker RSS;
four all-OCR jobs peaked at 59 MB. All eight workers exited zero without an OOM.
These passes began after the parser had retained model memory from the uncapped
matrix, and the host used at most 115 MB swap.

Production uses a 1 GiB rather than the minimum tested 512 MiB RAM ceiling. The
larger ceiling bounds a four-worker candidate to 4 GiB resident memory and preserves
space for multi-slice document aggregation under the existing 512 MiB expanded
artifact limit. Total memory plus swap is 1.25 GiB per worker. CPU is capped at
one because workers mostly wait while the eight parser CPUs are busy, then do
brief extraction and chunking work after each artifact arrives.

The 512 MiB candidate is not safe for the full allowed content shape. A
synthetic 120 MiB `content_list.json` with 29,254 text blocks produced 87,762
chunks and peaked at about 518 MiB in the worker cgroup. A 512 MiB RAM limit
with 768 MiB total memory plus swap completed after using 2.46 MiB of swap. The
same worker with no swap was OOM-killed with exit 137 after producing its
result. A 1 GiB no-swap worker completed at the same input size without an OOM.
Keep the 1 GiB RAM and 1.25 GiB total limit.

Replica scaling did not expose a host-memory limit. Eight cache-hit workers on
ordinary 26-page digital artifacts used at most 77 MiB of cgroup memory each,
left 14.20 GiB of host memory available, and added no swap. Their local
artifact verification, extraction, figure encoding, and chunking took 0.10 to
0.17 seconds per job. With the 120 MiB synthetic content list, four concurrent
workers left 12.22 GiB available and eight left 9.90 GiB, again without swap.

The final overlap pass held eight 120 MiB workers in memory while four
byte-distinct 26-page digital PDFs occupied all four MinerU lanes. All twelve
jobs exited zero. The parser peaked at 10.73 GiB, the host retained at least
3.47 GiB available RAM, and swap stayed at its 1.26 MiB idle baseline. The four
parses completed in 119.68 to 130.18 seconds. This is a harsher memory mix than
the expected workload because it combines maximum-shaped ingest content with a
fully saturated parser.

The normal saturated topology is four parsing jobs plus four ingest jobs. The
measured four-parser-plus-eight-worker overlap was an upper bound, not the
expected workload. Since it still retained 3.47 GiB of available RAM without
new swap, host memory supports four production workers with room to spare.

Four parser lanes produce about 1.95 parsed documents per minute on the digital
fixture. If parsed documents are 80 percent of uploads, they imply about 2.44
ingest jobs per minute. Two workers keep up only when mean end-to-end ingest
time stays below about 49 seconds; four raise that threshold to about 98
seconds and match the four-job handoff burst. Use four workers. Caption,
embedding, summary, and concept provider calls were omitted from these
non-billable resource tests, so measure their latency and rate-limit responses
before raising provider concurrency.

Do not scale by treating swap as worker capacity. Four workers at the current
per-worker caption setting permit at most sixteen simultaneous uncached figure
captions. That setting does not cap embedding, summary, or concept calls. Those
stages run sequentially within each job, so their host-wide concurrency is at
most the number of active workers. Confirm provider behavior before raising
caption concurrency above four. Swap remains crash headroom for unusual
documents and parser recovery.

For failure injection, the same cached digital artifact completed at 64 MiB,
showing why RSS alone is not an exact cgroup threshold when file pages are
shared. At 48 MiB with no swap, the worker was OOM-killed with exit 137. Docker
restarted it once as configured. The parser remained healthy. In production,
`restart: unless-stopped` replaces a worker whose PID 1 is killed; a MinerU
child OOM instead trips the parser cgroup watcher and replaces the whole parser.

## Operator response

- One failed request with a normal 4xx: do not restart the parser unless its
  health or progress signals also fail.
- Broken process-pool error, dead slice worker, no progress, or unresponsive
  health route: restart the whole parser container. Do not try to kill one
  MinerU child.
- Parser OOM: let Docker restart it, verify the OOM counter and host memory,
  then reduce competing load. Active fingerprints are quarantined and must not
  retry.
- Hard timeout: quarantine that fingerprint and fail the file with an
  operator-visible reason. Queue wait does not spend the timeout budget.
- Repeated crashes across unrelated files: stop parser admission, preserve the
  spool and logs, and treat it as a release or host incident rather than
  quarantining every file.

## Artifacts and cleanup

Raw logs and one-second cgroup samples remain on the host under
`/opt/evo-ingest/stress-results/`. The copied test source and generated scan are
under `/opt/evo-ingest/stress-current/` and `/opt/evo-ingest/stress-spool/`.
The test images remain in Docker's local image cache for reproduction.

No test container was left running. The final `docker ps` output was empty, and
the host reported about 15 GiB available RAM and 1.3 MiB swap in use after the
final cleanup.
