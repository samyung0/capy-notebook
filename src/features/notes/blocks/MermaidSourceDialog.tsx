import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { InputError } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import { Mermaid } from '@/features/materials/Mermaid';
import { m } from '@/i18n';

export default function MermaidSourceDialog({
  source,
  onSave,
  onClose,
}: {
  source: string;
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
  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} type="button" variant="ghost">
            {m.action_cancel()}
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
      width={760}
    >
      <Controller
        control={control}
        name="source"
        render={({ field }) => (
          <Textarea
            {...field}
            aria-label={m.editor_mermaid_source()}
            className="min-h-48 font-mono"
          />
        )}
      />
      <InputError errors={[errors.source]} />
      <Mermaid code={watch('source')} />
    </SimpleDialog>
  );
}
