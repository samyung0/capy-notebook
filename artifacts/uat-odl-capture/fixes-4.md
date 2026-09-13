# ODL implementation follow-ups, 2026-09-13

This round implements the five follow-ups approved after `fixes-3.md`. Changes
are in the shared main worktree and remain uncommitted. UAT rollout is separate.

1. Unique short prose survives chunk boundaries. Overlap-only tails are omitted,
   and overlap cannot jump across an oversized block. Source-proved decimal and
   Roman folios are filtered before packing. The saved Hong Kong golden remains
   untouched: 198 old chunks are exact, two lose stale duplicate prefixes, and
   two short source chunks are newly retained.
2. Four new publisher families were frozen before viewing parser output: 67
   native pages, 12 selected pages, 41 checked rows and four derived raster
   controls. A production-flag-matched Java baseline and current candidate are
   compared with the same gold. The set measures preservation and exposes
   remaining gaps; it does not demonstrate new repair gains.
3. Mixed native tables retain source-proved rows, explicit captions/units/notes
   and scoped literal styles. Review removed unsafe nearest-row attachment and
   unrelated caption prose. The final development replay retains 34/39 original
   structured rows plus five BERT rows, with all 53 retained style cells in scope.
   The five uncertain French rows remain in native text.
4. Fresh OCR uses pinned PP-DocLayoutV3 region ordering only when every line maps
   to exactly one region. Missing or competing regions leave the whole page in
   its original order. Text, confidence, geometry and within-region order remain
   intact. The 17 earlier geometries remain regression tests.
5. Real local parser HTTP, bundle receipts, indexing, hybrid retrieval, source
   capture and structured citations are exercised by an opt-in test with
   disposable SQL/Redis and deterministic model substitutes. Container tests
   exposed and repaired non-root package permissions, loss of OOM supervision
   when Python itself died, cancellation bypassing admission/deadlines, and
   duplicate image files consuming the bundle entry budget. Parse work now runs
   in a persistent child, supervised by the API. Byte-identical images share one
   file while every image occurrence keeps its coordinates and source bytes.

The final offline suite passes 688 tests. The 610-page textbook publishes in
167 seconds with all 17,821 image occurrences retained in 2,322 image files,
under the unchanged bundle limits. Final FIFO, timeout, OOM and application
integration checks pass. Independent review and limited rechecks
passed the scoped corrections. Detailed runtime outcomes, raw failures,
resource limits and the integration boundary are recorded in the
[implementation report](../../bench/parsers/reports/2026-09-13-odl-implementation.md).
The [new-source validation report](../../bench/parsers/reports/2026-09-13-odl-repair-validation.md)
keeps the unchanged gold, comparable baseline, runtime hashes and unscored
dimensions explicit.

The remaining quality gaps include the flattened MDPI table, Frontiers table
continuation ordering and unsupported French wrapped-cell associations.
Header semantics and OCR character accuracy are not certified by these tests.
No UAT deployment, shared ingest-host operation, live database mutation or paid
model call was made.
