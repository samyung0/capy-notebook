# Syllabus catalogs

These are Capy topic catalogs, not official publications or copies of
examination questions. Rule (Epo, 2026-10-02): a topic uses the exact official
name when the syllabus has one; otherwise it gets a name we choose to be useful
to learners.

| File | Subject | Topics |
| --- | --- | --- |
| `hkdse.json` | HKDSE Mathematics Compulsory Part | 18 learning units |
| `ielts.json` | IELTS Academic Reading | 7 passage subject areas |

Each JSON has one `exam` and a `subjects` array. A subject contains `topics`.
The exam also carries `full_label`, a 12 to 15 word `description` (shown under
the name on the exam strips, cut after two lines) and an optional `cover` for
the bank's exam switcher (fields in `openwiki/question-bank.md`, Exam switcher and covers);
`go run ./cmd/bank exams ../lab/questions/syllabi` from `server` writes them, and
a new exam without a cover gets a default one picked from its id. A paper cover's colour is the paper itself: #fbf9f3, #ffffff, #eceef1 or #f8efc9.
IDs are stable and namespaced; positions are one-based within their parent.
Every topic has an HTTPS `syllabus_reference`.

**HKDSE** topics are the 18 Compulsory Part learning units, labelled with the
exact names in the EDB Mathematics Education KLA Curriculum Guide (2017), page 25,
and anchored to the [Compulsory Part explanatory notes, updated December 2021](https://www.edb.gov.hk/attachment/en/curriculum-development/kla/ma/curr/EN_CP_e.pdf)
(PDF anchors use physical page numbers). Further Learning Units 19 and 20 are not
topics. The assessment framework also assumes the S1–3 curriculum; Epo kept
those units out of the catalog (2026-10-02), so junior content appears only
inside senior topics.

**IELTS** publishes no content syllabus. Topics are passage subject areas chosen
from the 24 passages in Cambridge IELTS 19 and 20 plus areas older tests use.
A bank question is one full passage in the real section 1, 2 or 3 pattern,
filed under its subject area. The task types on the [official Academic Reading
format page](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-reading)
are not stored: learners and the chat agent filter by the parts' answer types
(Epo, 2026-10-06).

Generation status is in `todo-question-bank.md` at the repository root.
Catalog presence does not mean questions have been generated or published.
