import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { m } from '@/i18n';
import { CopyError, errorCopy } from '@/lib/errors';
import { BlockEditor, type UploadQuestionAsset } from './BlockEditor';
import { renderGraphSvg } from './graph';
import type { QuestionBlock } from './types';

export const blockLabels: Record<QuestionBlock['type'], () => string> = {
  chart: m.question_ui_chart,
  graph: m.question_ui_graph,
  image: m.question_ui_image,
  plot: m.question_ui_plot,
  table: m.question_ui_table,
  text: m.question_ui_text,
};

/** A graph drawn to SVG off screen: a bank question uploads it (the bank
 * serves public images), a quiz keeps it inline. */
async function withGraphImage(
  block: QuestionBlock,
  bank: boolean,
  uploadAsset?: UploadQuestionAsset
): Promise<QuestionBlock> {
  if (block.type !== 'graph') return block;
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-20000px;top:0;';
  document.body.append(stage);
  let svg: string;
  try {
    svg = await renderGraphSvg(stage, block);
  } finally {
    stage.remove();
  }
  if (!bank) return { ...block, image: { svg } };
  if (!uploadAsset)
    throw new CopyError(m.question_ui_bank_image_uploads_are_unavailable());
  const asset = await uploadAsset(
    new File([svg], 'graph.svg', { type: 'image/svg+xml' })
  );
  if (!('url' in asset))
    throw new CopyError(m.question_ui_bank_image_uploads_are_unavailable());
  return { ...block, image: asset };
}

/**
 * A card's table, chart, graph or plot edited in its own dialog: the card
 * shows the figure, a click opens this. Edits stay here until Save (a graph
 * is drawn to its image then), Cancel leaves them, Remove takes the figure
 * out of the question.
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
  const [saving, setSaving] = useState(false);
  // Graph rows that cannot be drawn hold Save.
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState('');
  // A graph's zoom tools and a table cell's formula tools, beside the title.
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const save = async () => {
    setError('');
    setSaving(true);
    try {
      onSave(await withGraphImage(draft, bank, uploadAsset));
      onClose();
    } catch (failure) {
      setError(errorCopy(failure, m.question_ui_could_not_save_block()));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SimpleDialog
      action={
        <Button
          disabled={busy || saving || invalid}
          onClick={() => void save()}
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
          // Pulled left by its padding so its label lines up with the
          // content, as the card's borderless buttons are (Epo 2026-11-16).
          className="mr-auto -ml-5"
          disabled={saving}
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
      onClose={() => {
        if (!saving) onClose();
      }}
      // A table's first control is its Header row toggle: nothing takes the
      // focus, so its tooltip stays shut until it is pointed at.
      onOpenAutoFocus={(event) => {
        if (block.type === 'table') event.preventDefault();
      }}
      open
      pending={saving}
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
      {error && (
        <p className="mb-3 text-sm text-solid-error" role="alert">
          {error}
        </p>
      )}
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
