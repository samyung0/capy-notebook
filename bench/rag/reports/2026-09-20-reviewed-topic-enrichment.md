# Reviewed-context topic enrichment

Implemented delegated order: parse and figures; Sol source review with corrected excerpts, roles, full synopses and evidence; GLM topic generation from every reviewed excerpt plus the outline; final Sol topic-ID assignment; index and publish. The ordinary Qwen runner retains its prior order. No compact summaries were used.

Audited six published books. An initial full-context GLM pass mostly reused the old catalogs. Independent Sol review identified specific supported gaps with excerpt IDs; an evidence-linked GLM enrichment pass produced the final catalogs. All original catalogs/tags, candidate inputs/outputs, audit findings and assignment artifacts are preserved under `data/knowledge-base/topic-enrichment-2026-09-20/`.

| Book | Topics before | Topics after | Retired version | Current version | Excerpts checked |
| --- | ---: | ---: | ---: | ---: | ---: |
| information-strategies-for-communicators | 6 | 16 | 1 | 2 | 524 |
| information-systems-for-business-and-beyond | 13 | 15 | 1 | 2 | 469 |
| introducing-marketing | 10 | 15 | 1 | 2 | 749 |
| introductory-business-statistics | 17 | 19 | 1 | 2 | 108 |
| operations-management | 8 | 10 | 1 | 2 | 389 |
| physics | 23 | 29 | 2 | 3 | 2416 |

All 4,655 excerpt texts and final topic/role/evidence fields were compared with the new ingest-VM records. Each dashboard API record showed the published version before the previous retained version was retired. Source text and embeddings were unchanged; only topic catalogs and classification/evidence records changed. Non-instructional front matter remains without forced subject topics, with its review provenance retained.

Validation: 12 focused topic and ingest tests passed. Added coverage ensures full reviewed-note preservation, exact unique excerpt coverage, stable boundaries and omission of prior topic IDs from the GLM input. The updated Python files pass Ruff checks.

Operational note: repeated SQLite writer contention required temporarily quiescing scraping during publication. Its previous setting is restored after completion; no scraper implementation was changed. New in-flight books are continuing under the review-first workflow.
