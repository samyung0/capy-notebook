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
  /** An undoable change to an existing file: the tool's own row. */
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
  inspect_document: 'read',
  list_sources: 'list',
  list_trashed_files: 'list',
  read_document: 'read',
  read_knowledge: 'read',
  read_skill: 'read',
  resolve_source_change: 'edit',
  restore_file: 'restore',
  search_knowledge: 'search',
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
  edit_document: {
    done: (label) => m.chat_step_edit_done({ label }),
    fail: (label) => m.chat_step_edit_fail({ label }),
    fallback: m.chat_step_fallback_file,
    group: (count) => m.chat_step_edit_group({ count }),
    run: (label) => m.chat_step_edit_run({ label }),
  },
  inspect_document: {
    done: (label) => m.chat_step_inspect_done({ label }),
    fail: (label) => m.chat_step_inspect_fail({ label }),
    fallback: m.chat_step_fallback_file,
    group: (count) => m.chat_step_inspect_group({ count }),
    run: (label) => m.chat_step_inspect_run({ label }),
  },
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

const SEARCHES = new Set(['search_workspace', 'search_knowledge']);

/** The human label a row emphasises: the query (quoted), file or page. */
export function stepLabel(tool: ToolBlock): string {
  const copy = COPY[tool.name] ?? OTHER;
  if (tool.capture) return m.chat_step_page({ page: tool.capture.page });
  if (!tool.detail) return copy.fallback?.() ?? '';
  return SEARCHES.has(tool.name) ? `“${tool.detail}”` : tool.detail;
}

/** A row's sentence and the label inside it, for emphasis. */
export function stepTitle(
  tool: ToolBlock,
  state: StepState
): { text: string; label: string } {
  const copy = COPY[tool.name] ?? OTHER;
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
 * times, receipts for created and undoable files, and groups of one tool. */
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

    const state = stepState(tool, tool === lastOpen, stopped);
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
        effects.every((effect) => created.has(effect.resource.id))
      )
        continue;
      const undoable = effects.filter((effect) => effect.undo);
      if (undoable.length) {
        for (const effect of undoable) {
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

/** Normal mode once the answer starts: every step behind one summary row,
 * the receipts below it. */
export function foldTrace(input: Omit<TraceInput, 'receipts'>): {
  rows: TraceRow[];
  receipts: TraceRow[];
  steps: number;
  seconds?: number;
} {
  const rows = buildTrace({ ...input, receipts: false });
  const tools = input.activity.filter(
    (block): block is ToolBlock => block.kind === 'tool'
  );
  const thinking = rows.filter(
    (row) => row.type === 'thinking' && !row.running
  ).length;
  const end = Math.max(...tools.map((tool) => time(tool.endedAt)));
  const span = end - time(input.startedAt);
  return {
    receipts: buildTrace(input).filter(isReceipt),
    rows,
    seconds:
      tools.length && Number.isFinite(span)
        ? Math.max(1, Math.round(span / 1000))
        : undefined,
    steps: tools.length + thinking,
  };
}

/** The last tool step's icon and sentence: the folded line's title when the
 * turn has no step times to say how long it worked. */
export function latestStep(
  rows: readonly TraceRow[]
): { icon: ActivityIconKind; text: string } | undefined {
  for (const row of [...rows].reverse()) {
    switch (row.type) {
      case 'step':
        return {
          icon: toolIcon(row.tool.name),
          text: stepTitle(row.tool, row.state).text,
        };
      case 'group':
        return {
          icon: toolIcon(row.name),
          text: groupTitle(row.name, row.tools.length),
        };
      case 'created':
      case 'edited':
        return {
          icon: toolIcon(row.tool.name),
          text: stepTitle(row.tool, 'done').text,
        };
    }
  }
}

/** Normal mode while the turn runs: only the step it is on. */
export function currentRow(rows: readonly TraceRow[]): TraceRow | undefined {
  return [...rows].reverse().find((row) => row.type !== 'narration');
}

/** Undo reverses created, edited and restored; Redo reverses an Undo. */
export function undoAction(
  operation: ResourceEffectOperation
): 'undo' | 'redo' {
  return operation === 'edit_undone' || operation === 'trashed'
    ? 'redo'
    : 'undo';
}
