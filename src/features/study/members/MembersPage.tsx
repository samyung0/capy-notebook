import { Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useMembersProgress, useWorkspace } from '@/api/hooks';
import type {
  MemberProgress,
  MembersProgress,
  SummaryTopic,
  Workspace,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { SortMenu, type SortOption } from '@/components/app/ListToolbar';
import { Avatar } from '@/components/ui/Avatar';
import { SkeletonList } from '@/components/ui/feedback';
import { PendingDot } from '@/components/ui/PendingDot';
import { Tabs } from '@/components/ui/Tabs';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import { percentText } from '../assignments/assignmentText';
import { PracticeFrame } from '../practice/studyPage';
import { studyView } from '../practice/studyView';
import { LabelPill } from '../topicLabels';
import { MemberProfilePage } from './MemberProfile';
import { MembersRoster } from './MembersRoster';
import { storageFullOf } from './membersAttention';
import {
  focusOf,
  type MembersSort,
  type MembersTab,
  sortMembers,
  standingIn,
  topicCount,
  topicName,
} from './membersRows';

/** Members' URL, under `study=members`: `member` opens one's profile, `show`
 * the Topics tab, `manage` the Manage tab. */
export type MembersSearch = {
  manage?: true;
  member?: string;
  show?: 'topics';
};

/** Members (its own page on the rail since Epo 2026-11-11). A class's owner and
 * teaching assistants get three tabs: Overview, every member's marks (boards
 * Main, G2), Topics, members × topics (board G4), and Manage, the people with
 * sharing and invitations (`MembersRoster`). Every other member gets that list alone,
 * without marks. A visitor who is no member is sent to Practice. */
export function MembersPage({
  search,
  workspaceId,
}: {
  search: MembersSearch;
  workspaceId: string;
}) {
  const { data: ws } = useWorkspace(workspaceId);
  if (!ws) return null;
  if (!studyView(ws).manages)
    return ws.role ? (
      <MembersRoster workspace={ws} />
    ) : (
      <Navigate replace search={{ study: 'practice' }} to="." />
    );
  if (search.member)
    return (
      <MemberProfilePage
        key={search.member}
        memberId={search.member}
        show={search.show}
        workspaceId={workspaceId}
      />
    );
  return (
    <MembersList
      tab={search.manage ? 'manage' : search.show ? 'topics' : 'overview'}
      workspace={ws}
    />
  );
}

function MembersList({
  tab,
  workspace,
}: {
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
  const needsAction = storageFullOf(data);
  // Name A to Z first; Needs attention starts with the most to look at.
  const [sorting, setSorting] = useState<{
    ascending: boolean;
    sort: MembersSort;
  }>({ ascending: true, sort: 'name' });
  const sorts: SortOption<MembersSort>[] = [
    { icon: 'pencil', label: m.members_sort_name(), value: 'name' },
    { icon: 'alert', label: m.members_sort_attention(), value: 'attention' },
  ];
  const sorted = (members: MemberProgress[]) =>
    sortMembers(members, sorting.sort, sorting.ascending);
  const setTab = (next: string) =>
    navigate({
      replace: true,
      search: {
        manage: next === 'manage' ? (true as const) : undefined,
        show: next === 'topics' ? ('topics' as const) : undefined,
        study: 'members' as const,
      },
      to: '.',
    });
  const open = (member: MemberProgress) =>
    navigate({
      search: {
        member: member.userId,
        show: tab === 'topics' ? ('topics' as const) : undefined,
        study: 'members' as const,
      },
      to: '.',
    });
  const header = (
    <>
      {/* No New assignment here: Assignments has it (Epo 2026-11-11). */}
      <h1 className="t-page-title">{m.study_panel_members()}</h1>
      <Tabs
        className="page-bleed page-tabs-px mt-2 w-auto"
        onChange={(next) => void setTab(next)}
        tabs={[
          { label: m.members_tab_overview(), value: 'overview' },
          { label: m.members_tab_topics(), value: 'topics' },
          {
            // Something waits on the staff there, a member's full storage.
            label: (
              <span className="relative">
                {m.members_tab_manage()}
                {needsAction.size > 0 && (
                  <PendingDot className="-top-0.5 -right-2.5" />
                )}
              </span>
            ),
            value: 'manage',
          },
        ]}
        value={tab}
      />
    </>
  );
  if (tab === 'manage')
    return (
      <MembersRoster
        header={header}
        storageFull={needsAction}
        workspace={workspace}
      />
    );
  const topics = tab === 'topics';
  return (
    <PracticeFrame className="@container">
      {header}
      {/* The list pages' sort (Files, Workspaces); Topics lists by name. */}
      <div className="mt-4 mb-1.5 flex min-h-10 flex-wrap items-center gap-2 sm:min-h-11.5">
        {topics ? (
          <span className="t-meta text-fg-muted">
            {m.members_labels_need()}
          </span>
        ) : (
          // -ml-1 with the button's -mx-1 puts its icon on the gutter, as ListToolbar does.
          <div className="-ml-1 flex">
            <SortMenu
              ascending={sorting.ascending}
              onSortChange={(sort, ascending) =>
                setSorting({
                  ascending:
                    sort === sorting.sort ? ascending : sort === 'name',
                  sort,
                })
              }
              sort={sorting.sort}
              sorts={sorts}
            />
          </div>
        )}
      </div>
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
            <TopicsGrid data={data} onOpen={(mp) => void open(mp)} />
          ) : (
            <>
              {/* Where the table fits: the boards' Summary. */}
              <div className="@4xl:block hidden">
                <SummaryList
                  members={sorted(data.members)}
                  onOpen={(mp) => void open(mp)}
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
}: {
  members: MemberProgress[];
  onOpen: (member: MemberProgress) => void;
}) {
  return (
    <>
      <div
        aria-hidden
        className={cn(
          'h-9 border-divider border-b font-semibold text-[13px] text-fg-muted',
          GRID
        )}
      >
        <span>{m.members_col_member()}</span>
        <span>{m.study_panel_assignments()}</span>
        <span>{m.members_col_practice()}</span>
        <span>{m.topic_label_needs_practice()}</span>
      </div>
      <ul>
        {members.map((member) => (
          // The name is the row's button; the rest of the row clicks through
          // to it, and the storage chip is a control of its own.
          <li
            className={cn(
              'min-h-13 cursor-pointer border-divider border-b py-1.5 hover:bg-surface-hover-bg',
              GRID
            )}
            key={member.userId}
            onClick={() => onOpen(member)}
          >
            <MemberName member={member} onOpen={() => onOpen(member)} />
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
    <ul className="mt-1 @4xl:hidden">
      {members.map((member) => (
        <li
          className="flex min-h-16 cursor-pointer items-center gap-3 border-divider border-b py-3"
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
          <span
            className={cn(
              'shrink-0 font-bold',
              member.overall === undefined && 'text-fg-muted'
            )}
          >
            {member.overall === undefined ? '–' : percentText(member.overall)}
          </span>
        </li>
      ))}
    </ul>
  );
}

const questionsText = (count: number) =>
  count === 1 ? m.practice_questions_one() : m.practice_questions({ count });

function MemberName({
  member,
  onOpen,
}: {
  member: MemberProgress;
  onOpen?: () => void;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar
        aria-hidden
        className="size-7.5 shrink-0 text-xs"
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
  data,
  onOpen,
}: {
  data: MembersProgress;
  onOpen: (member: MemberProgress) => void;
}) {
  const { members, topics } = data;
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
            <th className="t-meta w-47.5 border-divider border-b py-3 pr-2 pl-3 text-left align-bottom font-semibold">
              {m.members_col_member()}
            </th>
            {topics.map((topic) => (
              <th
                className="t-meta border-divider border-b px-2 py-3 text-center align-bottom font-semibold"
                key={topic.topicId ?? topic.group}
              >
                <div className="line-clamp-2">{topicName(topic)}</div>
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
