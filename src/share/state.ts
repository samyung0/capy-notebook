import type {
  AnonymousEmbed,
  AnonymousFlashcards,
  AnonymousQuiz,
} from '@/api/types';

/* What a server-rendered share page hands its script, in
   `<script id="share-state">`: the data the page was rendered from, so the
   browser hydrates without fetching it again. A note sends only its embeds,
   the one part of it that becomes React again. */

export type ShareKind = 'quizzes' | 'flashcards' | 'notes';

export type ShareState =
  | { kind: 'quizzes'; quiz: AnonymousQuiz; token: string }
  | { kind: 'flashcards'; set: AnonymousFlashcards; token: string }
  | { kind: 'notes'; embeds: AnonymousEmbed[]; token: string };

export const SHARE_STATE_ID = 'share-state';
