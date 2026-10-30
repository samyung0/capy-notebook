import { readFileSync } from 'node:fs';
import { createParser, createStreamingParser } from '@openuidev/lang-core';
import { describe, expect, it } from 'vitest';
import quoteCases from '../../../../pipeline/tests/fixtures/openui_quote_repair.json';
import {
  chartKey,
  inspectAnswer,
  isLangAnswer,
  isProgramSyntax,
  repairQuotes,
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
    // Optional presentation args come after passages, so omitted axis titles
    // cannot swallow the citations.
    expect(chart?.props.slice(4)).toEqual([
      'passages',
      'illustrative',
      'xTitle',
      'yTitle',
    ]);
    const table = spec.components.find((c) => c.name === 'Table');
    expect(table?.props.slice(2)).toEqual(['passages', 'caption']);
    const plot = spec.components.find((c) => c.name === 'Plot');
    expect(plot?.props.slice(5)).toEqual([
      'passages',
      'illustrative',
      'lines',
      'marks',
    ]);
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
      'root = Answer([Chart("bar", "Balance (USD)", ["before", "after"], [Series("Alice", [250, 200])], [1])])'
    );
    expect(inspectAnswer(result)).toEqual({
      gap: false,
      invalidCharts: new Set(),
      text: 'Balance (USD)\n\nbefore · after\n\nAlice\n\n250 · 200',
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

  it('withholds a plot whose points the plot block refuses', () => {
    for (const curve of ['Curve("Vm", [[0, -70], [1]])', 'Curve("Vm", "x")']) {
      const inspected = inspectAnswer(
        parseAnswer(
          `root = Answer([Md("Keep this."), Plot("line", "AP", [${curve}], "t", "V", null, true)])`
        )
      );
      expect(inspected.gap).toBe(true);
      expect(inspected.text).toBe('Keep this.');
    }
  });

  it('projects a plot with its points, reference lines and marks', () => {
    const result = parseAnswer(
      'root = Answer([Plot("line", "AP", [Curve("Vm", [[0, -70], [1, 30]])], "t", "V", null, true, [RefLine("y", -55, "threshold")], [Point(0.5, 0, "peak")])])'
    );
    expect(inspectAnswer(result)).toEqual({
      gap: false,
      invalidCharts: new Set(),
      text: [
        'AP',
        'Vm: (0, -70) (1, 30)',
        't',
        'V',
        'value: -55',
        'threshold',
        'x: 0.5',
        'y: 0',
        'peak',
      ].join('\n\n'),
    });
  });

  it('projects an interactive as its title, without the html', () => {
    const result = parseAnswer(
      'root = Answer([HtmlEmbed("Slide the pH", "<input type=\\"range\\">", [2])])'
    );
    expect(inspectAnswer(result)).toEqual({
      gap: false,
      invalidCharts: new Set(),
      text: 'Slide the pH',
    });
  });

  // The pipeline's test_openui.py reads the same cases (Epo 2026-10-30, Q587).
  it.each(quoteCases.map((c) => [c.name, c] as const))(
    're-reads raw quotes like the pipeline: %s',
    (_name, c) => {
      expect(repairQuotes(c.line)).toBe(c.repaired);
    }
  );

  it('renders a repaired statement whole, with its passages', () => {
    const { program: source } = splitAnswer(
      [
        'root = Answer([bigpic, risk])',
        quoteCases[0].line,
        quoteCases[1].line,
      ].join('\n')
    );
    const inspected = inspectAnswer(parseAnswer(source));
    expect(inspected.gap).toBe(false);
    expect(inspected.text).toContain('"usually hydrogen nuclei—protons"');
    expect(inspected.text).toContain('"extremely low"');
    // The Renderer parses the text it receives with the streaming parser.
    const streamed = createStreamingParser(
      chatLibrary.toJSONSchema(),
      chatLibrary.root
    ).set(source);
    const blocks = streamed.root?.props.children as {
      props: { passages: number[]; text: string };
    }[];
    expect(blocks.map((block) => block.props.passages)).toEqual([[2], [1]]);
    expect(blocks[0].props.text).toContain('"usually hydrogen nuclei—protons"');
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
        'c = Chart("bar", "Balance (USD)", ["before", "after"], [s], [2, 3], false)',
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
