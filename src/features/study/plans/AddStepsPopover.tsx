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
import { IconButton } from '@/components/ui/IconButton';
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
import { readingOrder } from '@/features/workspace/workspaceContent';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';

type Option = {
  input: PlanStepInput;
  label: string;
  icon?: ReturnType<typeof fileIconName>;
};

/** The plan's one + (human/study-progress.md 2026-10-22): pick a workspace,
 * then tick its whole workspace, chapters, Others or single files; steps
 * already in the plan show ticked and disabled. New steps go to the end. */
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
        <IconButton
          icon="plus"
          label={m.plan_add_steps()}
          size="md"
          variant="outline"
        />
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
  const [picked, setPicked] = useState<Map<string, PlanStepInput>>(
    () => new Map()
  );
  const [singles, setSingles] = useState(false);
  const held = new Set(steps.map(stepKey));
  const workspace = workspaces?.find((ws) => ws.id === workspaceId);

  const options: Option[] = [
    {
      input: { kind: 'workspace', workspaceId },
      label: m.plan_whole_workspace(),
    },
    ...[...(chapters ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((ch) => ({
        input: { kind: 'chapter' as const, targetId: ch.id, workspaceId },
        label: ch.name,
      })),
    { input: { kind: 'unfiled', workspaceId }, label: m.study_others() },
  ];
  const singleOptions: Option[] = readingOrder(chapters, files, materials).map(
    (it) => ({
      icon:
        it.type === 'file'
          ? fileIconName(it.data)
          : materialIconName(it.data.type),
      input: { kind: it.type, targetId: it.id, workspaceId },
      label: it.type === 'file' ? it.data.name : it.data.title,
    })
  );
  const toggle = (input: PlanStepInput) =>
    setPicked((prev) => {
      const next = new Map(prev);
      const key = stepKey(input);
      if (!next.delete(key)) next.set(key, input);
      return next;
    });
  const row = (option: Option) => {
    const key = stepKey(option.input);
    const inPlan = held.has(key);
    return (
      <button
        aria-checked={inPlan || picked.has(key)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-button px-1.5 py-1.5 text-left',
          inPlan ? 'text-fg-muted' : 'hover:bg-surface-hover-bg'
        )}
        disabled={inPlan}
        key={key}
        onClick={() => toggle(option.input)}
        role="checkbox"
        type="button"
      >
        <span
          className={cn(
            checkboxVariants({ checked: inPlan || picked.has(key) }),
            'size-5 shrink-0',
            inPlan && 'opacity-50'
          )}
        >
          {(inPlan || picked.has(key)) && (
            <Icon name="check" size={14} strokeWidth={2.4} />
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
          setPicked(new Map());
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
                  className="size-4 shrink-0 rounded-[4px]"
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
              {ws.name}
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
          disabled={picked.size === 0}
          onClick={() => onAdd([...picked.values()])}
          rounded="large"
        >
          {m.plan_add_n_steps({ count: picked.size })}
        </Button>
      </div>
    </Card>
  );
}
