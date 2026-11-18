import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { useMembersProgress, useWorkspace } from '@/api/hooks';
import type {
  MemberProgress,
  MembersProgress,
  SummaryTopic,
  Workspace,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { ListToolbar } from '@/components/app/ListToolbar';
import {
  ariaSort,
  type ColumnSort,
  SortHeader,
  sortDirection,
} from '@/components/app/SortHeader';
import { Avatar } from '@/components/ui/Avatar';
import { SkeletonList } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import { percentText } from '../assignments/assignmentText';
import { ListRow, PracticeFrame, RowScore } from '../practice/studyPage';
import { studyView } from '../practice/studyView';
import { studyLink } from '../studyRoutes';
import { LabelPill } from '../topicLabels';
import { MemberProfilePage } from './MemberProfile';
import { MembersRoster } from './MembersRoster';
import { storageFullOf } from './membersAttention';
import {
  focusOf,
  type MembersSort,
  type MembersTab,
  needsAttention,
  sortMembers,
  standingIn,
  topicCount,
  topicKey,
  topicName,
} from './membersRows';

/** Members (its own page on the rail since Epo 2026-11-11): the people, with
 * sharing and invitations (`MembersRoster`). A class's owner and teaching
 * assistants manage them there; their marks are on Study (Epo 2026-11-13).
 * Every other member gets the list without marks; a visitor who is no member
 * has no Members (`studyView`). */
export function MembersPage({ workspaceId }: { workspaceId: string }) {
  const { data: ws } = useWorkspace(workspaceId);
  if (!ws) return null;
  return studyView(ws).manages ? (
    <StaffRoster workspace={ws} />
  ) : (
    <MembersRoster workspace={ws} />
  );
}

/** A class's staff: the people under the page's title, a member whose
 * storage is full flagged (the rail's dot). */
function StaffRoster({ workspace }: { workspace: Workspace }) {
  const { data } = useMembersProgress(workspace.id, { errorBoundary: false });
  return (
    <MembersRoster
      header={<h1 className="t-page-title">{m.study_panel_members()}</h1>}
      storageFull={storageFullOf(data)}
      workspace={workspace}
    />
  );
}

/** Study for a class's owner and teaching assistants (Epo 2026-11-13; Members'
 * Overview and Topics until then): Overview, every member's marks (boards
 * Main, G2), and Topics, members × topics (board G4), under `header`; a
 * member's line opens their profile, `member`. */
export function MembersMarks({
  header,
  member,
  tab,
  workspace,
}: {
  header: ReactNode;
  member?: string;
  tab: MembersTab;
  workspace: Workspace;
}) {
  if (member)
    return (
      <MemberProfilePage
        key={member}
        memberId={member}
        show={tab === 'topics' ? 'topics' : undefined}
        workspaceId={workspace.id}
      />
    );
  return <MembersList header={header} tab={tab} workspace={workspace} />;
}

function MembersList({
  header,
  tab,
  workspace,
}: {
  header: ReactNode;
  tab: MembersTab;
  workspace: Workspace;
}) {
  const workspaceId = workspace.id;
  const navigate = useNavigate();
  const { data, error, isError, isPending, refetch } = useMembersProgress(
    workspaceId,
    { errorBoundary: false }
  );
  const revealRef = useLoadingReveal(isPending);
  // Name A to Z first; a column header sorts by it (Epo 2026-11-13), and
  // Needs attention is a filter.
  const [order, setOrder] = useState<{
    ascending: boolean;
    sort: MembersSort;
  }>({ ascending: true, sort: 'name' });
  const [attention, setAttention] = useState(false);
  const sorting: ColumnSort<MembersSort> = {
    ascending: order.ascending,
    ascendingFirst: ['name'],
    onSortChange: (sort, ascending) => setOrder({ ascending, sort }),
    sort: order.sort,
  };
  const sorted = (members: MemberProgress[]) =>
    sortMembers(
      attention ? members.filter(needsAttention) : members,
      order.sort,
      order.ascending
    );
  const open = (member: MemberProgress) =>
    navigate(
      studyLink(workspaceId, tab === 'topics' ? 'topics' : 'summary', {
        member: member.userId,
      })
    );
  const topics = tab === 'topics';
  return (
    <PracticeFrame className="@container">
      {header}
      {/* The list pages' toolbar (Epo 2026-11-16), as Practice's; columns
          sort from their headers. 16px under the tabs, as on Files; -mb-1 is its
          -mb-3 with a PageBody's 8px. */}
      <ListToolbar
        after={
          topics && (
            <span className="t-meta text-fg-muted">
              {m.members_labels_need()}
            </span>
          )
        }
        className="mt-2 -mb-1"
        filters={[
          {
            key: 'attention',
            label: m.members_col_member(),
            onToggle: () => setAttention(!attention),
            options: [
              { label: m.members_filter_attention(), value: 'attention' },
            ],
            selected: attention ? ['attention'] : [],
          },
        ]}
        inPage
        onResetFilters={() => setAttention(false)}
      />
      {isPending ? (
        <SkeletonList className="mt-4" count={6} rowHeight={topics ? 64 : 52} />
      ) : isError ? (
        <ErrorState
          className="h-auto py-20"
          errorId={unexpectedErrorId(error)}
          onRetry={() => void refetch()}
          title={m.members_load_failed()}
          variant="panel"
        />
      ) : data.members.length === 0 ? (
        <p className="t-meta mt-6 text-fg-muted">{m.members_empty()}</p>
      ) : (
        <div ref={revealRef}>
          {topics ? (
            <TopicsGrid
              members={sorted(data.members)}
              onOpen={(mp) => void open(mp)}
              sorting={sorting}
              topics={data.topics}
            />
          ) : (
            <>
              {/* Where the table fits: the boards' Summary. */}
              <div className="@4xl:block hidden">
                <SummaryList
                  members={sorted(data.members)}
                  onOpen={(mp) => void open(mp)}
                  sorting={sorting}
                />
              </div>
              {/* Phones and narrow panes: a plain list; labels wait for the
                  profile (Epo 2026-11-08). */}
              <PhoneList
                members={sorted(data.members)}
                onOpen={(mp) => void open(mp)}
              />
            </>
          )}
        </div>
      )}
    </PracticeFrame>
  );
}

/** The rows bleed 12px into the gutter: text lines up with the toolbar and
 * Manage's list, the hover keeps room around it. */
const GRID =
  '-mx-3 grid grid-cols-[240px_280px_180px_minmax(0,1fr)] items-center gap-3 px-3';

/** Summary (board Main): one 52px line per member; a line opens the profile. */
function SummaryList({
  members,
  onOpen,
  sorting,
}: {
  members: MemberProgress[];
  onOpen: (member: MemberProgress) => void;
  sorting: ColumnSort<MembersSort>;
}) {
  const column = (label: string, value: MembersSort) => (
    <span
      aria-sort={ariaSort(sortDirection(sorting, value))}
      className="min-w-0"
      role="columnheader"
    >
      <SortHeader label={label} sorting={sorting} value={value} />
    </span>
  );
  return (
    <>
      <div
        className={cn(
          'h-9 border-divider border-b font-semibold text-[13px] text-fg-muted',
          GRID
        )}
        role="row"
      >
        {column(m.members_col_member(), 'name')}
        {column(m.study_panel_assignments(), 'assignments')}
        {column(m.members_col_practice(), 'practice')}
        {column(m.topic_label_needs_practice(), 'needs')}
      </div>
      <ul>
        {members.map((member) => (
          // The name is the row's button; the rest of the row clicks through
          // to it, and the storage chip is a control of its own.
          <li
            className={cn(
              // 36px, as the Study tables' rows (Epo 2026-11-13).
              'min-h-9 cursor-pointer border-divider border-b py-1 hover:bg-surface-hover-bg',
              GRID
            )}
            key={member.userId}
            onClick={() => onOpen(member)}
          >
            <MemberName member={member} onOpen={() => onOpen(member)} small />
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <AssignmentsCell member={member} />
            </div>
            <div className="font-semibold text-fg-muted">
              {member.practiceWeek > 0
                ? questionsText(member.practiceWeek)
                : '–'}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <FocusCell member={member} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Below the table's width: name, then "3 of 4 done · 2 missing", the overall
 * on the right. No practice or labels; the profile has them. */
function PhoneList({
  members,
  onOpen,
}: {
  members: MemberProgress[];
  onOpen: (member: MemberProgress) => void;
}) {
  return (
    <ul className="@4xl:hidden">
      {members.map((member) => (
        <ListRow
          className="cursor-pointer"
          key={member.userId}
          onClick={() => onOpen(member)}
        >
          <Avatar
            aria-hidden
            className="size-9 shrink-0 text-xs"
            name={member.name}
            src={member.avatarUrl || undefined}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <button
              className="min-w-0 self-start truncate rounded-sm text-left font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(member);
              }}
              type="button"
            >
              {member.name}
            </button>
            {member.assigned > 0 && (
              <span className="t-meta truncate text-fg-muted">
                {m.assignment_done_of({
                  done: member.done,
                  total: member.assigned,
                })}
                {member.missing > 0 && (
                  <>
                    {' · '}
                    <span className="font-semibold text-tint-error-fg">
                      {m.members_missing({ count: member.missing })}
                    </span>
                  </>
                )}
              </span>
            )}
          </div>
          {member.overall === undefined ? (
            <span className="shrink-0 font-bold text-fg-muted">–</span>
          ) : (
            <RowScore
              label={m.study_score_overall()}
              value={percentText(member.overall)}
            />
          )}
        </ListRow>
      ))}
    </ul>
  );
}

const questionsText = (count: number) =>
  count === 1 ? m.practice_questions_one() : m.practice_questions({ count });

function MemberName({
  member,
  onOpen,
  small,
}: {
  member: MemberProgress;
  onOpen?: () => void;
  /** A 24px avatar, for the Overview's 36px rows. */
  small?: boolean;
}) {
  return (
    <span
      className={cn('flex min-w-0 items-center', small ? 'gap-2' : 'gap-2.5')}
    >
      <Avatar
        aria-hidden
        className={cn(
          'shrink-0 text-xs',
          small ? 'size-6 text-[10px]' : 'size-7.5'
        )}
        name={member.name}
        src={member.avatarUrl || undefined}
      />
      {onOpen ? (
        <button
          className="min-w-0 truncate rounded-sm text-left font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          type="button"
        >
          {member.name}
        </button>
      ) : (
        <span className="min-w-0 truncate font-semibold">{member.name}</span>
      )}
    </span>
  );
}

/** "76% · 3 of 4 done", then "2 missing". */
function AssignmentsCell({ member }: { member: MemberProgress }) {
  if (member.assigned === 0)
    return <span className="font-semibold text-fg-muted">–</span>;
  return (
    <>
      <span>
        {member.overall !== undefined && (
          <span className="font-bold">{percentText(member.overall)} </span>
        )}
        <span className="font-semibold text-fg-muted">
          {member.overall !== undefined && '· '}
          {m.assignment_done_of({
            done: member.done,
            total: member.assigned,
          })}
        </span>
      </span>
      {member.missing > 0 && (
        <span className="t-meta inline-flex h-5.5 items-center rounded-md bg-tint-error px-1.75 font-semibold text-tint-error-fg">
          {m.members_missing({ count: member.missing })}
        </span>
      )}
    </>
  );
}

const CHIP =
  't-meta inline-flex h-5.5 items-center whitespace-nowrap rounded-md px-1.75 font-semibold';

function FocusCell({ member }: { member: MemberProgress }) {
  const focus = focusOf(member);
  switch (focus.kind) {
    case 'topics':
      return focus.topics.map((t: SummaryTopic) => (
        <span
          className={cn(CHIP, 'bg-tint-warning text-tint-warning-fg')}
          key={t.topicId ?? t.group}
        >
          {topicName(t)}
        </span>
      ));
    case 'not_started':
      return (
        <span className="font-semibold text-fg-muted">
          {m.learning_not_started()}
        </span>
      );
    default:
      return (
        <span className="font-semibold text-fg-muted">
          {m.members_nothing_flagged()}
        </span>
      );
  }
}

const COUNT: Record<SummaryTopic['label'], (count: number) => string> = {
  attempted: (count) => m.members_count_attempted({ count }),
  familiar: (count) => m.members_count_familiar({ count }),
  mastered: (count) => m.members_count_mastered({ count }),
  needs_practice: (count) =>
    count === 1
      ? m.members_count_needs_practice_one()
      : m.members_count_needs_practice({ count }),
  not_started: (count) => m.members_count_not_started({ count }),
  proficient: (count) => m.members_count_proficient({ count }),
};

/** Topics (board G4): members × topics, under an All members row of counts. A
 * member's row opens their profile. */
function TopicsGrid({
  members,
  onOpen,
  sorting,
  topics,
}: {
  /** Filtered and sorted. */
  members: MemberProgress[];
  onOpen: (member: MemberProgress) => void;
  sorting: ColumnSort<MembersSort>;
  topics: MembersProgress['topics'];
}) {
  return (
    // Sideways only: the page scrolls down (Epo 2026-11-12). The box bleeds
    // into the gutter so the cells' 12px start lines up with the page text, as
    // Overview's rows do; phones keep 4px so text sits at 16px.
    <div className="-mx-4 overflow-x-auto px-1 sm:-mx-3 sm:px-0">
      <table
        className="w-full table-fixed border-separate border-spacing-0"
        style={{ minWidth: 190 + topics.length * 120 }}
      >
        {/* All members sits on the page's colour, a light wash over a
            frosted page frame. */}
        <thead>
          <tr>
            <th
              aria-sort={ariaSort(sortDirection(sorting, 'name'))}
              className="t-meta w-47.5 border-divider border-b py-3 pr-2 pl-3 text-left align-bottom font-semibold"
            >
              <SortHeader
                label={m.members_col_member()}
                sorting={sorting}
                value="name"
              />
            </th>
            {topics.map((topic) => (
              <th
                aria-sort={ariaSort(
                  sortDirection(sorting, `topic:${topicKey(topic)}`)
                )}
                className="t-meta border-divider border-b px-2 py-3 text-center align-bottom font-semibold"
                key={topic.topicId ?? topic.group}
              >
                {/* Sorts the members by their standing in it. */}
                <SortHeader
                  label={topicName(topic)}
                  sorting={sorting}
                  value={`topic:${topicKey(topic)}`}
                />
                <div className="font-medium text-fg-muted">
                  {questionsText(topic.questions)}
                </div>
              </th>
            ))}
          </tr>
          <tr className="bg-page frosted:bg-black/4 dark:frosted:bg-white/5">
            <td className="h-10 border-divider border-b pr-2 pl-3 font-semibold">
              {m.members_all()}
            </td>
            {topics.map((topic) => {
              const count = topicCount(members, topic);
              return (
                <td
                  className="t-meta h-10 border-divider border-b px-2 text-center font-semibold text-fg-muted"
                  key={topic.topicId ?? topic.group}
                >
                  {count && COUNT[count.label](count.count)}
                </td>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr
              className="cursor-pointer hover:[&>td]:bg-surface-hover-bg"
              key={member.userId}
              onClick={() => onOpen(member)}
            >
              <td className="h-16 border-divider border-b py-2 pr-2 pl-3">
                <MemberName member={member} onOpen={() => onOpen(member)} />
              </td>
              {topics.map((topic) => (
                <TopicCell
                  key={topic.topicId ?? topic.group}
                  standing={standingIn(member, topic)}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopicCell({ standing }: { standing?: SummaryTopic }) {
  const label = standing?.label ?? 'not_started';
  return (
    <td className="h-16 border-divider border-b p-2 text-center">
      <LabelPill label={label} />
      <span className="mt-1.5 block font-semibold text-fg-muted text-xs">
        {standing && standing.asked > 0
          ? m.summary_right({ asked: standing.asked, right: standing.right })
          : m.learning_not_started()}
      </span>
    </td>
  );
}
