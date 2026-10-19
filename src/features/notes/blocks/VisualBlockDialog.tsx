import { zodResolver } from '@hookform/resolvers/zod';
import { useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { InputError } from '@/components/ui/Input';
import { BlockEditor } from '@/features/questions/BlockEditor';
import { renderGraphSvg } from '@/features/questions/graph';
import { IssueSummary } from '@/features/questions/IssueViews';
import { blockIssues } from '@/features/questions/issues';
import {
  blockWithoutBlanks,
  type ChartBlock,
  type GraphBlock,
  type QuestionBlock,
} from '@/features/questions/types';
import { questionBlockSchema } from '@/features/questions/validation';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';

export type NoteVisualBlock = ChartBlock | GraphBlock;

const blockResolver = zodResolver(z.object({ block: questionBlockSchema }));

export default function VisualBlockDialog({
  block,
  onSave,
  onClose,
}: {
  block: NoteVisualBlock;
  onSave: (block: NoteVisualBlock) => void | Promise<void>;
  onClose: () => void;
}) {
  const exportHost = useRef<HTMLDivElement>(null);
  const [invalid, setInvalid] = useState(false);
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<{ block: QuestionBlock }>({
    defaultValues: { block: structuredClone(block) },
    // Blanks (an empty chart value, a blank description) are dropped or
    // filled on Save, as in the question dialog.
    resolver: (values, context, options) =>
      blockResolver(
        { block: blockWithoutBlanks(values.block) },
        context,
        options
      ),
  });
  // What keeps Save off, worded as in the question dialog.
  const issues = blockIssues(useWatch({ control, name: 'block' }));
  const save = handleSubmit(async ({ block: draft }) => {
    try {
      if (draft.type !== 'graph' && draft.type !== 'chart')
        throw new Error('Unsupported note block');
      if (!exportHost.current) return;
      const next =
        draft.type === 'graph'
          ? {
              ...draft,
              image: { svg: await renderGraphSvg(exportHost.current, draft) },
            }
          : draft;
      questionBlockSchema.parse(next);
      await onSave(next);
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
          disabled={isSubmitting || invalid || issues.length > 0}
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
      title={block.type === 'chart' ? m.editor_chart() : m.editor_graph()}
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
              onChange={field.onChange}
              onInvalidChange={setInvalid}
            />
          )}
        />
      </fieldset>
      {errors.root?.message && <InputError>{errors.root.message}</InputError>}
      <div
        aria-hidden
        className="pointer-events-none fixed top-0 -left-[20000px]"
        ref={exportHost}
      />
    </SimpleDialog>
  );
}
