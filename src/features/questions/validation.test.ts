import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exampleQuestion } from './questionFixtures';
import {
  type QuestionPolicy,
  questionBlockSchema,
  validateQuestion,
  validateQuestions,
} from './validation';

const directory = new URL(
  '../../../server/internal/questions/testdata/',
  import.meta.url
);
describe('shared Go, collaboration and browser question fixtures', () => {
  for (const name of readdirSync(directory).filter((name) =>
    name.endsWith('.json')
  )) {
    const fixture = JSON.parse(
      readFileSync(new URL(name, directory), 'utf8')
    ) as { valid: boolean; question: unknown; policy: QuestionPolicy };
    it(name, () => {
      if (fixture.valid)
        expect(() =>
          validateQuestion(fixture.question, fixture.policy)
        ).not.toThrow();
      else
        expect(() =>
          validateQuestion(fixture.question, fixture.policy)
        ).toThrow();
    });
  }
  it('rejects duplicate part identities across different questions', () => {
    const one = exampleQuestion('one');
    const two = exampleQuestion('two');
    two.parts[0].id = one.parts[0].id;
    expect(() => validateQuestions([one, two])).toThrow('Part IDs');
  });
});

// Plot bounds mirror TestPlotBlockBoundsAndGradingText in Go; they join the
// shared fixtures once the collaboration validator knows plots.
describe('plot blocks', () => {
  const two = [0, 1];
  const plot = (patch: object = {}) => ({
    lines: [{ axis: 'y', label: 'threshold', value: -55 }],
    marks: [{ label: 'Na+ in', x: 1, y: 0 }],
    series: [
      {
        name: 'Vm',
        points: [
          [0, -70],
          [1.5, 30.5],
        ],
      },
    ],
    title: 'Action potential',
    type: 'plot',
    xTitle: 'Time (ms)',
    yTitle: 'Vm (mV)',
    ...patch,
  });
  const curve = (...points: unknown[]) => ({ name: 'c', points });
  it('accepts a plot with curves, reference lines and labelled points', () => {
    expect(questionBlockSchema.safeParse(plot()).success).toBe(true);
    expect(
      questionBlockSchema.safeParse(plot({ kind: 'scatter' })).success
    ).toBe(true);
  });
  it.each([
    [
      'five curves',
      { series: Array.from({ length: 5 }, () => curve(two, two)) },
    ],
    ['one point', { series: [curve(two)] }],
    ['three numbers', { series: [curve(two, [1, 2, 3])] }],
    ['text coordinate', { series: [curve(two, ['1', 2])] }],
    [
      'infinite coordinate',
      { series: [curve(two, [1, Number.POSITIVE_INFINITY])] },
    ],
    ['line axis', { lines: [{ axis: 'z', value: 1 }] }],
    ['unlabelled mark', { marks: [{ x: 1, y: 2 }] }],
    ['missing y title', { yTitle: undefined }],
    ['unknown kind', { kind: 'bar' }],
    ['unknown property', { shape: 'line' }],
  ])('refuses %s', (_, patch) => {
    expect(questionBlockSchema.safeParse(plot(patch)).success).toBe(false);
  });
});

describe('copied bank figures in a quiz', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const withFigure = (url: string) => ({
    ...exampleQuestion('q'),
    stem: [
      {
        description: 'A figure',
        height: 300,
        image: { url },
        type: 'image' as const,
        width: 400,
      },
    ],
  });

  it('accepts a link under VITE_BANK_ASSETS_URL only, like Go', () => {
    const figure = 'https://bank.example/assets/f.png';
    vi.stubEnv('VITE_BANK_ASSETS_URL', '');
    expect(() => validateQuestion(withFigure(figure))).toThrow();
    vi.stubEnv('VITE_BANK_ASSETS_URL', 'https://bank.example/assets');
    expect(() => validateQuestion(withFigure(figure))).not.toThrow();
    for (const outside of [
      'https://bank.example.evil/assets/f.png',
      'https://bank.example/assets/../private/f.png',
    ])
      expect(() => validateQuestion(withFigure(outside))).toThrow();
  });
});
