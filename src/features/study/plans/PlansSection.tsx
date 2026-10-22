import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { createStudyPlanBodyNameMax } from '@/api/gen/validators';
import {
  useCreateStudyPlan,
  useDeleteStudyPlan,
  useUpdateStudyPlan,
  useWorkspacePlans,
} from '@/api/hooks';
import type { PlanWorkspace, ProgressItem, StudyPlan } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import type { OpenItem } from '@/features/materials/openItem';
import { m } from '@/i18n';
import { iconUrl } from '@/lib/icon-catalog';
import { type PlanProgress, planProgress, workspaceMap } from './planProgress';

/** Opens a plan's item where it lives: in this workspace through the page's
 * own opener, elsewhere by navigating there. */
export function usePlanLinks(
  workspaceId: string | undefined,
  onOpenItem?: (item: OpenItem) => void
) {
  const navigate = useNavigate();
  return {
    openItem: (item: ProgressItem, inWorkspace: string) => {
      if (inWorkspace === workspaceId && onOpenItem) {
        onOpenItem({ id: item.id, kind: item.type });
        return;
      }
      void navigate({
        params: { workspaceId: inWorkspace },
        search:
          item.type === 'file' ? { file: item.id } : { material: item.id },
        to: '/workspaces/$workspaceId',
      });
    },
    openPlan: (plan: StudyPlan) =>
      void navigate({
        params: { workspaceId: plan.workspaceId },
        search: { plan: plan.id },
        to: '/workspaces/$workspaceId',
      }),
  };
}

/** "2 of 8 steps · Next: Conditional probability" */
export function planMeta(progress: PlanProgress) {
  return [
    m.plan_steps_done({ done: progress.done, total: progress.total }),
    progress.next && m.plan_next({ title: progress.next.item.title }),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The Study page's Plans: plans kept here, then the user's plans elsewhere
 * with a step here ("Also in", with their workspace's icon). */
export function PlansSection({
  workspaceId,
  hidden,
  onOpenItem,
}: {
  workspaceId: string;
  /** Study progress hidden here: no counts or next items. */
  hidden: boolean;
  onOpenItem: (item: OpenItem) => void;
}) {
  const { data } = useWorkspacePlans(workspaceId);
  const { mutateAsync: create } = useCreateStudyPlan(workspaceId);
  const { mutateAsync: update } = useUpdateStudyPlan(workspaceId);
  const { mutate: remove } = useDeleteStudyPlan();
  const links = usePlanLinks(workspaceId, onOpenItem);
  const [form, setForm] = useState<{ plan?: StudyPlan } | null>(null);
  const [deleting, setDeleting] = useState<StudyPlan | null>(null);
  if (!data) return null;
  const spaces = workspaceMap(data.workspaces);
  const own = data.plans.filter((p) => p.workspaceId === workspaceId);
  const elsewhere = data.plans.filter((p) => p.workspaceId !== workspaceId);

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-3 pb-1.5">
        <h3 className="font-bold">{m.plan_plans()}</h3>
        <Button
          iconLeft="plus"
          onClick={() => setForm({})}
          rounded="large"
          size="sm"
          variant="outline"
        >
          {m.plan_new()}
        </Button>
      </div>
      {data.plans.length === 0 && (
        <p className="border-divider border-t py-3 text-fg-muted text-sm">
          {m.plan_none()}
        </p>
      )}
      {own.map((plan) => (
        <PlanRow
          hidden={hidden}
          key={plan.id}
          menuItems={[
            {
              icon: 'pencil',
              label: m.plan_rename(),
              onClick: () => setForm({ plan }),
            },
            {
              danger: true,
              icon: 'trash',
              label: m.plan_delete(),
              onClick: () => setDeleting(plan),
            },
          ]}
          onContinue={(next) => links.openItem(next.item, next.workspaceId)}
          onOpen={() => links.openPlan(plan)}
          plan={plan}
          spaces={spaces}
        />
      ))}
      {elsewhere.map((plan) => (
        <PlanRow
          alsoIn
          hidden={hidden}
          key={plan.id}
          onOpen={() => links.openPlan(plan)}
          parent={spaces.get(plan.workspaceId)}
          plan={plan}
          spaces={spaces}
        />
      ))}
      {form && (
        <NameFormDialog
          defaultName={form.plan?.name ?? ''}
          key={form.plan?.id ?? 'new-plan'}
          maxLength={createStudyPlanBodyNameMax}
          onClose={() => setForm(null)}
          onSubmit={async (name) => {
            if (form.plan) await update({ id: form.plan.id, name });
            else links.openPlan(await create(name));
          }}
          open
          submitLabel={form.plan ? m.action_save() : m.action_create()}
          title={form.plan ? m.plan_rename() : m.plan_new()}
        />
      )}
      <ConfirmDialog
        body={m.plan_delete_body()}
        confirmLabel={m.action_delete()}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove(deleting.id)}
        open={!!deleting}
        title={m.plan_delete_title({ name: deleting?.name ?? '' })}
      />
    </section>
  );
}

/** One plan as a row: its name, steps done and next item, Continue. With
 * `parent` it leads with that workspace's icon; `alsoIn` marks a plan kept in
 * another workspace, which opens there. */
export function PlanRow({
  plan,
  spaces,
  parent,
  alsoIn = false,
  hidden = false,
  menuItems,
  onOpen,
  onContinue,
}: {
  plan: StudyPlan;
  spaces: ReadonlyMap<string, PlanWorkspace>;
  parent?: PlanWorkspace;
  alsoIn?: boolean;
  hidden?: boolean;
  menuItems?: React.ComponentProps<typeof Menu>['items'];
  onOpen: () => void;
  onContinue?: (next: NonNullable<PlanProgress['next']>) => void;
}) {
  const progress = planProgress(plan, spaces);
  const meta =
    alsoIn && parent
      ? m.plan_also_in({ workspace: parent.name })
      : hidden
        ? m.plan_step_count({ count: plan.steps.length })
        : planMeta(progress);
  return (
    <div className="group relative -mx-1.5 flex items-center gap-3 rounded-input border-divider border-t px-1.5 py-2.5 hover:bg-surface-hover-bg">
      {parent ? (
        <img
          alt=""
          className="size-8 shrink-0 rounded-button"
          src={iconUrl(parent.iconId)}
        />
      ) : (
        <span className="grid size-8 shrink-0 place-items-center text-fg-secondary">
          <Icon name="listOrdered" size={18} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <button
          className="line-clamp-1 text-left font-semibold after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action focus-visible:after:ring-inset"
          onClick={onOpen}
          type="button"
        >
          {plan.name}
        </button>
        <p className="t-meta truncate text-fg-muted">{meta}</p>
      </div>
      {!hidden && progress.next && onContinue && (
        <UnderlineLink
          accent
          className="relative z-10"
          onClick={() => progress.next && onContinue(progress.next)}
        >
          {m.study_continue()}
        </UnderlineLink>
      )}
      {alsoIn && (
        <UnderlineLink className="relative z-10" noArrow onClick={onOpen}>
          {m.learning_open()}
        </UnderlineLink>
      )}
      {menuItems && (
        <div className="relative z-10 -my-2 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <Menu items={menuItems} />
        </div>
      )}
    </div>
  );
}
