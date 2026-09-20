# Topic context trial

Compared two fresh GLM-5.3-Flash calls for Operations Management, with the same
subject, empty existing topic catalog, 86 parsed outline entries, schema and
base topic instructions. The enriched arm added all 389 Sol-reviewed excerpt
synopses, roles, evidence quotes, section paths and pages. It omitted existing
topic IDs to reduce circular copying. Both outputs passed the existing merge
validation. No experimental topics or tags were imported.

| Input | Topics | Input tokens | Output tokens | Seconds |
| --- | ---: | ---: | ---: | ---: |
| Outline only | 5 | 3,009 | 649 | 5.27 |
| Outline plus reviewed excerpts | 12 | 46,996 | 2,400 | 17.73 |

The outline arm combined World Class Manufacturing with OEE, scheduling with
JIT, and enterprise risk with packaging. The enriched arm separated those
areas and added distinct manufacturing-system design, scheduling
metaheuristics, mixed-model JIT scheduling and e-commerce packaging topics.
These distinctions correspond to the supplied chapters and excerpts. For
example, reviewed excerpts on PDF pages 169-170 support CONWIP and POLCA in
the JIT scope; page 172 supports mixed-model sequencing and Goal Chasing.
This is a qualitative specificity improvement, not a measured retrieval gain.

Recommendation: review and repair source text first; produce excerpt roles,
short content summaries and source evidence without requiring canonical topic
IDs; then generate/reuse topics from the outline and compact content notes;
finally assign topic IDs to corrected excerpts. Current tagging requires
topic IDs, so moving the entire topics stage after unchanged tagging creates
a dependency cycle. Using every summary costs about 15.6 times the input
tokens here; a compact per-section summary is a candidate for a follow-up
test, not a tested substitute.

Limitations: one book and one call per arm; no human gold topic list or
retrieval evaluation. Existing summaries were created while Sol knew the old
topics, so hiding topic IDs does not remove all prior-topic influence. The
enriched arm adds an instruction explaining the additional context. The
trial does not establish improved accuracy, alias reuse across an existing
catalog, or best topic count. More topics alone is not a quality metric.

Runner: `bench/rag/scripts/knowledge_topic_context_trial.py`.
Raw inputs and outputs: `bench/rag/reports/2026-09-20-topic-context-trial/`.
