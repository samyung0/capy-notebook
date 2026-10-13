import { describe, expect, it } from 'vitest';
import {
  buildElements,
  type GraphRow,
  parseRow,
  rowsFromElements,
  runtimeTerm,
} from './graphSyntax';
import type { GraphElement } from './types';
import { validGraphTerm } from './validation';

describe('parseRow', () => {
  it.each([
    ['y=0.5x^2-3', '0.5*x^2-3'],
    ['f(x)=sin (2x)', 'sin(2*x)'],
    ['y=2sin x+cos x', '2*sin(x)+cos(x)'],
    ['y=cos ^2x', 'cos(x)^2'],
    ['y=(x^2)/(16)', 'x^2/16'],
    ['y=e^(-x) * pi', 'e^(-x)*pi'],
    ['y=|x-1|', 'abs(x-1)'],
    ['y=x-(x-1)', 'x-(x-1)'],
    ['x^2', 'x^2'],
  ])('reads %s as a function', (row, term) => {
    const parsed = parseRow(row);
    expect(parsed).toEqual({ domain: undefined, kind: 'function', term });
    expect(validGraphTerm(term)).toBe(true);
  });

  it('reads a restriction as the domain', () => {
    expect(parseRow('y=sqrt(x){0<=x<=4}')).toEqual({
      domain: [0, 4],
      kind: 'function',
      term: 'sqrt(x)',
    });
  });

  it('reads named and unnamed points, evaluating constant coordinates', () => {
    expect(parseRow('A=(-2,-1)')).toEqual({
      coords: [-2, -1],
      kind: 'point',
      name: 'A',
    });
    expect(parseRow('P_1=(1/2, 3)')).toMatchObject({
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

  it('reads commands, including MathLive spelling names letter by letter', () => {
    expect(parseRow('s e g m e n t (A,B)')).toEqual({
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
    ['y=2sin x+', 'unfinished'],
    ['y=x+k', 'undefined'],
    ['segment(A)', 'points'],
    ['y<x+2', 'not yet'],
    ['x=2', 'not yet'],
    ['circle(A, -1)', 'radius'],
    ['y=x{x>0}', 'restriction'],
  ])('refuses %s', (row) => {
    expect(() => parseRow(row)).toThrow();
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
    domain: [0, 4],
    id: 'f',
    term: '0.5*x^2-3',
    type: 'functiongraph',
  },
  { coords: [5, 0.2], id: 't', text: '8 cm', type: 'text' },
];

describe('rows and elements', () => {
  it('round-trips a saved recipe, naming an unlabelled point others use', () => {
    const rows = rowsFromElements(elements);
    expect(
      rows.map((row) => (row.kind === 'expression' ? row.latex : row.text))
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

it('spells constants the way JessieCode defines them at draw time', () => {
  expect(runtimeTerm('2*pi*x+e')).toBe('2*PI*x+EULER');
  expect(runtimeTerm('2x')).toBe('2*x');
});
