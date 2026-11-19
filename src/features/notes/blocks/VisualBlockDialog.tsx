import { zodResolver } from '@hookform/resolvers/zod';
import type { SlateEditor } from 'platejs';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { InputError } from '@/components/ui/Input';
import { BlockDialog } from '@/features/questions/BlockDialog';
import { BlockEditor } from '@/features/questions/BlockEditor';
import { IssueSummary } from '@/features/questions/IssueViews';
import { blockIssues } from '@/features/questions/issues';
import {
  blockWithoutBlanks,
  type ChartBlock,
  type GraphBlock,
  type PlotBlock,
  type QuestionBlock,
} from '@/features/questions/types';
import { questionBlockSchema } from '@/features/questions/validation';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import { noteFigureBinding } from './noteFigureBinding';
import { rebasePlot } from './rebase';

export type NoteVisualBlock = ChartBlock | PlotBlock | GraphBlock;

/** A note's chart or graph, edited live in the quiz's figure dialog (Epo
 * 2026-11-16, D15): each change reaches the note as it is made, Done only
 * closes and Remove takes the figure out. `block` is the element's block as
 * it is now; a change from elsewhere (a peer, an Undo) reaches the dialog. */
export function LiveFigureDialog({
  block,
  editor,
  id,
  onClose,
}: {
  block: ChartBlock | GraphBlock;
  editor: SlateEditor;
  id: string;
  onClose: () => void;
}) {
  const [binding] = useState(() => noteFigureBinding(editor, id, block));
  useLayoutEffect(() => binding.receive(block), [binding, block]);
  return (
    <BlockDialog
      bank={false}
      binding={binding}
      block={block}
      onClose={onClose}
    />
  );
}

const blockResolver = zodResolver(z.object({ block: questionBlockSchema }));

/** Edits a plot as a draft saved at Save. `block` is the note's plot as it is
 * now: a peer's change while the dialog is open rebases the draft on it (Epo
 * 2026-10-17), the user's changed fields keeping the user's value; Save hands
 * over the draft with the plot it was last rebased on, so the note writes
 * only what the user changed. */
export function PlotDialog({
  block,
  onSave,
  onClose,
}: {
  block: PlotBlock;
  onSave: (block: PlotBlock, base: PlotBlock) => void | Promise<void>;
  onClose: () => void;
}) {
  const base = useRef(block);
  const {
    control,
    getValues,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<{ block: QuestionBlock }>({
    defaultValues: { block: structuredClone(block) },
    // Blanks (an empty value, a blank description) are dropped or filled on
    // Save, as in the question dialog.
    resolver: (values, context, options) =>
      blockResolver(
        { block: blockWithoutBlanks(values.block) },
        context,
        options
      ),
  });
  useEffect(() => {
    if (block === base.current) return;
    setValue(
      'block',
      rebasePlot(base.current, getValues('block') as PlotBlock, block)
    );
    base.current = block;
  }, [block, getValues, setValue]);
  // What keeps Save off, worded as in the question dialog.
  const issues = blockIssues(useWatch({ control, name: 'block' }));
  const save = handleSubmit(async ({ block: draft }) => {
    try {
      if (draft.type !== 'plot') throw new Error('Unsupported note block');
      questionBlockSchema.parse(draft);
      await onSave(draft, base.current);
      onClose();
    } catch (error) {
      setError('root', {
        message: errorCopy(error, m.editor_embed_save_failed()),
      });
    }
  });
  return (
    <SimpleDialog
      action={
        <Button
          disabled={isSubmitting || issues.length > 0}
          size="lg"
          type="submit"
          variant="accent"
        >
          {m.action_save()}
        </Button>
      }
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      onSubmit={save}
      open
      pending={isSubmitting}
      title={m.editor_plot()}
      width={1040}
    >
      <IssueSummary className="mb-4" messages={issues} />
      <fieldset className="min-w-0" disabled={isSubmitting}>
        <Controller
          control={control}
          name="block"
          render={({ field }) => (
            <BlockEditor
              block={field.value}
              editPlot
              onChange={field.onChange}
            />
          )}
        />
      </fieldset>
      {errors.root?.message && <InputError>{errors.root.message}</InputError>}
    </SimpleDialog>
  );
}
