# Question-bank search: keyword against embeddings

Date: 2026-10-04. Script: `bench/rag/scripts/bank_search.py`. Data: a local
restore of `bank-2026-10-03-before-round2.dump` (1,098 pilot questions: 900
HKDSE Mathematics in 18 topics, 198 IELTS Academic Reading in 11 task-type
topics). The live bank was not touched.

## Method

26 learner-style requests, each naming the topic or topics a useful hit belongs
to. Relevance is judged at the topic level, which is what the agent needs from a
search before it reads a question. Question text is the stem and part blocks,
without solutions or marking schemes.

- **Keyword:** Postgres full-text search (`english`), the query's words ORed,
  ranked by `ts_rank_cd`.
- **Embedding:** Qwen3-Embedding-4B on DeepInfra (the library's model), the
  query with the instruction "Given a study request, retrieve exam questions
  that practise it", cosine similarity over all questions.

## Results

| | Precision@5 | Hit@10 |
| --- | --- | --- |
| Keyword, all 26 | 0.38 | 0.85 |
| Embedding, all 26 | 0.71 | 0.85 |
| Keyword, 19 maths concepts | 0.37 | 0.79 |
| Embedding, 19 maths concepts | 0.89 | 1.00 |
| Keyword, 7 IELTS task types | 0.40 | 1.00 |
| Embedding, 7 IELTS task types | 0.20 | 0.43 |

Embeddings find the concept a maths request names even when the wording
differs ("what happens to the variance when every value doubles", "discriminant
and the nature of roots", "remainder theorem and factors of a cubic": keyword
0.0, embedding 1.0). Keyword search matches surface words such as "equation" or
"points" across topics.

IELTS task-type requests ("true false not given", "choose the correct heading")
fail with embeddings because each question carries a long passage that dominates
its vector; the instruction text is a small share. Keyword search does better
but is still weak.

## Decision for the tool

- Rank by embedding similarity.
- Filter by exam, topic and question type in SQL before ranking. Round 2 stores
  IELTS task types per question in `questions.question_types`, so a task-type
  request is a `types` filter, not a text match.
- Embed the question text without solutions, as here.

Open for phase 2: where the vectors live. The playground embeds bank questions
on first use and keeps them in memory; production should store them in the bank
database at publication, so a search never waits on embedding.

## Superseded (2026-10-04)

Epo chose listing over search: the syllabi are fixed and the exams well known,
so `list_question_bank` walks exams and subjects, a subject's topics, then a
topic's questions 50 per page. A request such as "practise my English
comprehension" reached IELTS reading with search too (7 of the top 10), but
statistics questions that mention "an English test" crept in and one passage
filled most of the top five. Revisit search when topics outgrow a few pages.

