import type * as Y from 'yjs';
import { userToast } from '@/components/ui/userToast';
import { readCards } from '@/features/flashcards/liveSet';
import { readMermaid } from '@/features/materials/liveMermaid';
import { readQuestions } from '@/features/quizzes/liveQuiz';
import { m } from '@/i18n';

/** What an item's drafts hold, as a file a person can read: a diagram's source,
 * a set's cards as tab-separated lines, a quiz's questions as JSON. */
function draftFile(doc: Y.Doc, document: 'keys' | undefined) {
  const shared = new Set(doc.share.keys());
  if (document === 'keys' || shared.has('questions'))
    return {
      extension: 'json',
      text: JSON.stringify(
        document === 'keys' ? doc.toJSON() : readQuestions(doc, null),
        null,
        2
      ),
    };
  const mermaid = shared.has('content') ? readMermaid(doc) : null;
  if (mermaid) return { extension: 'mmd', text: mermaid.source.toString() };
  return {
    extension: 'tsv',
    text: readCards(doc)
      .map((card) => `${card.front}\t${card.back}`)
      .join('\n'),
  };
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
  materialId,
  onGone,
  title,
}: {
  doc: Y.Doc;
  document: 'keys' | undefined;
  materialId: string;
  /** The toast closed: the rows go. */
  onGone: () => void;
  title: string;
}) {
  userToast({
    button: {
      label: m.editor_old_edits_download(),
      onClick: () => {
        const { extension, text } = draftFile(doc, which);
        download(`${title} (${m.editor_old_edits_file()}).${extension}`, text);
      },
    },
    description: m.editor_old_edits_body(),
    id: `expired-drafts-${materialId}-${which ?? 'content'}`,
    onClose: () => {
      onGone();
      doc.destroy();
    },
    title: m.editor_old_edits_title(),
    variant: 'error',
  });
}
