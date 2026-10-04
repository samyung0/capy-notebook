import { describe, expect, it } from 'vitest';
import { convertAgentMarkdown, markdownToDocument } from './markdownConvert';

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

describe('markdownToDocument', () => {
  it('turns agent markdown into the editor nodes a paste would give', () => {
    const { value } = markdownToDocument(
      [
        '# Tangents',
        'A **tangent** meets the [radius](javascript:alert(1)) at a right angle.',
        '- one point of contact',
        '| You see | Reason |\n| --- | --- |\n| 90° | tangent ⊥ radius |',
        fence('mermaid', 'flowchart LR\n  A --> B'),
        fence('quiz', 'questions: []'),
        fence('flashcards', 'cards:\n  - {front: Tangent, back: One point}'),
      ].join('\n\n')
    );
    expect(value.map((node) => node.type)).toEqual([
      'h1',
      'p',
      'p',
      'table',
      'mermaid',
      'material_ref',
      'material_ref',
    ]);
    const link = (value[1].children as { type?: string; url?: string }[]).find(
      (child) => child.type === 'a'
    );
    expect(link?.url).toBe('');
    expect(value[2]).toMatchObject({ listStyleType: 'disc' });
    expect(value[5]).toMatchObject({
      pending: 'questions: []',
      refKind: 'quiz',
    });
    expect(value[6]).toMatchObject({ refKind: 'flashcards' });
  });

  it('returns a draft per quiz or flashcards fence and refuses a broken one', () => {
    const { embedded } = convertAgentMarkdown(
      [
        fence('quiz', 'questions:\n  - {id: q1}'),
        '> Recap',
        fence('flashcards', 'cards:\n  - {front: A, back: B}'),
      ].join('\n\n')
    );
    expect(embedded).toEqual([
      { kind: 'quiz', questions: [{ id: 'q1' }] },
      { cards: [{ back: 'B', front: 'A' }], kind: 'flashcards' },
    ]);
    expect(() => convertAgentMarkdown(fence('quiz', 'questions: ['))).toThrow(
      'fence 1 (quiz) is not YAML'
    );
    expect(() =>
      convertAgentMarkdown(fence('flashcards', 'cards:\n  - {front: A}'))
    ).toThrow('fence 1 (flashcards) needs cards');
  });
});
