const CUSTOM_SYNTAX = /```(?:quiz|flashcards)|<video|<column/;

import { describe, expect, it, vi } from 'vitest';
import {
  flashcardsNode,
  htmlEmbedNode,
  type MaterialValue,
  quizNode,
} from '@/features/materials/document';
import {
  exampleAnswers,
  exampleQuestion,
} from '@/features/questions/questionFixtures';
import { bioNotes } from '@/mocks/noteContent/bio';
import { embeddedSeeds } from '@/mocks/noteContent/helpers';
import { exportLabels } from './client';
import { element, flattenStudyBlocks, paragraph } from './content';
import { renderExport } from './render';

const labels = exportLabels();
const image = {
  data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  height: 1,
  width: 1,
};
const render = async (
  value: MaterialValue,
  format: 'markdown' | 'docx' = 'markdown'
) =>
  renderExport(
    flattenStudyBlocks(value, labels),
    format,
    labels,
    { asset_mock_cell_diagram: image.data },
    'https://capy.test/materials/note',
    async () => image
  );

describe('readable note exports', () => {
  it('places native Word TOCs at each outline and keeps real headings separate from answer labels', async () => {
    const value = [
      element('toc', [{ text: '' }]),
      element('h1', [{ text: 'A & B' }]),
      element('h6', [{ text: '重复标题' }]),
      element('h6', [{ text: '重复标题' }]),
      paragraph('Worked solution', { exportBold: true }),
      element('p', [element('a', [{ text: 'Jump' }], { url: '#a--b' })]),
      element('toc', [{ text: '' }]),
    ];
    const word = await render(value, 'docx');
    expect(word.content).toContain('id="_CapyToc1"');
    expect(word.content).toContain('id="_CapyToc2"');
    expect(word.content).toContain('id="_CapyKeepNext1"');
    expect(word.content).toContain('href="#_CapyHeading1"');
    expect(word.toc).toEqual([
      { anchor: '_CapyHeading1', level: 1, text: 'A & B' },
      { anchor: '_CapyHeading2', level: 6, text: '重复标题' },
      { anchor: '_CapyHeading3', level: 6, text: '重复标题' },
    ]);
    const markdown = await render(value);
    expect(markdown.content).toContain('[A & B](<#a--b>)');
    expect(markdown.content).toContain('[重复标题](<#重复标题-1>)');
    expect(markdown.content).not.toContain('_Capy');
  });
  it('exports every feature-matrix block and keeps study answers after the questions', async () => {
    const fixture = bioNotes.find(
      (note) => note.id === 'mat_note_bio_feature_matrix'
    )!;
    const value = fixture.value.map((node) =>
      node.type === 'material_ref'
        ? embeddedSeeds.find((seed) => seed.id === node.materialId)!.block
        : node
    );
    const { content } = await render(value);
    expect(content).toContain('https://www.youtube.com/watch?v=URUJD5NEXC8');
    expect(content).toContain('Animal cell: nucleus, mitochondria');
    expect(content).toContain('```mermaid');
    expect(content).toContain('Quiz answer key');
    expect(content.indexOf('Quiz answer key')).toBeGreaterThan(
      content.indexOf('Question 4')
    );
    expect(content).toContain('Card 2');
    expect(content).toContain('Back:');
    expect(content).not.toMatch(CUSTOM_SYNTAX);
    expect((await render(value, 'docx')).content).toContain('<hr/>');
  });

  it('retains all seven answer types, multiple parts, distractors, units, hints and rich solutions', async () => {
    const questions = exampleAnswers.map((answer, i) =>
      exampleQuestion(String(i), answer)
    );
    questions[0].parts.push({
      ...exampleQuestion('extra', {
        accepted: ['12', '12.0'],
        type: 'short',
        unit: 'm/s',
      }).parts[0],
      solution: [
        {
          header: true,
          rows: [
            ['Time', 'Speed'],
            ['1 s', '12 m/s'],
          ],
          type: 'table',
        },
      ],
    });
    questions[6].parts[0].answer = {
      accepted: ['Surface area'],
      hints: ['Look at the folds'],
      type: 'open',
    };
    const { content } = await render([
      quizNode({ questions }),
      flashcardsNode([
        { back: 'The square of x.', front: 'What is $x^2$?', id: 'card' },
      ]),
    ]);
    for (const expected of [
      'Unused choice',
      'Nucleus → Stores DNA',
      'Ribosome',
      '12 m/s',
      '12.0 m/s',
      'Look at the folds',
      '| Time | Speed |',
      '$x^2$',
      'The square of x.',
    ])
      expect(content).toContain(expected);
  });

  it('preserves table data and escapes code, links and literal Markdown punctuation', async () => {
    const value = [
      paragraph('A | B * literal'),
      element('code_block', [element('code_line', [{ text: '```inside' }])], {
        lang: 'txt',
      }),
      element('table', [
        element('tr', [element('th', [paragraph('A | B')])]),
        element('tr', [element('td', [paragraph('one\ntwo')])]),
        element('tr', [
          element('td', [element('p', [{ code: true, text: 'echo a | wc' }])]),
          element('td', [paragraph('Count output')]),
        ]),
      ]),
    ];
    const { content } = await render(value);
    expect(content).toContain('A \\| B \\* literal');
    expect(content).toContain('````txt\n```inside\n````');
    expect(content).toContain('| A \\| B |');
    expect(content).toContain('one<br/>two');
    expect(content).toContain('` echo a \\| wc ` | Count output');
    const nested = await render([
      paragraph('Parent', {
        indent: 1,
        listStart: 100,
        listStyleType: 'decimal',
      }),
      paragraph('Child\ncontinued', { indent: 2, listStyleType: 'decimal' }),
      paragraph('Next parent', { indent: 1, listStyleType: 'decimal' }),
    ]);
    expect(nested.content).toContain(
      '100. Parent\n\n     1. Child<br/>continued\n\n101. Next parent'
    );
    await expect(
      render([
        paragraph('before'),
        element('p', [
          element('a', [{ text: 'unsafe' }], { url: 'javascript:alert(1)' }),
        ]),
      ])
    ).rejects.toThrow('protocol');
  });

  it('renders static DOCX HTML with void dividers, blue callouts and video previews', async () => {
    const { content } = await render(
      [
        element('hr', [{ text: '' }]),
        element('blockquote', [paragraph('Quote')]),
        element('callout', [paragraph('Information')], { variant: 'info' }),
        element('video', [{ text: '' }], {
          provider: 'youtube',
          videoId: 'URUJD5NEXC8',
        }),
      ],
      'docx'
    );
    expect(content).not.toContain('Playback requires');
    expect(content).toContain('<hr/>');
    expect(content).toContain('background-color:#eff6ff');
    expect(content).toContain('border-left:3px solid #3b82f6');
    expect(content).toContain('alt="capy-video:URUJD5NEXC8"');
    expect(content).toContain('youtube.com/watch?v=URUJD5NEXC8');
  });

  it('links an interactive block back to the note without running or drawing it', async () => {
    const draw = vi.fn(async () => image);
    const value = [htmlEmbedNode('<script>alert(1)</script>', 'Tangent', 'e1')];
    const noteUrl = 'https://capy.test/workspaces/w?material=n&mode=view';
    const [markdown, word] = await Promise.all(
      (['markdown', 'docx'] as const).map((format) =>
        renderExport(value, format, labels, {}, noteUrl, draw)
      )
    );
    expect(markdown.content).toBe(
      `[Interactive snippet](<${noteUrl}&block=e1>)\n\n`
    );
    expect(word.content).toBe(
      `<p><a href="${noteUrl.replace('&', '&amp;')}&amp;block=e1">Interactive snippet</a></p>`
    );
    expect(draw).not.toHaveBeenCalled();
  });

  it('fails on unreadable study references and unsupported nodes instead of dropping them', async () => {
    await expect(
      render([element('material_ref', [{ text: '' }])])
    ).rejects.toThrow('unavailable');
    await expect(
      render([element('new_plugin', [{ text: 'content' }])])
    ).rejects.toThrow('new_plugin');
    const draw = vi.fn(async () => image);
    const value = [
      element('img', [{ text: '' }], { url: 'https://example.test/image.png' }),
      element('img', [{ text: '' }], { url: 'https://example.test/image.png' }),
    ];
    const result = await renderExport(
      value,
      'markdown',
      labels,
      {},
      'https://capy.test',
      draw
    );
    expect(draw).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.files)).toEqual(['assets/figure-1.png']);
  });
});
