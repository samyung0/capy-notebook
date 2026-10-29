import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { createStudyPlanBodyNameMax } from '@/api/gen/validators';
import {
  stepKey,
  useChapters,
  useDeleteStudyPlan,
  useFiles,
  useMaterials,
  usePlanStudy,
  useResetWorkspaceStudy,
  useUpdateStudyPlan,
  useWorkspace,
  useWorkspaceAttempts,
  useWorkspacePlans,
  useWorkspaceStudy,
} from '@/api/hooks';
import type {
  MaterialRef,
  PlanStepInput,
  ProgressItem,
  SourceFile,
  StudyPlan,
  StudyPlans,
  StudySummary,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { FilterPopover, toggleValue } from '@/components/app/ListToolbar';
import { SettingRow, TabContent } from '@/components/app/tabPanel';
import { Button, ErrorAction } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { fileKindLabel } from '@/features/files/fileKindLabel';
import { materialKindLabel } from '@/features/materials/MaterialListCard';
import type { OpenItem } from '@/features/materials/openItem';
import {
  readingOrder,
  type WorkspaceContentItem,
} from '@/features/workspace/workspaceContent';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { FILE_KINDS } from '@/lib/listSearch';
import { AddStepsPopover } from './plans/AddStepsPopover';
import { PlanSelect } from './plans/PlanSelect';
import { usePlanLinks } from './plans/planLinks';
import { planProgress, stepInputs, workspaceMap } from './plans/planProgress';
import { QuickReview, WorkspaceReview } from './quickActions';
import { type StudyState, useStudyActions } from './studyItems';
import { SectionList, type StudyRow, type StudySection } from './studyRows';
import { WorkspaceRailMap } from './WorkspaceRailMap';

const MATERIAL_TYPES: MaterialRef['type'][] = [
  'note',
  'mindmap',
  'diagram',
  'quiz',
  'flashcards',
];

type Show = 'all' | 'unread' | 'read' | 'untracked';
const SHOWS: Show[] = ['all', 'unread', 'read', 'untracked'];
const showLabel: Record<Show, () => string> = {
  all: m.progress_show_all,
  read: m.progress_show_read,
  unread: m.progress_show_unread,
  untracked: m.progress_show_untracked,
};
const shows = (show: Show, state: StudyState | undefined) =>
  show === 'all' ||
  (show === 'read' && state === 'done') ||
  (show === 'untracked' && state === 'removed') ||
  (show === 'unread' && state !== 'done' && state !== 'removed');

/** The group key of steps in a workspace the user can no longer open. */
const LOCKED = 'locked';

const kindOf = (item: WorkspaceContentItem) =>
  item.type === 'file' ? item.data.kind : item.data.type;
const titleOf = (item: WorkspaceContentItem) =>
  item.type === 'file' ? item.data.name : item.data.title;

/** A workspace's Study page in the centre pane (human/study-progress.md
 * 2026-10-19, 2026-10-22, 2026-10-25): one plan at a time, picked at the
 * title's right, Default Plan being the workspace's chapter order. The plan
 * leads the railway map, Continue, Quick review and Quick actions, then its
 * chapters with each file's read state and each quiz's and set's attempts.
 * With study progress hidden (workspace settings → Study) only the plan
 * select, a line pointing there and the settings rows stay. */
export function StudyPage({
  workspaceId,
  planId,
  onOpenItem,
}: {
  workspaceId: string;
  planId?: string;
  onOpenItem: (item: OpenItem) => void;
}) {
  const {
    data: plans,
    error: plansError,
    refetch: refetchPlans,
  } = useWorkspacePlans(workspaceId, { errorBoundary: false });
  const plan = plans?.plans.find(
    (p) => p.id === planId && p.workspaceId === workspaceId
  );
  const {
    data: planStudy,
    error: planError,
    refetch: refetchPlan,
  } = usePlanStudy(workspaceId, plan?.id, { errorBoundary: false });
  // A failed plan read leaves the page to the error alone, centred in the
  // pane (up by half the workspace header).
  const error = (!plans && plansError) || (plan && !planStudy && planError);
  if (error)
    return (
      <div className="flex h-full min-h-96 items-center justify-center">
        <ErrorState
          action={
            <ErrorAction
              onClick={() => void (plansError ? refetchPlans() : refetchPlan())}
            >
              {m.error_action_retry()}
            </ErrorAction>
          }
          className="-translate-y-6 sm:-translate-y-7"
          description={m.error_generic_body()}
          errorId={unexpectedErrorId(error)}
          title={m.error_generic_title()}
          variant="panel"
        />
      </div>
    );
  return (
    <TabContent centered pane>
      <div className="flex items-center justify-between gap-3">
        <h2 className="t-card-title">{m.workspace_tab_study()}</h2>
        <PlanSelect planId={planId} plans={plans} workspaceId={workspaceId} />
      </div>
      {planId && plans && !plan ? (
        <p className="mt-6 text-fg-muted">{m.plan_missing()}</p>
      ) : (
        // A new plan starts with its own open chapters and Quick review.
        <StudyBody
          key={planId ?? ''}
          onOpenItem={onOpenItem}
          plan={plan}
          planId={planId}
          planStudy={planStudy}
          plans={plans}
          workspaceId={workspaceId}
        />
      )}
    </TabContent>
  );
}

function StudyBody({
  workspaceId,
  planId,
  plan,
  plans,
  planStudy,
  onOpenItem,
}: {
  workspaceId: string;
  planId?: string;
  plan?: StudyPlan;
  plans?: StudyPlans;
  /** The plan's review parts; the workspace's summary has the marks. */
  planStudy?: StudySummary;
  onOpenItem: (item: OpenItem) => void;
}) {
  const navigate = useNavigate();
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: study } = useWorkspaceStudy(workspaceId);
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const { data: attempts } = useWorkspaceAttempts(workspaceId);
  const { menuItems } = useStudyActions(workspaceId);
  const links = usePlanLinks(workspaceId, onOpenItem);
  const { mutate: resetStudy } = useResetWorkspaceStudy(workspaceId);
  // Step saves report failures in the global toast; the rename dialog waits.
  const { mutate: saveSteps, mutateAsync: updatePlan } =
    useUpdateStudyPlan(workspaceId);
  const { mutate: deletePlan } = useDeleteStudyPlan();
  const [confirmReset, setConfirmReset] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [kinds, setKinds] = useState<string[]>([]);
  const [show, setShow] = useState<Show>('all');
  // Open chapters: the next item's once loaded, every one a filter shows
  // ('all'), none once no filter runs, then by hand.
  const [openChapters, setOpenChapters] = useState<Set<string> | 'all'>();

  if (
    !(study && chapters && files && materials && attempts) ||
    (planId && !(plan && plans && planStudy))
  )
    return (
      <div className="mt-6">
        <SkeletonList count={8} rowHeight={52} />
      </div>
    );

  const hidden = !study.enabled;
  const review = plan && planStudy ? planStudy : study;
  const states = new Map(
    study.items.map((it) => [it.fileId ?? it.materialId, it.state])
  );
  const changedAt = new Map(
    study.items.map((it) => [it.fileId ?? it.materialId, it.updatedAt])
  );
  const byMaterial = new Map(attempts.items.map((it) => [it.materialId, it]));
  const ordered = readingOrder(chapters, files, materials);
  const contentById = new Map(ordered.map((it) => [it.id, it]));

  // This workspace's items with their full data; a plan step elsewhere has
  // that workspace's tracked items.
  const contentRow = (it: WorkspaceContentItem): StudyRow => ({
    attempts: byMaterial.get(it.id),
    icon:
      it.type === 'file'
        ? fileIconName(it.data)
        : materialIconName(it.data.type),
    id: it.id,
    kind: kindOf(it),
    menuItems: menuItems({ id: it.id, kind: it.type }, states.get(it.id)),
    readAt: changedAt.get(it.id),
    state: states.get(it.id),
    title: titleOf(it),
    type: it.type,
    workspaceId,
  });
  const progressRow = (it: ProgressItem, wsId: string): StudyRow => {
    const own = wsId === workspaceId ? contentById.get(it.id) : undefined;
    if (own) return contentRow(own);
    return {
      icon:
        it.type === 'file'
          ? fileIconName({
              kind: it.kind as SourceFile['kind'],
              name: it.title,
            })
          : materialIconName(it.kind as MaterialRef['type']),
      id: it.id,
      kind: it.kind,
      state: it.state,
      title: it.title,
      type: it.type,
      workspaceId: wsId,
    };
  };
  const openRow = (row: StudyRow) => links.openItem(row, row.workspaceId);

  // Default Plan: chapters in order, then Others. A plan: its steps.
  const progress =
    plan && plans ? planProgress(plan, workspaceMap(plans.workspaces)) : null;
  const inputs = plan ? stepInputs(plan.steps) : [];
  // Added files join their chapter's group (set with the groups below).
  let addSteps: (added: PlanStepInput[]) => void = () => {};
  let sections: (StudySection & { all: StudyRow[] })[];
  let nextRow: StudyRow | undefined;
  let nextKey: string | undefined;
  if (progress && plans && plan) {
    const spaces = workspaceMap(plans.workspaces);
    // Steps are files; the list groups consecutive ones of one chapter (or
    // Others) of one workspace under that chapter's row. A locked step groups
    // by workspace; an untracked one shows nowhere and rides along with the
    // group around it, leaving with it on Remove from plan.
    type Group = {
      ws: string;
      chapter: string | null;
      /** The step that opened the group, its identity. */
      head: number;
      steps: number[];
    };
    const groups: Group[] = [];
    let waiting: number[] = [];
    progress.steps.forEach((s, i) => {
      const item = s.items[0];
      if (!(s.step.locked || item)) {
        if (groups.length) groups.at(-1)?.steps.push(i);
        else waiting.push(i);
        return;
      }
      const chapter = s.step.locked ? LOCKED : (item?.chapterId ?? null);
      const last = groups.at(-1);
      if (last && last.ws === s.step.workspaceId && last.chapter === chapter)
        last.steps.push(i);
      else {
        groups.push({
          chapter,
          head: i,
          steps: [...waiting, i],
          ws: s.step.workspaceId,
        });
        waiting = [];
      }
    });
    // A new file goes after the last one shown of its chapter, else at the end.
    const chapterOf = (st: PlanStepInput) =>
      spaces
        .get(st.workspaceId)
        ?.items.find((it) => it.type === st.kind && it.id === st.targetId)
        ?.chapterId;
    addSteps = (added) => {
      const next = [...inputs];
      for (const st of added) {
        const chapter = chapterOf(st) ?? null;
        let at = next.length;
        next.forEach((o, i) => {
          if (o.workspaceId === st.workspaceId && chapterOf(o) === chapter)
            at = i + 1;
        });
        next.splice(at, 0, st);
      }
      saveSteps({ id: plan.id, steps: next });
    };
    const remove = (drop: number[]) =>
      saveSteps({
        id: plan.id,
        steps: inputs.filter((_, i) => !drop.includes(i)),
      });
    const removeItem = (i: number) => ({
      confirmLabel: m.menu_click_to_confirm(),
      danger: true,
      icon: 'listMinus' as const,
      label: m.plan_remove_step(),
      onClick: () => remove([i]),
    });
    sections = groups.map((g) => {
      const space = spaces.get(g.ws);
      const all = g.steps.flatMap((i) =>
        progress.steps[i].items.map((it) => {
          const row = progressRow(it, g.ws);
          // Each file leaves the plan on its own, after its study actions.
          return {
            ...row,
            menuItems: [
              ...(row.menuItems ?? []),
              { ...removeItem(i), separated: !!row.menuItems?.length },
            ],
          };
        })
      );
      const chapterName =
        g.chapter === LOCKED
          ? m.plan_step_locked()
          : g.chapter
            ? (space?.chapters.find((ch) => ch.id === g.chapter)?.name ?? '')
            : m.study_others();
      return {
        all,
        aside: g.ws === workspaceId ? undefined : space?.name,
        done: all.filter((row) => row.state === 'done').length,
        key: stepKey(inputs[g.head]),
        locked: g.chapter === LOCKED,
        menu: [{ ...removeItem(-1), onClick: () => remove(g.steps) }],
        name: chapterName,
        rows: all,
        total: all.length,
      };
    });
    if (progress.next) {
      nextRow = progressRow(progress.next.item, progress.next.workspaceId);
      const current = progress.current;
      nextKey =
        sections[groups.findIndex((g) => g.steps.includes(current))]?.key;
    }
  } else {
    sections = [
      ...[...chapters]
        .sort((a, b) => a.order - b.order)
        .map((ch) => ({ id: ch.id, name: ch.name })),
      { id: null, name: m.study_others() },
    ].map((ch) => {
      const items = ordered.filter(
        (it) => (it.data.chapterId ?? null) === ch.id
      );
      const all = items.map(contentRow);
      const mine = all.filter((row) => row.state !== 'removed');
      return {
        all,
        done: mine.filter((row) => row.state === 'done').length,
        key: ch.id ?? 'others',
        name: ch.name,
        rows: all,
        total: mine.length,
      };
    });
    const next = ordered.find(
      (it) => states.get(it.id) !== 'done' && states.get(it.id) !== 'removed'
    );
    if (next) {
      nextRow = contentRow(next);
      nextKey = next.data.chapterId ?? 'others';
    }
  }

  // Kinds the list holds, files first in the Files page's order.
  const present = new Set(sections.flatMap((s) => s.all.map((r) => r.kind)));
  const kindOptions = [
    ...FILE_KINDS.filter((kind) => present.has(kind)).map((kind) => ({
      label: fileKindLabel(kind),
      value: kind,
    })),
    ...MATERIAL_TYPES.filter((kind) => present.has(kind)).map((kind) => ({
      label: materialKindLabel(kind),
      value: kind,
    })),
  ];
  const filtering = kinds.length > 0 || show !== 'all';
  const visible = (row: StudyRow) =>
    (!kinds.length || kinds.includes(row.kind)) && shows(show, row.state);
  const shown = sections
    .map((s) => ({ ...s, rows: s.all.filter(visible) }))
    // A plan keeps its locked groups on show until a filter runs.
    .filter((s) => s.rows.length > 0 || (progress && !filtering && s.locked));

  if (!openChapters) {
    const keys = shown.map((s) => s.key);
    const first = nextKey && keys.includes(nextKey) ? nextKey : keys[0];
    setOpenChapters(new Set(first ? [first] : []));
  }
  const isOpen = (key: string) =>
    openChapters === 'all' || !!openChapters?.has(key);
  const toggleChapter = (key: string) =>
    setOpenChapters((prev) => {
      const next = new Set(
        prev === 'all' ? shown.map((s) => s.key) : (prev ?? [])
      );
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // The map draws the plan's tracked items, each once, its groups as stations.
  // Stations come from every group, so a filter never moves the map.
  const mapChapters = sections
    .filter((s) => !s.locked)
    .map((s) => ({ id: s.key, name: s.name }));
  const seen = new Set<string>();
  const mapItems = sections.flatMap((s) =>
    s.locked
      ? []
      : s.all
          .filter((row) => row.state !== 'removed' && !seen.has(row.id))
          .map((row) => {
            seen.add(row.id);
            return {
              chapterId: progress
                ? s.key
                : (contentById.get(row.id)?.data.chapterId ?? null),
              id: row.id,
              row,
              state: row.state,
              title: row.title,
            };
          })
  );

  return (
    <>
      {/* The switch is the member's own, in workspace settings' Study tab. */}
      {hidden && (
        <p className="mt-6 flex flex-wrap items-center gap-x-2 text-fg-muted">
          {m.study_hidden_here()}
          <Button
            className="underline"
            iconRight="navigationForward"
            onClick={() =>
              void navigate({
                replace: true,
                search: (previous) => ({ ...previous, settings: 'study' }),
                to: '.',
              })
            }
            size="xs"
            variant="ghost-link"
          >
            {m.workspace_settings()}
          </Button>
        </p>
      )}
      {!hidden && (
        <>
          {mapItems.length > 0 && (
            <div className="mt-2">
              <WorkspaceRailMap
                chapters={
                  progress
                    ? mapChapters
                    : [...chapters].sort((a, b) => a.order - b.order)
                }
                cover={workspace?.cover}
                items={mapItems}
                onOpen={(id) => {
                  const item = mapItems.find((it) => it.id === id);
                  if (item) openRow(item.row);
                }}
                workspaceId={plan ? `plan:${plan.id}` : workspaceId}
              />
            </div>
          )}
          {/* Sections spaced like Chapters below. */}
          <div className="mt-4 flex flex-col gap-8">
            {nextRow && (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="t-meta text-fg-muted">{m.study_next()}</p>
                  {/* Opens the item as Continue does, without a hover look. */}
                  <button
                    className="line-clamp-1 text-left font-semibold"
                    onClick={() => nextRow && openRow(nextRow)}
                    type="button"
                  >
                    {nextRow.title}
                  </button>
                </div>
                <UnderlineLink
                  accent
                  onClick={() => nextRow && openRow(nextRow)}
                >
                  {m.study_continue()}
                </UnderlineLink>
              </div>
            )}
            {/* Stays mounted through refreshes; hides itself. */}
            <QuickReview
              items={review.quickReview}
              planId={plan?.id}
              workspaceId={workspaceId}
            />
            <section className="flex flex-col">
              <h3 className="pb-1.5 font-bold">{m.study_quick_actions()}</h3>
              <WorkspaceReview
                iconId={workspace?.iconId}
                planId={plan?.id}
                unfinished={review.unfinished}
                workspaceId={workspaceId}
              />
            </section>
          </div>
        </>
      )}
      {/* Hidden study progress takes the chapters too. */}
      {!hidden && (
        <>
          <div className="mt-8 flex flex-wrap items-center gap-2">
            <h3 className="mr-auto font-bold">{m.study_contents()}</h3>
            {plan && (
              <AddStepsPopover
                defaultWorkspaceId={workspaceId}
                onAdd={addSteps}
                steps={plan.steps}
              />
            )}
            <FilterPopover
              filters={[
                {
                  key: 'kind',
                  label: m.files_filter_kind(),
                  onToggle: (value) => {
                    const next = toggleValue(kinds, value);
                    setKinds(next);
                    setOpenChapters(
                      next.length || show !== 'all' ? 'all' : new Set()
                    );
                  },
                  options: kindOptions,
                  selected: kinds,
                },
                // One pick at most; none is All items.
                {
                  key: 'show',
                  label: m.progress_show(),
                  onToggle: (value: string) => {
                    const next = show === value ? 'all' : (value as Show);
                    setShow(next);
                    setOpenChapters(
                      kinds.length || next !== 'all' ? 'all' : new Set()
                    );
                  },
                  // A plan lists tracked items only, so Not tracked is Default
                  // Plan's.
                  options: SHOWS.filter(
                    (value) =>
                      value !== 'all' && !(progress && value === 'untracked')
                  ).map((value) => ({ label: showLabel[value](), value })),
                  selected: show === 'all' ? [] : [show],
                },
              ]}
              onResetFilters={() => {
                setKinds([]);
                setShow('all');
                setOpenChapters(new Set());
              }}
            />
          </div>
          {plan && plan.steps.length === 0 ? (
            <p className="mt-2 border-divider border-t py-4 text-fg-muted">
              {m.plan_empty()}
            </p>
          ) : sections.every((s) => s.all.length === 0) ? (
            // Nothing in the workspace yet, filters or not.
            <p className="mt-2 border-divider border-t py-4 text-fg-muted">
              {m.study_empty()}
            </p>
          ) : shown.length === 0 ? (
            <p className="py-8 text-center text-fg-muted">
              {m.progress_nothing_shown()}
            </p>
          ) : (
            <SectionList
              isOpen={isOpen}
              onOpenRow={openRow}
              onToggle={toggleChapter}
              sections={shown}
              workspaceId={workspaceId}
            />
          )}
        </>
      )}
      {/* Settings-style rows, the destructive ones last. Every control takes
          one 96px column so the labels line up. */}
      <div className="mt-8 mb-20 flex flex-col gap-6">
        {plan && (
          <SettingRow hint={plan.name} title={m.plan_rename()}>
            <Button
              className="w-[96px]"
              onClick={() => setRenaming(true)}
              rounded="large"
              variant="outline"
            >
              {m.action_rename()}
            </Button>
          </SettingRow>
        )}
        <SettingRow
          hint={m.study_reset_confirm_body()}
          title={m.study_reset_title()}
        >
          <Button
            className="w-[96px]"
            onClick={() => setConfirmReset(true)}
            rounded="large"
            variant="danger-light"
          >
            {m.study_reset()}
          </Button>
        </SettingRow>
        {plan && (
          <SettingRow hint={m.plan_delete_body()} title={m.plan_delete()}>
            <Button
              className="w-[96px]"
              onClick={() => setDeleting(true)}
              rounded="large"
              variant="danger-light"
            >
              {m.action_delete()}
            </Button>
          </SettingRow>
        )}
      </div>
      <ConfirmDialog
        body={m.study_reset_confirm_body()}
        confirmLabel={m.study_reset()}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => resetStudy()}
        open={confirmReset}
        title={m.study_reset_confirm_title()}
      />
      {plan && renaming && (
        <NameFormDialog
          defaultName={plan.name}
          maxLength={createStudyPlanBodyNameMax}
          onClose={() => setRenaming(false)}
          onSubmit={(name) => updatePlan({ id: plan.id, name })}
          open
          submitLabel={m.action_save()}
          title={m.plan_rename()}
        />
      )}
      {plan && (
        <ConfirmDialog
          body={m.plan_delete_body()}
          confirmLabel={m.action_delete()}
          onClose={() => setDeleting(false)}
          // To Default Plan first, so the refreshed lists never show the
          // deleted plan as missing.
          onConfirm={() => {
            void navigate({ replace: true, search: { study: true }, to: '.' });
            deletePlan(plan.id);
          }}
          open={deleting}
          title={m.plan_delete_title({ name: plan.name })}
        />
      )}
    </>
  );
}
