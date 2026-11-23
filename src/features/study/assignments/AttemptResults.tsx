import { type ReactNode, useEffect, useState } from 'react';
import { useMarkAssignmentAnswer } from '@/api/hooks';
import type {
  Assignment,
  AssignmentAttempt,
  AssignmentGradedPart,
  AssignmentGradedQuestion,
} from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { userToast } from '@/components/ui/userToast';
import { formatFileSize } from '@/features/files/fileUtils';
import { AiWarning } from '@/features/questions/AiWarning';
import {
  QuestionBlockView,
  QuestionView,
  TextView,
} from '@/features/questions/QuestionView';
import { hasSample, SampleView } from '@/features/questions/SampleBlock';
import type {
  Question,
  QuestionBlock,
  QuestionPart,
} from '@/features/questions/types';
import { modelMarked, questionMarks } from '@/features/questions/types';
import { ReviewedDrawing } from '@/features/quizzes/drawing/DrawingAnswer';
import { type Answer, formatPoints } from '@/features/quizzes/grade';
import { GapText, QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { questionLine } from '../practice/practiceText';
import { PracticeFrame } from '../practice/studyPage';
import { studyLink } from '../studyRoutes';
import { BackToAssignments, type ProfileOrigin } from './AssignmentAttemptPage';
import { PreviewDialog } from './AssignmentPreview';
import {
  dayLabel,
  markText,
  OUTCOME_LABEL,
  OUTCOME_SQUARE,
  type Outcome,
  percentText,
  questionOutcome,
  questionPaperOf,
} from './assignmentText';
import { SubmissionFileList, useOpenSubmissionFile } from './HandIns';
import { LateBadge } from './LateBadge';
import { QuestionPaperCard, QuestionPaperView } from './LazyPaper';
import { MarkField } from './MarkField';
import { MarkingNow } from './MarkingNow';
import { SectionLabel } from './todoParts';
import { useAssignmentStart } from './useAssignmentStart';

const OUTCOME_CHIP: Record<Outcome, string> = {
  partly: 'bg-tint-warning text-tint-warning-fg',
  right: 'bg-tint-success text-tint-success-fg',
  waiting: 'bg-page-hover text-fg-secondary',
  wrong: 'bg-tint-error text-tint-error-fg',
};

const CHIP =
  'inline-flex h-5.5 items-center rounded-md px-1.75 font-semibold text-xs';

/** Full, Partly or None against a marking point. */
function ItemChip({ awarded, marks }: { awarded: number; marks: number }) {
  const outcome: Outcome =
    awarded >= marks ? 'right' : awarded > 0 ? 'partly' : 'wrong';
  return (
    <span className={cn(CHIP, OUTCOME_CHIP[outcome])}>
      {awarded >= marks
        ? m.assignment_item_full()
        : awarded > 0
          ? m.practice_outcome_partly()
          : m.assignment_item_none()}
    </span>
  );
}

/** Results (A5): the mark top right, then right, partly and wrong with
 * Practise again, then every question, opening to its answer. The class's staff
 * reach the same layout from the report's Members tab (G3m) and can change any
 * mark there. */
export function AttemptResults({
  assignment,
  attempt,
  fromProfile,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  fromProfile?: ProfileOrigin;
}) {
  if (attempt.gradesHidden)
    return <HiddenResults assignment={assignment} attempt={attempt} />;
  return (
    <MarkedResults
      assignment={assignment}
      attempt={attempt}
      fromProfile={fromProfile}
    />
  );
}

/** Results while grades wait for release (S7): the questions with whether
 * each was answered, and no marks, outcomes, comments or keys; a file's
 * graded quiz, its files. */
function HiddenResults({
  assignment,
  attempt,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
}) {
  const { postedBy } = assignment;
  const questions = attempt.questions as AssignmentGradedQuestion[];
  const answered = (q: AssignmentGradedQuestion) =>
    q.parts.some((part) => {
      const value = attempt.answers[part.id];
      return value !== undefined && value !== null && value !== '';
    });
  return (
    <PracticeFrame>
      <div className="flex w-full flex-col">
        <BackToAssignments />
        <h1 className="t-page-title mt-3">{attempt.title}</h1>
        <p className="t-meta mt-0.5 text-fg-muted">
          {m.assignment_submitted_on({
            date: attempt.submittedAt ? dayLabel(attempt.submittedAt) : '',
          })}
        </p>
        <p className="t-meta mt-4 rounded-lg bg-page-hover px-3 py-2.5 text-fg-secondary">
          {postedBy
            ? m.assignment_grades_hidden_note({ name: postedBy })
            : m.assignment_grades_hidden_note_anon()}
        </p>
        {assignment.paperFile ? (
          <PaperQuizFiles
            assignment={assignment}
            attempt={attempt}
            staff={false}
          />
        ) : (
          <ol className="mt-4 border-divider border-t">
            {questions.map((question, i) => (
              <li
                className="grid min-h-10 grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 border-divider border-b"
                key={question.id}
              >
                <span className="t-meta font-bold text-fg-muted">{`Q${i + 1}`}</span>
                <span className="truncate">
                  <TextView
                    className="whitespace-nowrap"
                    marks
                    text={questionLine(question as Question)}
                  />
                </span>
                <span className="t-meta text-fg-muted">
                  {answered(question)
                    ? m.assignment_answered()
                    : m.assignment_blank()}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </PracticeFrame>
  );
}

/** A file's graded quiz's results (Epo 2026-11-20, mock
 * QEetGvcmf2vvkVfqcYAKLz boards 6 and 7, as Canvas and Classroom show a
 * hand-in): the comment on its one question as Feedback, then the files
 * handed in and the question paper; no question row, a file being no
 * question (Epo: "a file is not a quiz question"). Staff get its Grade in
 * the Feedback's place. */
export function PaperQuizResults({
  assignment,
  attempt,
  onSaved,
  staff,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  /** Grading: on to the next member once the mark is saved. */
  onSaved?: () => void;
  staff: boolean;
}) {
  const question = (attempt.questions as AssignmentGradedQuestion[])[0];
  return (
    <>
      {staff && question ? (
        <PaperGrade
          assignment={assignment}
          attempt={attempt}
          onSaved={onSaved}
          question={question}
        />
      ) : (
        question?.comment && (
          <section
            aria-label={m.assignment_feedback()}
            className="mt-6 flex flex-col gap-2.5"
          >
            <SectionLabel>{m.assignment_feedback()}</SectionLabel>
            <CommentLine question={question} />
          </section>
        )
      )}
      <PaperQuizFiles assignment={assignment} attempt={attempt} staff={staff} />
    </>
  );
}

/** Staff's Grade for a file's graded quiz: one mark out of its total and the
 * comment its member reads as Feedback, saved as Grading saves them (its one
 * part's one marking point). */
function PaperGrade({
  assignment,
  attempt,
  onSaved,
  question,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  onSaved?: () => void;
  question: AssignmentGradedQuestion;
}) {
  const [part] = question.parts;
  const savedMark = !part || part.pending ? null : (part.itemAwards?.[0] ?? 0);
  const savedComment = question.comment ?? '';
  const [mark, setMark] = useState(savedMark);
  const [comment, setComment] = useState(savedComment);
  // A mark saved here or in Grading: the fields follow, as GradeField's do.
  useEffect(() => {
    setMark(savedMark);
    setComment(savedComment);
  }, [savedMark, savedComment]);
  const { mutate, isPending } = useMarkAssignmentAnswer(
    assignment.workspaceId,
    assignment.id
  );
  if (!part) return null;
  // Saving signs the comment, so an untouched Save would re-sign it.
  const changed = mark !== savedMark || comment.trim() !== savedComment;
  const save = () =>
    mutate(
      {
        attemptId: attempt.id,
        mark: {
          comment: comment.trim(),
          parts: [{ items: [mark ?? 0], partId: part.id }],
          questionId: question.id,
        },
      },
      {
        onError: (error) =>
          userToast({
            title: errorCopy(error, m.assignment_mark_failed()),
            variant: 'error',
          }),
        // Grading moves on instead, as its Approve does.
        onSuccess: () =>
          onSaved
            ? onSaved()
            : userToast({
                title: m.assignment_mark_saved(),
                variant: 'success',
              }),
      }
    );
  // Grade, then the comment under the Feedback its member reads it as.
  return (
    <>
      <section
        aria-label={m.assignment_col_grade()}
        className="mt-6 flex flex-col gap-2.5"
      >
        <SectionLabel>{m.assignment_col_grade()}</SectionLabel>
        <MarkField
          className="self-start"
          label={m.assignment_grade_of({ name: attempt.userName })}
          marks={part.marks}
          onChange={setMark}
          value={mark}
        />
      </section>
      <section
        aria-label={m.assignment_feedback()}
        className="mt-6 flex flex-col gap-2.5"
      >
        <SectionLabel>{m.assignment_feedback()}</SectionLabel>
        <Input
          aria-label={m.assignment_comment_for({ name: attempt.userName })}
          onChange={(event) => setComment(event.target.value)}
          placeholder={m.assignment_comment_for({ name: attempt.userName })}
          value={comment}
        />
        <div className="flex justify-end">
          {/* The mark field's height, as Grade's Save (GradeField). */}
          <Button
            className="h-8"
            disabled={isPending || mark === null || !changed}
            onClick={save}
            size="sm"
          >
            {m.assignment_save_marks()}
          </Button>
        </div>
      </section>
    </>
  );
}

/** A file's graded quiz's Your answers (staff's Answers), each opening on its
 * signed link, and its question paper, opening in the workspace's viewer as
 * Preview does. */
function PaperQuizFiles({
  assignment,
  attempt,
  staff,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  staff: boolean;
}) {
  const answers = staff ? m.assignment_answers() : m.assignment_your_answers();
  const open = useOpenSubmissionFile({ attemptId: attempt.id });
  const [reading, setReading] = useState(false);
  const paper = questionPaperOf(assignment) ?? null;
  return (
    <>
      <section aria-label={answers} className="mt-6 flex flex-col gap-1">
        <SectionLabel>{answers}</SectionLabel>
        {attempt.paperFiles.length === 0 && (
          // Submitted with none, or deleted from Files after.
          <p className="t-meta text-fg-muted">{m.assignment_paper_none()}</p>
        )}
        <SubmissionFileList
          files={attempt.paperFiles}
          meta={(file) => formatFileSize(file.sizeBytes)}
          onOpen={(file) => void open(file)}
          removing={false}
          results
          uploading={[]}
        />
      </section>
      <QuestionPaperCard
        className="mt-6"
        file={paper}
        onOpen={() => setReading(true)}
      />
      {/* Gone while open (trashed, unshared): the dialog goes with it. */}
      {reading && paper && (
        <PreviewDialog
          onClose={() => setReading(false)}
          title={m.assignment_question_paper()}
        >
          <QuestionPaperView file={paper} named />
        </PreviewDialog>
      )}
    </>
  );
}

function MarkedResults({
  assignment,
  attempt,
  fromProfile,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  fromProfile?: ProfileOrigin;
}) {
  const staff = !!assignment.manage;
  // A file's graded quiz reads as a hand-in, to its member and its staff.
  const paperQuiz = assignment.paperFile;
  const { dialog, start, starting } = useAssignmentStart(
    assignment.workspaceId
  );
  const questions = attempt.questions as AssignmentGradedQuestion[];
  // Counted by part, as each part shows its own outcome (Epo 2026-11-18).
  const counts: Record<Outcome, number> = {
    partly: 0,
    right: 0,
    waiting: 0,
    wrong: 0,
  };
  for (const question of questions)
    for (const part of question.parts)
      counts[questionOutcome({ ...question, parts: [part] })]++;
  const decided = attempt.total - attempt.waitingMarks;
  const when = attempt.submittedAt ? dayLabel(attempt.submittedAt) : '';
  const left =
    !staff &&
    !assignment.closedAt &&
    assignment.mine &&
    assignment.attempts - assignment.mine.attemptsUsed > 0;
  return (
    <PracticeFrame>
      <div className="flex w-full flex-col">
        <BackToAssignments
          // From a member's profile, back to it by their name (Epo
          // 2026-11-16); else staff go to the report's Responses.
          label={
            staff && fromProfile
              ? attempt.userName
              : staff
                ? m.assignment_tab_responses()
                : undefined
          }
          link={
            staff && fromProfile
              ? studyLink(
                  assignment.workspaceId,
                  fromProfile.show === 'topics' ? 'topics' : 'summary',
                  { member: fromProfile.member }
                )
              : staff
                ? {
                    search: { assignment: assignment.id, tab: 'responses' },
                    to: '.',
                  }
                : undefined
          }
        />
        <div className="mt-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="t-page-title">{attempt.title}</h1>
            <p className="t-meta mt-0.5 flex flex-wrap items-center gap-x-2 text-fg-muted">
              {staff && (
                <span className="font-semibold text-fg-secondary">
                  {attempt.userName}
                </span>
              )}
              {m.assignment_submitted_on({ date: when })}
              {attempt.autoSubmitted && (
                <span>{m.assignment_auto_submitted()}</span>
              )}
            </p>
          </div>
          <div className="shrink-0 text-right">
            {/* The badge beside the score; under it on phones, to leave the title room. */}
            <div className="flex flex-col items-end gap-1 sm:flex-row-reverse sm:items-center sm:gap-2">
              {/* The percent a size up from meta, further from the score
                  (Epo 2026-11-19). */}
              <p className="flex items-baseline gap-2.5 whitespace-nowrap">
                <span className="font-extrabold text-[1.875rem] leading-none tracking-[-0.02rem] sm:text-[2.125rem]">
                  {/* A file's one mark not given yet: "– / 40", as its field. */}
                  {paperQuiz && decided === 0
                    ? `– / ${formatPoints(attempt.total)}`
                    : markText(attempt.mark, decided)}
                </span>
                {decided > 0 && (
                  <span className="font-semibold text-base text-fg-muted">
                    {percentText(attempt.mark / decided)}
                  </span>
                )}
              </p>
              {attempt.late && (
                <LateBadge penaltyPct={attempt.latePenaltyPct} />
              )}
            </div>
            {/* Nothing marked yet has no mark before the penalty. */}
            {attempt.latePenaltyPct > 0 && decided > 0 && (
              // On phones it wraps under the mark rather than squeezing the title.
              <p className="t-meta mt-1 w-0 min-w-full text-fg-muted sm:w-auto sm:min-w-0 sm:whitespace-nowrap">
                {m.assignment_before_penalty({
                  mark: markText(attempt.correct, decided),
                })}
              </p>
            )}
          </div>
        </div>
        {(!paperQuiz || left) && (
          <div className="mt-5.5 flex flex-wrap items-center gap-2">
            {!paperQuiz &&
              (['right', 'partly', 'wrong', 'waiting'] as const).map(
                (outcome) =>
                  counts[outcome] > 0 && (
                    <span
                      className={cn(CHIP, OUTCOME_CHIP[outcome])}
                      key={outcome}
                    >
                      {`${counts[outcome]} ${OUTCOME_LABEL[outcome]().toLowerCase()}`}
                    </span>
                  )
              )}
            <div className="ml-auto flex items-center gap-2">
              {left && (
                <Button
                  disabled={starting}
                  onClick={() => start(assignment)}
                  variant="outline"
                >
                  {m.assignment_attempt_again()}
                </Button>
              )}
            </div>
          </div>
        )}
        {attempt.marking && <MarkingNow className="t-meta mt-3" />}
        {attempt.waitingAnswers > 0 && !staff && (
          <p className="t-meta mt-3 text-fg-secondary">
            {attempt.waitingAnswers === 1
              ? m.assignment_waiting_one({ name: assignment.postedBy })
              : m.assignment_waiting({
                  count: attempt.waitingAnswers,
                  name: assignment.postedBy,
                })}
          </p>
        )}
        {dialog}
        {paperQuiz ? (
          <PaperQuizResults
            assignment={assignment}
            attempt={attempt}
            staff={staff}
          />
        ) : (
          // Every question whole, as By question draws them (Epo 2026-11-22).
          <ol className="mx-auto mt-4 w-full max-w-3xl border-divider border-t">
            {questions.map((question, i) => (
              <li className="border-divider border-b py-6" key={question.id}>
                <ResultBody
                  assignment={assignment}
                  attempt={attempt}
                  commentHere
                  question={question}
                  questionNumber={i + 1}
                  staff={staff}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </PracticeFrame>
  );
}

/** The stem and a single part's blocks (a gaps part draws its own), less the
 * text the row's question line already shows: images, tables, more text. */
function extraBlocks(question: AssignmentGradedQuestion): QuestionBlock[] {
  const [part] = question.parts;
  const blocks =
    question.parts.length === 1 && part.answer.type !== 'gaps'
      ? [...question.stem, ...part.blocks]
      : question.stem;
  const line = blocks.findIndex(
    (block) => block.type === 'text' && block.text.trim() !== ''
  );
  return blocks.filter((_, i) => i !== line);
}

/** One question's answer with its marks; staff change them and comment
 * (results, and Grading's questions marked by rule). */
export function ResultBody({
  assignment,
  attempt,
  commentHere,
  question,
  questionNumber,
  staff,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  /** The question's comment shows and is written here; without it its marks
   * save keeping the comment as it is. */
  commentHere: boolean;
  question: AssignmentGradedQuestion;
  /** A member's Results: the question drawn whole as the Questions tab draws
   * it, each part's answer and marks where its answer would be (Epo
   * 2026-11-22). Without it, Grading's answer alone. */
  questionNumber?: number;
  staff: boolean;
}) {
  const { mutate, isPending } = useMarkAssignmentAnswer(
    assignment.workspaceId,
    assignment.id
  );
  const [items, setItems] = useState<Record<string, (number | null)[]>>(() =>
    Object.fromEntries(
      question.parts
        .filter((p) => modelMarked(p.answer.type))
        .map((p) => [
          p.id,
          (p.markscheme ?? []).map((_, i) =>
            p.pending ? null : (p.itemAwards?.[i] ?? 0)
          ),
        ])
    )
  );
  const [closed, setClosed] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(
      question.parts
        .filter((p) => !modelMarked(p.answer.type))
        .map((p) => [p.id, p.awarded ?? 0])
    )
  );
  const [comment, setComment] = useState(question.comment ?? '');
  const complete =
    Object.values(items).every((list) => list.every((v) => v !== null)) &&
    Object.values(closed).every((v) => v !== null);
  const save = () =>
    mutate(
      {
        attemptId: attempt.id,
        mark: {
          comment: commentHere ? comment.trim() : (question.comment ?? ''),
          parts: question.parts.map((part) =>
            modelMarked(part.answer.type)
              ? {
                  items: (items[part.id] ?? []).map((v) => v ?? 0),
                  partId: part.id,
                }
              : { mark: closed[part.id] ?? 0, partId: part.id }
          ),
          questionId: question.id,
        },
      },
      {
        onError: (error) =>
          userToast({
            title: errorCopy(error, m.assignment_mark_failed()),
            variant: 'error',
          }),
        onSuccess: () =>
          userToast({ title: m.assignment_mark_saved(), variant: 'success' }),
      }
    );
  const whole = questionNumber !== undefined;
  const partView = (part: AssignmentGradedPart) =>
    modelMarked(part.answer.type) ? (
      <OpenPart
        answer={attempt.answers[part.id]}
        editing={staff}
        items={items[part.id] ?? []}
        key={part.id}
        onItem={(i, value) =>
          setItems((all) => ({
            ...all,
            [part.id]: (all[part.id] ?? []).map((v, j) =>
              j === i ? value : v
            ),
          }))
        }
        part={part}
        showKeys={attempt.showAnswers}
      />
    ) : (
      <ClosedPart
        answers={attempt.answers}
        editing={staff}
        key={part.id}
        mark={closed[part.id] ?? null}
        onMark={(value) => setClosed((all) => ({ ...all, [part.id]: value }))}
        part={part}
        question={question}
        showKeys={attempt.showAnswers}
        whole={whole}
      />
    );
  const graded = (id: string) => question.parts.find((p) => p.id === id);
  const footer = staff ? (
    <div className="flex flex-col gap-2">
      {commentHere && (
        <Input
          aria-label={m.assignment_comment_for({ name: attempt.userName })}
          onChange={(event) => setComment(event.target.value)}
          placeholder={m.assignment_comment_for({
            name: attempt.userName,
          })}
          value={comment}
        />
      )}
      <div className="flex justify-end">
        {/* The mark fields' height, as Grade's Save (GradeField). */}
        <Button
          className="h-8"
          disabled={isPending || !complete}
          onClick={save}
          size="sm"
        >
          {m.assignment_save_marks()}
        </Button>
      </div>
    </div>
  ) : (
    commentHere && question.comment && <CommentLine question={question} />
  );
  if (whole) {
    const awarded = question.parts.reduce((n, p) => n + (p.awarded ?? 0), 0);
    return (
      <div className="flex flex-col gap-5">
        <QuestionView
          question={question as unknown as Question}
          questionNumber={questionNumber}
          renderAnswer={(shown) => {
            const part = graded(shown.id);
            return (
              part && (
                <div className="col-[2/-1] flex min-w-0 flex-col gap-5">
                  {partView(part)}
                </div>
              )
            );
          }}
          // A gaps part's text with the member's answers in its blanks.
          renderBlock={(block, _, section) => {
            const part = graded(section.partId ?? '');
            return part?.answer.type === 'gaps' &&
              block.type === 'text' &&
              !section.solution ? (
              <GapText
                block={block}
                disabled
                part={part}
                review={attempt.showAnswers}
                value={attempt.answers[part.id] as Answer}
              />
            ) : (
              <QuestionBlockView block={block} />
            );
          }}
          renderMarks={(shown) => {
            const part = graded(shown.id);
            return part && <PartMark part={part} question={question} />;
          }}
          totalMarks={
            <MarkOf
              awarded={awarded}
              marks={questionMarks(question as Question)}
              waiting={question.parts.some((p) => p.pending)}
            />
          }
        />
        {footer}
      </div>
    );
  }
  const extra = extraBlocks(question);
  return (
    <div className="flex flex-col gap-5">
      {extra.length > 0 && (
        <div className="grid gap-3">
          {extra.map((block, i) => (
            <QuestionBlockView block={block} key={i} />
          ))}
        </div>
      )}
      {question.parts.map(partView)}
      {footer}
    </div>
  );
}

/** A part's outcome and mark beside it: its square, its word (gone on narrow
 * questions) and "1 / 2". */
function PartMark({
  part,
  question,
}: {
  part: AssignmentGradedPart;
  question: AssignmentGradedQuestion;
}) {
  const outcome = questionOutcome({ ...question, parts: [part] });
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn('size-2.5 shrink-0 rounded-xs', OUTCOME_SQUARE[outcome])}
      />
      <span className="@max-[36rem]/question:sr-only">
        {OUTCOME_LABEL[outcome]()}
      </span>
      <MarkOf
        awarded={part.awarded ?? 0}
        marks={part.marks}
        waiting={outcome === 'waiting'}
      />
    </span>
  );
}

/** "1 / 2", the mark bold; "– / 2" while it waits. */
function MarkOf({
  awarded,
  marks,
  waiting,
}: {
  awarded: number;
  marks: number;
  waiting: boolean;
}) {
  return (
    <span>
      <b className="font-bold text-fg">
        {waiting ? '–' : formatPoints(awarded)}
      </b>
      {` / ${formatPoints(marks)}`}
    </span>
  );
}

/** A question's comment as its member reads it: who wrote it, then it, the
 * avatar centred on its first line when it runs to several. */
function CommentLine({ question }: { question: AssignmentGradedQuestion }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex h-lh shrink-0 items-center">
        <Avatar
          aria-hidden
          className="size-6.5 text-[10px]"
          name={question.commentByName ?? ''}
          src={question.commentByAvatarUrl || undefined}
        />
      </span>
      <p className="min-w-0">
        <b className="font-bold">{question.commentByName}</b>
        {' · '}
        {question.comment}
      </p>
    </div>
  );
}

/** A written answer: the answer, the marking points with their marks, and the
 * worked solution folded away. Grading shows its answers the same way (Epo
 * 2026-11-19), with the AI's marks in a column of their own (`aiColumn`) and
 * a paper's pages in place of a typed answer (`paper`). */
export function OpenPart({
  aiColumn = false,
  answer,
  editing,
  items,
  onItem,
  paper,
  part,
  showKeys,
}: {
  aiColumn?: boolean;
  answer: unknown;
  editing: boolean;
  items: (number | null)[];
  onItem: (index: number, value: number | null) => void;
  paper?: ReactNode;
  part: AssignmentGradedPart;
  showKeys: boolean;
}) {
  const text = typeof answer === 'string' ? answer : '';
  const scheme = part.markscheme ?? [];
  const label = 't-meta text-fg-secondary';
  return (
    <>
      <div>
        <p className={label}>{m.assignment_your_answer()}</p>
        {paper ? (
          <div className="mt-1.5">{paper}</div>
        ) : part.answer.type === 'drawing' ? (
          // Drawn from its board, with no frame (R2).
          <div className="mt-1.5">
            {answer ? (
              <ReviewedDrawing
                blocks={part.blocks}
                marks={m.question_ui_marks({ count: part.marks })}
                title={m.drawing_answer_question()}
                value={answer as Answer}
              />
            ) : (
              <span className="text-fg-muted">
                {m.assignment_not_answered()}
              </span>
            )}
          </div>
        ) : (
          <div className="mt-1.5 rounded-lg border border-line px-3 py-2">
            {text ? (
              <TextView marks text={text} />
            ) : (
              <span className="text-fg-muted">
                {m.assignment_not_answered()}
              </span>
            )}
          </div>
        )}
        {/* How it was marked, under the answer it is about. */}
        {(part.aiComment ||
          (!editing && (part.pending || part.markedBy === 'ai'))) && (
          <div className="mt-2 flex flex-col items-start gap-2">
            {part.pending &&
              !editing &&
              (part.marking ? (
                // A marking run holds it now (Q729).
                <MarkingNow />
              ) : (
                <span
                  className={cn(CHIP, OUTCOME_CHIP.waiting)}
                  data-not-marked
                >
                  {m.assignment_not_marked()}
                </span>
              ))}
            {part.aiComment && (
              <AiWarning flag={part.aiFlag} message={part.aiComment} />
            )}
            {part.markedBy === 'ai' && !editing && (
              <span className="t-meta text-fg-muted">
                {m.assignment_marked_by_ai()}
              </span>
            )}
          </div>
        )}
      </div>
      {showKeys && scheme.length > 0 && (
        // As the report's marking table: a line under each point, running
        // across both columns with no gap (Epo 2026-11-18); the Awarded
        // column pads itself.
        // By its own width, as Grading's pane is narrower than the screen:
        // under 448px the chips go and the AI's marks take only their width.
        <div className="@container">
          <div
            className={cn(
              'grid items-center',
              aiColumn
                ? '@md:grid-cols-[minmax(0,1fr)_72px_210px] grid-cols-[minmax(0,1fr)_auto_auto]'
                : '@md:grid-cols-[minmax(0,1fr)_210px] grid-cols-[minmax(0,1fr)_auto]'
            )}
          >
            <p className={cn(label, 'border-divider border-b pb-1.5')}>
              {m.assignment_marking_points()}
            </p>
            {aiColumn && (
              <p className={cn(label, 'border-divider border-b pb-1.5 pl-3')}>
                {m.assignment_col_ai()}
              </p>
            )}
            <p className={cn(label, 'border-divider border-b pb-1.5 pl-3')}>
              {m.assignment_awarded()}
            </p>
            {scheme.map((item, i) => {
              const awarded = items[i] ?? null;
              return (
                <div className="contents" key={i}>
                  <div className="flex items-center self-stretch border-divider border-b py-2.5">
                    <TextView marks text={item.text} />
                  </div>
                  {aiColumn && (
                    <div className="t-meta flex items-center self-stretch whitespace-nowrap border-divider border-b pl-3 text-fg-muted">
                      {part.aiAwards
                        ? markText(part.aiAwards[i] ?? 0, item.marks)
                        : '–'}
                    </div>
                  )}
                  <div className="flex min-h-11 items-center gap-2 self-stretch border-divider border-b py-2 pl-3">
                    {editing ? (
                      <MarkField
                        label={item.text}
                        marks={item.marks}
                        onChange={(value) => onItem(i, value)}
                        value={awarded}
                      />
                    ) : (
                      <span className="whitespace-nowrap font-bold">
                        {awarded === null
                          ? `– / ${formatPoints(item.marks)}`
                          : markText(awarded, item.marks)}
                      </span>
                    )}
                    {awarded !== null && (
                      <span className="@max-md:hidden">
                        <ItemChip awarded={awarded} marks={item.marks} />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {showKeys && hasSample(part) && (
        <div>
          <p className={label}>{m.question_ui_sample_answer_heading()}</p>
          <div className="mt-1.5">
            <SampleView part={part} />
          </div>
        </div>
      )}
      {showKeys && part.solution.length > 0 && <WorkedSolution part={part} />}
    </>
  );
}

/** The part's Solution, open under its heading as the Sample answer is (Epo
 * 2026-11-18, as on the view by question). */
function WorkedSolution({ part }: { part: QuestionPart }) {
  return (
    <div>
      <p className="t-meta text-fg-secondary">
        {m.question_ui_worked_solution()}
      </p>
      <div className="mt-1.5 grid gap-2">
        {part.solution.map((block, i) => (
          <QuestionBlockView block={block} key={i} />
        ))}
      </div>
    </div>
  );
}

/** A marked-by-rule part: as a quiz's checked question, or with no keys the
 * member's own answer alone; staff can change its mark. */
function ClosedPart({
  answers,
  editing,
  mark,
  onMark,
  part,
  question,
  showKeys,
  whole = false,
}: {
  answers: AssignmentAttempt['answers'];
  editing: boolean;
  mark: number | null;
  onMark: (value: number | null) => void;
  part: AssignmentGradedPart;
  question: AssignmentGradedQuestion;
  showKeys: boolean;
  /** The question is drawn whole around it, its blocks and groups drawn. */
  whole?: boolean;
}) {
  const single = question.parts.length === 1;
  const shown = {
    ...question,
    ...(whole && { groups: [] }),
    parts: [
      {
        ...part,
        // A single part's blocks head the row (extraBlocks), a whole
        // question's draws them all; else a gaps part keeps its text, the
        // gaps being in it.
        blocks:
          whole || (single && part.answer.type !== 'gaps') ? [] : part.blocks,
        ...(whole && { group: undefined }),
      },
    ],
    stem: [],
  } as unknown as Question;
  return (
    <div
      className={cn(
        'flex flex-col gap-2',
        // The question's view draws its text, so its own header is empty.
        whole && '[&>article>header]:hidden'
      )}
    >
      <QuestionRunner
        answers={answers}
        disabled
        headerMarks={false}
        layout="list"
        partResults={false}
        question={shown}
        review={showKeys}
      />
      {editing && (
        <div className="flex items-center justify-end gap-2">
          <span className="t-meta text-fg-muted">
            {m.assignment_change_mark()}
          </span>
          <MarkField
            label={m.assignment_change_mark()}
            marks={part.marks}
            onChange={onMark}
            value={mark}
          />
        </div>
      )}
    </div>
  );
}
