import { readFileSync } from 'node:fs';
import { createParser } from '@openuidev/lang-core';
import { describe, expect, it } from 'vitest';
import {
  chartKey,
  inspectAnswer,
  isLangAnswer,
  isProgramSyntax,
  splitAnswer,
} from './answer';
import { PROMPT_PATH, renderPrompt, renderSpec, SPEC_PATH } from './generated';
import { chatLibrary, parseAnswer } from './library';
import { composeAnswers, extractQuestions } from './questions';

describe('generated prompt and spec', () => {
  it('match the committed files (run pnpm gen:openui after changing schema.ts)', () => {
    expect(readFileSync(PROMPT_PATH, 'utf8')).toBe(renderPrompt());
    expect(readFileSync(SPEC_PATH, 'utf8')).toBe(renderSpec());
  });

  it('lists every component with passages in the position the parser reads', () => {
    const spec = JSON.parse(renderSpec()) as {
      root: string;
      components: { name: string; props: string[] }[];
    };
    expect(spec.root).toBe('Answer');
    const md = spec.components.find((c) => c.name === 'Md');
    expect(md?.props).toEqual(['text', 'passages']);
    const chart = spec.components.find((c) => c.name === 'Chart');
    // Optional presentation args come after passages, so an omitted unit
    // cannot swallow the citations.
    expect(chart?.props.slice(4)).toEqual(['passages', 'unit', 'illustrative']);
    const table = spec.components.find((c) => c.name === 'Table');
    expect(table?.props.slice(2)).toEqual(['passages', 'caption']);
  });
});

describe('local answer recovery', () => {
  it.each([
    ['root = Answer([Md("Readable"), missing])', true],
    ['root = Answer([Md("Readable", [], "second paragraph")])', true],
    ['root = Answer([Md("Readable", [], null, "", [])])', false],
    ['root = Answer([Callout("wrong", "Title", "Lost text")])', true],
    ['root = Answer([])', true],
    ['root = Answer(', true],
    ['a = Md("Recovered without a root")', false],
  ])('reports lost content in %s', (source, gap) => {
    expect(inspectAnswer(parseAnswer(source)).gap).toBe(gap);
  });

  it('distinguishes Markdown equations from broken program syntax', () => {
    expect(isProgramSyntax('E = mc² describes energy.')).toBe(false);
    expect(isProgramSyntax('root = Answer(')).toBe(true);
    expect(isProgramSyntax('a = Md("unfinished')).toBe(true);
  });

  it.each(['[10]', '[10, "bad", 30]'])(
    'rejects damaged chart measurements %s',
    (values) => {
      const result = parseAnswer(
        `root = Answer([Md("Keep this."), Chart("bar", "Scores", ["A", "B", "C"], [Series("S", ${values})], [1])])`
      );
      const inspected = inspectAnswer(result);
      expect(inspected.gap).toBe(true);
      expect(inspected.text).toBe('Keep this.');
    }
  );

  it('keeps valid chart numbers in the Markdown projection', () => {
    const result = parseAnswer(
      'root = Answer([Chart("bar", "Balance", ["before", "after"], [Series("Alice", [250, 200])], [1], "USD")])'
    );
    expect(inspectAnswer(result)).toEqual({
      gap: false,
      invalidCharts: new Set(),
      text: 'Balance\n\nbefore · after\n\nAlice\n\n250 · 200\n\nUSD',
    });
  });

  it('keeps independent charts when another statement has damaged numbers', () => {
    const result = parseAnswer(
      [
        'root = Answer([good, bad])',
        'good = Chart("bar", "Same", ["A", "B"], [Series("S", [1, 3])])',
        'bad = Chart("bar", "Same", ["A", "B"], [Series("S", [1, "bad", 3])])',
      ].join('\n')
    );
    const inspected = inspectAnswer(result);
    expect(inspected.gap).toBe(true);
    expect(inspected.text).toBe('Same\n\nA · B\n\nS\n\n1 · 3');
    expect(inspected.invalidCharts.size).toBe(1);
    const charts = result?.root?.props.children as {
      props: unknown;
      statementId: string;
    }[];
    expect(charts[0].props).toEqual(charts[1].props);
    expect(
      inspected.invalidCharts.has(
        chartKey(charts[0].props, charts[0].statementId)
      )
    ).toBe(false);
    expect(
      inspected.invalidCharts.has(
        chartKey(charts[1].props, charts[1].statementId)
      )
    ).toBe(true);
  });

  it('keeps a fence paired when prose surrounds the program', () => {
    const { prefix, program: source } = splitAnswer(
      'Here.\n```openui-lang\nroot = Answer([Md("Recovered.", [2])])\n```\nHope that helps.'
    );
    expect(prefix).toBe('Here.');
    expect(inspectAnswer(parseAnswer(source)).text).toBe('Recovered.');
    expect(inspectAnswer(parseAnswer(source)).gap).toBe(false);
  });
});

const program = [
  'root = Answer([intro, tabs, ask, ask2])',
  'intro = Md("Four guarantees.", [2])',
  'tabs = Tabs([t1])',
  't1 = Tab("Atomicity", [a])',
  'a = Md("All or nothing.", [1])',
  'ask = AskUser("Which one next?", ["Atomicity", "Isolation"])',
  'ask2 = AskUser("Anything to include?", [])',
].join('\n');

describe('questions', () => {
  it('tells a program from prose', () => {
    expect(isLangAnswer(program)).toBe(true);
    expect(isLangAnswer('Atomicity means [1] all or nothing.')).toBe(false);
    expect(isLangAnswer(`Here is the answer.\n\n${program}`)).toBe(true);
  });

  it('extracts the questions of a completed answer in reading order', () => {
    expect(extractQuestions(program)).toEqual([
      { choices: ['Atomicity', 'Isolation'], question: 'Which one next?' },
      { choices: [], question: 'Anything to include?' },
    ]);
    expect(extractQuestions('Plain prose')).toEqual([]);
    expect(extractQuestions(`Here are my questions.\n\n${program}`)).toEqual(
      extractQuestions(program)
    );
  });

  it('composes answered questions into one message and drops the rest', () => {
    const questions = extractQuestions(program);
    expect(
      composeAnswers(questions, [{ choice: 'Isolation', other: ' ' }, {}])
    ).toBe('Which one next?\nIsolation');
    expect(
      composeAnswers(questions, [{}, { other: 'The exam question.' }])
    ).toBe('Anything to include?\nThe exam question.');
  });

  it('parses nested arrays and keeps chart values apart from passages', () => {
    const parser = createParser(chatLibrary.toJSONSchema(), chatLibrary.root);
    const result = parser.parse(
      [
        'root = Answer([c])',
        'c = Chart("bar", "Balance", ["before", "after"], [s], [2, 3], "USD", false)',
        's = Series("sender", [2, 3])',
      ].join('\n')
    );
    const chart = (
      result.root as unknown as {
        props: { children: { props: Record<string, unknown> }[] };
      }
    ).props.children[0];
    expect(chart.props.passages).toEqual([2, 3]);
    expect(
      (chart.props.series as { props: { values: number[] } }[])[0].props.values
    ).toEqual([2, 3]);
    expect(result.meta.errors).toEqual([]);
  });
});
