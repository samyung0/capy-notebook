import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { createStudyPlanBodyNameMax } from '@/api/gen/validators';
import {
  useDeleteStudyPlan,
  useUpdateStudyPlan,
  useWorkspacePlans,
} from '@/api/hooks';
import type { PlanStepInput } from '@/api/types';
import { TabContent } from '@/components/app/tabPanel';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import type { OpenItem } from '@/features/materials/openItem';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import { AddStepsPopover } from './AddStepsPopover';
import { usePlanLinks } from './PlansSection';
import {
  planProgress,
  type StepProgress,
  stepInputs,
  stepTitle,
  workspaceMap,
} from './planProgress';

/** A plan in its workspace's centre pane (`plan=`): its steps in order, each
 * counted from the workspace's progress. + adds steps, rows reorder by
 * whole-row drag with the accent drop line, ⋮ per row and for the plan. */
export function PlanPage({
  workspaceId,
  planId,
  onOpenItem,
}: {
  workspaceId: string;
  planId: string;
  onOpenItem: (item: OpenItem) => void;
}) {
  const navigate = useNavigate();
  const { data } = useWorkspacePlans(workspaceId);
  const { mutateAsync: update } = useUpdateStudyPlan(workspaceId);
  const { mutate: remove } = useDeleteStudyPlan();
  const links = usePlanLinks(workspaceId, onOpenItem);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dragged = useRef<number | null>(null);
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(
    null
  );
  const backToStudy = () =>
    navigate({ replace: true, search: { study: true }, to: '.' });

  if (!data)
    return (
      <TabContent centered>
        <SkeletonList count={6} rowHeight={52} />
      </TabContent>
    );
  const plan = data.plans.find(
    (p) => p.id === planId && p.workspaceId === workspaceId
  );
  const back = (
    <UnderlineLink
      iconLeft="navigationBack"
      noArrow
      onClick={() => navigate({ search: { study: true }, to: '.' })}
    >
      {m.workspace_tab_study()}
    </UnderlineLink>
  );
  if (!plan)
    return (
      <TabContent centered>
        {back}
        <p className="mt-6 text-fg-muted">{m.plan_missing()}</p>
      </TabContent>
    );

  const spaces = workspaceMap(data.workspaces);
  const progress = planProgress(plan, spaces);
  const parent = spaces.get(plan.workspaceId);
  const save = (steps: PlanStepInput[]) => update({ id: plan.id, steps });
  const inputs = stepInputs(plan.steps);
  const move = (from: number, to: number) => {
    const next = [...inputs];
    const [step] = next.splice(from, 1);
    next.splice(to, 0, step);
    void save(next);
  };
  const openStep = (s: StepProgress) => {
    if (s.step.locked || !s.workspace) return;
    const item = s.items.find((it) => it.state !== 'done') ?? s.items[0];
    if (item) links.openItem(item, s.step.workspaceId);
  };

  return (
    <TabContent centered>
      {back}
      <div className="mt-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="t-card-title wrap-break-word">{plan.name}</h2>
          <p className="t-meta mt-1 text-fg-muted">
            {[
              parent && m.plan_in_workspace({ workspace: parent.name }),
              m.plan_steps_done({ done: progress.done, total: progress.total }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <AddStepsPopover
          defaultWorkspaceId={workspaceId}
          onAdd={(added) => void save([...inputs, ...added])}
          steps={plan.steps}
        />
        <Menu
          items={[
            {
              icon: 'pencil',
              label: m.plan_rename(),
              onClick: () => setRenaming(true),
            },
            {
              danger: true,
              icon: 'trash',
              label: m.plan_delete(),
              onClick: () => setDeleting(true),
            },
          ]}
        />
      </div>
      {progress.next && (
        <div className="mt-3">
          <UnderlineLink
            accent
            onClick={() =>
              progress.next &&
              links.openItem(progress.next.item, progress.next.workspaceId)
            }
          >
            {m.learning_continue_item({ title: progress.next.item.title })}
          </UnderlineLink>
        </div>
      )}
      {plan.steps.length === 0 ? (
        <p className="mt-6 border-divider border-t py-4 text-fg-muted">
          {m.plan_empty()}
        </p>
      ) : (
        <ol className="mt-5">
          {progress.steps.map((s, i) => {
            const ws = s.workspace;
            const shown = ws && !ws.hidden;
            const finished = s.done >= s.total;
            const next =
              i === progress.current &&
              progress.next &&
              m.plan_next({ title: progress.next.item.title });
            return (
              <li
                className={cn(
                  'group relative -mx-1.5 flex items-center gap-3 rounded-input border-divider border-t px-1.5 py-2.5 hover:bg-surface-hover-bg',
                  i === progress.current && 'bg-tint-accent-1/60'
                )}
                draggable
                key={`${s.step.kind}:${s.step.workspaceId}:${s.step.targetId ?? ''}`}
                onDragEnd={() => {
                  dragged.current = null;
                  setDrop(null);
                }}
                onDragOver={(e) => {
                  if (dragged.current === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY >= rect.top + rect.height / 2;
                  setDrop((d) =>
                    d?.index === i && d.after === after
                      ? d
                      : { after, index: i }
                  );
                }}
                onDragStart={(e) => {
                  dragged.current = i;
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData(
                    'application/x-capy-plan-step',
                    `${i}`
                  );
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragged.current;
                  dragged.current = null;
                  setDrop(null);
                  if (from === null) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientY >= rect.top + rect.height / 2;
                  const to = i + (after ? 1 : 0) - (from < i ? 1 : 0);
                  if (to !== from) move(from, to);
                }}
              >
                {drop?.index === i && (
                  <div
                    className={cn(
                      'pointer-events-none absolute right-1 left-1 z-10 h-0 border-solid-accent-1 border-t-2',
                      drop.after
                        ? 'bottom-0 translate-y-1/2'
                        : 'top-0 -translate-y-1/2'
                    )}
                  />
                )}
                <span className="w-5 shrink-0 text-center font-bold text-fg-muted text-sm">
                  {i + 1}
                </span>
                {ws ? (
                  <img
                    alt=""
                    className="size-8 shrink-0 rounded-button"
                    src={iconUrl(ws.iconId)}
                  />
                ) : (
                  <span className="grid size-8 shrink-0 place-items-center rounded-button bg-surface-dark text-fg-muted">
                    <Icon name="lock" size={16} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {s.step.locked ? (
                    <p className="line-clamp-1 text-fg-muted">
                      {m.plan_step_locked()}
                    </p>
                  ) : (
                    <button
                      className={cn(
                        'line-clamp-1 text-left font-semibold after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset',
                        shown && finished && 'text-fg-secondary'
                      )}
                      onClick={() => openStep(s)}
                      type="button"
                    >
                      {stepTitle(s.step)}
                    </button>
                  )}
                  <p className="t-meta truncate text-fg-muted">
                    {s.step.locked
                      ? m.plan_step_locked_hint()
                      : [ws?.name, shown && next].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {shown && s.total > 0 && (
                  <span className="t-meta hidden shrink-0 text-fg-muted sm:inline">
                    {m.study_of({ done: s.done, total: s.total })}
                  </span>
                )}
                {shown && (
                  <Icon
                    className={cn(
                      'shrink-0',
                      finished ? 'text-tint-success-fg' : 'text-fg-muted'
                    )}
                    name={
                      finished
                        ? 'circleCheck'
                        : s.done
                          ? 'ellipse'
                          : 'circleDashed'
                    }
                    size={14}
                  />
                )}
                <div className="relative z-10 -my-2 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                  <Menu
                    items={[
                      ...(s.step.locked
                        ? []
                        : [
                            {
                              icon: 'view' as const,
                              label: m.plan_open_step(),
                              onClick: () => openStep(s),
                            },
                          ]),
                      ...(i > 0
                        ? [
                            {
                              icon: 'arrowUp' as const,
                              label: m.plan_move_to_top(),
                              onClick: () => move(i, 0),
                            },
                          ]
                        : []),
                      {
                        danger: true,
                        icon: 'listMinus',
                        label: m.plan_remove_step(),
                        onClick: () =>
                          void save(inputs.filter((_, j) => j !== i)),
                      },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {renaming && (
        <NameFormDialog
          defaultName={plan.name}
          maxLength={createStudyPlanBodyNameMax}
          onClose={() => setRenaming(false)}
          onSubmit={(name) => update({ id: plan.id, name })}
          open
          submitLabel={m.action_save()}
          title={m.plan_rename()}
        />
      )}
      <ConfirmDialog
        body={m.plan_delete_body()}
        confirmLabel={m.action_delete()}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove(plan.id, { onSuccess: backToStudy })}
        open={deleting}
        title={m.plan_delete_title({ name: plan.name })}
      />
    </TabContent>
  );
}
