import type {
  PlanStep,
  PlanStepInput,
  PlanWorkspace,
  ProgressItem,
  StudyPlan,
} from '@/api/types';
import { inReadingOrder } from '@/features/workspace/workspaceContent';
import { m } from '@/i18n';

/* A plan's progress, counted in the browser from its workspaces' tracked items
 * (human/study-progress.md 2026-10-22): a step is done when its tracked items
 * are, the current step is the first that is not, and its next item is the
 * first not done in reading order. Locked steps count for nothing. */

export type StepProgress = {
  step: PlanStep;
  workspace?: PlanWorkspace;
  items: ProgressItem[];
  done: number;
  total: number;
};

export type PlanProgress = {
  steps: StepProgress[];
  /** Steps done of steps counted (locked ones left out). */
  done: number;
  total: number;
  /** Index of the current step; -1 once every step is done. */
  current: number;
  next?: { item: ProgressItem; workspaceId: string };
};

const matches = (step: PlanStep, item: ProgressItem) => {
  switch (step.kind) {
    case 'workspace':
      return true;
    case 'unfiled':
      return !item.chapterId;
    case 'chapter':
      return item.chapterId === step.targetId;
    default:
      return item.type === step.kind && item.id === step.targetId;
  }
};

export function planProgress(
  plan: StudyPlan,
  workspaces: ReadonlyMap<string, PlanWorkspace>
): PlanProgress {
  const ordered = new Map<string, ProgressItem[]>();
  const orderedIn = (ws: PlanWorkspace) => {
    let items = ordered.get(ws.workspaceId);
    if (!items) {
      items = inReadingOrder(ws.chapters, ws.items);
      ordered.set(ws.workspaceId, items);
    }
    return items;
  };
  const steps = plan.steps.map((step): StepProgress => {
    const workspace = step.locked
      ? undefined
      : workspaces.get(step.workspaceId);
    if (!workspace) return { done: 0, items: [], step, total: 0 };
    const items = orderedIn(workspace).filter((it) => matches(step, it));
    return {
      done: items.filter((it) => it.state === 'done').length,
      items,
      step,
      total: items.length,
      workspace,
    };
  });
  const counted = steps.filter((s) => !s.step.locked);
  const current = steps.findIndex((s) => !s.step.locked && s.done < s.total);
  const item =
    current < 0
      ? undefined
      : steps[current].items.find((it) => it.state !== 'done');
  return {
    current,
    done: counted.filter((s) => s.done >= s.total).length,
    next: item && { item, workspaceId: steps[current].step.workspaceId },
    steps,
    total: counted.length,
  };
}

export const workspaceMap = (list: readonly PlanWorkspace[]) =>
  new Map(list.map((ws) => [ws.workspaceId, ws]));

/** What a step is called: its chapter, file or workspace, or "Others". */
export const stepTitle = (step: PlanStep) =>
  step.kind === 'unfiled' ? m.study_others() : step.title;

/** The steps as the update endpoint takes them. */
export const stepInputs = (steps: readonly PlanStep[]): PlanStepInput[] =>
  steps.map(({ kind, targetId, workspaceId }) => ({
    kind,
    workspaceId,
    ...(targetId ? { targetId } : {}),
  }));
