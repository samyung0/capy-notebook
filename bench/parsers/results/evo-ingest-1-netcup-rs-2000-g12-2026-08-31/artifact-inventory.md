# Artifact inventory

## Stored in this repository

`raw/` is an exact copy of the VM's `/opt/evo-ingest/stress-results/` directory
at collection time. It contains 160 files totaling 555,064 bytes. The directory
includes parser concurrency CSVs and logs, failure-injection logs, worker
cgroup samples, container exit states, and cache-hit worker results.

`raw-sha256.txt` contains one SHA-256 digest for every imported file.
`supplemental-results.json` records measurements printed by the later memory
and parser-overlap harnesses before those harnesses wrote their own result
files. The decision record in `../../netcup-2026-08-31-stress.md` combines both
sets.

## Retained on evo-ingest-1

The following generated inputs and caches remain on the VM. They are excluded
from the repository because the benchmark scripts can regenerate them.

| VM path                           | Files |         Bytes | Contents                                                                 |
| --------------------------------- | ----: | ------------: | ------------------------------------------------------------------------ |
| `/opt/evo-ingest/stress-current/` |    12 |   327,412,284 | Parser source snapshot and 32, 64, 96, and 120 MiB content-list fixtures |
| `/opt/evo-ingest/stress-spool/`   |   154 | 1,371,748,911 | Synthetic PDFs, immutable parser bundles, and overlap fixtures           |

Content-list fixture digests:

| Fixture            | SHA-256                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `content-32.json`  | `225152f448ee2910b5518463e91b93bec4121d17ce7cac5e4dc3116180e4cc5c` |
| `content-64.json`  | `740fdfc23beb36da96a08386e2006a848ce9cb75d7aa349de2f7d591bf1bcada` |
| `content-96.json`  | `086e75903d481d7f8363eeb0b7bac339592b208e53da096dace672b00ad73d78` |
| `content-120.json` | `51bdd201e6153dbc887a5cff0c068b79439c2ebcd63eec507364e9379b66e3ed` |

Benchmark images retained in Docker's local cache:

| Image                        | Image ID                                                                  | Reported size |
| ---------------------------- | ------------------------------------------------------------------------- | ------------: |
| `evo-parser-stress:current`  | `sha256:f891c36a6ed55f165672f8ce1ca290a1d8f9af2650f04cbf0138a697e7572843` |        2.5 GB |
| `evo-worker-stress:current`  | `sha256:dc0c6af2a9d0c245ca9d5174b134a21e73518fea79a0acefabf34bf3a62cc81b` |        884 MB |
| `evo-current-parser:stress`  | `sha256:d0f0678ab869e1bb9819a911eefd9338433259f0702ae8c1ee1abf392fd788b5` |        2.5 GB |
| `evo-current-parser:stress8` | `sha256:b7f9a3aad60740d24657f716a4ae6583ec5df726d406de103348c93555aa2d89` |        2.5 GB |
