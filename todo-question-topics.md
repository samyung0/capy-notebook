# Topics on questions

Epo's request (2026-11-15): a quiz can cover more than one topic, so each
question should carry its own topic, and item bank questions should show it
apart from their free tags. Copied from Canvas, where a question's tags are
for search only and mastery comes from a separate link to a course outcome
(our topic).

Status: **built 2026-11-15 (steps 1–3), uncommitted; several topics per question decided 2026-11-15, building.** Mock: https://claude.ai/artifact/TKzdwqtxLWRoiAzkFrzDXs (2026-11-15).

## Today

- A file (quiz included) has one `materials.topic_id`; the Topics tab groups
  files by it.
- Questions carry no topic. Mastery (topic labels, Still missing, suggested
  reviews, topic sessions) reads the quiz's topic, so a quiz spanning topics
  counts wholly to one (`study-progress.md`, "A question's topic is its
  quiz's").
- `answer_events` name the quiz and question but no topic, so answers on a
  deleted quiz count toward no topic.
- Item bank questions carry free tags only.

## What changes

1. **A question's topic.** Each question in the shared question format gets
   an optional `topicId`: one of its workspace's topics. Empty means "the
   quiz's topic", so every existing question keeps counting exactly as now
   and a single-topic quiz needs no work.
2. **The quiz keeps its own topic** as where the file sits (Topics tab, Files
   tree), like any file. What it *covers* is its topic plus its questions'
   topics, shown as "Membranes & transport +1" in Practice and the
   Assignments table.
3. **Mastery reads the question's topic.** Topic labels, Still missing,
   suggested reviews and topic sessions count each question under its own
   topic (falling back to the quiz's). Changing a question's topic moves its
   past answers with it, as moving a quiz does today.
4. **Answers remember their topic.** `answer_events` store the topic at
   answer time, read only once the quiz is deleted, so deleted quizzes'
   answers still count toward a topic.
5. **Tags stay separate.** Tags are free text for search and filtering and
   never count toward mastery (Canvas: tags vs outcomes).
6. **Item banks.** A workspace bank question has a topic from that
   workspace's topics, shown as a coloured badge before its plain tags, with
   a Topic filter beside Tags. Copying it into a quiz keeps its topic.
7. **A topic that goes away.** Deleting a topic, or moving a quiz to another
   workspace, leaves its questions' own topic ids in place but reads ignore
   them, so they follow the quiz's topic again; a quiz moved back counts them
   again (Epo 2026-11-15, after review: keep read-time ignoring).

## Decided (Epo 2026-11-15, "go with suggestions")

- **Q1. Board A:** a question's topic is a Topic field beside Answer type and
  Marks, its list starting with "Quiz's topic".
- **Q2. My bank keeps the topic as a plain tag** (its name); a question copied
  from My bank into a class quiz follows that quiz's topic.
- **Q3. No model-picked topics for now:** generated and converted questions
  follow the quiz's topic; the generate and convert prompts stay as they are.

## Several topics per question (Epo 2026-11-15)

"i think let a quesiton have multiple topics, i mean thats most cases anyway",
after Canvas's per-question Align to Outcomes (one or more outcomes per
question) was compared. Picks from board "Several topics per question" on the
question editor mock (https://claude.ai/artifact/Gyj7hBmGVJ3bRqoxNttQVQ):

- **Field as drawn:** the card footer's Topic becomes a Topics multi-select:
  "Quiz's topic" first (ticking it clears the question's own topics), then
  the workspace's topics with checkboxes; the trigger shows the names joined
  with commas. The bank dialog's Topic field is the same control.
- **Counts fully under each topic** (as Canvas counts a question toward every
  aligned outcome): labels, Still missing, suggested reviews and topic
  sessions take the question under every one of its topics. A question with
  topics of its own counts under those, not the quiz's.
- **At most 5 topics a question.**
- **Bank:** a class bank question shows a coloured badge per topic before its
  tags, and the Topic filter matches a question carrying any picked topic;
  into My bank every topic's name becomes a plain tag.
- Format: `topicIds` (an array, at most 5, no duplicates) replaces
  `topicId`; empty or absent means the quiz's topic. No compat shim (no
  legacy data).

## Order

1. Question format `topicId`, editor field (Q1), Practice/Assignments
   "covers" display.
2. Mastery reads question topics; `answer_events.topic_id`.
3. Item bank topic badge, Topic filter, copy keeps the topic; My bank rule
   (Q2).
