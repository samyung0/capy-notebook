# One Sol owner through book review and topics

The delegated knowledge-builder workflow now keeps topic proposal and final
topic assignment with the Sol medium agent that owns source review. GLM is not
required between those stages. Parsing, taxonomy validation, indexing and
publication still use their existing programs; the owner drives them.

`lab/knowledge/topics.py --export-context` exports the current subject catalog,
outline, full reviewed notes, proposal rules and pinned input hashes.
`--proposal` accepts the owner's artifact and uses the existing ID/label/alias
merge and 96-topic cap without a model call. It rejects stale book/subject/source/
corpus/review bindings, invalid proposal schema, unknown reused IDs and missing
model provenance. Subagent token usage is recorded as unknown.

The same owner then uses the merged topic IDs for final tags. This preserves the
useful review context while keeping shared catalog decisions explicit. Long
books still require saved artifacts and, when review was split, an owner that
assembles every scope. Conversation memory is not the source of record.

The `kb` heartbeat and review contract were updated. Its fifteen-minute schedule
and **PAUSED** state remain unchanged. The ordinary dashboard runner and automatic
scraper retain their existing model paths. The application's live retrieval and
material-writing agent is also a separate use of a model; the GLM low/high
comparison does not determine which model should propose builder topics.

## Bounded Sol medium trial

A fresh Sol medium agent received the existing full review of the 58-excerpt
*Chinese Contract Law* course unit and the current contract-law catalog. It read
all reviewed records and inspected selected canonical passages, reused the
three existing topics, proposed none, and assigned every excerpt.

The first assignment artifact had valid topic IDs but left empty topics on four
passages whose old roles still described teaching content. The parent caught
this incompatibility during final-tag review. The same Sol owner then inspected
physical PDF pages 1–6 and corrected five administrative passages, including the
contents page, to `non_teaching` with no topics. It preserved the adjacent
substantive introduction and all full synopses, evidence and retrieval fields.

The resulting candidate passed the pilot's tag validator: **58 tags, zero review
items, all evidence verified**. Six excerpts are non-teaching, including one
already classified that way. The parent independently checked complete ID
coverage, assignments and unchanged full-note/evidence/retrieval fields.
The trial used no GLM call and changed no canonical tags or published version.

This establishes that Sol can carry the topic and final-tag steps with the
review artifacts available. It does not establish unattended whole-library
accuracy: this was one short course unit, the catalog already covered its main
content, and the first final-tag candidate needed feedback. Novel-topic quality
and very large books remain less tested. Deterministic validation is still needed
even when the same agent owns the whole assignment.

## Verification and evidence

Nine focused topic/importer tests passed, including a test that forbids model
calls during context export and proposal import, preserves full notes, and
rejects stale review input, unknown IDs and malformed topic proposals. Python
formatting and linting passed.

- [Trial receipt and artifact hashes](2026-09-21-sol-topic-owner/receipt.json)
- [Sol proposal](2026-09-21-sol-topic-owner/proposal.json)
- [Merged candidate catalog](2026-09-21-sol-topic-owner/topics-candidate.json)
- [Final topic assignments](2026-09-21-sol-topic-owner/assignments.json)
- [Source-page inspection and final-tag validation](2026-09-21-sol-topic-owner/verification.json)
- [Sol's assessment](2026-09-21-sol-topic-owner/assessment.md)
- [Current review contract](../../../lab/knowledge/review.md)

Full reviewed context and the complete candidate tag file remain under the
ignored `data/knowledge-base/sol-topics-trial-2026-09-21/` directory.
