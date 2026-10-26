import { useState } from 'react';
import {
  stepKey,
  useChapters,
  useFiles,
  useMaterials,
  useWorkspaces,
} from '@/api/hooks';
import type { PlanStep, PlanStepInput } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { checkboxVariants } from '@/components/ui/Checkbox';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { useStudyStates } from '@/features/study/studyItems';
import { readingOrder } from '@/features/workspace/workspaceContent';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';

/** A row to tick: a whole workspace, a chapter, Others or one file, each
 * standing for its tracked files. */
type Option = {
  key: string;
  label: string;
  icon?: ReturnType<typeof fileIconName>;
  inputs: PlanStepInput[];
};

/** The plan's Add steps, an accent button left of the Study page's Filter
 * (human/study-progress.md 2026-10-22, 2026-10-25): pick a workspace,
 * then tick its whole workspace, chapters, Others or single files. A tick
 * picks the row's tracked files, so the workspace ticks every chapter and a
 * row with only some of its files picked (or in the plan) shows a dash; a row
 * whose files are all in the plan shows ticked and disabled. The page places
 * the new steps. */
export function AddStepsPopover({
  defaultWorkspaceId,
  steps,
  onAdd,
}: {
  defaultWorkspaceId: string;
  steps: readonly PlanStep[];
  onAdd: (inputs: PlanStepInput[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        {/* Accent text like Workspaces' New workspace, the hover tint only. */}
        <Button
          className="h-fit px-2 py-1.5 font-bold text-link"
          iconLeft="plus"
          size="md"
          variant="ghost-hover"
        >
          {m.plan_add_steps()}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(360px,calc(100vw-32px))] gap-0 border-0 bg-transparent p-0 shadow-none!"
      >
        {open && (
          <AddSteps
            defaultWorkspaceId={defaultWorkspaceId}
            onAdd={(inputs) => {
              onAdd(inputs);
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
            steps={steps}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function AddSteps({
  defaultWorkspaceId,
  steps,
  onAdd,
  onCancel,
}: {
  defaultWorkspaceId: string;
  steps: readonly PlanStep[];
  onAdd: (inputs: PlanStepInput[]) => void;
  onCancel: () => void;
}) {
  const { data: workspaces } = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const { data: chapters } = useChapters(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId);
  const { states } = useStudyStates(workspaceId);
  // Ticked files by id: every row reads its tick from them, so the whole
  // workspace, its chapters and single files stay in step.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [singles, setSingles] = useState(false);
  const held = new Set(steps.map(stepKey));
  const workspace = workspaces?.find((ws) => ws.id === workspaceId);

  // Steps are files: a chapter (or Others, or the workspace) adds its tracked
  // files in reading order; the plan does not follow it afterwards.
  const tracked = readingOrder(chapters, files, materials).filter(
    (it) => states.get(it.id) !== 'removed'
  );
  const inputOf = (it: (typeof tracked)[number]): PlanStepInput => ({
    kind: it.type,
    targetId: it.id,
    workspaceId,
  });
  const options: Option[] = [
    {
      inputs: tracked.map(inputOf),
      key: 'workspace',
      label: m.plan_whole_workspace(),
    },
    ...[...(chapters ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((ch) => ({
        inputs: tracked
          .filter((it) => it.data.chapterId === ch.id)
          .map(inputOf),
        key: `chapter:${ch.id}`,
        label: ch.name,
      })),
    {
      inputs: tracked.filter((it) => !it.data.chapterId).map(inputOf),
      key: 'others',
      label: m.study_others(),
    },
  ].filter((option) => option.inputs.length > 0);
  const singleOptions: Option[] = tracked.map((it) => ({
    icon:
      it.type === 'file'
        ? fileIconName(it.data)
        : materialIconName(it.data.type),
    inputs: [inputOf(it)],
    key: `item:${it.id}`,
    label: it.type === 'file' ? it.data.name : it.data.title,
  }));
  // The ticked files not in the plan yet, in reading order.
  const toAdd = tracked
    .map(inputOf)
    .filter((input) => picked.has(input.targetId) && !held.has(stepKey(input)));
  const row = (option: Option) => {
    // Files already in the plan count as ticked and stay put.
    const free = option.inputs
      .filter((input) => !held.has(stepKey(input)))
      .map((input) => input.targetId);
    const inPlan = free.length === 0;
    const ticked = free.filter((id) => picked.has(id)).length;
    const all = ticked === free.length;
    // Some of its files ticked or in the plan, not all: a dash.
    const mixed = !all && ticked + option.inputs.length - free.length > 0;
    const toggle = () =>
      setPicked((prev) => {
        const next = new Set(prev);
        for (const id of free) {
          if (all) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    return (
      <button
        aria-checked={all ? true : mixed ? 'mixed' : false}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-button px-1.5 py-1.5 text-left',
          inPlan ? 'text-fg-muted' : 'hover:bg-surface-hover-bg'
        )}
        disabled={inPlan}
        key={option.key}
        onClick={toggle}
        role="checkbox"
        type="button"
      >
        <span
          className={cn(
            checkboxVariants({ checked: all || mixed }),
            'size-5 shrink-0',
            inPlan && 'opacity-50'
          )}
        >
          {(all || mixed) && (
            <Icon name={all ? 'check' : 'minus'} size={14} strokeWidth={2.4} />
          )}
        </span>
        {option.icon && (
          <FileIcon className="size-3.75 shrink-0" name={option.icon} />
        )}
        <span className="min-w-0 flex-1 translate-y-px truncate">
          {option.label}
        </span>
        {inPlan && (
          <span className="t-meta shrink-0">{m.plan_step_in_plan()}</span>
        )}
      </button>
    );
  };

  return (
    <Card
      border="solid"
      className="max-h-[min(520px,70dvh)] gap-3 overflow-y-auto p-3.5"
      radius="card"
    >
      <p className="font-semibold">{m.plan_workspace()}</p>
      <Select
        onValueChange={(id) => {
          setWorkspaceId(id);
          setPicked(new Set());
          setSingles(false);
        }}
        value={workspaceId}
      >
        <SelectTrigger aria-label={m.plan_workspace()}>
          <SelectValue>
            <span className="flex min-w-0 items-center gap-2">
              {workspace && (
                <img
                  alt=""
                  className="size-5 shrink-0 rounded-[4px]"
                  src={iconUrl(workspace.iconId)}
                />
              )}
              <span className="truncate">{workspace?.name}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(workspaces ?? []).map((ws) => (
            <SelectItem key={ws.id} value={ws.id}>
              <span className="flex min-w-0 items-center gap-2">
                <img
                  alt=""
                  className="size-5 shrink-0 rounded-[4px]"
                  src={iconUrl(ws.iconId)}
                />
                <span className="truncate">{ws.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex flex-col">
        {options.map(row)}
        <button
          aria-expanded={singles}
          className="mt-1 self-start px-1.5 py-1 text-link underline underline-offset-3"
          onClick={() => setSingles(!singles)}
          type="button"
        >
          {m.plan_single_files()}
        </button>
        {singles && singleOptions.map(row)}
      </div>
      <div className="flex justify-end gap-2 border-divider border-t pt-3">
        <Button onClick={onCancel} rounded="large" variant="outline">
          {m.action_cancel()}
        </Button>
        <Button
          disabled={toAdd.length === 0}
          onClick={() => onAdd(toAdd)}
          rounded="large"
        >
          {m.plan_add_n_steps({ count: toAdd.length })}
        </Button>
      </div>
    </Card>
  );
}
