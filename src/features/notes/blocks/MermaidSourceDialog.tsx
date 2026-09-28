import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { InputError } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import { Mermaid } from '@/features/materials/Mermaid';
import type { MermaidTheme } from '@/features/materials/mermaidThemes';
import { m } from '@/i18n';

/** Source on the left, a live preview in the block's theme on the right. */
export default function MermaidSourceDialog({
  source,
  theme,
  onSave,
  onRemove,
  onClose,
}: {
  source: string;
  theme: MermaidTheme;
  onSave: (source: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const {
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<{ source: string }>({
    defaultValues: { source },
    resolver: zodResolver(z.object({ source: z.string().trim().min(1) })),
  });
  // The preview keeps the last diagram that parsed; the error shows here.
  const [renderError, setRenderError] = useState<string | null>(null);
  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} type="button" variant="ghost">
            {m.action_cancel()}
          </Button>
          <Button
            onClick={() => {
              onRemove();
              onClose();
            }}
            type="button"
            variant="danger-light"
          >
            {m.question_ui_remove_block()}
          </Button>
          <Button type="submit" variant="accent">
            {m.action_save()}
          </Button>
        </>
      }
      onClose={onClose}
      onSubmit={handleSubmit(({ source: next }) => {
        onSave(next);
        onClose();
      })}
      open
      title={m.editor_diagram()}
      width={880}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col">
          <Controller
            control={control}
            name="source"
            render={({ field }) => (
              <Textarea
                {...field}
                aria-label={m.editor_mermaid_source()}
                className="min-h-72 flex-1 font-mono"
              />
            )}
          />
          <InputError errors={[errors.source]} />
          {renderError != null && (
            <p className="mt-1 whitespace-pre-wrap font-mono text-solid-error text-xs">
              {m.mermaid_failed()}
              {renderError ? `: ${renderError}` : ''}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <Mermaid
            code={watch('source')}
            onError={setRenderError}
            theme={theme}
          />
        </div>
      </div>
    </SimpleDialog>
  );
}
