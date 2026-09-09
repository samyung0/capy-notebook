# Native PDF geometry inside MinerU

Developer Epo authorized isolated VM tests and benchmark code to avoid unnecessary
MinerU model passes using reliable PDF text and geometry, with Astra xhigh
subagents and a comparison against the improved Java structural/Qwen experiments.
Production parser behavior stays unchanged. No persistent upstream fork is needed
for the first experiments; version-bound hooks can test the changes in an isolated
runtime before deciding whether a maintained fork is justified.

## Arms

- Fresh unmodified MinerU 3.4.5 with the current Capy adapter and retained models.
- Native text-region geometry inside MinerU's existing neural page layout,
  bypassing text detection only when source characters and placement pass checks.
- Conservative whole-page native geometry that bypasses model analysis while
  retaining MinerU's downstream document reconstruction.
- A combined candidate only if the individual paths demonstrate useful gains
  without new source-quality failures.

Native routing rules use source properties, not filenames, expected answers or
known benchmark page IDs. Scans and ambiguous content retain the existing model
path. Each run records selected/skipped work and reasons. Failed candidates remain
in the evidence. Model weights, lane count, processing windows and caption scope
are held fixed when measuring the bypass itself.

## Execution and evidence

Use `/opt/capy-mineru-native-20260909` on `159.195.61.195`, separate containers,
no exposed ports, eight CPUs and 14 GiB RAM. Read the frozen source corpus and
model cache from the September 8 experiment without modifying them. Only one
measured workload runs on the VM at a time. Check host state before starting;
production, UAT and local services share the machine when active.

Start with a fresh screen baseline and focused digital/scan comparisons. Test
revisions on the same source probes and inspect changed content, tables, formulas,
reading order, page attribution and figure artifacts. Promote only candidates
with explained output changes. Then run intact documents and a long document,
and repeat useful capacity comparisons. Separate cold startup from warm work.
Use small synthetic adversarial pages for geometry guards without encoding
corpus-specific answers into the routing rules.

Root owns VM scheduling, the runner, comparison and report. One Astra worker owns
`mineru_native_text.py` and its focused check; another owns `mineru_native_page.py`
and its focused check. The reused benchmark reviewer owns read-only evidence
assessment. Benchmark code and checks live under `bench/parsers/scripts`; artifacts
live under `bench/parsers/reports/local/2026-09-09-mineru-native`.

## Comparison with Java and captions

The latest structural Java arm passes the frozen screen probes, but its intact
result reuses 36 page responses and has 160 unexecuted selected captions. It has
no measured complete new latency. Keep this separate from the older 480.64-second
Java/Qwen literal-prompt run. That older measurement includes 390.66 seconds of
Qwen work and is not a timing result for the structural candidate.

Compare native extraction first. Compare output quality using identical saved
caption requests only when the source image, prompt and model options match,
labeling offline replay explicitly. Measure or report caption cost separately;
do not add historical provider times and call the sum a fresh end-to-end run.
MinerU figure captions and Java page-recovery captions can have different counts
and information requirements, so neither is automatically a common fixed cost.
New provider calls, if available and useful, use the established Qwen3.8 Flash
configuration with bounded request counts and recorded receipts.

Stop an approach when measured quality regressions outweigh its speed gain or
when generic safe eligibility leaves negligible work to skip. Iterate promising
failures and then compare the best completed candidate. No claim of a global
performance optimum or quality equivalence follows from a few source probes.
