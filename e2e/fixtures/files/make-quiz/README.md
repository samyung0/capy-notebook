# Make a quiz fixtures

Small invented papers with no exam text, account or provider data. Regenerate them with
`uv run --no-project --with python-docx --with python-pptx python e2e/fixtures/files/generate_quiz.py`.

| Input | Content and intended check |
| --- | --- |
| paper.docx (37 KB) | Two Letter pages split by a page break. Page 1: the title `Harbour Town practice sheet`, `Sheet code: UAT_RUN_MARKER`, question 1 (a ferry, answer 23) and question 2 (a lighthouse, answer 10). Page 2: question 3 (pears, answer 28). The pages step draws two standing pages, and a run picking page 1 finds questions 1 and 2 alone. |
| paper.pptx (29 KB) | Two 4:3 blank-layout slides with one text box each, holding the same text: slide 1 the title, sheet code and questions 1 and 2, slide 2 question 3. The pages step draws two lying pages, with the same check. |

The UAT runner replaces `UAT_RUN_MARKER` in an in-memory copy before uploading, so each run
parses new bytes. The mock's spec uploads the file as it is here.
