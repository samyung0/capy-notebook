import type * as Y from 'yjs';
import type { Material } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { readCards } from '@/features/flashcards/liveSet';
import { readMermaid } from '@/features/materials/liveMermaid';
import { keysScope, readQuestions } from '@/features/quizzes/liveQuiz';
import { m } from '@/i18n';

/** A live item's kind: every material kind but a note, whose drafts open
 * as the merge view's pieces. */
export type ItemKind = Exclude<Material['kind'], 'note'>;

/** What an item's drafts hold, as a file a person can read, by the item's
 * known kind: a diagram's source, a set's cards as tab-separated lines, a
 * quiz's questions (or its keys document) as JSON, a canvas's blocks as JSON
 * (its board's elements live in its surface block). Null when they hold
 * nothing to save: no empty file is made. */
export function draftFile(
  doc: Y.Doc,
  kind: ItemKind,
  document: 'keys' | undefined
): { extension: string; text: string } | null {
  switch (kind) {
    case 'canvas': {
      const blocks = doc.getMap('blocks');
      return blocks.size
        ? { extension: 'json', text: JSON.stringify(blocks.toJSON(), null, 2) }
        : null;
    }
    case 'quiz': {
      // A document drawn from rows has no root types until asked for one.
      const value =
        document === 'keys'
          ? keysScope(doc).toJSON()
          : readQuestions(doc, null);
      return Object.keys(value).length
        ? { extension: 'json', text: JSON.stringify(value, null, 2) }
        : null;
    }
    case 'diagram':
    case 'mindmap': {
      const source = readMermaid(doc)?.source.toString();
      return source ? { extension: 'mmd', text: source } : null;
    }
    case 'flashcards': {
      const cards = readCards(doc);
      return cards.length
        ? {
            extension: 'tsv',
            text: cards.map((card) => `${card.front}\t${card.back}`).join('\n'),
          }
        : null;
    }
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * An item's edits past the 7-day expiry (Epo 2026-11-04, D14): the item opens as
 * usual, and a toast offers them until it is dismissed, at any open rather than
 * only the one that happened to meet them. They go when it closes, so a tab closed
 * first shows it again at the next open.
 */
export function offerExpiredDrafts({
  doc,
  document: which,
  kind,
  materialId,
  onGone,
  title,
}: {
  doc: Y.Doc;
  document: 'keys' | undefined;
  kind: ItemKind;
  materialId: string;
  /** The toast closed: the rows go. */
  onGone: () => void;
  /** The file's name, read when it is downloaded. */
  title: () => string;
}) {
  // A file that could not be made keeps them, for the next open's toast.
  let failed = false;
  userToast({
    button: {
      label: m.editor_old_edits_download(),
      onClick: () => {
        const made = draftFile(doc, kind, which);
        if (!made) {
          failed = true;
          userToast({
            title: m.lost_edits_download_failed(),
            variant: 'error',
          });
          return;
        }
        download(
          `${title()} (${m.editor_old_edits_file()}).${made.extension}`,
          made.text
        );
      },
    },
    description: m.editor_old_edits_body(),
    id: `expired-drafts-${materialId}-${which ?? 'content'}`,
    onClose: () => {
      if (!failed) onGone();
      doc.destroy();
    },
    title: m.editor_old_edits_title(),
    variant: 'error',
  });
}
