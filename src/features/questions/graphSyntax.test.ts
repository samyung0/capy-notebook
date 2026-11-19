import { describe, expect, it } from 'vitest';
import {
  buildElements,
  type GraphRow,
  markRow,
  parseRow,
  readExpression,
  readRow,
  reconcileRows,
  rowsAfterEdit,
  rowsFromElements,
  typedLine,
} from './graphSyntax';
import type { GraphElement } from './types';

describe('parseRow', () => {
  it.each([
    'y=0.5x^{2}-3',
    'f\\left(x\\right)=\\sin\\left(2x\\right)',
    'x^2',
    'x^{2}-y^{2}=0',
    'x=3',
    'y=x\\left\\lbrace 0\\le x\\le 2\\right\\rbrace',
  ])('keeps the formula row %s as typed', (latex) => {
    expect(parseRow(latex)).toEqual({ kind: 'expression', latex });
  });

  it('reads named and unnamed points, evaluating constant coordinates', () => {
    expect(parseRow('A=\\left(-2,-1\\right)')).toEqual({
      coords: [-2, -1],
      kind: 'point',
      name: 'A',
    });
    expect(parseRow('P_{1}=\\left(\\frac{1}{2},3\\right)')).toMatchObject({
      coords: [0.5, 3],
      name: 'P_1',
    });
    expect(parseRow('(3,4)')).toMatchObject({
      coords: [3, 4],
      name: undefined,
    });
    // A bracket left open at the end closes itself.
    expect(parseRow('C=(1,2')).toMatchObject({ coords: [1, 2], name: 'C' });
  });

  it('reads commands, upright as MathLive writes them or plain', () => {
    expect(parseRow('\\operatorname{segment}\\left(A,B\\right)')).toEqual({
      command: 'segment',
      kind: 'command',
      points: ['A', 'B'],
    });
    expect(parseRow('polygon(A,B,C,D)')).toMatchObject({
      points: ['A', 'B', 'C', 'D'],
    });
    expect(parseRow('circle(A, 3)')).toMatchObject({
      points: ['A'],
      radius: 3,
    });
  });

  it.each([
    ['y=2\\sin x+', 'unfinished'],
    ['y=\\frac{1}{\\placeholder{}}', 'unfinished'],
    ['y=x+k', 'undefined'],
    ['y=x_{1}', 'undefined'],
    ['segment(A)', 'points'],
    ['y<x+2', 'not yet'],
    ['circle(A, -1)', 'radius'],
    ['y=x\\left\\lbrace 0<x<y\\right\\rbrace', 'restriction'],
  ])('refuses %s', (row) => {
    expect(() => parseRow(row)).toThrow();
  });
});

describe('readExpression', () => {
  it.each([
    ['y=0.5x^{2}-3', 2, -1],
    ['f\\left(x\\right)=\\sin\\left(2x\\right)', Math.PI / 4, 1],
    ['y=2\\sin x+\\cos x', 0, 1],
    ['y=\\cos^{2}x', 0, 1],
    ['y=\\frac{x^{2}}{16}', 4, 1],
    ['y=\\sqrt{x}', 9, 3],
    ['y=\\sqrt[3]{x}', -8, -2],
    ['y=\\left|x-1\\right|', -1, 2],
    ['y=e^{-x}\\cdot\\pi', 0, Math.PI],
    ['y=2\\pi x', 1, 2 * Math.PI],
    ['y=3\\times x^{10}', 1, 3],
    ['y=\\ln x+\\exp\\left(x\\right)', 1, Math.E],
    ['y=\\log x', 100, 2],
    ['y=\\log_{2}x', 8, 3],
    ['y=\\log_2\\left(x\\right)', 8, 3],
    ['y=\\sin^{-1}x', 1, Math.PI / 2],
    ['y=\\sec x+\\csc x+\\cot x', Math.PI / 4, 2 * Math.SQRT2 + 1],
    ['y=\\sinh x+\\cosh x-\\tanh x', 0, 1],
    ['y=\\left\\lfloor x\\right\\rfloor+\\lceil x\\rceil', 1.5, 3],
    ['y=2|x|', -3, 6],
    ['y=\\left\\lbrack x+1\\right\\rbrack^{2}', 1, 4],
    ['y=x^23', 2, 12],
    ['y=x^{23}', 1, 1],
    ['y=\\arctan x', 1, Math.PI / 4],
    ['y=\\operatorname{floor}\\left(x\\right)', 1.5, 1],
    ['y=\\left(x+1\\right)\\left(x-1\\right)', 2, 3],
    ['3x+1', 1, 4],
  ])('reads %s as a function of x', (latex, x, value) => {
    const read = readExpression(latex);
    expect(read.kind).toBe('function');
    if (read.kind !== 'function') return;
    expect(read.at(x)).toBeCloseTo(value);
  });

  it('reads any other equation in x and y as an implicit curve, left less right', () => {
    const lines = readExpression('x^{2}-y^{2}=0');
    expect(lines.kind).toBe('equation');
    expect(lines.at(1, 1)).toBe(0);
    expect(lines.at(2, 1)).toBe(3);
    const circle = readExpression('x^2+y^2=4');
    expect(circle.at(0, 2)).toBe(0);
    expect(readExpression('x=3').at(3, 7)).toBe(0);
    // y on both sides is no function of x.
    expect(readExpression('y=xy+1').kind).toBe('equation');
  });

  it('reads a restriction on x', () => {
    expect(
      readExpression('y=\\sqrt{x}\\left\\lbrace 0\\le x\\le 4\\right\\rbrace')
        .domain
    ).toEqual([0, 4]);
    expect(readExpression('y=x{0<=x<=4}').domain).toEqual([0, 4]);
    // One side, as Desmos: the other bound open.
    expect(
      readExpression('y=x\\left\\lbrace x\\ge0\\right\\rbrace').domain
    ).toEqual([0, Number.POSITIVE_INFINITY]);
    expect(
      readExpression('y=x\\left\\lbrace x<3\\right\\rbrace').domain
    ).toEqual([Number.NEGATIVE_INFINITY, 3]);
    expect(
      readExpression('y=x\\left\\lbrace 2\\ge x\\right\\rbrace').domain
    ).toEqual([Number.NEGATIVE_INFINITY, 2]);
  });
});

const elements: GraphElement[] = [
  { coords: [1, 1], id: 'a', name: 'A', type: 'point' },
  { coords: [9, 1], id: 'b', name: 'B', type: 'point' },
  { coords: [5, 6], id: 'c', type: 'point' },
  { id: 's', points: ['a', 'c'], ticks: 1, type: 'segment' },
  { id: 'g', label: 'x°', points: ['b', 'a', 'c'], type: 'angle' },
  {
    dash: true,
    id: 'f',
    latex: 'y=0.5x^{2}-3\\left\\lbrace 0\\le x\\le 4\\right\\rbrace',
    type: 'expression',
  },
  { coords: [5, 0.2], id: 't', text: '8 cm', type: 'text' },
];

describe('rows and elements', () => {
  it('round-trips a saved recipe, naming an unlabelled point others use', () => {
    const rows = rowsFromElements(elements);
    expect(
      rows.map((row) =>
        row.kind === 'expression'
          ? row.latex
          : row.kind === 'label'
            ? row.text
            : row.key
      )
    ).toEqual([
      'A=\\left(1,1\\right)',
      'B=\\left(9,1\\right)',
      'P_{1}=\\left(5,6\\right)',
      '\\operatorname{segment}\\left(A,P_{1}\\right)',
      '\\operatorname{angle}\\left(B,A,P_{1}\\right)',
      'y=0.5x^{2}-3\\left\\lbrace 0\\le x\\le 4\\right\\rbrace',
      '8 cm',
    ]);
    expect(buildElements(rows)).toEqual({ elements, errors: new Map() });
  });

  it('reads back each row it writes as the element it came from', () => {
    for (const row of rowsFromElements(elements))
      if (row.kind === 'expression')
        expect(parseRow(row.latex)).toEqual(row.parsed);
  });

  it('keeps free marks, an arrow and a label size it has no row for', () => {
    const kept: GraphElement[] = [
      { coords: [0, 0], id: 'A', name: 'A', type: 'point' },
      { coords: [2, 0], id: 'B', name: 'B', type: 'point' },
      { arrow: true, id: 's', points: ['A', 'B'], type: 'segment' },
      { coords: [1, 1], id: 't', size: 24, text: 'Area', type: 'text' },
      { coords: [-1, 2], id: 'f', latex: '\\frac12', type: 'formula' },
      { center: [0, 0], id: 'e', radii: [2, 1], type: 'ellipse' },
    ];
    expect(buildElements(rowsFromElements(kept)).elements).toEqual(kept);
  });

  it('marks rows that use a missing or repeated name', () => {
    const rows: GraphRow[] = [
      {
        key: 'a',
        kind: 'expression',
        latex: '',
        parsed: parseRow('A=(0,0)'),
        style: {},
      },
      {
        key: 'b',
        kind: 'expression',
        latex: '',
        parsed: parseRow('A=(1,1)'),
        style: {},
      },
      {
        key: 's',
        kind: 'expression',
        latex: '',
        parsed: parseRow('segment(A,B)'),
        style: {},
      },
    ];
    const { elements: built, errors } = buildElements(rows);
    expect(built.map((element) => element.id)).toEqual(['a']);
    expect([...errors.keys()]).toEqual(['b', 's']);
  });

  it('keeps a hidden or custom point label apart from the row name', () => {
    const rows: GraphRow[] = [
      {
        key: 'a',
        kind: 'expression',
        latex: '',
        parsed: parseRow('A=(0,0)'),
        style: { label: '' },
      },
      {
        key: 'b',
        kind: 'expression',
        latex: '',
        parsed: parseRow('B=(1,1)'),
        style: { label: "B'" },
      },
    ];
    expect(buildElements(rows).elements).toEqual([
      { coords: [0, 0], id: 'a', type: 'point' },
      { coords: [1, 1], id: 'b', name: "B'", type: 'point' },
    ]);
  });
});

describe('reconcileRows', () => {
  const point = (id: string, x: number): GraphElement => ({
    coords: [x, 0],
    id,
    name: id.toUpperCase(),
    type: 'point',
  });
  const reconcile = (
    rows: GraphRow[],
    elements: GraphElement[],
    typing: string[] = []
  ) =>
    reconcileRows(
      rows,
      elements,
      new Map(buildElements(rows).elements.map((e) => [e.id, e])),
      (key) => typing.includes(key)
    );

  it('keeps the same rows when the elements are the ones they give', () => {
    const rows = rowsFromElements([point('a', 0), point('b', 1)]);
    expect(reconcile(rows, buildElements(rows).elements)).toBe(rows);
  });

  it('takes a co-editor’s elements and keeps a row still being typed', () => {
    const rows: GraphRow[] = [
      ...rowsFromElements([point('a', 0), point('b', 1)]),
      { key: 'typing', kind: 'expression', latex: 'segment(', style: {} },
    ];
    const [a] = rows;
    const next = reconcile(
      rows,
      [point('a', 0), point('b', 5), point('c', 2)],
      ['typing']
    );
    expect(next[0]).toBe(a);
    expect(next.map((row) => row.key)).toEqual(['a', 'b', 'typing', 'c']);
    expect(buildElements(next).elements).toEqual([
      point('a', 0),
      point('b', 5),
      point('c', 2),
    ]);
  });

  it('keeps a row typed here over a co-editor’s change to its element', () => {
    const rows = rowsFromElements([point('a', 0), point('b', 1)]);
    const typed: GraphRow[] = rows.map((row) =>
      row.key === 'b' && row.kind === 'expression'
        ? { ...row, latex: 'B=(1,', parsed: undefined }
        : row
    );
    const next = reconcile(typed, [point('a', 3), point('b', 9)], ['b']);
    expect(next[1]).toBe(typed[1]);
    expect(buildElements(next).elements).toEqual([point('a', 3)]);
  });

  it('drops a row a co-editor removed unless it is being typed', () => {
    const rows = rowsFromElements([point('a', 0), point('b', 1)]);
    expect(reconcile(rows, [point('b', 1)]).map((row) => row.key)).toEqual([
      'b',
    ]);
    expect(
      reconcile(rows, [point('b', 1)], ['a']).map((row) => row.key)
    ).toEqual(['a', 'b']);
  });
});

describe('scientific numbers', () => {
  it('write rows and labels as GeoGebra does, never with a bare e', () => {
    const [row] = rowsFromElements([
      { coords: [6.02e23, 3e-7], id: 'a', name: 'A', type: 'point' },
    ]);
    expect(row.kind === 'expression' && row.latex).toBe(
      'A=\\left(6.02\\cdot 10^{23},3\\cdot 10^{-7}\\right)'
    );
    // That row reads back to the same point.
    expect(parseRow(row.kind === 'expression' ? row.latex : '')).toEqual({
      coords: [6.02e23, 3e-7],
      kind: 'point',
      name: 'A',
    });
  });
});

describe('rows after a tool', () => {
  const typed = (key: string, latex: string): GraphRow => ({
    key,
    kind: 'expression',
    latex,
    style: {},
    ...readRow(latex),
  });
  const rows = [
    typed('A', 'A=(1,2)'),
    typed('B', 'B=(4,3)'),
    typed('s', 'segment(A,B)'),
  ];
  const { elements } = buildElements(rows);

  it('moves a named point in its row, adds a drawn mark and drops an erased one', () => {
    const line: GraphElement = {
      coords: [
        [0, 0],
        [1, 1],
      ],
      id: 'l',
      type: 'polyline',
    };
    const moved = elements.map((element) =>
      element.id === 'A' && element.type === 'point'
        ? { ...element, coords: [2, 2] as [number, number] }
        : element
    );
    const next = rowsAfterEdit(rows, elements, [...moved, line]);
    expect(next[0]).toMatchObject({ latex: 'A=\\left(2,2\\right)' });
    expect(next.slice(1, 3)).toEqual(rows.slice(1, 3));
    expect(next[3]).toEqual({ element: line, key: 'l', kind: 'mark' });
    expect(buildElements(next).elements).toEqual([...moved, line]);
    const erased = rowsAfterEdit(next, buildElements(next).elements, [
      ...moved.slice(0, 2),
    ]);
    expect(erased.map((row) => row.key)).toEqual(['A', 'B']);
  });

  it('gives a placed point a named row that a typed segment can use', () => {
    const placed: GraphElement = {
      coords: [3, -1],
      id: 'p',
      name: 'C',
      type: 'point',
    };
    const next = rowsAfterEdit(rows, elements, [...elements, placed]);
    expect(next[3]).toMatchObject({ latex: 'C=\\left(3,-1\\right)' });
    const built = buildElements([...next, typed('t', 'segment(A,C)')]);
    expect(built.elements.at(-2)).toEqual(placed);
    expect(built.elements.at(-1)).toEqual({
      id: 't',
      points: ['A', 'p'],
      type: 'segment',
    });
  });

  it("lists a free mark as the plane does, a line's two points typed in place", () => {
    const line: GraphElement = {
      coords: [
        [0, -1],
        [2.5, 1],
      ],
      id: 'l',
      type: 'polyline',
    };
    expect(markRow(line)).toEqual({ text: '(0, −1) to (2.5, 1)', typed: true });
    expect(typedLine(line, '(1, 1) to (-3, 4)')).toEqual({
      ...line,
      coords: [
        [1, 1],
        [-3, 4],
      ],
    });
    expect(typedLine(line, '(1, 1)')).toBeNull();
    expect(
      markRow({ center: [0, 0], id: 'e', radii: [1, 1], type: 'ellipse' })
    ).toEqual({ text: 'Ellipse', typed: false });
  });
});

// Epo 2026-11-18 ("never show this"): a row still being typed says nothing.
it('reads a row still being typed as no element and no issue', () => {
  expect(readRow('y=2x+')).toEqual({
    error: undefined,
    parsed: undefined,
  });
});
