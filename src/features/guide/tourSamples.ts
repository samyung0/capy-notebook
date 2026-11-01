import type { ReviewAnswer, ReviewResult } from '@/api/types';
import type { FlashcardContent } from '@/features/materials/blocks';
import { m } from '@/i18n';

/* What the tour shows where the starter workspace has nothing yet (no chats,
   nothing to review, no past review): display-only examples built from the
   welcome note's own cards and questions, never sent or cached. */

/** The result page's id for the sample: step 8 opens it when the workspace
 * has no past review, and the page shows `sampleResult` for it while the
 * tour runs, without fetching. */
export const TOUR_SAMPLE_SESSION = 'tour-sample';

export const sampleChats = () => [
  m.tour_sample_chat_summary(),
  m.tour_sample_chat_quiz(),
  m.tour_sample_chat_plan(),
];

const sampleCards = (): FlashcardContent[] => [
  {
    back: m.tour_sample_card_retrieval_back(),
    front: m.tour_sample_card_retrieval_front(),
    id: 'tour-card-1',
  },
  {
    back: m.tour_sample_card_spacing_back(),
    front: m.tour_sample_card_spacing_front(),
    id: 'tour-card-2',
  },
];

/** The review's sample: its first card of four. */
export const sampleReview = () => ({ card: sampleCards()[0], total: 4 });

const card = (c: FlashcardContent, rating: number): ReviewAnswer => ({
  back: c.back,
  front: c.front,
  itemId: c.id,
  kind: 'card',
  materialId: TOUR_SAMPLE_SESSION,
  materialTitle: m.tour_sample_note(),
  rating,
});

/** A true-or-false question worth one mark, answered right or wrong. */
const question = (
  id: string,
  text: string,
  key: boolean,
  right: boolean
): ReviewAnswer => ({
  answers: {},
  correct: right ? 1 : 0,
  itemId: id,
  kind: 'question',
  materialId: TOUR_SAMPLE_SESSION,
  materialTitle: m.tour_sample_note(),
  question: {
    id,
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: { correct: key, type: 'boolean' },
        awarded: right ? 1 : 0,
        blocks: [{ text, type: 'text' }],
        id: `${id}:part:1`,
        marks: 1,
        solution: [],
      },
    ],
    stem: [],
  },
  rating: right ? 3 : 1,
  total: 1,
});

/** The result page's sample: the review's four items, two cards and two
 * questions, one of each gone wrong or hard. */
export function sampleResult(workspaceId: string): ReviewResult {
  const [retrieval, spacing] = sampleCards();
  return {
    better: 1,
    items: [
      card(retrieval, 3),
      question('tour-q-1', m.tour_sample_question_spacing(), true, true),
      card(spacing, 2),
      question('tour-q-2', m.tour_sample_question_rereading(), false, false),
    ],
    session: {
      answered: 4,
      chapterName: m.tour_sample_chapter(),
      group: 'chapter',
      iconId: '',
      id: TOUR_SAMPLE_SESSION,
      lastAnswerAt: '',
      startedAt: '',
      total: 4,
      workspaceId,
      workspaceName: '',
    },
  };
}
