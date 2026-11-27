import {
  type ComponentType,
  createContext,
  createElement,
  lazy,
  useContext,
  useSyncExternalStore,
} from 'react';
import { showErrorToast } from '@/api/queryClient';
import { userToast } from '@/components/ui/userToast';
import { parseMathText } from '@/features/questions/parseMathText';
import type {
  GraphBlock,
  LearnerQuestion,
  QuestionBlock,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { errorKind } from '@/lib/errors';
import { CannotShow } from './CannotShow';
import type { MaterialElement, MaterialValue } from './document';
import { loadedMathLive, loadMathLive } from './mathLive';

/* The code a note's blocks load on their own, past what the editor brings:
 * what a block draws with and what its buttons open. Each loads once, for its
 * lazy component and Preview's preload alike (Epo 2026-11-20: pressing
 * Preview loads the whole note first), and a block reads how it settled.
 *
 * A load the person or Preview asked for (`load`: a block drawn, a button
 * pressed) that fails marks the code failed: what needs it draws "This block
 * cannot be shown" (CannotShow) in its place, never a thrown error, and the
 * error toast offers Reload, at once or, offline, once the connection is
 * back. An idle preload's failure (`preload`) marks nothing, so the part
 * keeps its button and a press asks again. Asking again cannot succeed before
 * a reload: the browser keeps a failed import in the document's module map
 * (on Chromium 151 a second import() of the URL fails without a request), so
 * the failed promise is kept. */

type Settled = 'loaded' | 'failed';

export interface BlockCode<T = unknown> {
  /** Loads it for what the person or Preview asked for. */
  load: () => Promise<T>;
  /** Loads it ahead in idle time; a failure here marks nothing. */
  preload: () => Promise<T>;
  /** 'loaded' once any load brought it, 'failed' once an asked one could
   * not; undefined until then. */
  readonly settled: Settled | undefined;
}

const listeners = new Set<() => void>();

/** A load failed offline and waits for the connection: then a toast offers
 * the reload that brings it, once. */
let failedOffline = false;

function toastFailure(error: unknown) {
  if (errorKind(error) !== 'offline') {
    showErrorToast(error);
    return;
  }
  if (failedOffline) return;
  failedOffline = true;
  window.addEventListener(
    'online',
    () => {
      failedOffline = false;
      userToast({
        button: {
          label: m.error_action_reload(),
          onClick: () => window.location.reload(),
        },
        description: m.error_chunk_offline_body(),
        id: 'block-code-offline',
        title: m.error_chunk_offline_title(),
        variant: 'error',
      });
    },
    { once: true }
  );
}

function blockCode<T>(
  importer: () => Promise<T>,
  {
    quiet = false,
    registered,
  }: {
    /** What needs it says itself that it could not load and tries again
     * itself: a failure marks nothing, shows no toast and is not kept. */
    quiet?: boolean;
    /** It is here already, loaded by an import of its own. */
    registered?: () => boolean;
  } = {}
): BlockCode<T> {
  let promise: Promise<T> | undefined;
  let state: Settled | undefined;
  let asked = false;
  const settle = (next: Settled) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const start = () => {
    promise ??= importer().then(
      (module) => {
        settle('loaded');
        return module;
      },
      (error: unknown) => {
        if (quiet) promise = undefined;
        throw error;
      }
    );
    return promise;
  };
  return {
    load: () => {
      const loading = start();
      if (!(asked || quiet)) {
        asked = true;
        loading.catch((error: unknown) => {
          settle('failed');
          toastFailure(error);
        });
      }
      return loading;
    },
    preload: start,
    get settled() {
      return state ?? (registered?.() ? 'loaded' : undefined);
    },
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The code an open Preview stopped waiting for (NotePreview's limit): what
 * needs it draws CannotShow there, as for a failed load, until Preview opens
 * again, even if it arrives meanwhile. */
export const GivenUpCode = createContext<ReadonlySet<BlockCode>>(new Set());

/** Whether `code` could not load, or Preview gave up on it: what needs it
 * draws CannotShow instead. */
export function useCodeFailed(code: BlockCode) {
  const givenUp = useContext(GivenUpCode).has(code);
  const failed = useSyncExternalStore(
    subscribe,
    () => code.settled === 'failed',
    () => false
  );
  return givenUp || failed;
}

/** The component `code` exports, an asked load: CannotShow if it could not
 * load, whatever order its user hears of the failure in. */
function lazyBlock<P>(code: BlockCode<{ default: ComponentType<P> }>) {
  const notShown: { default: ComponentType<P> } = {
    default: () => createElement(CannotShow),
  };
  return lazy(() => code.load().catch(() => notShown));
}

/** BlockSuite's drawing board, about 650 KB gzipped: a canvas answer's
 * Answer in Canvas and Open canvas, a shown canvas's Open canvas, and the quiz
 * editor's canvases and drawn samples. */
export const boardCode = blockCode(
  () => import('@/features/quizzes/drawing/DrawingBoardScreen')
);
export const DrawingBoardScreen = lazyBlock(boardCode);

/** An HTML embed's View source. */
export const htmlSourceCode = blockCode(
  () => import('@/features/notes/blocks/HtmlEmbedSourceDialog')
);
export const HtmlEmbedSourceDialog = lazyBlock(htmlSourceCode);

/** The graph engine, which draws a graph (GraphView). */
export const graphCode = blockCode(
  () => import('@/features/questions/graphPaint')
);

/** KaTeX, which lays out a graph's formulas. A graph draws without it, and
 * its formulas load it again as they draw (`drawing`). */
export const katexCode = blockCode(
  () => graphCode.preload().then((paint) => paint.loadKatex()),
  { quiet: true }
);

/** MathLive and its static stylesheet: a formula in an equation or a
 * question's text, and a long answer's Formula. Each of those handles its
 * failure itself (the formula's TeX as text, the field's could-not-load
 * line). */
export const mathCode = blockCode(loadMathLive, {
  quiet: true,
  registered: () => loadedMathLive() !== undefined,
});

/** What a node needs by its `type`: a note's elements, a question's blocks, a
 * graph's elements and a quiz part's answer. Everything else draws with the
 * editor's code (and an image's, figure's or diagram's full-screen view comes
 * with it), or, a Mermaid diagram, in its worker, which says itself when it
 * could not load. */
const NEEDS: Partial<Record<string, BlockCode>> = {
  canvas: boardCode,
  equation: mathCode,
  formula: katexCode,
  graph: graphCode,
  html_embed: htmlSourceCode,
  inline_equation: mathCode,
  open: mathCode,
};

/** Whether any text in `value` holds a formula, which MathLive draws. */
const holdsFormula = (value: unknown): boolean => {
  if (typeof value === 'string')
    return (
      value.includes('$') &&
      parseMathText(value).some((token) => token.type !== 'text')
    );
  if (Array.isArray(value)) return value.some(holdsFormula);
  return (
    !!value &&
    typeof value === 'object' &&
    Object.values(value).some(holdsFormula)
  );
};

/** Adds what a node of `type` needs to `found`. */
function need(type: string, found: Set<BlockCode>) {
  const code = NEEDS[type];
  if (code) found.add(code);
}

/** Adds what a question's block (or a note's graph) needs to `found`. A
 * drawn canvas opens on the board (Open canvas); an empty one shows
 * nothing. */
function blockNeeds(shown: QuestionBlock, found: Set<BlockCode>) {
  if (shown.type === 'canvas') {
    if ('board' in shown) found.add(boardCode);
    return;
  }
  need(shown.type, found);
  if (shown.type === 'graph')
    for (const element of shown.elements) need(element.type, found);
}

/** A quiz's needs, kept while its questions are the same array. */
const quizNeeds = new WeakMap<
  readonly LearnerQuestion[],
  readonly BlockCode[]
>();

function questionsNeed(questions: readonly LearnerQuestion[]) {
  let needs = quizNeeds.get(questions);
  if (!needs) {
    const found = new Set<BlockCode>();
    for (const question of questions) {
      for (const shown of question.stem) blockNeeds(shown, found);
      for (const group of question.groups ?? [])
        for (const shown of group.blocks) blockNeeds(shown, found);
      for (const part of question.parts) {
        for (const shown of part.blocks) blockNeeds(shown, found);
        need(part.answer.type, found);
      }
      if (holdsFormula(question)) found.add(mathCode);
    }
    needs = [...found];
    quizNeeds.set(questions, needs);
  }
  return needs;
}

type QuestionsOf = (quizId: string) => readonly LearnerQuestion[] | undefined;

/** Adds what `node` and the elements inside it need to `found`. */
function collect(
  node: MaterialElement,
  questionsOf: QuestionsOf,
  found: Set<BlockCode>
) {
  if (node.type === 'graph') blockNeeds(node.block as GraphBlock, found);
  else need(node.type, found);
  if (
    node.type === 'material_ref' &&
    node.refKind === 'quiz' &&
    typeof node.materialId === 'string'
  ) {
    const questions = questionsOf(node.materialId);
    if (questions)
      for (const needed of questionsNeed(questions)) found.add(needed);
  }
  for (const child of node.children)
    if ('type' in child) collect(child as MaterialElement, questionsOf, found);
}

/** A top-level block's needs, kept while the block is the same object: Preview
 * walks the note again on every redraw. */
const elementNeeds = new WeakMap<MaterialElement, readonly BlockCode[]>();

/**
 * The code a note's blocks need: its elements, and the questions of its
 * embedded quizzes as `questionsOf` holds them (a quiz not read yet adds
 * nothing). Flashcard sets draw with the editor's code.
 */
export function codeOf(
  value: MaterialValue,
  questionsOf: QuestionsOf
): Set<BlockCode> {
  const found = new Set<BlockCode>();
  for (const node of value) {
    // An embed's questions may have been read since.
    if (node.type === 'material_ref') {
      collect(node, questionsOf, found);
      continue;
    }
    let needs = elementNeeds.get(node);
    if (!needs) {
      const own = new Set<BlockCode>();
      collect(node, questionsOf, own);
      needs = [...own];
      elementNeeds.set(node, needs);
    }
    for (const needed of needs) found.add(needed);
  }
  return found;
}
