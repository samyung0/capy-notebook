import type { Thumbnail } from '@/components/app/ThumbnailPanel';
import { m } from '@/i18n';
import blankDocx from './templates/blank-docx.svg';
import blankXlsx from './templates/blank-xlsx.svg';

/** The Create tab's card thumbnails. Study materials show an example of a
 * filled one, drawn from preview data like a stored material's (Epo
 * 2026-10-25, mock T1); the Office blanks show an empty page or sheet, dimmed in dark mode like real page images. */
export const TEMPLATE_THUMBNAILS = {
  diagram: () => ({
    preview: {
      kind: 'diagram',
      source: `flowchart LR\n  A[${m.create_preview_diagram_light()}] --> B[${m.create_preview_diagram_thylakoid()}]\n  B --> C[ATP]`,
    },
  }),
  docx: () => ({ fileKind: 'doc', thumbnailUrl: blankDocx }),
  flashcards: () => ({
    preview: {
      cardCount: 3,
      first: { front: m.create_preview_card_front(), hasImage: false },
      kind: 'flashcards',
    },
  }),
  note: () => ({
    preview: {
      blocks: [
        { level: 1, t: 'h', text: m.create_preview_note_title() },
        { t: 'p', text: m.create_preview_note_text() },
        {
          items: [
            m.create_preview_note_item_1(),
            m.create_preview_note_item_2(),
          ],
          t: 'ul',
        },
      ],
      kind: 'note',
    },
  }),
  quiz: () => ({
    preview: {
      first: {
        options: [
          m.create_preview_quiz_option_1(),
          m.create_preview_quiz_option_2(),
          m.create_preview_quiz_option_3(),
        ],
        stem: m.create_preview_quiz_stem(),
        type: 'mcq',
      },
      kind: 'quiz',
      questionCount: 1,
    },
  }),
  xlsx: () => ({ fileKind: 'sheet', thumbnailUrl: blankXlsx }),
} satisfies Record<string, () => Thumbnail>;
