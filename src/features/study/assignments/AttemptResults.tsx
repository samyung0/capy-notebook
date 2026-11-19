import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useMarkAssignmentAnswer } from '@/api/hooks';
import type {
  Assignment,
  AssignmentAttempt,
  AssignmentGradedPart,
  AssignmentGradedQuestion,
} from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { userToast } from '@/components/ui/userToast';
import { AiWarning } from '@/features/questions/AiWarning';
import { answerLabels } from '@/features/questions/editorFields';
import { QuestionBlockView, TextView } from '@/features/questions/QuestionView';
import { hasSample, SampleView } from '@/features/questions/SampleBlock';
import type {
  Question,
  QuestionBlock,
  QuestionPart,
} from '@/features/questions/types';
import { modelMarked, questionMarks } from '@/features/questions/types';
import { ReviewedDrawing } from '@/features/quizzes/drawing/DrawingAnswer';
import { type Answer, formatPoints } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { blockText, questionLine } from '../practice/practiceText';
import { PracticeFrame } from '../practice/studyPage';
import { studyLink } from '../studyRoutes';
import { BackToAssignments, type ProfileOrigin } from './AssignmentAttemptPage';
import {
  dayLabel,
  markText,
  OUTCOME_LABEL,
  OUTCOME_SQUARE,
  type Outcome,
  percentText,
  questionOutcome,
  questionRowName,
} from './assignmentText';
import { LateBadge } from './LateBadge';
import { MarkField } from './MarkField';
import { MarkingNow } from './MarkingNow';
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
    return <HiddenResults attempt={attempt} postedBy={assignment.postedBy} />;
  return (
    <MarkedResults
      assignment={assignment}
      attempt={attempt}
      fromProfile={fromProfile}
    />
  );
}

/** Results while grades wait for release (S7): the questions with whether
 * each was answered, and no marks, outcomes, comments or keys. */
function HiddenResults({
  attempt,
  postedBy,
}: {
  attempt: AssignmentAttempt;
  postedBy: string;
}) {
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
      </div>
    </PracticeFrame>
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
  // A task's maker runs it and takes it: the attempt here is their own.
  const taker = !staff || !!assignment.own;
  const { dialog, start, starting } = useAssignmentStart(
    assignment.workspaceId
  );
  const rows = resultRows(attempt.questions as AssignmentGradedQuestion[]);
  const [opened, setOpened] = useState<string[]>(() => {
    const first = rows.find((row) => questionOutcome(row.shown) === 'waiting');
    return first ? [first.id] : [];
  });
  const counts: Record<Outcome, number> = {
    partly: 0,
    right: 0,
    waiting: 0,
    wrong: 0,
  };
  for (const row of rows) counts[questionOutcome(row.shown)]++;
  const decided = attempt.total - attempt.waitingMarks;
  const when = attempt.submittedAt ? dayLabel(attempt.submittedAt) : '';
  const left =
    taker &&
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
                  {markText(attempt.mark, decided)}
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
            {attempt.latePenaltyPct > 0 && (
              // On phones it wraps under the mark rather than squeezing the title.
              <p className="t-meta mt-1 w-0 min-w-full text-fg-muted sm:w-auto sm:min-w-0 sm:whitespace-nowrap">
                {m.assignment_before_penalty({
                  mark: markText(attempt.correct, decided),
                })}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5.5 flex flex-wrap items-center gap-2">
          {(['right', 'partly', 'wrong', 'waiting'] as const).map(
            (outcome) =>
              counts[outcome] > 0 && (
                <span className={cn(CHIP, OUTCOME_CHIP[outcome])} key={outcome}>
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
        <ol className="mt-4 border-divider border-t">
          {rows.map((row) => (
            <ResultRow
              assignment={assignment}
              attempt={attempt}
              key={row.id}
              onToggle={() =>
                setOpened((list) =>
                  list.includes(row.id)
                    ? list.filter((id) => id !== row.id)
                    : [...list, row.id]
                )
              }
              open={opened.includes(row.id)}
              row={row}
              staff={staff}
            />
          ))}
        </ol>
      </div>
    </PracticeFrame>
  );
}

/** A row of a member's result: a whole question, or one part of a question
 * of several, laid flat as the report's Questions tab lays them (Epo
 * 2026-11-18): "Q19 (a)" with its own mark and, open, its question's stem and
 * group above its answer. */
type ResultRowItem = {
  id: string;
  /** "Q19", "Q19 (a)(i)". */
  name: string;
  /** The row's one line: the part's first text, else the question's. */
  line: string;
  /** The question, or for a part's row the question narrowed to that part
   * with its stem moved to `context`. */
  shown: AssignmentGradedQuestion;
  /** A part's row: its question's stem and its group's text and figures. */
  context: QuestionBlock[];
  number: number;
  /** The question's last row, which holds its comment. */
  last: boolean;
};

function resultRows(questions: AssignmentGradedQuestion[]): ResultRowItem[] {
  return questions.flatMap((question, i): ResultRowItem[] => {
    const number = i + 1;
    const line = questionLine(question as Question);
    if (question.parts.length < 2)
      return [
        {
          context: [],
          id: question.id,
          last: true,
          line,
          name: `Q${number}`,
          number,
          shown: question,
        },
      ];
    return question.parts.map((part, j) => {
      const group = part.group
        ? question.groups?.find((g) => g.id === part.group)
        : undefined;
      return {
        context: [...question.stem, ...(group?.blocks ?? [])],
        id: part.id,
        last: j === question.parts.length - 1,
        line: blockText(part.blocks) || line,
        name: questionRowName(number, question, part.id),
        number,
        shown: { ...question, parts: [part], stem: [] },
      };
    });
  });
}

function ResultRow({
  assignment,
  attempt,
  onToggle,
  open,
  row,
  staff,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  onToggle: () => void;
  open: boolean;
  row: ResultRowItem;
  staff: boolean;
}) {
  const question = row.shown;
  const outcome = questionOutcome(question);
  const awarded = question.parts.reduce((n, p) => n + (p.awarded ?? 0), 0);
  const marks = questionMarks(question as Question);
  // Folding swaps the row's toggle for another: the keyboard's focus follows.
  const toggleButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const toggle = () => {
    refocus.current = document.activeElement === toggleButton.current;
    onToggle();
  };
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    toggleButton.current?.focus();
  }, [open]);
  if (open)
    return (
      <OpenResultRow
        assignment={assignment}
        attempt={attempt}
        awarded={awarded}
        marks={marks}
        onToggle={toggle}
        outcome={outcome}
        row={row}
        staff={staff}
        toggleRef={toggleButton}
      />
    );
  const score = (
    <span className="whitespace-nowrap text-right font-bold">
      {outcome === 'waiting' ? (
        <span className="t-meta font-semibold text-fg-muted">
          {`– / ${formatPoints(marks)}`}
        </span>
      ) : (
        <>
          {formatPoints(awarded)}{' '}
          <span className="font-semibold text-fg-muted">
            / {formatPoints(marks)}
          </span>
        </>
      )}
    </span>
  );
  return (
    <li className="border-divider border-b">
      <button
        aria-expanded={false}
        // The number at least its column, wider for a part's "Q18 (a)(i)",
        // pushing the text right rather than under it (Epo 2026-11-19).
        className="grid min-h-9 w-full grid-cols-[10px_minmax(30px,auto)_minmax(0,1fr)_auto_20px] items-center gap-2 py-1 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset sm:grid-cols-[92px_minmax(34px,auto)_minmax(0,1fr)_60px_20px] sm:gap-2.5"
        onClick={toggle}
        ref={toggleButton}
        type="button"
      >
        <span className="t-meta flex items-center gap-1.75 font-semibold text-fg-secondary">
          <span
            className={cn(
              'size-2.5 shrink-0 rounded-xs',
              OUTCOME_SQUARE[outcome]
            )}
          />
          <span className="truncate max-sm:sr-only">
            {OUTCOME_LABEL[outcome]()}
          </span>
        </span>
        <span className="t-meta whitespace-nowrap font-bold text-fg-muted">
          {row.name}
        </span>
        <span className="truncate">
          <TextView className="whitespace-nowrap" marks text={row.line} />
        </span>
        {score}
        <Icon
          className="justify-self-end text-fg-muted"
          name="chevronDown"
          size={16}
        />
      </button>
    </li>
  );
}

/** An open question as the report's Questions tab lays one out (Epo
 * 2026-11-17): the question and its mark on the left, the answer and its
 * marking on the right; under lg, where the shell leaves too little room
 * for both, they stack. */
function OpenResultRow({
  assignment,
  attempt,
  awarded,
  marks,
  onToggle,
  outcome,
  row,
  staff,
  toggleRef,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  awarded: number;
  marks: number;
  onToggle: () => void;
  outcome: Outcome;
  row: ResultRowItem;
  staff: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
}) {
  const question = row.shown;
  const type =
    question.parts.length === 1 ? question.parts[0].answer.type : undefined;
  const meta = [
    row.name,
    type && answerLabels[type](),
    marks === 1
      ? m.question_ui_one_mark()
      : m.question_ui_marks({ count: marks }),
  ]
    .filter(Boolean)
    .join(' · ');
  // A click on the question's side folds it, as on the report; the answer's
  // side holds fields and menus, so its clicks never do. Where the press
  // began counts: a mark picked from a menu by touch can land its click on
  // whatever is under the menu once it closes.
  const pressedAnswer = useRef(false);
  const press = (event: MouseEvent) => {
    const target = event.target as Element;
    pressedAnswer.current =
      !event.currentTarget.contains(target) ||
      !!target.closest('[data-result-body]');
  };
  const fold = (event: MouseEvent) => {
    const target = event.target as Element;
    if (pressedAnswer.current || !event.currentTarget.contains(target)) return;
    if (target.closest('a, button, [data-result-body]')) return;
    if (window.getSelection()?.toString()) return;
    onToggle();
  };
  return (
    // The click is a shortcut; its fold button is the keyboard's way.
    <li
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_20px] gap-x-3 border-divider border-b py-5 lg:grid-cols-[320px_minmax(0,1fr)_20px] lg:gap-x-10"
      onClick={fold}
      onPointerDown={press}
    >
      <div className="min-w-0">
        <p className="t-meta text-fg-secondary">{meta}</p>
        <p className="mt-2 text-[1.0625rem] leading-snug">
          <TextView marks text={row.line} />
        </p>
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn(CHIP, OUTCOME_CHIP[outcome])}>
            {OUTCOME_LABEL[outcome]()}
          </span>
          <span className="whitespace-nowrap">
            <b className="font-bold text-xl">
              {outcome === 'waiting' ? '–' : formatPoints(awarded)}
            </b>{' '}
            <span className="font-semibold text-fg-muted">
              / {formatPoints(marks)}
            </span>
          </span>
        </p>
      </div>
      <button
        aria-expanded
        aria-label={row.name}
        className="col-start-2 row-start-1 grid size-5 place-items-center self-start justify-self-end text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-action lg:col-start-3"
        onClick={onToggle}
        ref={toggleRef}
        type="button"
      >
        <Icon className="rotate-180" name="chevronDown" size={16} />
      </button>
      <div
        className="col-span-2 mt-4 min-w-0 cursor-auto lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:mt-0"
        data-result-body
      >
        {row.context.length > 0 && (
          <div className="mb-5 grid gap-3">
            <p className="t-meta text-fg-secondary">
              {m.assignment_from_question({ number: row.number })}
            </p>
            {row.context.map((block, i) => (
              <QuestionBlockView block={block} key={i} />
            ))}
          </div>
        )}
        <ResultBody
          assignment={assignment}
          attempt={attempt}
          commentHere={row.last}
          question={question}
          staff={staff}
        />
      </div>
    </li>
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
  staff,
}: {
  assignment: Assignment;
  attempt: AssignmentAttempt;
  /** The question's comment shows and is written on its last row; a part
   * row before it saves its marks keeping the comment as it is. */
  commentHere: boolean;
  question: AssignmentGradedQuestion;
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
      {question.parts.map((part) =>
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
            onMark={(value) =>
              setClosed((all) => ({ ...all, [part.id]: value }))
            }
            part={part}
            question={question}
            showKeys={attempt.showAnswers}
          />
        )
      )}
      {staff ? (
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
        commentHere &&
        question.comment && (
          <div className="flex items-center gap-2.5">
            <Avatar
              aria-hidden
              className="size-6.5 text-[10px]"
              name={question.commentByName ?? ''}
              src={question.commentByAvatarUrl || undefined}
            />
            <p className="min-w-0">
              <b className="font-bold">{question.commentByName}</b>
              {' · '}
              {question.comment}
            </p>
          </div>
        )
      )}
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
}: {
  answers: AssignmentAttempt['answers'];
  editing: boolean;
  mark: number | null;
  onMark: (value: number | null) => void;
  part: AssignmentGradedPart;
  question: AssignmentGradedQuestion;
  showKeys: boolean;
}) {
  const single = question.parts.length === 1;
  const shown = {
    ...question,
    parts: [
      {
        ...part,
        // A single part's blocks head the row (extraBlocks); a gaps part keeps
        // its text, the gaps being in it.
        blocks: single && part.answer.type !== 'gaps' ? [] : part.blocks,
      },
    ],
    stem: [],
  } as unknown as Question;
  return (
    <div className="flex flex-col gap-2">
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
