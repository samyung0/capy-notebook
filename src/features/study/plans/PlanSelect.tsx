import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { createStudyPlanBodyNameMax } from '@/api/gen/validators';
import {
  useCreateStudyPlan,
  useWorkspace,
  useWorkspaceStudy,
} from '@/api/hooks';
import type { StudyPlans } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { markGettingStarted } from '@/features/guide/gettingStarted';
import { m } from '@/i18n';
import { iconUrl } from '@/lib/icon-catalog';

const DEFAULT = 'default';
const NEW = 'new';

/** The Study page's plan (human/study-progress.md 2026-10-25): Default Plan,
 * the plans kept here, then "Also in" plans kept elsewhere with a step here
 * (opening in their own workspace), and New study plan. The pick lives in the URL
 * (`plan=`); the trigger shows a closed eye while study progress is hidden. */
export function PlanSelect({
  workspaceId,
  planId,
  plans,
}: {
  workspaceId: string;
  planId?: string;
  plans?: StudyPlans;
}) {
  const navigate = useNavigate();
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: study } = useWorkspaceStudy(workspaceId);
  const { mutateAsync: create } = useCreateStudyPlan(workspaceId);
  const [creating, setCreating] = useState(false);
  const own = plans?.plans.filter((p) => p.workspaceId === workspaceId) ?? [];
  const elsewhere =
    plans?.plans.filter((p) => p.workspaceId !== workspaceId) ?? [];
  const current = own.find((p) => p.id === planId);
  // Default Plan leads with the workspace's icon, every other plan the plan icon.
  const workspaceIcon = workspace && (
    <img
      alt=""
      className="size-4 shrink-0 -translate-y-px rounded-[3px]"
      height={16}
      src={iconUrl(workspace.iconId)}
      width={16}
    />
  );
  // The route mirrored, starting top left as the plan reads.
  const planIcon = (
    <Icon className="-translate-y-px -scale-x-100" name="route" size={16} />
  );
  const open = (id: string | undefined, inWorkspace = workspaceId) =>
    void navigate({
      params: { workspaceId: inWorkspace },
      search: { study: true, ...(id ? { plan: id } : {}) },
      to: '/workspaces/$workspaceId',
    });

  return (
    <>
      <Select
        onValueChange={(value) => {
          if (value === NEW) setCreating(true);
          else if (value === DEFAULT) open(undefined);
          else {
            const plan = plans?.plans.find((p) => p.id === value);
            if (plan) open(plan.id, plan.workspaceId);
          }
        }}
        value={current?.id ?? DEFAULT}
      >
        <SelectTrigger
          aria-label={m.plan_plans()}
          className="w-auto min-w-[160px] max-w-[240px]"
        >
          <SelectValue>
            <span className="flex items-center gap-2">
              {/* Hidden study progress shows in place of the plan's icon. */}
              {study?.enabled === false ? (
                <Icon
                  className="-translate-y-px text-fg-muted"
                  name="viewOff"
                  size={16}
                />
              ) : current ? (
                planIcon
              ) : (
                workspaceIcon
              )}
              <span className="truncate">
                {current?.name ?? m.plan_default()}
              </span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={DEFAULT}>
            {workspaceIcon}
            {m.plan_default()}
          </SelectItem>
          {own.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {planIcon}
              {p.name}
            </SelectItem>
          ))}
          {elsewhere.length > 0 && (
            <SelectGroup>
              <SelectSeparator className="my-1" />
              <SelectLabel>{m.plan_also_in_heading()}</SelectLabel>
              {elsewhere.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {planIcon}
                  {p.name}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          <SelectSeparator className="my-1" />
          <SelectItem value={NEW}>
            <Icon name="plus" />
            {m.plan_new()}
          </SelectItem>
        </SelectContent>
      </Select>
      {creating && (
        <NameFormDialog
          defaultName=""
          maxLength={createStudyPlanBodyNameMax}
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            const plan = await create(name);
            markGettingStarted('plan');
            open(plan.id);
          }}
          open
          submitLabel={m.action_create()}
          title={m.plan_new()}
        />
      )}
    </>
  );
}
