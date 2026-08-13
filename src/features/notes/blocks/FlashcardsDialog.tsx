import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import {
  type FlashcardContent,
  parseFlashcardsFenceBody,
} from '@/features/materials/blocks';
import { m } from '@/i18n';
import { uid } from '@/lib/id';
import { flashcardsFenceBody } from './shared';

/** Small popup to author a ```flashcards block inline in a note. Emits the
 * fence body (YAML) via onSave. */
export function FlashcardsDialog({
  open,
  initialCode,
  onSave,
  onClose,
}: {
  open: boolean;
  initialCode?: string;
  onSave: (code: string) => void;
  onClose: () => void;
}) {
  const [cards, setCards] = useState<FlashcardContent[]>([]);

  useEffect(() => {
    if (!open) return;
    const parsed = initialCode
      ? parseFlashcardsFenceBody(initialCode).cards
      : [];
    setCards(
      parsed.length ? parsed : [{ back: '', front: '', id: uid('card') }]
    );
  }, [open, initialCode]);

  function update(i: number, patch: Partial<FlashcardContent>) {
    setCards((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function add() {
    setCards((cs) => [...cs, { back: '', front: '', id: uid('card') }]);
  }
  function remove(i: number) {
    setCards((cs) => cs.filter((_, idx) => idx !== i));
  }

  const clean = cards.filter((c) => c.front.trim() || c.back.trim());
  const canSave = clean.length > 0;

  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            {m.action_cancel()}
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => onSave(flashcardsFenceBody(clean))}
          >
            {m.action_insert()}
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={m.editor_flashcards()}
      width={620}
    >
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-auto pr-1">
        {cards.map((c, i) => (
          <div
            className="flex items-start gap-2 rounded-card border border-line p-2"
            key={c.id}
          >
            <div className="grid flex-1 grid-cols-2 gap-2">
              <Input
                onChange={(e) => update(i, { front: e.target.value })}
                placeholder={m.editor_card_front()}
                value={c.front}
              />
              <Input
                onChange={(e) => update(i, { back: e.target.value })}
                placeholder={m.editor_card_back()}
                value={c.back}
              />
            </div>
            <IconButton
              icon="trash"
              label={m.editor_remove_card()}
              onClick={() => remove(i)}
              size="sm"
              variant="ghost"
            />
          </div>
        ))}
        <Button
          className="self-start"
          onClick={add}
          size="sm"
          variant="outline"
        >
          {m.flashcards_add_card()}
        </Button>
        {!canSave && (
          <p className="t-meta text-fg-muted">{m.editor_flashcards_min()}</p>
        )}
      </div>
    </SimpleDialog>
  );
}
