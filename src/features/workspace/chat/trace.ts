import { isApiError } from '@/api/client';
import type {
  ActivityBlock,
  ResourceEffect,
  ResourceEffectOperation,
} from '@/api/types';
import { m } from '@/i18n';

export type ToolBlock = Extract<ActivityBlock, { kind: 'tool' }>;

export type ActivityIconKind =
  | 'think'
  | 'search'
  | 'read'
  | 'look'
  | 'list'
  | 'edit'
  | 'trash'
  | 'restore'
  | 'bouncy';

export type StepState = 'running' | 'done' | 'failed' | 'unknown' | 'stopped';

export type TraceRow =
  | { type: 'narration'; id: string; text: string }
  | { type: 'thinking'; id: string; running: boolean; seconds?: number }
  | { type: 'step'; id: string; tool: ToolBlock; state: StepState }
  /** Two or more finished calls of one tool in a row. */
  | { type: 'group'; id: string; name: string; tools: ToolBlock[] }
  /** A file the turn created; later steps on that file fold into it. */
  | { type: 'created'; id: string; effect: ResourceEffect; tool: ToolBlock }
  /** A change to an existing file: the tool's own row, with Undo while the
   * edit's room holds it. */
  | { type: 'edited'; id: string; effect: ResourceEffect; tool: ToolBlock };

/** A wait shorter than this between steps is not a thinking step; the live
 * Thinking row appears after the same delay. */
export const THINKING_DELAY_MS = 400;

const CREATE_TOOLS = new Set(['create_material', 'create_deck']);

/** A file this step created: a create tool's, or another tool's created
 * effect (add_questions starting a new quiz). Its Undo trashes the file and
 * Redo restores it, so trashed and restored stay on the card too. */
function isCreated(tool: ToolBlock, effect: ResourceEffect): boolean {
  if (CREATE_TOOLS.has(tool.name)) return true;
  if (tool.name === 'trash_file' || tool.name === 'restore_file') return false;
  return (
    effect.operation === 'created' ||
    effect.operation === 'trashed' ||
    effect.operation === 'restored'
  );
}

const ICONS: Record<string, ActivityIconKind> = {
  add_question_media: 'edit',
  add_questions: 'edit',
  capture_knowledge_page: 'look',
  capture_page: 'look',
  create_deck: 'edit',
  create_material: 'edit',
  edit_document: 'edit',
  edit_office_document: 'edit',
  inspect_document: 'read',
  inspect_office_document: 'read',
  list_sources: 'list',
  list_trashed_files: 'list',
  read_document: 'read',
  read_knowledge: 'read',
  read_skill: 'read',
  resolve_source_change: 'edit',
  restore_file: 'restore',
  search_knowledge: 'search',
  search_web: 'search',
  search_workspace: 'search',
  trash_file: 'trash',
  write_slide: 'edit',
};

export function toolIcon(name: string): ActivityIconKind {
  return ICONS[name] ?? 'bouncy';
}

type Copy = {
  run: (label: string) => string;
  done: (label: string) => string;
  fail: (label: string) => string;
  group: (count: number) => string;
  /** The label when the tool event carries none. */
  fallback?: () => string;
};

const read = (group: Copy['group'], fallback: Copy['fallback']): Copy => ({
  done: (label) => m.chat_step_read_done({ label }),
  fail: (label) => m.chat_step_read_fail({ label }),
  fallback,
  group,
  run: (label) => m.chat_step_read_run({ label }),
});
const look: Copy = {
  done: (label) => m.chat_step_look_done({ label }),
  fail: (label) => m.chat_step_look_fail({ label }),
  fallback: m.chat_step_fallback_page,
  group: (count) => m.chat_step_look_group({ count }),
  run: (label) => m.chat_step_look_run({ label }),
};
const create: Copy = {
  done: (label) => m.chat_step_create_done({ label }),
  fail: (label) => m.chat_step_create_fail({ label }),
  fallback: m.chat_step_fallback_file,
  group: (count) => m.chat_step_create_group({ count }),
  run: (label) => m.chat_step_create_run({ label }),
};
const edit: Copy = {
  done: (label) => m.chat_step_edit_done({ label }),
  fail: (label) => m.chat_step_edit_fail({ label }),
  fallback: m.chat_step_fallback_file,
  group: (count) => m.chat_step_edit_group({ count }),
  run: (label) => m.chat_step_edit_run({ label }),
};
const inspect: Copy = {
  done: (label) => m.chat_step_inspect_done({ label }),
  fail: (label) => m.chat_step_inspect_fail({ label }),
  fallback: m.chat_step_fallback_file,
  group: (count) => m.chat_step_inspect_group({ count }),
  run: (label) => m.chat_step_inspect_run({ label }),
};

const COPY: Record<string, Copy> = {
  add_question_media: {
    done: (label) => m.chat_step_media_done({ label }),
    fail: (label) => m.chat_step_media_fail({ label }),
    fallback: m.chat_step_fallback_question,
    group: (count) => m.chat_step_media_group({ count }),
    run: (label) => m.chat_step_media_run({ label }),
  },
  add_questions: {
    done: (label) => m.chat_step_questions_done({ label }),
    fail: (label) => m.chat_step_questions_fail({ label }),
    fallback: m.chat_step_fallback_file,
    group: (count) => m.chat_step_questions_group({ count }),
    run: (label) => m.chat_step_questions_run({ label }),
  },
  capture_knowledge_page: look,
  capture_page: look,
  create_deck: create,
  create_material: create,
  edit_document: edit,
  // The Office tools read and write as the document tools do (Epo 2026-10-20).
  edit_office_document: edit,
  inspect_document: inspect,
  inspect_office_document: inspect,
  list_sources: {
    done: () => m.chat_step_list_sources_done(),
    fail: () => m.chat_step_list_sources_fail(),
    group: (count) => m.chat_step_list_sources_group({ count }),
    run: () => m.chat_step_list_sources_run(),
  },
  list_trashed_files: {
    done: () => m.chat_step_list_trash_done(),
    fail: () => m.chat_step_list_trash_fail(),
    group: (count) => m.chat_step_list_trash_group({ count }),
    run: () => m.chat_step_list_trash_run(),
  },
  read_document: read(
    (count) => m.chat_step_read_files_group({ count }),
    m.chat_step_fallback_file
  ),
  read_knowledge: read(
    (count) => m.chat_step_read_library_group({ count }),
    m.chat_step_fallback_book
  ),
  read_skill: read(
    (count) => m.chat_step_read_guides_group({ count }),
    m.chat_step_fallback_guide
  ),
  read_study_progress: {
    done: () => m.chat_step_progress_done(),
    fail: () => m.chat_step_progress_fail(),
    group: (count) => m.chat_step_progress_group({ count }),
    run: () => m.chat_step_progress_run(),
  },
  resolve_source_change: {
    done: (label) => m.chat_step_resolve_done({ label }),
    fail: (label) => m.chat_step_resolve_fail({ label }),
    fallback: m.chat_step_fallback_file,
    group: (count) => m.chat_step_resolve_group({ count }),
    run: (label) => m.chat_step_resolve_run({ label }),
  },
  restore_file: {
    done: (label) => m.chat_step_restore_done({ label }),
    fail: (label) => m.chat_step_restore_fail({ label }),
    fallback: m.chat_step_fallback_file,
    group: (count) => m.chat_step_restore_group({ count }),
    run: (label) => m.chat_step_restore_run({ label }),
  },
  search_knowledge: {
    done: (label) => m.chat_step_search_library_done({ label }),
    fail: () => m.chat_step_search_library_fail(),
    group: (count) => m.chat_step_search_library_group({ count }),
    run: (label) => m.chat_step_search_library_run({ label }),
  },
  // Draft copy for Epo's review (2026-10-24).
  search_web: {
    done: (label) => m.chat_step_search_web_done({ label }),
    fail: () => m.chat_step_search_web_fail(),
    group: (count) => m.chat_step_search_web_group({ count }),
    run: (label) => m.chat_step_search_web_run({ label }),
  },
  search_workspace: {
    done: (label) => m.chat_step_search_sources_done({ label }),
    fail: () => m.chat_step_search_sources_fail(),
    group: (count) => m.chat_step_search_sources_group({ count }),
    run: (label) => m.chat_step_search_sources_run({ label }),
  },
  trash_file: {
    done: (label) => m.chat_step_trash_done({ label }),
    fail: (label) => m.chat_step_trash_fail({ label }),
    fallback: m.chat_step_fallback_file,
    group: (count) => m.chat_step_trash_group({ count }),
    run: (label) => m.chat_step_trash_run({ label }),
  },
  write_slide: {
    done: (label) => m.chat_step_write_done({ label }),
    fail: (label) => m.chat_step_write_fail({ label }),
    fallback: m.chat_step_fallback_slide,
    group: (count) => m.chat_step_write_group({ count }),
    run: (label) => m.chat_step_write_run({ label }),
  },
};

const OTHER: Copy = {
  done: () => m.chat_step_other_done(),
  fail: () => m.chat_step_other_fail(),
  group: (count) => m.chat_step_other_group({ count }),
  run: () => m.chat_step_other_run(),
};

const SEARCHES = new Set([
  'search_workspace',
  'search_knowledge',
  'search_web',
]);

/** A tool's copy; an edit that created its file (edit_office_document's
 * create) reads as create_material's does. */
function copyOf(tool: ToolBlock): Copy {
  const copy = COPY[tool.name] ?? OTHER;
  return copy === edit &&
    tool.effects?.some((effect) => isCreated(tool, effect))
    ? create
    : copy;
}

/** The human label a row emphasises: the query (quoted), file or page. */
export function stepLabel(tool: ToolBlock): string {
  const copy = copyOf(tool);
  if (tool.capture) return m.chat_step_page({ page: tool.capture.page });
  if (!tool.detail) return copy.fallback?.() ?? '';
  return SEARCHES.has(tool.name) ? `“${tool.detail}”` : tool.detail;
}

/** A row's sentence and the label inside it, for emphasis. */
export function stepTitle(
  tool: ToolBlock,
  state: StepState
): { text: string; label: string } {
  const copy = copyOf(tool);
  const label = stepLabel(tool);
  const running = copy.run(label);
  switch (state) {
    case 'running':
      return { label, text: running };
    case 'done':
      return { label, text: copy.done(label) };
    case 'failed':
      return { label, text: copy.fail(label) };
    case 'unknown':
      return { label, text: m.chat_step_unknown({ step: running }) };
    case 'stopped':
      return {
        label,
        text: m.chat_step_stopped({
          step: running.charAt(0).toLowerCase() + running.slice(1),
        }),
      };
  }
}

/** The commands a finished call left unapplied: an Office edit the engine
 * cut at a per-call limit that no later edit of its file in the turn
 * followed (Epo 2026-10-23, Q171). */
function notApplied(tool: ToolBlock): number {
  return tool.outcome && tool.applied !== undefined && tool.total !== undefined
    ? tool.total - tool.applied
    : 0;
}

/** A running call's progress after its sentence: "30 of 32". */
export function stepProgress(
  tool: ToolBlock,
  state: StepState
): string | undefined {
  if (
    state === 'running' &&
    tool.applied !== undefined &&
    tool.total !== undefined
  )
    return m.chat_step_progress({ applied: tool.applied, total: tool.total });
}

/** A finished call's warning icon text: "2 commands not applied". */
export function unappliedWarning(tool: ToolBlock): string | undefined {
  const left = notApplied(tool);
  if (left <= 0) return;
  return left === 1
    ? m.chat_step_not_applied_one()
    : m.chat_step_not_applied({ count: left });
}

export function groupTitle(name: string, count: number): string {
  return (COPY[name] ?? OTHER).group(count);
}

function stepState(
  tool: ToolBlock,
  running: boolean,
  stopped: boolean
): StepState {
  switch (tool.outcome) {
    case 'succeeded':
      return 'done';
    case 'failed':
    case 'refused':
      return 'failed';
    case 'cancelled':
      return 'stopped';
    case 'outcome_unknown':
      return 'unknown';
    default:
      if (running) return 'running';
      return stopped ? 'stopped' : 'unknown';
  }
}

const time = (iso?: string) => (iso ? Date.parse(iso) : Number.NaN);

export interface TraceInput {
  activity: readonly ActivityBlock[];
  /** The message is still streaming. */
  live: boolean;
  /** false lists every tool as a plain row (the Normal fold's contents). */
  receipts?: boolean;
  /** When the turn began: the assistant message's createdAt. */
  startedAt?: string;
  /** The user stopped the turn. */
  stopped: boolean;
  /** The model is between steps (after the Thinking delay). */
  thinking: boolean;
}

/** Turns a message's activity into trace rows: thinking gaps from the step
 * times, receipts for created and edited files, and groups of one tool. */
export function buildTrace({
  activity,
  startedAt,
  live,
  stopped,
  thinking,
  receipts = true,
}: TraceInput): TraceRow[] {
  const tools = activity.filter(
    (block): block is ToolBlock => block.kind === 'tool'
  );
  const lastOpen = live
    ? [...tools].reverse().find((tool) => !tool.outcome)
    : undefined;
  const created = new Set<string>();
  const rows: TraceRow[] = [];
  let since = time(startedAt);
  let first = true;

  for (const block of activity) {
    if (block.kind === 'narration') {
      rows.push({ id: block.id, text: block.text, type: 'narration' });
      continue;
    }
    const tool: ToolBlock = block;
    const start = time(tool.startedAt);
    const gap = start - since;
    if (gap >= THINKING_DELAY_MS) {
      rows.push({
        id: `${tool.id}:thinking`,
        running: false,
        seconds: Math.max(1, Math.round(gap / 1000)),
        type: 'thinking',
      });
    } else if (first && Number.isNaN(gap)) {
      rows.push({
        id: `${tool.id}:thinking`,
        running: false,
        type: 'thinking',
      });
    }
    first = false;
    since = time(tool.endedAt ?? tool.startedAt);

    // A call reporting progress runs until its outcome, even while a later
    // one runs: a cut Office edit waits for the next edit of its file.
    const state = stepState(
      tool,
      tool === lastOpen || (live && tool.total !== undefined),
      stopped
    );
    const effects = tool.effects ?? [];
    if (receipts && effects.length) {
      if (effects.some((effect) => isCreated(tool, effect))) {
        for (const effect of effects) {
          created.add(effect.resource.id);
          rows.push({
            effect,
            id: `${tool.id}:${effect.resource.id}`,
            tool,
            type: 'created',
          });
        }
        continue;
      }
      if (
        state === 'done' &&
        !notApplied(tool) &&
        effects.every((effect) => created.has(effect.resource.id))
      )
        continue;
      const edits = effects.filter(
        (effect) =>
          effect.operation === 'edited' || effect.operation === 'edit_undone'
      );
      if (edits.length) {
        for (const effect of edits) {
          rows.push({
            effect,
            id: `${tool.id}:${effect.resource.id}`,
            tool,
            type: 'edited',
          });
        }
        continue;
      }
    }
    rows.push({ id: tool.id, state, tool, type: 'step' });
  }
  if (thinking) rows.push({ id: 'thinking', running: true, type: 'thinking' });
  return groupSteps(rows);
}

function groupSteps(rows: TraceRow[]): TraceRow[] {
  const out: TraceRow[] = [];
  let run: Extract<TraceRow, { type: 'step' }>[] = [];
  const flush = () => {
    if (run.length > 1) {
      out.push({
        id: `${run[0].id}:group`,
        name: run[0].tool.name,
        tools: run.map((row) => row.tool),
        type: 'group',
      });
    } else out.push(...run);
    run = [];
  };
  for (const row of rows) {
    if (
      row.type === 'step' &&
      row.state === 'done' &&
      (!run.length || run[0].tool.name === row.tool.name)
    ) {
      run.push(row);
      continue;
    }
    flush();
    if (row.type === 'step' && row.state === 'done') run.push(row);
    else out.push(row);
  }
  flush();
  return out;
}

const isReceipt = (row: TraceRow) =>
  row.type === 'created' || row.type === 'edited';

/** Normal mode once the answer starts: the steps behind summary rows, the
 * receipts below them. */
export function foldTrace(input: Omit<TraceInput, 'receipts'>): {
  rows: TraceRow[];
  receipts: TraceRow[];
  steps: number;
} {
  const rows = buildTrace({ ...input, receipts: false });
  const tools = input.activity.filter(
    (block): block is ToolBlock => block.kind === 'tool'
  );
  const thinking = rows.filter(
    (row) => row.type === 'thinking' && !row.running
  ).length;
  return {
    receipts: buildTrace(input).filter(isReceipt),
    rows,
    steps: tools.length + thinking,
  };
}

/** The last tool step: its index in `rows`, icon and sentence. Normal's folded
 * line names it, and the steps before it open above that line. */
export function latestStep(
  rows: readonly TraceRow[]
): { index: number; icon: ActivityIconKind; text: string } | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    switch (row.type) {
      case 'step':
        return {
          icon: toolIcon(row.tool.name),
          index,
          text: stepTitle(row.tool, row.state).text,
        };
      case 'group':
        return {
          icon: toolIcon(row.name),
          index,
          text: groupTitle(row.name, row.tools.length),
        };
      case 'created':
      case 'edited':
        return {
          icon: toolIcon(row.tool.name),
          index,
          text: stepTitle(row.tool, 'done').text,
        };
      default:
        break;
    }
  }
}

/** Normal mode: the rows split at each narration, which stays as text, so a
 * fold (or the live row) only ever covers the steps between them. */
export function foldSegments(rows: readonly TraceRow[]): TraceRow[][] {
  const out: TraceRow[][] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (row.type !== 'narration' && last && last[0].type !== 'narration') {
      last.push(row);
    } else out.push([row]);
  }
  return out;
}

/** Refusals that keep the step: the Office maintenance pause and a room busy
 * for a moment (a publication handoff, a reset under way). */
const temporaryUndoRefusals = new Set([
  'office_editing_paused',
  'unavailable_target',
]);

/** Whether a failed Undo or Redo was refused (its step is gone: hide the
 * button) rather than of unknown outcome (no answer, a server error) or
 * refused for a moment, which keep the button: a retry gets the step's
 * receipt if the first landed, or lands once the room takes it. */
export function undoRefused(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status < 500 &&
    !temporaryUndoRefusals.has(error.code ?? '')
  );
}

/** Undo reverses created, edited and restored; Redo reverses an Undo. */
export function undoAction(
  operation: ResourceEffectOperation
): 'undo' | 'redo' {
  return operation === 'edit_undone' || operation === 'trashed'
    ? 'redo'
    : 'undo';
}
