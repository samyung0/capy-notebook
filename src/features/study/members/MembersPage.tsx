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
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { percentText } from '../assignments/assignmentText';
import { PracticeFrame } from '../practice/studyPage';
import { studyView } from '../practice/studyView';
import { LabelPill } from '../topicLabels';
import { MemberProfilePage } from './MemberProfile';
import { MembersRoster } from './MembersRoster';
import {
  focusOf,
  type MembersShow,
  type MembersSort,
  sortMembers,
  standingIn,
  topicCount,
  topicName,
} from './membersRows';
import { StorageFullChip } from './StorageFullChip';

/** Members' URL, under `study=members`: `member` opens one's profile, `show`
 * picks Overview's view, `manage` the Manage tab. */
export type MembersSearch = {
  manage?: true;
  member?: string;
  show?: 'topics';
};

/** Members (its own page on the rail since Epo 2026-11-11). A class's owner and
 * teaching assistants get two tabs (Epo 2026-11-11): Overview, every member's
 * marks (boards Main, G4, G2), and Manage, the people with sharing and
 * invitations (`MembersRoster`). Every other member gets that list alone,
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
      manage={!!search.manage}
      show={search.show ? 'topics' : 'summary'}
      workspace={ws}
    />
  );
}

function MembersList({
  manage,
  show,
  workspace,
}: {
  manage: boolean;
  show: MembersShow;
  workspace: Workspace;
}) {
  const workspaceId = workspace.id;
  const navigate = useNavigate();
  const { data, error, isError, isPending, refetch } = useMembersProgress(
    workspaceId,
    { errorBoundary: false }
  );
  const [sort, setSort] = useState<MembersSort>('attention');
  const count = data?.members.length;
  const meta = [
    workspace.name,
    count === undefined
      ? null
      : count === 1
        ? m.workspace_members_one()
        : m.workspace_members_count({ count }),
  ]
    .filter(Boolean)
    .join(' · ');
  const setShow = (next: MembersShow) =>
    navigate({
      replace: true,
      search: {
        show: next === 'topics' ? ('topics' as const) : undefined,
        study: 'members' as const,
      },
      to: '.',
    });
  // Overview keeps its view while Manage is open.
  const setTab = (next: string) =>
    navigate({
      replace: true,
      search: {
        manage: next === 'manage' ? (true as const) : undefined,
        show: show === 'topics' ? ('topics' as const) : undefined,
        study: 'members' as const,
      },
      to: '.',
    });
  const open = (member: MemberProgress) =>
    navigate({
      search: {
        member: member.userId,
        show: show === 'topics' ? ('topics' as const) : undefined,
        study: 'members' as const,
      },
      to: '.',
    });
  const showLabel =
    show === 'topics' ? m.members_show_topics() : m.members_show_summary();
  const sortLabel =
    sort === 'name' ? m.members_sort_name() : m.members_sort_attention();
  const header = (
    <>
      {/* No New assignment here: Assignments has it (Epo 2026-11-11). */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3">
        <h1 className="t-page-title">{m.study_panel_members()}</h1>
        <span className="t-meta mt-1.5 text-fg-muted">{meta}</span>
      </div>
      <Tabs
        className="mt-2"
        onChange={(next) => void setTab(next)}
        tabs={[
          { label: m.members_tab_overview(), value: 'overview' },
          { label: m.members_tab_manage(), value: 'manage' },
        ]}
        value={manage ? 'manage' : 'overview'}
      />
    </>
  );
  if (manage) return <MembersRoster header={header} workspace={workspace} />;
  return (
    <PracticeFrame className="@container">
      {header}
      <div
        className={cn(
          'mt-4 flex flex-wrap items-center gap-2',
          show === 'topics' ? 'mb-2' : 'mb-1.5'
        )}
      >
        <div className="@4xl:block hidden">
          <Menu
            align="start"
            items={(['summary', 'topics'] as const).map((value) => ({
              checked: show === value,
              label:
                value === 'topics'
                  ? m.members_show_topics()
                  : m.members_show_summary(),
              onClick: () => void setShow(value),
            }))}
            trigger={
              <Button
                className="px-2.5"
                iconRight="chevronDown"
                size="sm"
                variant="outline"
              >
                {m.members_show({ view: showLabel })}
              </Button>
            }
          />
        </div>
        <div className={cn(show === 'topics' && '@4xl:hidden')}>
          <Menu
            align="start"
            items={(['attention', 'name'] as const).map((value) => ({
              checked: sort === value,
              label:
                value === 'name'
                  ? m.members_sort_name()
                  : m.members_sort_attention(),
              onClick: () => setSort(value),
            }))}
            trigger={
              <Button
                className="px-2.5"
                iconRight="chevronDown"
                size="sm"
                variant="outline"
              >
                {m.members_sort({ order: sortLabel })}
              </Button>
            }
          />
        </div>
        {show === 'topics' && (
          <span className="t-meta ml-auto @4xl:inline hidden text-fg-muted">
            {m.members_labels_need()}
          </span>
        )}
      </div>
      {isPending ? (
        <SkeletonList
          className="mt-4"
          count={6}
          rowHeight={show === 'topics' ? 64 : 52}
        />
      ) : isError ? (
        <ErrorState
          action={
            <Button onClick={() => void refetch()} variant="outline">
              {m.action_retry()}
            </Button>
          }
          className="mt-10"
          errorId={unexpectedErrorId(error)}
          title={m.members_load_failed()}
          variant="panel"
        />
      ) : data.members.length === 0 ? (
        <p className="t-meta mt-6 text-fg-muted">{m.members_empty()}</p>
      ) : (
        <>
          {/* Where the table fits: the boards' Summary or By topic. */}
          <div className="@4xl:block hidden">
            {show === 'topics' ? (
              <TopicsGrid data={data} onOpen={(mp) => void open(mp)} />
            ) : (
              <SummaryList
                members={sortMembers(data.members, sort)}
                onOpen={(mp) => void open(mp)}
              />
            )}
          </div>
          {/* Phones and narrow panes: a plain list; labels wait for the
              profile (Epo 2026-11-08). */}
          <PhoneList
            members={sortMembers(data.members, sort)}
            onOpen={(mp) => void open(mp)}
          />
        </>
      )}
    </PracticeFrame>
  );
}

const GRID =
  'grid grid-cols-[240px_280px_180px_minmax(0,1fr)] items-center gap-3 px-3';

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
            <span className="flex min-w-0 items-center gap-2">
              <button
                className="min-w-0 truncate rounded-sm text-left font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(member);
                }}
                type="button"
              >
                {member.name}
              </button>
              {member.storageFull && <StorageFullChip />}
            </span>
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
  stacked,
}: {
  member: MemberProgress;
  onOpen?: () => void;
  /** The storage chip under the name, in By topic's narrow column. */
  stacked?: boolean;
}) {
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-2.5',
        stacked && 'grid grid-cols-[auto_minmax(0,1fr)] gap-y-1'
      )}
    >
      <Avatar
        aria-hidden
        className={cn('size-7.5 shrink-0 text-xs', stacked && 'row-span-2')}
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
      {member.storageFull && (
        <span className={cn(stacked && 'col-start-2')}>
          <StorageFullChip />
        </span>
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
    case 'attempted':
      return (
        <span className={cn(CHIP, 'bg-page-hover text-fg-secondary')}>
          {m.topic_label_attempted()}
        </span>
      );
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

/** By topic (board G4): members × topics, under a pinned All members row of
 * counts. A member's row opens their profile. The grid scrolls both ways in a
 * box no taller than the window, so the header and All members stay in view
 * (Q723, finding 9): a sideways scroller would otherwise hold them. */
function TopicsGrid({
  data,
  onOpen,
}: {
  data: MembersProgress;
  onOpen: (member: MemberProgress) => void;
}) {
  const { members, topics } = data;
  return (
    <div className="-mx-4 max-h-[calc(100dvh-190px)] overflow-auto px-4 sm:mx-0 sm:px-0">
      <table
        className="w-full table-fixed border-separate border-spacing-0"
        style={{ minWidth: 190 + topics.length * 120 }}
      >
        {/* Opaque rows: the card's colour, then All members on the page's. */}
        <thead className="sticky top-0 z-10">
          <tr className="bg-surface">
            <th className="t-meta w-47.5 border-divider border-b py-3 pr-2 pl-3 text-left align-bottom font-semibold text-fg-muted">
              {m.members_col_member()}
            </th>
            {topics.map((topic) => (
              <th
                className="t-meta border-divider border-b px-2 py-3 text-center align-bottom font-semibold text-fg-muted"
                key={topic.topicId ?? topic.group}
              >
                <div className="line-clamp-2">{topicName(topic)}</div>
                <div className="font-medium">
                  {questionsText(topic.questions)}
                </div>
              </th>
            ))}
          </tr>
          <tr className="bg-page">
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
                <MemberName
                  member={member}
                  onOpen={() => onOpen(member)}
                  stacked
                />
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
