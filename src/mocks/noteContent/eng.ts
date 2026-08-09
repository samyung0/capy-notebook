import { quizNode } from '@/features/materials/document';
import {
  bullet,
  callout,
  columns,
  heading,
  hr,
  link,
  mention,
  p,
  quote,
  type SeedNote,
  text,
  toc,
  todo,
} from './helpers';

/** English Literature — close reading: quotes, marks, columns, light quiz. */
export const engNotes: SeedNote[] = [
  {
    chapterId: null,
    daysAgo: 3,
    id: 'mat_note_eng_gatsby',
    title: 'Close reading — The Great Gatsby (Ch. 1–3)',
    value: [
      heading(1, 'The Great Gatsby — early chapters'),
      toc(),
      p([
        text('Track how Fitzgerald builds '),
        text('Nick', { italic: true }),
        text(' as a narrator who claims honesty while quietly '),
        text('editing', { strikethrough: true }),
        text(
          'shaping what we see. Theme seeds: class, desire, and the green light.'
        ),
      ]),
      callout(
        [
          text('Writing move: pair a short quotation with a '),
          text('so-what', { bold: true }),
          text(' clause — never drop a quote and walk away.'),
        ],
        'info'
      ),
      heading(2, 'Passage to annotate'),
      quote(
        '“In my younger and more vulnerable years my father gave me some advice that I’ve been turning over in my mind ever since.”'
      ),
      columns(
        ['50%', '50%'],
        [
          p([
            text('Form', { bold: true, color: '#1d4ed8' }),
            text(': first-person retrospective; advice frame; soft irony.'),
          ]),
          p([
            text('Function', { bold: true, color: '#9f1239' }),
            text(': establishes Nick’s self-image and invites us to test it.'),
          ]),
        ]
      ),
      heading(2, 'Motifs to watch'),
      bullet([
        text('Green light', { highlight: true }),
        text(' — desire projected onto Daisy / the future'),
      ]),
      bullet([
        text('Eyes of T.J. Eckleburg — moral gaze / hollow advertising god'),
      ]),
      bullet([
        text('East Egg vs West Egg — '),
        text('old money', { underline: true }),
        text(' vs '),
        text('new money', { underline: true }),
      ]),
      hr(),
      heading(2, 'Style notes'),
      p([
        text(
          'Fitzgerald’s sentences often delay the verb or pile modifiers — mark where rhythm '
        ),
        text('speeds', { italic: true }),
        text(' vs '),
        text('lingers', { italic: true }),
        text('. For secondary context see '),
        link(
          'Britannica: The Great Gatsby',
          'https://www.britannica.com/topic/The-Great-Gatsby'
        ),
        text('.'),
      ]),
      p([
        text('Workshop: '),
        mention('Kate Malone'),
        text(' wants peer feedback on thesis statements by Wednesday.'),
      ]),
      heading(2, 'Thesis practice'),
      quizNode(
        {
          questions: [
            {
              correct: [2],
              explanation:
                'The strongest claims link Nick’s narrative reliability to theme, not plot summary.',
              id: 'eng_gatsby_q1',
              level: 'analysis',
              options: [
                { value: 'Gatsby is rich and throws parties.' },
                { value: 'Daisy lives in East Egg.' },
                {
                  value:
                    'Nick’s claim of honesty is undermined by selective narration that romanticizes Gatsby.',
                },
                { value: 'The novel is set in the 1920s.' },
              ],
              prompt: 'Which thesis is most analytically useful?',
              type: 'mcq',
            },
          ],
        },
        'quiz_eng_gatsby'
      ),
      heading(2, 'Reading todos'),
      todo('Finish Ch. 3 and log three motif sightings', true),
      todo('Draft a 4-sentence paragraph on Nick’s reliability'),
      todo('Bring one contested quotation to seminar'),
      callout(
        'Success: every claim points back to diction or syntax in the passage.',
        'success'
      ),
      p([
        text('Keyboard while drafting in class: '),
        text('Ctrl', { kbd: true }),
        text('+'),
        text('B', { kbd: true }),
        text(' for emphasis marks on key phrases.'),
      ]),
    ],
    workspaceId: 'ws_eng',
    workspaceName: 'English Literature',
  },
];
