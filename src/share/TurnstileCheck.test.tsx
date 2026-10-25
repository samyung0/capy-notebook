import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { AnonymousEmbed, AnonymousQuiz } from '@/api/types';
import { m } from '@/i18n';
import { PublicQuizEmbed } from './PublicQuizEmbed';
import { SharedQuiz } from './SharedQuiz';

/* A shared quiz's and an embedded quiz's Turnstile slot sit under their
   Submit, with the hint hidden until Cloudflare shows a challenge (Q372). */

const questions = [
  {
    id: 'q1',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: { type: 'boolean' },
        blocks: [{ text: 'True?', type: 'text' }],
        id: 'q1:part:1',
        marks: 1,
      },
    ],
    stem: [],
  },
] as AnonymousQuiz['questions'];

const CHECK =
  /<div data-turnstile-check="true"><p class="[^"]*" hidden="">[^<]*<\/p><div><\/div><\/div>/;

it('puts the slot under Submit, its hint hidden, on both quiz pages', () => {
  const pages = [
    renderToStaticMarkup(
      <SharedQuiz
        quiz={
          {
            author: { name: 'Mia' },
            id: 'qz_1',
            name: 'Cells',
            questions,
            updatedAt: '2026-10-25T00:00:00Z',
          } as AnonymousQuiz
        }
        token="qz_1.sig"
      />
    ),
    renderToStaticMarkup(
      <PublicQuizEmbed
        embed={{ id: 'qz_2', kind: 'quiz', questions } as AnonymousEmbed}
        token="note.sig"
      />
    ),
  ];
  for (const html of pages) {
    const submit = html.indexOf(`>${m.quiz_submit()}</button>`);
    const check = html.search(CHECK);
    expect(submit).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(submit);
  }
});
