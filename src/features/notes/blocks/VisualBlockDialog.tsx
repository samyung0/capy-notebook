import { zodResolver } from '@hookform/resolvers/zod';
import { useRef } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { InputError } from '@/components/ui/Input';
import { BlockEditor } from '@/features/questions/BlockEditor';
import { renderGraphSvg } from '@/features/questions/graph';
import type {
  ChartBlock,
  GraphBlock,
  QuestionBlock,
} from '@/features/questions/types';
import { questionBlockSchema } from '@/features/questions/validation';
import { m } from '@/i18n';

export type NoteVisualBlock = ChartBlock | GraphBlock;

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
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<{ block: QuestionBlock }>({
    defaultValues: { block: structuredClone(block) },
    resolver: zodResolver(z.object({ block: questionBlockSchema })),
  });
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
        message:
          error instanceof Error ? error.message : m.editor_embed_save_failed(),
      });
    }
  });
  return (
    <SimpleDialog
      footer={
        <>
          <Button
            disabled={isSubmitting}
            onClick={onClose}
            type="button"
            variant="ghost"
          >
            {m.action_cancel()}
          </Button>
          <Button disabled={isSubmitting} type="submit" variant="accent">
            {m.action_save()}
          </Button>
        </>
      }
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      onSubmit={save}
      open
      title={block.type === 'chart' ? m.editor_chart() : m.editor_graph()}
      width={760}
    >
      <fieldset className="min-w-0" disabled={isSubmitting}>
        <Controller
          control={control}
          name="block"
          render={({ field }) => (
            <BlockEditor block={field.value} onChange={field.onChange} />
          )}
        />
      </fieldset>
      {errors.block && <InputError>{m.editor_embed_invalid()}</InputError>}
      {errors.root?.message && <InputError>{errors.root.message}</InputError>}
      <div
        aria-hidden
        className="pointer-events-none fixed top-0 -left-[20000px]"
        ref={exportHost}
      />
    </SimpleDialog>
  );
}
