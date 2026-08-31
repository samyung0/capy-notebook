# Evo ingest 1 benchmark results: 2026-08-31

This directory collects the small raw logs, resource samples, and result
manifests for the 2026-08-31 ingest-host capacity tests. The decision record is
[`../../netcup-2026-08-31-stress.md`](../../netcup-2026-08-31-stress.md).

The generated PDFs, 32 to 120 MiB content-list fixtures, parser bundles, Docker
images, and model cache remain on `evo-ingest-1`. The generated input and spool
directories total about 1.6 GiB and are reproducible from the scripts in
`bench/parsers`. `artifact-inventory.md` records their VM paths and the retained
Docker images separately.

`raw/` is a copy of `/opt/evo-ingest/stress-results/` from the VM. It contains
the parser concurrency samples, failure-injection logs, worker cgroup samples,
container exit states, and cache-hit worker runs that the VM harness persisted.
`supplemental-results.json` records the later console-only memory and overlap
measurements that the first harness version did not write to a file.

Files:

- `machine.md` identifies the VM and its measured hardware and software.
- `artifact-inventory.md` records what was copied and what remains on the VM.
- `raw-sha256.txt` checks every imported raw result file.
- `supplemental-results.json` preserves the later memory and overlap results.
