import { lazy, type ReactNode, Suspense, useContext, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import type { Answer } from '../grade';
import type { PinnedQuestion } from './DrawingBoardScreen';
import {
  DrawingDraftScope,
  type DrawingValue,
  drawingDraftKey,
  isDrawingValue,
} from './drawingValue';

// BlockSuite loads only when a board opens.
const DrawingBoardScreen = lazy(() => import('./DrawingBoardScreen'));

/**
 * A drawing part's answer area. Before drawing, one generic squared grid with
 * Draw answer (E1, Epo 2026-11-06); after Done, the drawing with Edit drawing
 * (D1); checked, the drawing under its verdict with Open drawing, which opens
 * the whole board read only (R1, R4).
 */
export function DrawingAnswer({
  disabled,
  onChange,
  partId,
  pinned,
  review,
  value,
  verdict,
}: {
  disabled: boolean;
  onChange: (value: Answer) => void;
  partId: string;
  pinned: PinnedQuestion;
  review: boolean;
  value: Answer;
  /** Checked: the part's verdict line, above the drawing. */
  verdict?: ReactNode;
}) {
  const scope = useContext(DrawingDraftScope);
  const [open, setOpen] = useState(false);
  const drawing = isDrawingValue(value) ? value : null;
  const taking = !(review || disabled);
  const close = () => setOpen(false);
  const done = (next: DrawingValue | null) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <div className="flex flex-col items-start gap-3">
      {verdict}
      {drawing ? (
        <img
          alt={m.drawing_answer_image()}
          className="h-auto max-h-[300px] w-auto max-w-full"
          src={drawing.image}
        />
      ) : review ? null : (
        // A generic grid, the same for every drawing part.
        <div className="drawing-grid relative aspect-[52/30] w-full max-w-[520px]">
          {taking && (
            <Button
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
              iconLeft="pencil"
              onClick={() => setOpen(true)}
              variant="outline"
            >
              {m.drawing_answer_draw()}
            </Button>
          )}
        </div>
      )}
      {drawing && taking && (
        <Button
          iconLeft="pencil"
          onClick={() => setOpen(true)}
          variant="outline"
        >
          {m.drawing_answer_edit()}
        </Button>
      )}
      {drawing && review && (
        <Button
          iconRight="navigationForward"
          onClick={() => setOpen(true)}
          size="sm"
          variant="outline"
        >
          {m.drawing_answer_open()}
        </Button>
      )}
      {open && (
        <Suspense fallback={null}>
          <DrawingBoardScreen
            draft={taking && scope ? drawingDraftKey(scope, partId) : undefined}
            onClose={close}
            onDone={taking ? done : undefined}
            pinned={pinned}
            readOnly={!taking}
            saved={drawing?.board}
          />
        </Suspense>
      )}
    </div>
  );
}
