import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, type UIEvent, useRef, useState } from 'react';
import { useAssignmentReport, useReleaseAssignmentGrades } from '@/api/hooks';
import type {
  Assignment,
  AssignmentMemberRow,
  AssignmentPartReport,
  AssignmentQuestionReport,
  AssignmentReport as ReportData,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Tabs } from '@/components/ui/Tabs';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { FileActionsTarget } from '@/features/files/fileModeContext';
import {
  createEditorStatusStore,
  EditorSaveStatus,
} from '@/features/materials/CenterContentHeader';
import { answerLabels } from '@/features/questions/editorFields';
import {
  AnswerView,
  marksText,
  optionLetter,
  QuestionBlockView,
  QuestionView,
  TextView,
} from '@/features/questions/QuestionView';
import { hasSample, SampleView } from '@/features/questions/SampleBlock';
import { modelMarked, type Question } from '@/features/questions/types';
import { formatPoints } from '@/features/quizzes/grade';
import { QuizReadSplit } from '@/features/quizzes/QuizEditor';
import { QuizSplit } from '@/features/quizzes/QuizSplit';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { useFullscreenSearch } from '@/lib/useFullscreenSearch';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { ListRow, PracticeFrame, Td, Th } from '../practice/studyPage';
import type { AssignmentsSearch, ReportTab } from '../studyRoutes';
import { ApproveTab } from './ApproveTab';
import { BackToAssignments } from './AssignmentAttemptPage';
import { AssignmentFiles } from './AssignmentFiles';
import {
  AssignmentPreview,
  PreviewDialog,
  QuizFilePreview,
} from './AssignmentPreview';
import { AssignmentSettingsTab, PublishButton } from './AssignmentSettingsTab';
import { reportView } from './assignmentPage';
import {
  averageLegend,
  averageTone,
  dayLabel,
  isGraded,
  markText,
  questionPaperOf,
  takesLateWork,
} from './assignmentText';
import { GradedQuizQuestions } from './GradedQuizQuestions';
import { GradingTab } from './GradingTab';
import { HandInMembers } from './HandIns';
import { LateBadge } from './LateBadge';
import { QuestionPaperView } from './LazyPaper';
import { MarkingNow } from './MarkingNow';
import { PreviewButton } from './PreviewButton';
import {
  type NumberItem,
  NumberStrip,
  QuestionNumbers,
} from './QuestionNumbers';

const CHIP =
  'inline-flex h-5.5 shrink-0 items-center rounded-md bg-page-hover px-1.75 font-semibold text-fg-secondary text-xs';

const TAB_LABELS: Record<ReportTab, () => string> = {
  content: m.assignment_tab_content,
  grading: m.assignment_tab_grading,
  questions: m.assignment_tab_questions,
  responses: m.assignment_tab_responses,
  settings: m.assignment_tab_settings,
};

/** An assignment's report (boards G3, G3m, A3): the facts as chips, then its
 * tabs, each with its own link. A graded quiz (Epo 2026-11-15, boards Main and
 * Responses) has Questions, its quiz edited in place, Responses, Grading
 * (Epo 2026-11-19) and Settings,
 * Preview and a draft's Publish in its header; an Assignment has Content (its
 * files), Responses (who has done it; a member's row opens Grading at them),
 * Grading when it takes files or points, and Settings (Epo 2026-11-21). */
export function AssignmentReport({
  assignment,
  search,
}: {
  assignment: Assignment;
  search: AssignmentsSearch;
}) {
  const navigate = useNavigate();
  const { data, error, isError, isPending, refetch } = useAssignmentReport(
    assignment.id,
    { errorBoundary: false }
  );
  const marked = assignment.kind === 'marked';
  // A graded quiz, or an Assignment graded on points (Epo 2026-11-14).
  const graded = isGraded(assignment);
  const draft = !!assignment.draft;
  const { byQuestion, tab, tabs } = reportView(assignment, search);
  const go = (next: AssignmentsSearch) =>
    navigate({
      search: { assignment: assignment.id, ...next },
      to: '.',
    });
  const pickTab = (value: string) =>
    void go(value === tabs[0] ? {} : { tab: value as ReportTab });
  const [previewing, setPreviewing] = useState(false);
  // Grading's, Questions' and By question's full screen (`fullscreen` in the
  // URL, as the workspace's); Escape in a question's field stays the field's.
  const [fullscreen, setFullscreen] = useFullscreenSearch({
    fieldsKeepEscape: true,
  });
  // The quiz editor's Undo and Redo portal into the header, beside its save
  // status, as on the quiz's own page.
  const [editorActions, setEditorActions] = useState<HTMLElement | null>(null);
  const [editorStatus] = useState(createEditorStatusStore);
  const manage = assignment.manage;
  const quizId = manage?.quizId;
  const editing = marked && tab === 'questions';
  // A file's graded quiz (Epo 2026-11-20): its Questions tab is the file.
  const paper = questionPaperOf(assignment);
  // From a tablet up, the quiz editor alone covers the page (Epo 2026-11-19).
  const wide = useMediaQuery('(min-width: 768px)');
  const editorFullscreen = editing && !!quizId && wide && fullscreen;
  // No kind, submissions or average here: Responses' numbers hold those (Epo
  // 2026-11-13).
  const chips = [
    assignment.draft ? m.assignment_draft() : null,
    assignment.dueAt
      ? m.assignment_due({ date: dayLabel(assignment.dueAt) })
      : null,
    assignment.noLate
      ? m.assignment_switch_no_late()
      : assignment.latePenaltyPct > 0
        ? m.assignment_late_penalty({ percent: assignment.latePenaltyPct })
        : null,
    assignment.closedAt
      ? m.assignment_closed_on({ date: dayLabel(assignment.closedAt) })
      : null,
    !graded || assignment.draft || manage?.showGrades !== 'manual'
      ? null
      : manage.gradesReleasedAt
        ? m.assignment_grades_released_on({
            date: dayLabel(manage.gradesReleasedAt),
          })
        : m.assignment_grades_not_released(),
  ].filter(Boolean) as string[];
  const notGraded = marked ? (manage?.notGraded ?? 0) : 0;
  const toApprove =
    marked && manage?.marking !== 'manual'
      ? (manage?.toApprove ?? 0) - notGraded
      : 0;
  // Show grades Manual (T5): the button stays until they are released.
  const releasable =
    graded &&
    !assignment.draft &&
    manage?.showGrades === 'manual' &&
    !manage.gradesReleasedAt;

  // Full screen: Grading with a list to cover, Questions while it edits, By
  // question's split (Epo 2026-11-22).
  const fullscreenHere =
    (tab === 'grading' && !!data?.members.length) ||
    (editing && !!quizId) ||
    (marked && tab === 'responses' && byQuestion && !!data?.questions.length);
  const previewHere = marked && tab === 'questions';
  // A published one previews its frozen questions, so it waits for the report.
  const previewWaits = !(draft || data || paper !== undefined);

  return (
    <PracticeFrame
      // The quiz editor fills the page under the tabs, as the quiz page does;
      // so does Grading's split from a tablet up.
      className={cn(
        editing && 'flex flex-col overflow-hidden pb-0 lg:pb-0',
        (tab === 'grading' || (tab === 'responses' && byQuestion)) &&
          'md:flex md:flex-col md:overflow-hidden md:pb-0 lg:pb-0'
      )}
    >
      {/* Stepped aside past a phone's first Approve screen (tailwind.css). */}
      {/* As a member's attempt reads (Epo 2026-11-19): the title, its chips
          under it, the actions at the chips' right. */}
      <div className="flex" data-report-head>
        <BackToAssignments />
      </div>
      <div className="mt-3" data-report-head>
        <h1 className="t-page-title truncate" title={assignment.title}>
          {assignment.title}
        </h1>
        {/* One row, never wrapping (Epo 2026-11-20): the actions stay at the
            chips' right, and chips past the room scroll, as Grading's do. */}
        <div className="mt-1 flex items-center gap-2 sm:gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {/* Published and not closed yet: Open, in green, first (Epo 2026-11-16). */}
            {!assignment.draft && !assignment.closedAt && (
              <span
                className={cn(CHIP, 'bg-tint-success text-tint-success-fg')}
              >
                {m.assignment_state_open()}
              </span>
            )}
            {/* The time limit alone, with no kind before it. */}
            {assignment.timeLimitMin ? (
              <span className={cn(CHIP, 'gap-1')}>
                <Icon className="shrink-0" name="clock" size={14} />
                {minutesShort(assignment.timeLimitMin)}
              </span>
            ) : null}
            {chips.map((chip) => (
              <span className={CHIP} key={chip}>
                {chip}
              </span>
            ))}
            {/* Waiting answers: AI-marked to approve, and not graded (T3). */}
            {toApprove > 0 && (
              <span
                className={cn(CHIP, 'bg-tint-accent-1 text-tint-accent-1-fg')}
              >
                {m.assignment_to_approve({ count: toApprove })}
              </span>
            )}
            {notGraded > 0 && (
              <span
                className={cn(CHIP, 'bg-tint-warning text-tint-warning-fg')}
              >
                {m.assignment_not_graded({ count: notGraded })}
              </span>
            )}
          </div>
          {(marked || releasable) && (
            <div className="flex shrink-0 items-center gap-2">
              {editing && quizId && !editorFullscreen && (
                <>
                  {/* Its words from a tablet up: a phone's row keeps
                      room for the buttons, the icon telling the state. */}
                  <EditorSaveStatus labelled={wide} store={editorStatus} />
                  <span className="flex items-center" ref={setEditorActions} />
                </>
              )}
              {/* On Questions only, borderless (Epo 2026-11-23): here on
                  phones, on the tabs' row from a tablet up. */}
              {previewHere && (
                <PreviewButton
                  className="md:hidden"
                  disabled={previewWaits}
                  onClick={() => setPreviewing(true)}
                  variant="ghost-hover"
                />
              )}
              {marked && draft && <PublishButton assignment={assignment} />}
              {releasable && <ReleaseGrades assignment={assignment} />}
            </div>
          )}
        </div>
      </div>
      {/* Grading's full screen at the row's end (Epo 2026-11-19), as the
          workspace's: the members and the file, nothing else. */}
      <div className="relative" data-report-head>
        <Tabs
          className="page-bleed page-tabs-px mt-3.5 w-auto"
          onChange={pickTab}
          tabs={tabs.map((value) => ({
            // A task's Grading reads hand-ins when there are no points to give.
            label:
              value === 'grading' && !marked && assignment.points === undefined
                ? m.assignment_tab_hand_ins()
                : value === 'questions' && paper !== undefined
                  ? m.assignment_question_paper()
                  : TAB_LABELS[value](),
            value,
          }))}
          value={tab}
        />
        {(fullscreenHere || previewHere) && (
          // The last label ends on the content's edge, or past the page's
          // padding the hand-in file header's open-in-new-tab icon.
          <div
            className={cn(
              'absolute top-1/2 flex -translate-y-1/2 items-center gap-1 max-md:hidden',
              marked ? 'right-[-4px]' : 'right-[-13px] lg:right-[-25px]'
            )}
          >
            {previewHere && (
              <PreviewButton
                className={cn('pl-2', fullscreenHere ? 'pr-2' : 'pr-1')}
                disabled={previewWaits}
                onClick={() => setPreviewing(true)}
                size="sm"
                variant="ghost-hover"
              />
            )}
            {fullscreenHere && (
              <Button
                className="pr-1 pl-2"
                iconLeft="maximize"
                onClick={() => setFullscreen(true)}
                size="sm"
                variant="ghost-hover"
              >
                {m.material_fullscreen()}
              </Button>
            )}
          </div>
        )}
      </div>
      {tab === 'settings' ? (
        <AssignmentSettingsTab
          assignment={assignment}
          className="tab-body-mt"
        />
      ) : editing ? (
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            // Full screen: the editor alone, its save status, Undo, Redo and
            // the exit in a bar above it.
            editorFullscreen ? 'fixed inset-0 z-40 bg-surface' : 'page-bleed'
          )}
        >
          {editorFullscreen && (
            <div className="flex h-12 shrink-0 items-center justify-end gap-2 border-divider border-b px-4">
              <EditorSaveStatus labelled store={editorStatus} />
              <span className="flex items-center" ref={setEditorActions} />
              <ToolbarButton
                label={m.material_fullscreen_exit()}
                onClick={() => setFullscreen(false)}
              >
                <Icon name="minimize" />
              </ToolbarButton>
            </div>
          )}
          {paper === undefined ? (
            quizId ? (
              <FileActionsTarget.Provider value={editorActions}>
                <GradedQuizQuestions
                  onStatusChange={editorStatus.getState().report}
                  quizId={quizId}
                />
              </FileActionsTarget.Provider>
            ) : (
              // Its quiz is gone: the questions members were given, to read.
              data && (
                <QuizReadSplit
                  questions={data.questions.map((item) => item.question)}
                />
              )
            )
          ) : (
            <QuestionPaperView
              change={
                assignment.manage && {
                  assignmentId: assignment.id,
                  workspaceId: assignment.workspaceId,
                }
              }
              file={paper}
              named
            />
          )}
        </div>
      ) : marked ? (
        isPending ? (
          <SkeletonList className="mt-5" count={6} rowHeight={44} />
        ) : isError ? (
          <ErrorState
            className="h-auto py-20"
            errorId={unexpectedErrorId(error)}
            onRetry={() => void refetch()}
            title={m.assignment_load_failed()}
            variant="panel"
          />
        ) : tab === 'grading' ? (
          <ApproveTab
            assignment={assignment}
            onExitFullscreen={() => setFullscreen(false)}
            report={data}
            search={search}
          />
        ) : (
          <ResponsesTab
            assignment={assignment}
            byQuestion={byQuestion}
            fullscreen={wide && fullscreen}
            go={go}
            onExitFullscreen={() => setFullscreen(false)}
            report={data}
          />
        )
      ) : tab === 'grading' ? (
        <GradingTab
          assignment={assignment}
          go={(next) => void go(next)}
          loading={isPending}
          members={data?.members ?? []}
          onExitFullscreen={() => setFullscreen(false)}
          search={search}
        />
      ) : tab === 'content' ? (
        <AssignmentContent assignment={assignment} />
      ) : (
        <AssignmentResponses
          assignment={assignment}
          loading={isPending}
          members={data?.members ?? []}
          // Only Grading has more of a member to show.
          onOpen={
            tabs.includes('grading')
              ? (member) => void go({ member: member.userId, tab: 'grading' })
              : undefined
          }
        />
      )}
      {previewing && (
        <PreviewDialog
          onClose={() => setPreviewing(false)}
          title={m.assignment_preview()}
        >
          {/* What members see (Epo 2026-11-13): a published one's frozen
              questions, a draft's quiz file as Publish would freeze it. */}
          {paper === undefined ? (
            draft ? (
              quizId && <QuizFilePreview quizId={quizId} />
            ) : (
              data && (
                <AssignmentPreview
                  questions={data.questions.map((item) => item.question)}
                />
              )
            )
          ) : (
            <QuestionPaperView file={paper} named />
          )}
        </PreviewDialog>
      )}
    </PracticeFrame>
  );
}

/** Responses (Epo 2026-11-15, board Responses): a View of By member (the
 * members and their marks) or By question (each question's numbers), the
 * numbers above both (Epo 2026-11-22). Grading is its own tab, so no button
 * here opens it (Epo 2026-11-19). */
function ResponsesTab({
  assignment,
  byQuestion,
  fullscreen,
  go,
  onExitFullscreen,
  report,
}: {
  assignment: Assignment;
  byQuestion: boolean;
  /** By question covers the page (from a tablet up). */
  fullscreen: boolean;
  go: (next: AssignmentsSearch) => unknown;
  onExitFullscreen: () => void;
  report: ReportData;
}) {
  const manual = assignment.manage?.marking === 'manual';
  const view = m.assignment_view();
  // On the numbers' line, at its end (Epo 2026-11-22).
  const viewSelect = (
    <div className="flex items-center gap-3">
      <span className="font-semibold text-fg-secondary text-sm">{view}</span>
      <Select
        onValueChange={(value) =>
          void go(
            value === 'question'
              ? { by: 'question', tab: 'responses' }
              : { tab: 'responses' }
          )
        }
        value={byQuestion ? 'question' : 'member'}
      >
        {/* 36px, as the header's Preview (Epo 2026-11-16). */}
        <SelectTrigger aria-label={view} className="h-9 w-42.5">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="member">{m.assignment_by_member()}</SelectItem>
            <SelectItem value="question">
              {m.assignment_by_question()}
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
  return (
    <>
      <AssignmentStats
        assignment={assignment}
        end={viewSelect}
        members={report.members}
      />
      {byQuestion ? (
        <QuestionsTab
          aiMarks={!manual}
          fullscreen={fullscreen}
          go={go}
          onExitFullscreen={onExitFullscreen}
          questions={report.questions}
        />
      ) : (
        <MembersTab assignment={assignment} go={go} members={report.members} />
      )}
    </>
  );
}

/** An Assignment's Content (Epo 2026-11-21): the files it gives out. */
function AssignmentContent({ assignment }: { assignment: Assignment }) {
  return assignment.files.length > 0 ? (
    <AssignmentFiles assignment={assignment} />
  ) : (
    <p className="t-meta tab-body-mt text-fg-muted">
      {m.assignment_content_empty()}
    </p>
  );
}

/** An Assignment's Responses (Epo 2026-11-21): its numbers, then the members
 * in the hand-ins table's design, a row opening Grading at them. */
function AssignmentResponses({
  assignment,
  loading,
  members,
  onOpen,
}: {
  assignment: Assignment;
  loading: boolean;
  members: AssignmentMemberRow[];
  onOpen?: (member: AssignmentMemberRow) => void;
}) {
  if (loading)
    return <SkeletonList className="tab-body-mt" count={5} rowHeight={40} />;
  return (
    <>
      <AssignmentStats assignment={assignment} members={members} />
      <HandInMembers
        assignment={assignment}
        members={members}
        onOpen={onOpen}
      />
    </>
  );
}

function MemberName({ member }: { member: AssignmentMemberRow }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar
        aria-hidden
        className="size-6.5 shrink-0 text-[10px]"
        name={member.name}
        src={member.avatarUrl || undefined}
      />
      <span className="truncate font-semibold">{member.name}</span>
    </span>
  );
}

/** Members (G3m): when each submitted, how long they took, their mark and how
 * many answers wait. A row opens that member's answers. */
function MembersTab({
  assignment,
  go,
  members,
}: {
  assignment: Assignment;
  go: (next: AssignmentsSearch) => unknown;
  members: AssignmentMemberRow[];
}) {
  const status = (member: AssignmentMemberRow) =>
    member.submittedAt ? (
      <span className="flex items-center gap-2">
        {dayLabel(member.submittedAt)}
        {member.late && <LateBadge penaltyPct={member.latePenaltyPct} />}
      </span>
    ) : member.missing ? (
      <span className="font-semibold text-tint-error-fg">
        {m.assignment_missing()}
      </span>
    ) : (
      <span className="text-fg-muted">
        {member.running
          ? m.assignment_in_progress()
          : m.assignment_not_submitted()}
      </span>
    );
  const approve = (member: AssignmentMemberRow) =>
    member.marking ? (
      // A marking run holds an attempt of theirs now (Q729).
      <MarkingNow className="t-meta" />
    ) : (
      member.waitingAnswers > 0 && (
        <button
          className="t-meta font-semibold text-tint-accent-1-fg underline decoration-[1.5px] underline-offset-3 outline-none focus-visible:ring-2 focus-visible:ring-action"
          onClick={(event) => {
            event.stopPropagation();
            void go({ member: member.userId, tab: 'grading' });
          }}
          type="button"
        >
          {m.assignment_to_approve({ count: member.waitingAnswers })}
        </button>
      )
    );
  const open = (member: AssignmentMemberRow) => {
    if (member.attemptId) void go({ attempt: member.attemptId });
  };
  return (
    <>
      <table className="mt-2 hidden w-full table-fixed border-separate border-spacing-0 md:table">
        <thead>
          <tr>
            <Th>{m.assignment_col_member()}</Th>
            <Th className="w-50">{m.assignment_col_submitted()}</Th>
            <Th className="w-30">{m.assignment_col_time_taken()}</Th>
            <Th className="w-30">{m.assignment_col_mark()}</Th>
            <Th className="w-35" />
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr
              className={cn(
                member.attemptId &&
                  'cursor-pointer hover:[&>td]:bg-surface-hover-bg'
              )}
              key={member.userId}
              onClick={() => open(member)}
            >
              <Td>
                <MemberName member={member} />
              </Td>
              <Td muted={!member.missing}>{status(member)}</Td>
              <Td muted>
                {member.minutes ? minutesShort(member.minutes) : ''}
              </Td>
              <Td>
                {member.mark !== undefined && (
                  <span className="font-bold">
                    {formatPoints(member.mark)}{' '}
                    <span className="font-semibold text-fg-muted">
                      / {formatPoints(member.total ?? 0)}
                    </span>
                  </span>
                )}
              </Td>
              <Td>{approve(member)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-1 md:hidden">
        {members.map((member) => (
          <ListRow
            className={cn(member.attemptId && 'cursor-pointer')}
            key={member.userId}
            onClick={() => open(member)}
          >
            <div className="min-w-0 flex-1">
              <MemberName member={member} />
              <div className="t-meta mt-0.5 flex flex-wrap items-center gap-x-2 pl-9 text-fg-muted">
                {status(member)}
                {member.minutes ? (
                  <span>{minutesShort(member.minutes)}</span>
                ) : null}
                {approve(member)}
              </div>
            </div>
            {member.mark !== undefined && (
              <span className="shrink-0 font-bold">
                {markText(member.mark, member.total ?? 0)}
              </span>
            )}
          </ListRow>
        ))}
      </ul>
      {takesLateWork(assignment) && (
        <p className="t-meta mt-3 text-fg-muted">{m.assignment_late_note()}</p>
      )}
    </>
  );
}

const minutesShort = (count: number) => m.assignment_minutes_short({ count });

/** An assignment's numbers over its Questions, or an unmarked one's Members
 * (Epo 2026-11-13): submissions, then a marked one's average mark and time and
 * the attempts and uploads a member is allowed. */
function AssignmentStats({
  assignment,
  end,
  members,
}: {
  assignment: Assignment;
  /** At the row's end: Responses' View (Epo 2026-11-22). */
  end?: ReactNode;
  members: AssignmentMemberRow[];
}) {
  const manage = assignment.manage;
  const times = members.flatMap((member) =>
    member.minutes ? [member.minutes] : []
  );
  const marked = assignment.kind === 'marked';
  const marks = members.flatMap((member) =>
    member.mark === undefined
      ? []
      : [{ mark: member.mark, total: member.total ?? 0 }]
  );
  const mean = (values: number[]) =>
    formatPoints(
      Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1))
    );
  const stats = [
    {
      label: marked
        ? m.assignment_col_submitted()
        : assignment.allowUploads
          ? m.assignment_col_handed_in()
          : m.assignment_done(),
      value: m.assignment_stat_of({
        done: manage?.done ?? 0,
        total: manage?.assigned ?? 0,
      }),
    },
    // In marks, as each question's (Epo 2026-11-22): the members' rows'
    // marks over what they were out of.
    isGraded(assignment) && {
      label: m.assignment_average(),
      value: marks.length
        ? `${mean(marks.map(({ mark }) => mark))} / ${mean(marks.map(({ total }) => total))}`
        : '–',
    },
    marked && {
      label: m.assignment_stat_time(),
      value: times.length
        ? minutesShort(
            Math.round(times.reduce((a, b) => a + b, 0) / times.length)
          )
        : '–',
    },
    marked && assignment.attempts > 1
      ? {
          label: m.assignment_field_attempts(),
          value: String(assignment.attempts),
        }
      : null,
    marked && assignment.allowUploads
      ? {
          label: m.assignment_field_submission(),
          value: assignment.uploadOnly
            ? m.assignment_submission_upload()
            : m.assignment_submission_both(),
        }
      : null,
  ].filter((stat) => !!stat);
  return (
    <div className="tab-body-mt mb-2 flex shrink-0 flex-wrap items-center gap-x-10 gap-y-3">
      <dl className="flex flex-wrap gap-x-10 gap-y-3">
        {stats.map((stat) => (
          <div key={stat.label}>
            <dt className="t-meta text-fg-muted">{stat.label}</dt>
            <dd className="mt-0.5 font-bold text-xl">{stat.value}</dd>
          </div>
        ))}
      </dl>
      {end && <div className="ml-auto">{end}</div>}
    </div>
  );
}

/** Questions (G3) laid out as a member answers them (Epo 2026-11-22): the
 * numbers on the left in their average's tint, every question on the right
 * as the Questions tab draws it, its parts labelled and sub-parts indented,
 * each part's numbers where its answer would be. A number scrolls to its
 * question; the one in view is current. */
function QuestionsTab({
  aiMarks,
  fullscreen,
  go,
  onExitFullscreen,
  questions,
}: {
  aiMarks: boolean;
  /** The split alone over the page, as the quiz editor's full screen. */
  fullscreen: boolean;
  go: (next: AssignmentsSearch) => unknown;
  onExitFullscreen: () => void;
  questions: AssignmentQuestionReport[];
}) {
  const [current, setCurrent] = useState<string | undefined>(
    questions[0]?.question.id
  );
  const list = useRef<HTMLOListElement>(null);
  const items = questions.map((row): NumberItem => {
    const average = questionAverage(row);
    return {
      id: row.question.id,
      label: average
        ? `${m.assignment_average()} ${m.assignment_stat_of(average)}`
        : m.assignment_not_marked(),
      state: 'empty',
      tone: averageTone(average?.share),
    };
  });
  const open = (id: string) => {
    setCurrent(id);
    list.current
      ?.querySelector(`[data-report-question="${id}"]`)
      // Not in every test DOM.
      ?.scrollIntoView?.({ block: 'start' });
  };
  // The first question still in view below the pane's top is current.
  const follow = (event: UIEvent) => {
    const pane = event.target as HTMLElement;
    if (!pane.matches('[data-quiz-pane]')) return;
    const top = pane.getBoundingClientRect().top + 96;
    const shown = [
      ...pane.querySelectorAll<HTMLElement>('[data-report-question]'),
    ].find((el) => el.getBoundingClientRect().bottom > top);
    if (shown) setCurrent(shown.dataset.reportQuestion);
  };
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        fullscreen
          ? 'fixed inset-0 z-40 bg-surface'
          : 'page-bleed mt-3 border-divider border-t'
      )}
      onScrollCapture={follow}
    >
      {fullscreen && (
        <div className="flex h-12 shrink-0 items-center justify-end border-divider border-b px-4">
          <ToolbarButton
            label={m.material_fullscreen_exit()}
            onClick={onExitFullscreen}
          >
            <Icon name="minimize" />
          </ToolbarButton>
        </div>
      )}
      <QuizSplit
        current={current}
        listed
        numbers={
          <QuestionNumbers
            current={current}
            items={items}
            legend={averageLegend()}
            onOpen={open}
          />
        }
        onBack={() => undefined}
        onOpen={open}
        onQuestion
        phoneStrip={
          <NumberStrip current={current} items={items} onOpen={open} />
        }
        questions={questions.map((row) => row.question)}
      >
        <ol className="mx-auto w-full max-w-3xl px-4 pb-10 sm:px-6" ref={list}>
          {questions.map((row, i) => (
            <li
              className="scroll-mt-4 border-divider border-b py-6 last:border-b-0"
              data-report-question={row.question.id}
              key={row.question.id}
            >
              <QuestionView
                question={row.question}
                questionNumber={i + 1}
                renderAnswer={(part) => {
                  const stats = row.parts.find((p) => p.partId === part.id);
                  return (
                    stats && (
                      <div className="col-[2/-1] min-w-0">
                        <PartStats
                          aiMarks={aiMarks}
                          go={go}
                          part={stats}
                          question={row.question}
                        />
                      </div>
                    )
                  );
                }}
                // The type goes on narrow questions, where it squeezes the text.
                renderMarks={(part) => (
                  <>
                    <span className="@max-[36rem]/question:hidden">
                      {`${answerLabels[part.answer.type]()} · `}
                    </span>
                    {marksText(part.marks)}
                  </>
                )}
              />
            </li>
          ))}
        </ol>
      </QuizSplit>
    </div>
  );
}

/** A question's average over its parts marked so far, in marks and as a
 * share of those parts' marks; none until one is marked. */
function questionAverage(row: AssignmentQuestionReport) {
  let done = 0;
  let total = 0;
  for (const stats of row.parts) {
    const part = row.question.parts.find((p) => p.id === stats.partId);
    if (stats.average === undefined || !part) continue;
    done += stats.average;
    total += part.marks;
  }
  if (!total) return;
  return {
    done: formatPoints(Number(done.toFixed(1))),
    share: done / total,
    total,
  };
}

/** A part's numbers: its average, led by "AI graded" on an open or drawing
 * part unless Marking is Manual (Epo 2026-11-14); answer frequencies, common
 * wrong answers or how often each marking point was awarded; then its key. */
function PartStats({
  aiMarks,
  go,
  part,
  question,
}: {
  /** The AI marks its open and drawn answers (Marking isn't Manual). */
  aiMarks: boolean;
  go: (next: AssignmentsSearch) => unknown;
  part: AssignmentPartReport;
  question: Question;
}) {
  const source = question.parts.find((p) => p.id === part.partId);
  if (!source) return null;
  const answer = source.answer;
  // "Average 2.8 of 4" for every type, in marks (Epo 2026-11-22, was "80%"
  // for closed answers); only "Average" is muted. "–" until one is marked.
  const open = modelMarked(answer.type);
  const tone = averageTone(
    part.average === undefined || !source.marks
      ? undefined
      : part.average / source.marks
  );
  const value =
    part.average === undefined
      ? undefined
      : m.assignment_stat_of({
          done: formatPoints(Number(part.average.toFixed(1))),
          total: source.marks,
        });
  return (
    <div className="grid gap-3">
      {/* The average in its band's tint, as the question's number (Epo
          2026-11-22). */}
      <p className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        {aiMarks && open && (
          <Badge size="sm" tone="accent-1">
            {m.assignment_ai_graded()}
          </Badge>
        )}
        <span className="text-fg-muted">{m.assignment_average()}</span>
        {value && tone ? (
          <Badge size="sm" tone={tone}>
            {value}
          </Badge>
        ) : (
          <b className="font-bold">–</b>
        )}
      </p>
      {answer.type === 'mcq' && part.options && (
        <OptionBars
          correct={answer.correct}
          counts={part.options}
          labels={answer.options}
          letters
        />
      )}
      {answer.type === 'boolean' && part.options && (
        <OptionBars
          correct={[answer.correct ? 0 : 1]}
          counts={part.options}
          labels={[m.question_ui_true(), m.question_ui_false()]}
        />
      )}
      {answer.type === 'short' && !!part.wrongAnswers?.length && (
        <div>
          <p className="t-meta text-fg-secondary">
            {m.assignment_common_wrong()}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {part.wrongAnswers.map((wrong) => (
              <span className={CHIP} key={wrong.text}>
                {`${wrong.text} · ${wrong.count}`}
              </span>
            ))}
          </div>
        </div>
      )}
      {open && part.items && (
        <div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_210px]">
            <p className="t-meta border-divider border-b pb-1.5 text-fg-secondary">
              {m.assignment_marking_point()}
            </p>
            <p className="t-meta border-divider border-b pb-1.5 text-fg-secondary">
              {m.assignment_awarded()}
            </p>
            {part.items.map((item) => {
              const share = item.marked ? item.awarded / item.marked : 0;
              return (
                <div className="contents" key={item.text}>
                  <div className="border-divider border-b py-2.5 pr-2">
                    <TextView marks text={item.text} />
                  </div>
                  <div className="flex min-h-11 items-center gap-2 border-divider border-b py-2">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-14 shrink-0 overflow-hidden rounded-full bg-divider sm:w-25"
                    >
                      <span
                        className="block h-full bg-solid-accent-1"
                        style={{ width: `${share * 100}%` }}
                      />
                    </span>
                    <span className="t-meta whitespace-nowrap font-semibold text-fg-secondary">
                      {m.practice_tried_of({
                        members: item.marked,
                        tried: item.awarded,
                      })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <UnderlineLink
            className="mt-3 text-fg"
            onClick={() => void go({ question: question.id, tab: 'grading' })}
          >
            {m.assignment_check_marks()}
          </UnderlineLink>
        </div>
      )}
      <PartKey part={source} />
    </div>
  );
}

/** A part's answer, sample answer and solution under its numbers (Epo
 * 2026-11-13): the accepted answers or key where the bars do not already mark
 * it, a long or drawing part's sample answer (Epo 2026-11-15), the Solution. */
function PartKey({ part }: { part: Question['parts'][number] }) {
  const { answer } = part;
  const key =
    answer.type === 'mcq' ||
    answer.type === 'boolean' ||
    modelMarked(answer.type) ? null : (
      <AnswerView part={part} />
    );
  const sample = hasSample(part);
  if (!key && !sample && part.solution.length === 0) return null;
  return (
    <div className="mt-1 grid gap-3">
      {key && (
        <div>
          <p className="t-meta mb-1 text-fg-secondary">
            {m.question_ui_answer()}
          </p>
          {key}
        </div>
      )}
      {sample && (
        <div>
          <p className="t-meta mb-1 text-fg-secondary">
            {m.question_ui_sample_answer_heading()}
          </p>
          <SampleView part={part} />
        </div>
      )}
      {part.solution.length > 0 && (
        <div>
          <p className="t-meta mb-1 text-fg-secondary">
            {m.question_ui_worked_solution()}
          </p>
          <div className="grid gap-3">
            {part.solution.map((block, i) => (
              <QuestionBlockView block={block} key={i} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OptionBars({
  correct,
  counts,
  labels,
  letters,
}: {
  correct: number[];
  counts: number[];
  labels: string[];
  letters?: boolean;
}) {
  const max = Math.max(
    1,
    ...counts.map((n) => n),
    counts.reduce((a, b) => a + b, 0)
  );
  return (
    <ul className="flex flex-col gap-1.5">
      {labels.map((label, i) => {
        const right = correct.includes(i);
        return (
          <li
            className={cn(
              'grid min-h-7 items-center gap-2',
              // True and False have no letter column, so they start at the
              // column's edge. The label and its bar halve the full width.
              letters
                ? 'grid-cols-[20px_minmax(0,1fr)_72px_16px] sm:grid-cols-[20px_minmax(0,1fr)_minmax(80px,1fr)_20px]'
                : 'grid-cols-[minmax(0,1fr)_72px_16px] sm:grid-cols-[minmax(0,1fr)_minmax(80px,1fr)_20px]'
            )}
            key={label}
          >
            {letters && (
              <span className="font-semibold text-fg-muted">
                {optionLetter(i)}
              </span>
            )}
            {/* Correct at the column's right edge, lined up down the list. */}
            <span className="flex min-w-0 items-center justify-between gap-2 font-medium">
              <TextView className="truncate" text={label} />
              {right && (
                <span className="t-meta inline-flex shrink-0 items-center gap-1 text-tint-success-fg">
                  <Icon name="check" size={14} />
                  <span className="max-sm:sr-only">
                    {m.assignment_correct_answer()}
                  </span>
                </span>
              )}
            </span>
            <span
              aria-hidden
              className="block h-2 overflow-hidden rounded-full bg-divider"
            >
              <span
                className={cn(
                  'block h-full',
                  right ? 'bg-solid-success' : 'bg-line-strong'
                )}
                style={{ width: `${(counts[i] / max) * 100}%` }}
              />
            </span>
            <span className="text-right font-semibold">{counts[i]}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Release grades (T5), confirming first how many answers still wait. */
function ReleaseGrades({
  assignment,
  className,
}: {
  assignment: Assignment;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  const { mutate, isPending } = useReleaseAssignmentGrades(
    assignment.workspaceId,
    assignment.id
  );
  const waiting = assignment.manage?.toApprove ?? 0;
  return (
    <div className={className}>
      <Button disabled={isPending} onClick={() => setAsking(true)}>
        {m.assignment_release_grades()}
      </Button>
      {asking && (
        <ConfirmDialog
          body={[
            m.assignment_release_grades_body(),
            waiting === 1
              ? m.assignment_release_waiting_one()
              : waiting > 1
                ? m.assignment_release_waiting({ count: waiting })
                : '',
          ]
            .filter(Boolean)
            .join(' ')}
          confirmLabel={m.assignment_release_grades()}
          danger={false}
          onClose={() => setAsking(false)}
          onConfirm={() => mutate()}
          open
          title={m.assignment_release_grades_title()}
        />
      )}
    </div>
  );
}
