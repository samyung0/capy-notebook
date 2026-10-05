import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Input, InputError, InputField } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import { HTML_EMBED_MAX_BYTES, htmlBytes } from '@/features/materials/document';
import { m } from '@/i18n';

/** An interactive block's title and snippet. Editors save changes (within the
 * 64 KB cap); without `onSave` it only shows the source. */
export default function HtmlEmbedSourceDialog({
  html,
  title,
  onSave,
  onClose,
}: {
  html: string;
  title?: string;
  onSave?: (next: { html: string; title: string }) => void;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<{ html: string; title: string }>({
    defaultValues: { html, title: title ?? '' },
    resolver: zodResolver(
      z.object({
        html: z
          .string()
          .trim()
          .min(1)
          .refine((value) => htmlBytes(value) <= HTML_EMBED_MAX_BYTES, {
            message: m.html_embed_too_large(),
          }),
        title: z.string().trim(),
      })
    ),
  });
  return (
    <SimpleDialog
      footer={
        onSave ? (
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
        ) : (
          <Button
            onClick={onClose}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_close()}
          </Button>
        )
      }
      onClose={onClose}
      onSubmit={
        onSave &&
        handleSubmit((next) => {
          onSave(next);
          onClose();
        })
      }
      open
      title={title || m.editor_export_interactive()}
      width={880}
    >
      {onSave && (
        <InputField
          error={errors.title}
          id="html-embed-title"
          label={m.common_title()}
        >
          <Input id="html-embed-title" {...register('title')} />
        </InputField>
      )}
      <Textarea
        aria-label={m.html_embed_source()}
        className="min-h-96 font-mono text-sm"
        readOnly={!onSave}
        spellCheck={false}
        {...register('html')}
      />
      <InputError errors={[errors.html]} />
    </SimpleDialog>
  );
}
