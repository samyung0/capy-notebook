import { useMemo } from 'react';
import { parseFlashcardsFenceBody } from './blocks';

/** Read-only renderer for a ```flashcards fenced block (YAML payload). */
export function FlashcardsBlock({ body }: { body: string }) {
  const { cards } = useMemo(() => parseFlashcardsFenceBody(body), [body]);

  if (!cards.length) {
    return (
      <pre className="my-3 overflow-auto rounded-card border border-line bg-surface-hover-bg p-3 text-xs">
        <code className="font-mono text-fg-muted">Empty flashcards block</code>
      </pre>
    );
  }

  return (
    <div className="my-4 flex flex-col gap-2">
      {cards.map((c) => (
        <div
          className="grid grid-cols-2 gap-3 rounded-card border border-line bg-surface p-3 text-sm"
          key={c.id}
        >
          <span className="font-medium text-fg">{c.front}</span>
          <span className="text-fg-secondary">{c.back}</span>
        </div>
      ))}
    </div>
  );
}
