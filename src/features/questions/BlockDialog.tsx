import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { m } from '@/i18n';
import { BlockEditor, type UploadQuestionAsset } from './BlockEditor';
import type { QuestionBlock } from './types';

export const blockLabels: Record<QuestionBlock['type'], () => string> = {
  chart: m.question_ui_chart,
  graph: m.question_ui_graph,
  image: m.question_ui_image,
  plot: m.question_ui_plot,
  table: m.question_ui_table,
  text: m.question_ui_text,
};

/**
 * A card's table, chart, graph or plot edited in its own dialog: the card
 * shows the figure, a click opens this. Edits stay here until Save, Cancel
 * leaves them, Remove takes the figure out of the question.
 */
export function BlockDialog({
  bank,
  block,
  onClose,
  onRemove,
  onSave,
  uploadAsset,
}: {
  bank: boolean;
  block: QuestionBlock;
  onClose: () => void;
  onRemove: () => void;
  onSave: (block: QuestionBlock) => void;
  uploadAsset?: UploadQuestionAsset;
}) {
  const [draft, setDraft] = useState(block);
  const [busy, setBusy] = useState(false);
  // Graph rows that cannot be drawn hold Save.
  const [invalid, setInvalid] = useState(false);
  // A graph's zoom tools and a table cell's formula tools, beside the title.
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  return (
    <SimpleDialog
      action={
        <Button
          disabled={busy || invalid}
          onClick={() => {
            onSave(draft);
            onClose();
          }}
          rounded="large"
          size="md"
          type="button"
          variant="accent"
        >
          {m.question_ui_save()}
        </Button>
      }
      footer={
        <Button
          className="mr-auto"
          onClick={() => {
            onRemove();
            onClose();
          }}
          rounded="large"
          size="md"
          type="button"
          variant="danger-light"
        >
          {m.question_ui_remove_block()}
        </Button>
      }
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
          <div className="flex items-center" ref={setTools} />
        </div>
      }
      width={1040}
    >
      <BlockEditor
        bank={bank}
        block={draft}
        onBusyChange={setBusy}
        onChange={setDraft}
        onInvalidChange={setInvalid}
        toolbarTarget={tools}
        uploadAsset={uploadAsset}
      />
    </SimpleDialog>
  );
}
