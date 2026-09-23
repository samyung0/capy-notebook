# Retrieval cases for playground tuning

The current tests do not establish that vector search, lexical search or
language handling are finished. They establish that the tested abstention and
document-opening candidates did not improve completed answers. Exact-name
lookup still takes repeated searches, and the frozen corpus is too small to
settle multilingual ranking. Test a retrieval change against a demonstrated
evidence miss and full-turn recovery cost.

The fresh failures below also happen after the agent receives useful evidence.
They are good prompt/tool-contract cases. No system or tool prompt was edited
while preparing these histories. All fresh cases use Tencent GLM-5.3-Flash,
high reasoning. The earlier cell-biology run is explicitly historical and used
low reasoning.

## Open and rerun

- [Curate playground](http://127.0.0.1:18765/): select the existing `curate`
  config. It keeps the user's saved prompt, Tencent high and 160 tool calls.
- [Workspace playground](http://127.0.0.1:18766/): select `workspace` for the
  author case, or `workspace-gpt20` for the scoped negative case. This separate
  server uses the frozen 29-file, 2,217-chunk lab index with read-only access.
  The two local configs preserve the exact saved chat prompt used in the tests.
  That prompt still includes an AskUser example removed from the current
  application prompt; it was not silently synchronized.

The workspace server also offers a `curate` preset and the authorized read-only
shared library. Its earlier library-disabled setup prevented the curate
checkbox from offering knowledge tools; that local setup is corrected. Select
`curate` to load the saved curate system prompt as well. The checkbox alone
preserves an explicit custom workspace prompt. Material entries in the right
panel now open their saved content in a dialog.

The Runs list contains the IDs below. Opening one restores its conversation,
ledger, available retained evidence and generated materials. It does not replace
the selected config. To test a prompt change from scratch, select the matching
config, copy the original user question from the restored run, use **Clear
conversation**, paste the question and run. To test an edit or follow-up,
keep the restored conversation instead. Save tuned configs under a new name.

If an already-open page predates these imports, its Runs list needs a reload.
Preserve any unsaved prompt edits first. The original history records remain
unchanged; the descriptive IDs are additional local copies.

## Fresh failing cases

| History ID | Observed problem | Pass criterion |
| --- | --- | --- |
| `20260923-chat-author-mixed-format` | Correct author evidence eventually arrives after six searches and one read. The final answer adds prose before its OpenUI program, so it is not a valid structured answer. | Produce valid OpenUI with supported author/affiliation claims. Reduce the recovery calls without losing the evidence. |
| `20260923-chat-gpt20-format` | Correctly says GPT-20 is absent from the selected evidence and labels the suggested correction as GPT-2, but replies in plain Markdown. | Valid OpenUI that keeps the identifiers distinct and respects the selected article. This is not a fabricated GPT-20 answer. |
| `20260923-curate-enzyme-explanation-errors` | The six-question quiz's explanations misnumber distractors. Q3 calls choice 4 an activator even though choice 4 is its correct noncompetitive-inhibitor answer. Q2, Q4, Q5 and Q6 have related contradictions. | Six questions with exactly one valid answer each; key, option wording and every explanation agree. Correct source retrieval alone does not pass this case. |
| `20260923-curate-enzyme-compact-ambiguous` | Q1 says both inhibitors are present together, while its options and explanation compare separate inhibitor conditions. | State the two experimental conditions clearly, or supply an answer about their combined effect. Do not silently change the setup between stem and explanation. |
| `20260923-curate-absence-overclaim` | Correctly avoids inventing a SciPy ODR guide, but claims no library source covers the APIs after a handful of ranked searches. Those searches do not establish exhaustive absence. | Explain that the searches did not find the requested API coverage, and preserve the decision not to fabricate a guide. |

The compact enzyme history records the benchmark-only 20-preview response.
Loading that history does not enable compact search in the interactive server;
new normal curate turns still use the current five-hit search. The question is
useful for output-quality tuning under either search mode.

`20260923-curate-binomial-control` is a supported control, not a failure. It
preserves the source example's n=8, p=0.7, k=5 and probability about 0.254.
Keep it passing while tuning. Source publishing continues on the other machine,
so interactive reruns use the then-current library rather than the benchmark's
fixed database snapshot.

## Subject catalog follow-up

The developer chose a subject-only initial catalog on September 23, with topics
retrieved on demand. After disclosing the wording changes, the application and
saved curate presets now distinguish subject browse calls from topic filters.
The initial catalog contains explicit `browse_knowledge({"subject": "…"})`
calls with counts and no aliases. Subject responses label each `topic_id`.
Only step 3 of the saved system prompt changed.

The live read-only check found 39 subjects, about 654 catalog tokens, and 27
topics under `general-biology`; every returned topic ID passed the library's
topic validator. Port 18766 was restarted and its actual prompt preview and
browser tools array checked. The 57 retrieval-helper tests, Go tool-contract
tests and playground Python self-checks passed.

History `20260923-125820-e03a66` repeats the enzyme request through Tencent GLM
high with the updated curate preset. It completed in 215.5 seconds with one
note and one quiz, using three direct searches and five reads. No unknown-topic
refusal occurred; all searches omitted `topics`, so this run does not exercise
the subject-browse path. Two material writes were refused for unread excerpts;
the agent read the missing evidence and completed both materials. This is a
routing check, not a quiz-quality pass or an application-payload acceptance
check. The existing quiz contract issue below remains open. Receipt:
`bench/rag/reports/local/2026-09-23-subject-browse-check.json`.

## Historical regression

`20260923-curate-cell-biology-keys-historical` restores the user's earlier
advanced Set 2 request, materials and preceding conversation. It is a September
21 Tencent-low run, not a new high-reasoning result:

- Q2 has two valid choices according to its own explanation: all four cells
  are abnormal, and two lack the chromosome while two have doubled copies.
- Q3 marks C, trisomy 18, while its explanation selects B, autosomal monosomy.
- Q10 marks B, 25%, while its explanation selects C, more than half.

Use it to test a follow-up repair, or recreate its preceding request context
before testing fresh generation. A pass requires corrected keys and a
single-answer Q2, not just a statement that the quiz was checked.

## Application acceptance is a separate gate

All four fresh enzyme/ecology quiz payloads fail the actual application's
`materialdoc.QuizDocument` converter at `questions[0]: id is required`. The
playground's local writer saves them anyway. The exposed tool schema permits
arbitrary question objects and refers to the quiz generator's shape without
showing that shape.

The mismatch goes beyond the missing ID. These outputs use `question`, string
options and `answer`; the application expects `id`, a supported `type`,
`level`, `prompt`, option objects and `correct` in its defined shape. Therefore
the local “create_material succeeded” line is not application acceptance.

Recommended implementation follow-up: expose the actual quiz input contract
and apply equivalent validation in the playground. No contract or prompt fix
was made in this test. Prompt experiments can improve the content, but count
valid application payloads separately from locally saved JSON.

The [workspace report](2026-09-23-workspace-terminal-tencent.md) describes the
terminal-instruction experiment and why it remains unpromoted. The
[curate comparison](2026-09-23-knowledge-compact-tencent.md) records the current
and compact-search turns, source checks and costs.

## Local restart

The workspace server's ignored launcher and presets are under
`lab/playground/local/`. From the repository root, with the existing lab tunnel
available, restart it with:

```sh
.venv/bin/python lab/playground/local/start-workspace-review.py
```

It verifies the frozen source/chunk hashes and read-only transaction setting
before serving port 18766. Curate continues on the existing port 18765 server.
All generated materials and imported histories stay local.
