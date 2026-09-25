# Deferred Office benchmarks and UAT hardening

The 2026-09-25 Office storage round measured storage multipliers, reparse model
costs and summary reuse with one-off probes. Reports, prototype patches and the
probe scripts are kept in `artifacts/2026-09-25-office-storage/`. The scripts
still import the headless bundle and each other through scratch paths, so they
are reference material, not a runnable benchmark. The developer plans to harden
UAT after the storage round; these items belong to that pass.

## `bench/office` family

Create it with the standard layout (`scripts/`, `fixtures/`, `reports/`) and
register it in `bench/README.md` and the benchmark table in `AGENTS.md`.

- Storage: seed, baseline and pending-change bytes per fixture and format, the
  charge after first Edit open and at the refresh peak under the quota rule
  (source plus pending effects plus growth beyond the seed). Start from
  `probes/storage/` and `probes/cross-shrink/`.
- Large spreadsheets in WASM: seed, open, one-cell commit, checkpoint save and
  export at 10k, 50k and 100k cells. Start from `probes/xlsx-lazy/`.
- Collaboration service cost per incoming update and browser draft write cost
  per keystroke.
- WASM sizes of the viewer and editor builds against the previous pin.

The fork's golden seed and state-size budget tests land with the storage round.
This family adds the numbers that are too slow or too large for CI.

## UAT hardening

- Performance and stress tests for collaboration: many editors in one Office
  room and one Plate room, sustained typing, reconnect storms.
- Large Office files near the plan limits: open, edit, save and publish times.
- Publication under concurrent editing: the flush and rebase path with several
  active editors, including a slow or disconnecting one.
- A rehearsal of the seed-changing upgrade window on UAT: pause editing,
  publish every file with pending edits, deploy, bump epochs and reseed.

## Late merge of old-epoch edits

Today a client that was disconnected while a publication completed goes to
recovery and can only download its unsaved edits. Merging them instead needs
the previous source and the final old-epoch state kept for a grace period, and
the late updates rebased with the same rebase publication uses. This becomes
necessary when offline editing is built; until then the handoff's flush covers
every connected editor.
