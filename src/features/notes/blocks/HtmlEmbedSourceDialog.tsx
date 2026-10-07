import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Input, InputError, InputField } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import { HTML_EMBED_MAX_BYTES, htmlBytes } from '@/features/materials/document';
import { m } from '@/i18n';

/** An interactive block's caption and snippet. Editors save changes (within the
 * 64 KB cap); without `onSave` it only shows the source. */
export default function HtmlEmbedSourceDialog({
  caption,
  html,
  onSave,
  onClose,
}: {
  caption?: string;
  html: string;
  onSave?: (next: { caption: string; html: string }) => void;
  onClose: () => void;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<{ caption: string; html: string }>({
    defaultValues: { caption: caption ?? '', html },
    resolver: zodResolver(
      z.object({
        caption: z.string().trim(),
        html: z
          .string()
          .trim()
          .min(1)
          .refine((value) => htmlBytes(value) <= HTML_EMBED_MAX_BYTES, {
            message: m.html_embed_too_large(),
          }),
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
      title={m.html_embed_source()}
      width={880}
    >
      {onSave && (
        <InputField
          error={errors.caption}
          id="html-embed-caption"
          label={m.html_embed_caption()}
        >
          <Input id="html-embed-caption" {...register('caption')} />
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
