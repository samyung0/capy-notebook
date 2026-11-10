import { Fragment, type ReactNode, useState } from 'react';
import { useHideTodoDone, useTodoTick } from '@/api/hooks';
import type { Assignment } from '@/api/types';
import {
  ariaSort,
  type ColumnSort,
  SortHeader,
  sortDirection,
} from '@/components/app/SortHeader';
import { Checkbox } from '@/components/ui/Checkbox';
import { useIsPhone } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon, type IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import type { TodoSort } from '@/lib/listSearch';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { dateLabel, dueText } from './assignmentText';
import {
  handedInText,
  rowHeading,
  TodoCheckDialog,
  TodoDialog,
  TodoRemoveDialog,
  waitingText,
} from './TodoDialog';
import { assignmentFileIcon, WorkChip } from './TodoSection';
import { isPlainTask, type TodoRow, type TodoTableSection } from './todoRows';

const keyOf = (row: TodoRow) =>
  `${row.approval ? 'approve' : 'work'}:${row.a.id}`;

/** Whether a mark can change it. Answers waiting can be ticked off even once
 * the quiz has closed, which is when most wait. Otherwise a closed one can't
 * change, and on Done a plain task's tick or a tick by hand can be undone, a
 * submission can't. */
function canTick(row: TodoRow, doneTab: boolean) {
  const { a } = row;
  if (row.approval) return !doneTab;
  if (a.closed) return false;
  if (doneTab) return a.mine?.done ? isPlainTask(a) : !!a.mine?.checkedOff;
  return isPlainTask(a) || !a.mine?.done;
}

/** The Details column: answers waiting, a quiz's mark, time limit or that it
 * runs, Not handed in when ticked by hand, else a task's first file. */
function Details({ doneTab, row }: { doneTab: boolean; row: TodoRow }) {
  const { a } = row;
  const done = !!a.mine?.done;
  let text: string | null = null;
  let tone: 'warn' | 'ok' | undefined;
  if (row.approval) {
    text = waitingText(a.manage?.toApprove ?? 0);
    tone = 'warn';
  } else if (!isPlainTask(a) && done) {
    text = handedInText(a);
    tone = a.kind === 'marked' && a.mine?.mark !== undefined ? 'ok' : undefined;
  } else if (doneTab && !done) {
    text =
      a.kind === 'marked' ? m.todo_not_handed_in() : m.assignment_not_done();
  } else if (!isPlainTask(a) && a.mine?.checkedOff) {
    text = m.todo_not_handed_in();
    tone = 'warn';
  } else if (a.mine?.runningAttemptId) {
    text = m.todo_in_progress();
  } else if (a.kind === 'marked' && a.timeLimitMin) {
    text = m.assignment_minutes_short({ count: a.timeLimitMin });
  }
  if (text)
    return (
      <span
        className={cn(
          't-meta',
          tone === 'warn' && 'font-semibold text-tint-warning-fg',
          tone === 'ok' && 'font-semibold text-tint-success-fg'
        )}
      >
        {text}
      </span>
    );
  const file = a.files[0];
  if (!file) return null;
  return (
    <span className="t-meta inline-flex min-w-0 max-w-full items-center gap-1.5">
      <FileIcon className="size-3.5 shrink-0" name={assignmentFileIcon(file)} />
      {/* Down 1px onto the icon's centre, as the workspace panel's rows. */}
      <span className="translate-y-px truncate">{file.name}</span>
      {a.files.length > 1 && (
        <span className="shrink-0 translate-y-px text-fg-muted">
          +{a.files.length - 1}
        </span>
      )}
    </span>
  );
}

/** The Due column, or on Done its Done on: the day it was done or ticked off,
 * else "Closed" and the day it closed. */
function DueCell({ a, doneTab }: { a: Assignment; doneTab: boolean }) {
  if (doneTab) {
    const at = a.mine?.doneAt ?? a.mine?.checkedAt;
    if (at) return <span className="t-meta">{dateLabel(at)}</span>;
    return a.closedAt ? (
      <span className="t-meta text-fg-muted">
        {m.todo_closed_on({ date: dateLabel(a.closedAt) })}
      </span>
    ) : null;
  }
  const due = dueText(a.dueAt, false);
  return (
    <span
      className={cn(
        't-meta',
        !a.dueAt && 'text-fg-muted',
        due.tone === 'overdue' && 'font-semibold text-tint-error-fg',
        due.tone === 'soon' && 'font-semibold text-fg'
      )}
    >
      {due.text}
    </span>
  );
}

function RowTitle({ row }: { row: TodoRow }) {
  const { a } = row;
  const chip = <WorkChip title={a.title} />;
  if (row.approval)
    return (
      <>
        <span className="shrink-0">{m.dashboard_approve_on()}</span>
        {chip}
      </>
    );
  if (a.kind === 'marked') return chip;
  return <span className="min-w-0 truncate">{a.title}</span>;
}

function HeaderCell<S extends string>({
  className,
  icon,
  label,
  sort,
  sorting,
}: {
  className?: string;
  icon: IconName;
  label: string;
  sort?: S;
  sorting: ColumnSort<S>;
}) {
  return (
    <th
      aria-sort={sort ? ariaSort(sortDirection(sorting, sort)) : undefined}
      className={cn(
        // py-2.5 as Billing's and Files' tables.
        't-meta whitespace-nowrap py-2.5 pr-4 font-medium text-fg-muted',
        className
      )}
    >
      {/* A block like the select-all box beside it, so both centre alike. */}
      <span className="flex items-center gap-1.5">
        <Icon className="shrink-0 -translate-y-px" name={icon} size={18} />
        {sort ? (
          <SortHeader fit label={label} sorting={sorting} value={sort} />
        ) : (
          label
        )}
      </span>
    </th>
  );
}

const needsAsking = (row: TodoRow) => row.approval || !isPlainTask(row.a);

/**
 * The To do page's ticks and selection (Epo 2026-11-10). A row's box selects
 * it; the toolbar's selection bar then marks the picked rows done or not done.
 * A plain task's tick is its done; a quiz's, a hand-in's or the answers
 * waiting asks first and only clears To do. A tick shows at once and holds
 * until To do has reread it.
 */
export function useTodoTicks(sections: TodoTableSection[], doneTab: boolean) {
  const { mutateAsync } = useTodoTick();
  const { mutateAsync: hide } = useHideTodoDone();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  /** Deleted off Done: gone at once, held until To do has reread. */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [removeAsking, setRemoveAsking] = useState<TodoRow[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<TodoRow[] | null>(null);
  const tickedOf = (row: TodoRow) => pending[keyOf(row)] ?? row.ticked;
  /** Marked one way and on its way to the other tab: it leaves at once. */
  const moving = (row: TodoRow) =>
    removing.has(keyOf(row)) ||
    (keyOf(row) in pending && pending[keyOf(row)] !== row.ticked);
  // What the tab shows: rows on their way out are gone already.
  const rows = sections.flatMap((s) => s.rows).filter((row) => !moving(row));
  const leaving = sections.flatMap((s) => s.rows).length - rows.length;
  const picked = rows.filter((row) => selected.has(keyOf(row)));
  const toDone = picked.filter(
    (row) => !tickedOf(row) && canTick(row, doneTab)
  );
  const toUndo = picked.filter((row) => tickedOf(row) && canTick(row, doneTab));
  const clear = () => setSelected(new Set());

  /** Sends the rows' ticks as one call. They leave at once and hold until To
   * do has reread; each call clears its own rows, since a second mutate()
   * would drop the first one's per-call callbacks. A failure has shown its
   * toast, and its rows come back. */
  const send = (list: TodoRow[], checked: boolean) => {
    const keys = list.map(keyOf);
    setPending((p) => ({
      ...p,
      ...Object.fromEntries(keys.map((key) => [key, checked])),
    }));
    void mutateAsync(
      list.map((row) => ({
        approvals: row.approval,
        checked,
        id: row.a.id,
        task: !row.approval && isPlainTask(row.a),
        workspaceId: row.a.workspaceId,
      }))
    )
      .catch(() => undefined)
      .finally(() =>
        setPending((p) =>
          Object.fromEntries(
            Object.entries(p).filter(([key]) => !keys.includes(key))
          )
        )
      );
  };
  /** Marks rows done, asking first when any isn't a plain task. */
  const markDone = (list: TodoRow[]) => {
    if (list.some(needsAsking)) {
      setAsking(list);
      return;
    }
    send(list, true);
    clear();
  };
  return {
    allSelected: rows.length > 0 && picked.length === rows.length,
    asking,
    clear,
    confirm: () => {
      if (asking) send(asking, true);
      setAsking(null);
      clear();
    },
    count: picked.length,
    dismiss: () => setAsking(null),
    isSelected: (row: TodoRow) => selected.has(keyOf(row)),
    /** Rows leaving this tab, for counts that shouldn't wait for the reread. */
    leaving,
    markDone,
    markNotDone: (list: TodoRow[]) => {
      send(list, false);
      clear();
    },
    moving,
    /** Done's Delete: takes the picked rows off the caller's Done list, after
     * asking. */
    remove: () => {
      setRemoveAsking(picked);
    },
    removeAsking,
    removeConfirm: () => {
      if (!removeAsking) return;
      const keys = removeAsking.map(keyOf);
      setRemoving((r) => new Set([...r, ...keys]));
      void hide(removeAsking.map((row) => row.a.id))
        .catch(() => undefined)
        .finally(() =>
          setRemoving((r) => new Set([...r].filter((k) => !keys.includes(k))))
        );
      setRemoveAsking(null);
      clear();
    },
    removeDismiss: () => setRemoveAsking(null),
    selectAll: () => setSelected(new Set(rows.map(keyOf))),
    tickedOf,
    toDone,
    toggle: (row: TodoRow) =>
      setSelected((current) => {
        const next = new Set(current);
        if (!next.delete(keyOf(row))) next.add(keyOf(row));
        return next;
      }),
    toUndo,
  };
}
export type TodoTicks = ReturnType<typeof useTodoTicks>;

/**
 * The To do page's list (Epo 2026-11-10, board K): a table in Billing's style,
 * a group per class that folds, a box on every row that selects it (`ticks`)
 * and the row opening its details, with a select-all box in the header. A row
 * marked done or not done leaves for the other tab at once, and the header
 * stays over Nothing to do once none is left. Phones stack each row's facts under it. The Done tab
 * shows the same table, dated by when each was done, ticked off or closed.
 */
export function TodoTable({
  doneTab,
  sections,
  sorting,
  ticks,
}: {
  doneTab: boolean;
  sections: TodoTableSection[];
  sorting: ColumnSort<TodoSort>;
  ticks: TodoTicks;
}) {
  const phone = useIsPhone();
  // Posted by from xl only, so the titles keep their room on a laptop; a
  // rendered column, not a hidden one, so the group rows' span matches.
  const wide = useMediaQuery('(min-width: 1280px)');
  const columns = wide ? 5 : 4;
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<string | null>(null);
  const rows = sections.flatMap((s) =>
    s.rows.map((row) => ({ row, workspace: s.workspace }))
  );
  const find = (key: string | null) =>
    key ? rows.find(({ row }) => keyOf(row) === key) : undefined;
  const { tickedOf } = ticks;
  const visible = (section: TodoTableSection) =>
    section.rows.filter((row) => !ticks.moving(row));
  // Empty the moment its last rows are marked, not after the reread.
  const empty = sections.every((s) => visible(s).length === 0);
  const emptyText = doneTab ? m.todo_done_empty() : m.todo_empty();
  const toggleFold = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const box = (row: TodoRow) => (
    <Checkbox
      aria-label={rowHeading(row)}
      checked={ticks.isSelected(row)}
      onChange={() => ticks.toggle(row)}
      size={18}
    />
  );
  const title = (row: TodoRow) => (
    <button
      // One line: a long title ends in an ellipsis.
      className="flex min-w-0 max-w-full items-center gap-1.5 rounded-button text-left focus-visible:outline-2 focus-visible:outline-action"
      onClick={(e) => {
        e.stopPropagation();
        setOpened(keyOf(row));
      }}
      type="button"
    >
      <RowTitle row={row} />
    </button>
  );
  const group = (section: TodoTableSection): ReactNode => {
    const { workspace } = section;
    const open = !folded.has(workspace.workspaceId);
    return (
      <h2>
        <button
          aria-expanded={open}
          className="inline-flex max-w-full items-center gap-2 rounded-button pr-1 text-left focus-visible:outline-2 focus-visible:outline-action"
          onClick={() => toggleFold(workspace.workspaceId)}
          type="button"
        >
          <Icon
            className={cn(
              'shrink-0 text-fg-muted transition-transform',
              open && 'rotate-90'
            )}
            name="chevronRight"
            size={18}
          />
          <img
            alt=""
            className="size-5.5 shrink-0 rounded-[5px]"
            height={22}
            src={iconUrl(workspace.iconId)}
            width={22}
          />
          <span className="t-subtitle truncate">{workspace.name}</span>
          {section.open !== undefined && (
            <span className="t-meta shrink-0 text-fg-muted">
              {m.todo_group_open({ count: section.open })}
            </span>
          )}
        </button>
      </h2>
    );
  };

  const openRow = find(opened);
  const dialogs = (
    <>
      {openRow && (
        <TodoDialog
          canTick={canTick(openRow.row, doneTab)}
          onClose={() => setOpened(null)}
          // The row leaves for the other tab at once, so its dialog closes.
          onTick={(checked) => {
            setOpened(null);
            if (checked) ticks.markDone([openRow.row]);
            else ticks.markNotDone([openRow.row]);
          }}
          row={openRow.row}
          ticked={tickedOf(openRow.row)}
          workspace={openRow.workspace}
        />
      )}
      {ticks.removeAsking && (
        <TodoRemoveDialog
          onClose={ticks.removeDismiss}
          onConfirm={ticks.removeConfirm}
          rows={ticks.removeAsking}
        />
      )}
      {ticks.asking && (
        <TodoCheckDialog
          onClose={ticks.dismiss}
          onConfirm={ticks.confirm}
          rows={ticks.asking}
        />
      )}
    </>
  );

  if (phone)
    return (
      <>
        <ul>
          {empty && (
            <li className="t-subtitle py-20 text-center font-normal text-fg-muted">
              {emptyText}
            </li>
          )}
          {sections
            .filter((s) => visible(s).length > 0)
            .map((section) => (
              <Fragment key={section.workspace.workspaceId}>
                <li className="border-divider border-b pt-4 pb-2 pl-0.5 first:pt-1">
                  {group(section)}
                </li>
                {!folded.has(section.workspace.workspaceId) &&
                  visible(section).map((row) => (
                    <li
                      className="flex cursor-pointer items-start gap-2.5 border-divider border-b px-0.5 py-2.5"
                      key={keyOf(row)}
                      onClick={() => setOpened(keyOf(row))}
                    >
                      <span
                        className="mt-0.5 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {box(row)}
                      </span>
                      <div
                        className={cn(
                          'flex min-w-0 flex-1 flex-col gap-1',
                          // Done: muted.
                          doneTab && 'opacity-55'
                        )}
                      >
                        {title(row)}
                        <div className="t-meta flex flex-wrap items-center gap-x-2 gap-y-0.5 text-fg-secondary">
                          <DueCell a={row.a} doneTab={doneTab} />
                          <Details doneTab={doneTab} row={row} />
                        </div>
                      </div>
                    </li>
                  ))}
              </Fragment>
            ))}
        </ul>
        {dialogs}
      </>
    );

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] table-fixed text-left text-sm">
          <thead>
            <tr className="border-divider border-b">
              <th className="w-9 py-2.5 pr-2 pl-1">
                <span className="flex">
                  <Checkbox
                    aria-label={m.files_select_all()}
                    checked={ticks.allSelected}
                    onChange={() =>
                      ticks.allSelected ? ticks.clear() : ticks.selectAll()
                    }
                    size={18}
                  />
                </span>
              </th>
              <HeaderCell
                icon="list"
                label={m.todo_col_todo()}
                sort={doneTab ? undefined : ('title' as const)}
                sorting={sorting}
              />
              {wide && (
                <HeaderCell
                  className="w-40"
                  icon="profile"
                  label={m.todo_fact_posted()}
                  sorting={sorting}
                />
              )}
              <HeaderCell
                className="w-44"
                icon="info"
                label={m.todo_col_details()}
                sorting={sorting}
              />
              <HeaderCell
                className="w-36 pr-1"
                icon="schedule"
                label={doneTab ? m.todo_col_done_on() : m.todo_col_due()}
                sort={doneTab ? ('done' as const) : ('due' as const)}
                sorting={sorting}
              />
            </tr>
          </thead>
          <tbody>
            {empty && (
              <tr>
                <td
                  className="t-subtitle py-20 text-center font-normal text-fg-muted"
                  colSpan={columns}
                >
                  {emptyText}
                </td>
              </tr>
            )}
            {sections
              .filter((s) => visible(s).length > 0)
              .map((section) => (
                <Fragment key={section.workspace.workspaceId}>
                  <tr>
                    <td
                      // In by the row boxes' 4px, so the button's focus ring isn't
                      // clipped and its chevron lines up with the boxes.
                      className="border-divider border-b pt-5 pb-2 pl-1"
                      colSpan={columns}
                    >
                      {group(section)}
                    </td>
                  </tr>
                  {!folded.has(section.workspace.workspaceId) &&
                    visible(section).map((row) => (
                      <tr
                        className={cn(
                          'cursor-pointer border-divider border-b hover:bg-surface-hover-bg',
                          // Done reads as finished: the row is muted past its
                          // box (Epo 2026-11-10: no strike line).
                          doneTab && '[&>td:not(:first-child)]:opacity-55'
                        )}
                        key={keyOf(row)}
                        onClick={() => setOpened(keyOf(row))}
                      >
                        <td
                          className="py-2 pr-2 pl-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="flex">{box(row)}</span>
                        </td>
                        <td className="py-2 pr-4">{title(row)}</td>
                        {wide && (
                          <td className="truncate py-2 pr-4">
                            <span className="t-meta">{row.a.postedBy}</span>
                          </td>
                        )}
                        <td className="py-2 pr-4">
                          <Details doneTab={doneTab} row={row} />
                        </td>
                        <td className="whitespace-nowrap py-2 pr-1">
                          <DueCell a={row.a} doneTab={doneTab} />
                        </td>
                      </tr>
                    ))}
                </Fragment>
              ))}
          </tbody>
        </table>
      </div>
      {dialogs}
    </>
  );
}
