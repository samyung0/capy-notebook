import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Question } from '@/api/types';
import {
  createMaterialDocument,
  flashcardsNode,
  type MaterialValue,
  mermaidNode,
  quizNode,
} from './document';
import { MaterialPreview } from './MaterialPreview';

function renderMaterial(value: MaterialValue): string {
  return renderToStaticMarkup(
    <MaterialPreview content={createMaterialDocument(value)} />
  );
}

describe('static study-block renderers', () => {
  it('renders task lists with read-only checked state', () => {
    const html = renderMaterial([
      {
        checked: true,
        children: [{ text: 'Completed task' }],
        indent: 1,
        listStyleType: 'todo',
        type: 'p',
      },
    ]);

    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain('line-through');
    expect(html).toContain('Completed task');
  });

  it('omits unsafe link URLs from static previews', () => {
    const html = renderMaterial([
      {
        children: [
          {
            children: [{ text: 'Unsafe link' }],
            type: 'a',
            url: 'javascript:alert(1)',
          },
        ],
        type: 'p',
      },
    ]);

    expect(html).toContain('Unsafe link');
    expect(html).not.toContain('href="javascript:');
  });

  it('renders persisted font style marks in material previews', () => {
    const html = renderMaterial([
      {
        children: [
          {
            backgroundColor: '#fef9c3',
            color: '#dc2626',
            fontSize: '24px',
            text: 'Styled text',
          },
        ],
        type: 'p',
      },
    ]);

    expect(html).toContain('font-size:24px');
    expect(html).toContain('color:#dc2626');
    expect(html).toContain('background-color:#fef9c3');
    expect(html).toContain('Styled text');
  });

  it('labels Mermaid mindmaps separately from diagrams', () => {
    const html = renderMaterial([
      mermaidNode('mindmap\n  root((Topic))', 'Topic map', 'mindmap'),
    ]);

    expect(html).toContain('>Mindmap</span>');
    expect(html).toContain('Topic map');
  });

  it('renders semantic callout variants and code language labels in previews', () => {
    const html = renderMaterial([
      {
        children: [{ children: [{ text: 'Check this first' }], type: 'p' }],
        type: 'callout',
        variant: 'warning',
      },
      {
        children: [
          { children: [{ text: 'const ready = true;' }], type: 'code_line' },
        ],
        lang: 'typescript',
        type: 'code_block',
      },
    ]);

    expect(html).toContain('data-slate-variant="warning"');
    expect(html).toContain('border-solid-warning');
    expect(html).toContain('Check this first');
    expect(html).toContain('TypeScript');
    expect(html).toContain('const');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain(' ready = ');
    expect(html).toContain('true');
  });

  it('does not render code blocks with persisted list metadata as list items', () => {
    const html = renderMaterial([
      {
        children: [
          { children: [{ text: 'const ready = true;' }], type: 'code_line' },
        ],
        indent: 1,
        listStyleType: 'disc',
        type: 'code_block',
      },
    ]);

    expect(html).not.toContain('role="listitem"');
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('<ol');
    expect(html).toContain('const ready');
  });

  it('preserves persisted column ratios in previews', () => {
    const html = renderMaterial([
      {
        children: [
          {
            children: [{ children: [{ text: 'Wide' }], type: 'p' }],
            type: 'column',
            width: '66.667%',
          },
          {
            children: [{ children: [{ text: 'Narrow' }], type: 'p' }],
            type: 'column',
            width: '33.333%',
          },
        ],
        type: 'column_group',
      },
    ]);

    expect(html).toContain('--column-width:66.667%');
    expect(html).toContain('--column-width:33.333%');
    expect(html).toContain('Wide');
    expect(html).toContain('Narrow');
  });

  it('renders every quiz question shape as a read-only answer review', () => {
    const questions: Question[] = [
      {
        correct: [0],
        id: 'mcq',
        level: 'recall',
        options: [
          { explanation: 'This is why.', value: 'Correct' },
          { value: 'Distractor' },
        ],
        prompt: 'Pick one',
        type: 'mcq',
      },
      {
        correct: [0, 1],
        id: 'multi',
        level: 'application',
        options: [{ value: 'First' }, { value: 'Second' }],
        prompt: 'Pick several',
        type: 'multi',
      },
      {
        correct: true,
        id: 'boolean',
        level: 'recall',
        prompt: 'True or false?',
        type: 'boolean',
      },
      {
        accepted: [{ value: 'Accepted answer' }],
        id: 'short',
        level: 'application',
        prompt: 'Fill this',
        type: 'short',
      },
      {
        id: 'ordering',
        items: [{ value: 'First item' }, { value: 'Second item' }],
        level: 'application',
        prompt: 'Put these in order',
        type: 'ordering',
      },
      {
        explanation: 'Pairs are shown in their correct arrangement.',
        id: 'matching',
        level: 'analysis',
        pairs: [{ left: 'Left', right: 'Right' }],
        prompt: 'Match these',
        type: 'matching',
      },
      {
        accepted: [{ value: 'Cristae increase surface area.' }],
        hints: [{ value: 'ATP' }],
        id: 'open',
        level: 'application',
        prompt: 'Why is the inner membrane folded?',
        rubrics: [{ value: 'Mentions folds' }],
        type: 'open',
      },
    ];

    const html = renderMaterial([
      quizNode({ questions, timeLimitMin: 15 }, 'quiz'),
    ]);

    expect(html).toContain('1.');
    expect(html).toContain('7.');
    expect(html).toContain('This is why.');
    expect(html).toContain('Accepted answer');
    expect(html).toContain('First item');
    expect(html).toContain('Left');
    expect(html).toContain('value="Right" selected=""');
    expect(html).toContain('Why is the inner membrane folded?');
    expect(html).toContain('Pairs are shown in their correct arrangement.');
    expect(html).toContain('border-solid-success');
    expect(html).toContain('cursor-default');
    expect(html).not.toContain('Time limit: 15 min');
  });

  it('renders flashcard fronts and backs as side-by-side rows', () => {
    const html = renderMaterial([
      flashcardsNode(
        [
          { back: 'Back one', front: 'Front one', id: 'card-1' },
          { back: 'Back two', front: 'Front two', id: 'card-2' },
        ],
        'deck'
      ),
    ]);

    expect(html).toContain('data-block-id="card-1"');
    expect(html).toContain('data-block-id="card-2"');
    expect(html).toContain('Front one');
    expect(html).toContain('Back two');
    expect(html).toContain('grid-cols-[minmax(0,1fr)_minmax(0,1fr)]');
  });
});
