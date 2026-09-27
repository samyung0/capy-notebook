# Pilot syllabus catalogs

Verified against official sources on 2026-09-27. These are Capy topic catalogs,
not official publications or copies of examination questions.

| File | Subject | Topics |
| --- | --- | --- |
| `hkdse.json` | HKDSE Mathematics Compulsory Part | 18 |
| `ielts.json` | IELTS Academic Reading | 11 |

Each JSON has one `exam` and a `subjects` array. A subject contains `topics`.
IDs are stable and namespaced; positions are one-based within their parent.
Every topic has an HTTPS `syllabus_reference`. Labels paraphrase the source
headings. Positions preserve the official learning-unit or question-type order.

HKDSE follows units 1–18 in the EDB [Compulsory Part explanatory notes, updated
December 2021](https://www.edb.gov.hk/attachment/en/curriculum-development/kla/ma/curr/EN_CP_e.pdf).
PDF anchors use physical page numbers, including front matter. Further Learning
Units 19 and 20 concern applying knowledge across units and investigation; they
are documented here rather than turned into extra fixed-content topics.
The [2027 HKEAA assessment framework](https://www.hkeaa.edu.hk/DocLibrary/HKDSE/Subject_Information/math/2027hkdse-e-math.pdf)
also includes junior-secondary prerequisites. The 18-topic catalog is the senior
secondary pilot scope, not a claim to separately catalog all S1–3 content.

IELTS follows the 11 types on the [official Academic Reading format page](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-reading).
Topic 9 retains the official combined summary/note/table/flow-chart grouping.
These are reading task types, not a fixed list of passage subjects.

Start the rendering smoke run with
`hkdse-math-compulsory-functions-and-graphs`, using an original applied quadratic
graph and a numeric part with a prescribed unit. This tests graph assets and
value-only quantity answers. Then cover all 29 catalog topics, about 50 original
questions per topic, through the separate reference, writer and blind-solver
stages. Catalog presence does not mean questions have been generated or published.

Source verification, the 2026 provisional modelling update and scope caveats are
recorded locally in `data/question-bank/pilot-2026-09-27/catalog-sources.md`.
