import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { InputError } from '@/components/ui/Input';
import { Mermaid, mermaidFailureMessage } from '@/features/materials/Mermaid';
import { MermaidCodeEditor } from '@/features/materials/MermaidCodeEditor';
import type { MermaidFailure } from '@/features/materials/mermaidError';
import type { MermaidTheme } from '@/features/materials/mermaidThemes';
import { m } from '@/i18n';

/** Source on the left, a live preview in the block's theme on the right; the
 * line mermaid blames is marked in the source. */
export default function MermaidSourceDialog({
  source,
  theme,
  onSave,
  onClose,
}: {
  source: string;
  theme: MermaidTheme;
  onSave: (source: string) => void;
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
  // The preview keeps the last diagram that parsed; the error shows in the source.
  const [failure, setFailure] = useState<MermaidFailure | null>(null);
  return (
    <SimpleDialog
      footer={
        <>
          <Button
            onClick={onClose}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
          <Button size="lg" type="submit" variant="accent">
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
              <MermaidCodeEditor
                className="h-72 rounded-card border border-line bg-field"
                errorLine={failure?.line ?? null}
                label={m.editor_mermaid_source()}
                onChange={field.onChange}
                value={field.value}
              />
            )}
          />
          <InputError errors={[errors.source]} />
          {/* A blamed line is marked in the source instead. */}
          {failure && failure.line == null && (
            <p className="mt-1 font-semibold text-solid-error text-xs">
              {mermaidFailureMessage(failure)}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <Mermaid code={watch('source')} onError={setFailure} theme={theme} />
        </div>
      </div>
    </SimpleDialog>
  );
}
