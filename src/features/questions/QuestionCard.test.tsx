import { parseHTML } from 'linkedom';
import { act, type ReactNode, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getLocale, m } from '@/i18n';
import {
  heldSample,
  holdSample,
  keepAnswer,
  keepCanvas,
  keptAnswer,
  keptCanvas,
  keptPart,
} from './typeMemory';
import { blankQuestion, type Question, type QuestionPart } from './types';

/* The open text's editor reads its value once, so a block added or removed
   above it closes it rather than letting it write over the block in its place. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

vi.mock('@/components/ui/Dialog', () => ({ useIsPhone: () => false }));
// Menus and the type select stay shut here; this DOM has no layout for them.
vi.mock('@/components/ui/Popover', () => ({
  Popover: () => null,
  PopoverTrigger: () => null,
}));
vi.mock('@/components/ui/ToolbarButton', () => ({
  ToolbarButton: ({
    disabled,
    label,
    onClick,
  }: {
    disabled?: boolean;
    label: string;
    onClick?: () => void;
  }) => (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      type="button"
    />
  ),
}));
// The type select's choice, made by a test, and why its Canvas is off.
const typeSelect = vi.hoisted(() => ({
  canvasOff: undefined as string | undefined,
  pick: (_kind: string) => {},
}));
vi.mock('./editorFields', async (original) => ({
  ...(await original<typeof import('./editorFields')>()),
  AnswerTypeSelect: ({
    canvasOff,
    onChange,
  }: {
    canvasOff?: string;
    onChange: (kind: string) => void;
  }) => {
    typeSelect.canvasOff = canvasOff;
    typeSelect.pick = onChange;
    return null;
  },
  MarksInput: () => null,
}));
// A quiz's canvas as its card's tools alone; no board loads here.
vi.mock('@/features/quizzes/drawing/CanvasField', async (original) => ({
  ...(await original<
    typeof import('@/features/quizzes/drawing/CanvasField')
  >()),
  CanvasField: ({ tools }: { tools?: ReactNode }) => tools,
  canvasLoads: async () => true,
}));
// As the real editor: uncontrolled, its value read on mount.
vi.mock('./TextEditor', () => ({
  TextEditor: ({
    onChange,
    value,
  }: {
    onChange: (text: string, ids: string[]) => void;
    value: string;
  }) => (
    <textarea
      data-editor=""
      defaultValue={value}
      onChange={(event) => onChange(event.target.value, [])}
    />
  ),
}));

const { createRoot } = await import('react-dom/client');
const { QuestionCard, QuestionCardView } = await import('./QuestionCard');

const host = document.createElement('div');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

let current: Question;
let setOutside: (question: Question) => void;

/** The card on a question held here; `refuse` turns every write down, as a
 * live quiz does one past a cap. */
function Card({
  canvases,
  openPart,
  quizId,
  refuse,
  start,
}: {
  /** A quiz's, drawing canvases. */
  canvases?: boolean;
  openPart?: string;
  quizId?: string;
  refuse?: boolean;
  start: Question;
}) {
  const [question, setQuestion] = useState(start);
  current = question;
  setOutside = setQuestion;
  return (
    <QuestionCard
      addPartInFooter
      openPart={openPart}
      question={question}
      quizId={quizId}
      uploadSample={
        canvases ? async () => ({ board: 'b', image: 'i' }) : undefined
      }
      write={(next) => {
        if (refuse) return false;
        setQuestion(next);
        return true;
      }}
    />
  );
}

const text = (value: string) => ({ text: value, type: 'text' as const });
const table = { header: false, rows: [['1']], type: 'table' as const };

/** A question whose text is A, a table, B and C, with B open in its editor. */
async function showEditingB() {
  const question = blankQuestion();
  const [part] = question.parts;
  root = createRoot(host);
  await act(async () =>
    root.render(
      <Card
        start={{
          ...question,
          parts: [
            { ...part, blocks: [text('A'), table, text('B'), text('C')] },
          ],
        }}
      />
    )
  );
  const b = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'B'
  );
  await act(async () => b?.click());
}

const blockTexts = () =>
  current.parts[0].blocks.map((block) =>
    block.type === 'text' ? block.text : block.type
  );

it('closes the open text when a figure above it goes', async () => {
  await showEditingB();
  expect(host.querySelector('[data-editor]')).not.toBeNull();
  const remove = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${m.question_ui_remove_block()}"]`
  );
  await act(async () => remove?.click());
  expect(host.querySelector('[data-editor]')).toBeNull();
  expect(blockTexts()).toEqual(['A', 'B', 'C']);
});

it('closes the open text when a co-editor removes a block above it', async () => {
  await showEditingB();
  expect(host.querySelector('[data-editor]')).not.toBeNull();
  const [part] = current.parts;
  await act(async () =>
    setOutside({
      ...current,
      parts: [{ ...part, blocks: part.blocks.slice(1) }],
    })
  );
  // C now sits where B's editor was.
  expect(host.querySelector('[data-editor]')).toBeNull();
  expect(blockTexts()).toEqual(['table', 'B', 'C']);
});

// Epo 2026-11-23 (E2, E3): a folded Canvas part says where it answers while
// a canvas above could take it.
it("says in a folded Canvas part's line where it answers", async () => {
  const question = blankQuestion();
  const [part] = question.parts;
  const canvas = (id: string, shared: boolean) => ({
    ...part,
    answer: shared
      ? { shared: true as const, type: 'canvas' as const }
      : { type: 'canvas' as const },
    blocks: shared
      ? [text('Fill it in.')]
      : [text('Mark it.'), { type: 'canvas' as const }],
    id,
    markscheme: [{ marks: 1, text: 'Right.' }],
  });
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QuestionCardView
        answer={() => null}
        number={1}
        question={{
          ...question,
          parts: [canvas('a', true), canvas('b', false)],
          stem: [text('A cross.'), { type: 'canvas' }],
        }}
      />
    )
  );
  const canvasLabel = m.question_ui_canvas();
  expect(host.textContent).toContain(
    `${canvasLabel} · ${m.question_canvas_line_same()} · ${m.question_ui_one_mark()}`
  );
  expect(host.textContent).toContain(
    `${canvasLabel} · ${m.question_canvas_line_new()} · ${m.question_ui_one_mark()}`
  );
});

/** The tab's memory (`typeMemory.ts`), empty. */
function stubSession() {
  const session = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => session.get(key) ?? null,
    removeItem: (key: string) => session.delete(key),
    setItem: (key: string, value: string) => session.set(key, value),
  });
  return session;
}

// Epo 2026-11-23: a canvas answer kept answering in the canvas above, taken
// back with none above now, answers on a canvas of its own, the one Same
// canvas took, in its place.
it('gives a canvas answer kept for the canvas above its own canvas when none is above', async () => {
  stubSession();
  const question = blankQuestion();
  const open = {
    ...question.parts[0],
    answer: { accepted: [], type: 'open' as const },
    blocks: [text('Draw its height.')],
    marks: 2,
    markscheme: [{ marks: 2, text: 'A right angle.' }],
  };
  const drawn = { board: 'b', image: 'i', type: 'canvas' as const };
  keepAnswer('qz_1', { ...open, answer: { shared: true, type: 'canvas' } });
  keepCanvas('qz_1', open.id, { block: drawn, index: 0 });
  root = createRoot(host);
  await act(async () =>
    root.render(<Card quizId="qz_1" start={{ ...question, parts: [open] }} />)
  );
  await act(async () => typeSelect.pick('canvas'));
  expect(current.parts[0].answer).toEqual({ type: 'canvas' });
  expect(current.parts[0].blocks).toEqual([drawn, text('Draw its height.')]);
});

// Epo 2026-11-23: Add part keeps the lone part's answer for the tab once its
// write goes, not for a write a live quiz turned down.
it("keeps a lone part's answer once Add part's write goes", async () => {
  const session = stubSession();
  const question = blankQuestion();
  const start = { ...question, parts: [{ ...question.parts[0], marks: 3 }] };
  const addPart = () =>
    [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.question_ui_add_part()
    );
  root = createRoot(host);
  await act(async () =>
    root.render(<Card quizId="qz_1" refuse start={start} />)
  );
  await act(async () => addPart()?.click());
  expect(session.size).toBe(0);
  await act(async () => root.render(<Card quizId="qz_1" start={start} />));
  await act(async () => addPart()?.click());
  expect(current.parts).toHaveLength(2);
  expect(keptPart('qz_1', question.id, current.parts[0].id)).toMatchObject({
    marks: 3,
  });
});

// Epo 2026-11-24: Undo of Add part brings the lone part back with its own
// id, and what Add part kept goes, so nothing stale comes back later.
it('forgets what Add part kept once Undo brings the lone part back', async () => {
  stubSession();
  const question = blankQuestion();
  const start = { ...question, parts: [{ ...question.parts[0], marks: 3 }] };
  root = createRoot(host);
  await act(async () => root.render(<Card quizId="qz_1" start={start} />));
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === m.question_ui_add_part())
      ?.click()
  );
  const [made] = current.parts;
  await act(async () => setOutside(start));
  expect(keptPart('qz_1', question.id, made.id)).toBeNull();
});

/** Parts (a), (b) and (c) under a stem with a canvas (`above`): (a) answers
 * on its own canvas with a drawn sample, (c) holds a view-only canvas, and
 * without the stem's (d) holds one, so the question holds 4 canvases, its
 * cap; (b) holds none. */
function atCanvasCap(above: boolean): Question {
  const question = blankQuestion();
  const [first] = question.parts;
  const empty = { type: 'canvas' as const };
  const markscheme = [{ marks: 1, text: 'Right.' }];
  const part = (id: string, fields: Partial<QuestionPart>): QuestionPart => ({
    ...first,
    id,
    markscheme,
    ...fields,
  });
  return {
    ...question,
    parts: [
      part('a', {
        answer: { sample: { board: 's', image: 't' }, type: 'canvas' },
        blocks: [text('Draw it.'), empty],
      }),
      part('b', {
        answer: { accepted: [], type: 'open' },
        blocks: [text('Shade it.')],
      }),
      part('c', {
        answer: { accepted: [], type: 'open' },
        blocks: [text('Name it.'), empty],
      }),
      ...(above
        ? []
        : [
            part('d', {
              answer: { accepted: [], type: 'open' },
              blocks: [text('Label it.'), empty],
            }),
          ]),
    ],
    stem: above ? [text('A cross.'), empty] : [text('A cross.')],
  };
}

// Epo 2026-11-24: at the cap a part turned into a Canvas part answers in the
// canvas above, as a canvas of its own would pass the cap, its kept drawn
// sample staying in the tab's memory; with none above Canvas is off.
it('starts a part turned into a Canvas part on Same canvas at the cap', async () => {
  stubSession();
  root = createRoot(host);
  await act(async () =>
    root.render(<Card canvases openPart="b" start={atCanvasCap(false)} />)
  );
  expect(typeSelect.canvasOff).toBe(m.question_canvas_cap({ max: 4 }));
  act(() => root.unmount());
  const start = atCanvasCap(true);
  const sample = { board: 'b2', image: 'i2' };
  const [, b] = start.parts;
  keepAnswer('qz_1', { ...b, answer: { sample, type: 'canvas' } });
  root = createRoot(host);
  await act(async () =>
    root.render(<Card openPart="b" quizId="qz_1" start={start} />)
  );
  await act(async () => typeSelect.pick('canvas'));
  expect(current.parts[1].answer).toEqual({ shared: true, type: 'canvas' });
  expect(current.parts[1].blocks).toEqual(b.blocks);
  expect(heldSample('qz_1', 'b')).toEqual(sample);
  expect(keptAnswer('qz_1', 'b', 'open')?.answer).toEqual(b.answer);
});

/** A lone Long answer part, as the type switch tests start it. */
function loneOpen(): Question {
  const question = blankQuestion();
  return {
    ...question,
    parts: [
      {
        ...question.parts[0],
        answer: { accepted: [], type: 'open' },
        blocks: [text('Draw its height.')],
        markscheme: [{ marks: 1, text: 'A right angle.' }],
      },
    ],
  };
}

// Epo 2026-11-24: the tab's memory changes only once the write lands, so a
// switch to Canvas a live quiz turns down keeps the canvas Same took and the
// held sample.
it("keeps the tab's memory when a switch to Canvas doesn't go", async () => {
  stubSession();
  const start = loneOpen();
  const [open] = start.parts;
  const canvas = {
    block: { board: 'b', image: 'i', type: 'canvas' as const },
    index: 1,
  };
  const sample = { board: 's', image: 't' };
  keepAnswer('qz_1', { ...open, answer: { shared: true, type: 'canvas' } });
  keepCanvas('qz_1', open.id, canvas);
  holdSample('qz_1', open.id, sample);
  root = createRoot(host);
  await act(async () =>
    root.render(<Card quizId="qz_1" refuse start={start} />)
  );
  await act(async () => typeSelect.pick('canvas'));
  expect(keptCanvas('qz_1', open.id)).toEqual(canvas);
  expect(heldSample('qz_1', open.id)).toEqual(sample);
  expect(keptAnswer('qz_1', open.id, 'open')).toBeNull();
});

// Epo 2026-11-24: a held sample goes once the part's sample comes back, so a
// later switch can't put an older one back.
it('forgets a held sample once a newer one comes back', async () => {
  stubSession();
  const start = loneOpen();
  const [open] = start.parts;
  const newer = { board: 's2', image: 't2' };
  keepAnswer('qz_1', {
    ...open,
    answer: { sample: newer, type: 'canvas' },
  });
  holdSample('qz_1', open.id, { board: 's1', image: 't1' });
  root = createRoot(host);
  await act(async () => root.render(<Card quizId="qz_1" start={start} />));
  await act(async () => typeSelect.pick('canvas'));
  expect(current.parts[0].answer).toEqual({ sample: newer, type: 'canvas' });
  expect(heldSample('qz_1', open.id)).toBeNull();
});

// Epo 2026-11-24: a stem's canvas that parts answer in keeps its Remove,
// disabled, naming them.
it('disables Remove on a canvas parts answer in, naming them', async () => {
  const question = blankQuestion();
  const [first] = question.parts;
  const shared = (id: string): QuestionPart => ({
    ...first,
    answer: { shared: true, type: 'canvas' },
    id,
    markscheme: [{ marks: 1, text: 'Right.' }],
  });
  root = createRoot(host);
  await act(async () =>
    root.render(
      <Card
        canvases
        start={{
          ...question,
          parts: [shared('a'), shared('b')],
          stem: [text('A cross.'), { type: 'canvas' }],
        }}
      />
    )
  );
  const remove = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${m.question_canvas_answered_parts({ parts: '(a) and (b)' })}"]`
  );
  expect(remove?.disabled).toBe(true);
});
