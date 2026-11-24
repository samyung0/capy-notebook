import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import * as limits from '@/api/limits.generated';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, SimpleDialog } from '@/components/ui/Dialog';
import { m } from '@/i18n';
import { BlockEditor, type UploadQuestionAsset } from './BlockEditor';
import type { FigureBinding } from './figureBinding';
import { GraphEditor } from './GraphEditor';
import type { QuestionBlock } from './types';

export const blockLabels: Record<QuestionBlock['type'], () => string> = {
  canvas: m.question_ui_canvas,
  chart: m.question_ui_chart,
  graph: m.question_ui_graph,
  image: m.question_ui_image,
  plot: m.question_ui_plot,
  table: m.question_ui_table,
  text: m.question_ui_text,
};

/** A chart or graph edited where it lives; a table (or a quiz's plot,
 * shown only) as a draft until Save. */
type Edits =
  | { binding: FigureBinding; onRemove?: never; onSave?: never }
  | {
      binding?: never;
      onRemove: () => void;
      onSave: (block: QuestionBlock) => void;
    };

/**
 * A card's table, chart, graph or plot edited in its own dialog: the card
 * shows the figure, a click opens this. A chart or graph is edited where it
 * lives (Epo 2026-11-16, D2/D3/D13): each change is written as it is made,
 * Done only closes, and the dialog closes once a co-editor removes the
 * figure. A table stays a draft here until Save, and closing leaves it.
 * Remove takes the figure out of the question.
 */
export function BlockDialog({
  bank,
  binding,
  block,
  onClose,
  onRemove,
  onSave,
  uploadAsset,
}: {
  bank: boolean;
  block: QuestionBlock;
  onClose: () => void;
  uploadAsset?: UploadQuestionAsset;
} & Edits) {
  const [draft, setDraft] = useState(block);
  const [busy, setBusy] = useState(false);
  // A table cell's formula tools, beside the title.
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(
    () =>
      binding?.subscribe(() => {
        if (!binding.read()) close.current();
      }),
    [binding]
  );
  const removeBlock = () => {
    if (binding) binding.remove();
    else onRemove();
    onClose();
  };
  // A graph fills the dialog, laid out as the canvas plane (Epo 2026-11-17):
  // its own menu and Done stand in for the title and footer.
  if (block.type === 'graph' && binding)
    return (
      <Dialog onOpenChange={(open) => !open && onClose()} open>
        <DialogContent
          aria-describedby={undefined}
          cardClassName="h-full"
          cardScrollContainerClassName="max-h-none overflow-hidden p-0 sm:p-0 max-sm:pb-0"
          className="h-[calc(100dvh-2rem)] max-h-none max-w-[min(90rem,100vw)]"
          showCloseButton={false}
        >
          <DialogPrimitive.Title className="sr-only">
            {blockLabels.graph()}
          </DialogPrimitive.Title>
          <GraphEditor
            binding={binding}
            descriptionMax={
              bank ? limits.QUESTION_TEXT_MAX : limits.QUESTION_DESCRIPTION_MAX
            }
            onDone={onClose}
            onRemove={removeBlock}
          />
        </DialogContent>
      </Dialog>
    );
  const remove = (
    <Button
      // Pulled left by its padding so its label lines up with the content, as
      // the card's borderless buttons are (Epo 2026-11-16).
      className="mr-auto -ml-5"
      onClick={removeBlock}
      rounded="large"
      size="md"
      type="button"
      variant="danger-light"
    >
      {m.question_ui_remove_block()}
    </Button>
  );
  const button = (label: string, onClick: () => void) => (
    <Button
      disabled={busy}
      onClick={onClick}
      rounded="large"
      size="md"
      type="button"
      variant="accent"
    >
      {label}
    </Button>
  );
  return (
    <SimpleDialog
      // A live figure's Done only closes: it sits in the footer, where the
      // dialog adds no Cancel (as a live card's dialog has none).
      {...(binding
        ? {
            footer: (
              <>
                {remove}
                {button(m.drawing_board_done(), onClose)}
              </>
            ),
          }
        : {
            action: button(m.question_ui_save(), () => {
              onSave(draft);
              onClose();
            }),
            footer: remove,
          })}
      onClose={onClose}
      // A table's first control is its Header row toggle: nothing takes the
      // focus, so its tooltip stays shut until it is pointed at.
      onOpenAutoFocus={(event) => {
        if (block.type === 'table') event.preventDefault();
      }}
      open
      title={
        <div className="flex items-center justify-between gap-3">
          <span>{blockLabels[block.type]()}</span>
          {/* Phones: the tools take no more height than the title's line, so
              the title stays level with the close and Save beside it. */}
          <div className="flex items-center max-sm:-my-1.5" ref={setTools} />
        </div>
      }
      width={1040}
    >
      <BlockEditor
        bank={bank}
        binding={binding}
        block={draft}
        onBusyChange={setBusy}
        onChange={setDraft}
        toolbarTarget={tools}
        uploadAsset={uploadAsset}
      />
    </SimpleDialog>
  );
}
