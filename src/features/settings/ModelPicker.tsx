import { useModels, useSetModelPrefs } from '@/api/hooks';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

function modelLabel(key: string, fallback: string): string {
  switch (key) {
    case 'deepseek-flash':
      return m.model_deepseek_flash();
    case 'deepseek-pro':
      return m.model_deepseek_pro();
    default:
      return fallback;
  }
}

function modelDescription(key: string): string {
  switch (key) {
    case 'deepseek-flash':
      return m.model_deepseek_flash_desc();
    case 'deepseek-pro':
      return m.model_deepseek_pro_desc();
    default:
      return '';
  }
}

/** Preference picker for chat / generate. Changing it does not rewrite an
 * already-pinned conversation; the next new thread picks up the new key. */
export function ModelPicker({
  className,
  surface,
}: {
  className?: string;
  surface: 'chat' | 'generate';
}) {
  const { data } = useModels(surface, { errorBoundary: false });
  const { isPending, mutate } = useSetModelPrefs();
  const models = data?.models ?? [];
  const selected = models.find((option) => option.key === data?.selectedKey);
  const selectedDescription = selected ? modelDescription(selected.key) : '';

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Select
        disabled={isPending || models.length === 0}
        onValueChange={(key) => {
          mutate(
            surface === 'chat'
              ? { chatModelKey: key }
              : { generateModelKey: key }
          );
        }}
        value={data?.selectedKey || undefined}
      >
        <SelectTrigger
          aria-label={
            surface === 'chat'
              ? m.settings_llm_chat()
              : m.settings_llm_generate()
          }
          className="w-full max-w-sm"
        >
          <SelectValue placeholder={m.model_picker_label()} />
        </SelectTrigger>
        <SelectContent>
          {models.map((option) => (
            <SelectItem
              key={option.key}
              title={modelDescription(option.key) || undefined}
              value={option.key}
            >
              {modelLabel(option.key, option.displayName)}
              {option.isDefault ? ` · ${m.settings_llm_default()}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selectedDescription ? (
        <p className="text-fg-muted text-sm">{selectedDescription}</p>
      ) : null}
    </div>
  );
}
