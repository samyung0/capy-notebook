import { useModels, useSetModelPrefs } from '@/api/hooks';
import type { ModelOption, ModelSurface, SetModelPrefsReq } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { sortModelOptions } from './llmOptions';
import { ReasoningControls } from './ReasoningControls';

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

export function providerLabel(slug: string): string {
  switch (slug) {
    case 'anthropic':
      return m.settings_llm_key_anthropic();
    case 'deepseek':
      return m.settings_llm_key_deepseek();
    case 'openai':
      return m.settings_llm_key_openai();
    default:
      return slug;
  }
}

export function ModelOptionLabel({ option }: { option: ModelOption }) {
  return (
    <span className="flex min-w-0 items-center gap-2 pr-6">
      <span className="min-w-0 truncate">
        {modelLabel(option.key, option.displayName)}
        {option.isDefault ? ` · ${m.settings_llm_default()}` : ''}
      </span>
      {option.usesUserKey ? (
        <Icon className="size-3.5 shrink-0 text-fg-muted" name="key" />
      ) : null}
      {option.available ? null : (
        <Icon className="size-3.5 shrink-0 text-fg-muted" name="lock" />
      )}
    </span>
  );
}

type CloudSurface = Exclude<ModelSurface, 'quiz'>;

const SURFACE_LABEL: Record<CloudSurface, () => string> = {
  chat: () => m.settings_llm_chat(),
  editor: () => m.settings_llm_editor(),
  generate: () => m.settings_llm_generate(),
};

const PREF_FIELD: Record<CloudSurface, keyof SetModelPrefsReq> = {
  chat: 'chatModelKey',
  editor: 'editorModelKey',
  generate: 'generateModelKey',
};

/** Preference picker for one surface. Changing it applies to the next request;
 * work already in flight keeps the model it ran with, and existing assistant
 * turns keep the model pinned onto them. */
export function ModelPicker({
  className,
  surface,
}: {
  className?: string;
  surface: CloudSurface;
}) {
  const { data } = useModels(surface, { errorBoundary: false });
  const { isPending, mutate } = useSetModelPrefs();
  const models = sortModelOptions(data?.models ?? []);
  const selected = models.find((option) => option.key === data?.selectedKey);
  const selectedDescription = selected ? modelDescription(selected.key) : '';
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <Select
          disabled={isPending || models.length === 0}
          onValueChange={(key) => {
            mutate({ [PREF_FIELD[surface]]: key });
          }}
          value={data?.selectedKey || undefined}
        >
          <SelectTrigger
            aria-label={SURFACE_LABEL[surface]()}
            className="w-full max-w-sm"
          >
            <SelectValue placeholder={m.model_picker_label()} />
          </SelectTrigger>
          <SelectContent>
            {models.map((option) => (
              <SelectItem
                disabled={!option.available}
                key={option.key}
                title={
                  option.available
                    ? modelDescription(option.key) || undefined
                    : m.settings_llm_locked({
                        provider: providerLabel(option.providerSlug),
                      })
                }
                value={option.key}
              >
                <ModelOptionLabel option={option} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {surface === 'chat' || surface === 'generate' ? (
          <ReasoningControls
            effort={data?.selectedReasoningEffort ?? ''}
            mode={data?.selectedReasoningMode ?? ''}
            selected={selected}
            surface={surface}
          />
        ) : null}
      </div>
      {selected?.usesUserKey ? (
        <p className="text-fg-muted text-sm">
          {m.settings_llm_byok_disclaimer()}
        </p>
      ) : selectedDescription ? (
        <p className="text-fg-muted text-sm">{selectedDescription}</p>
      ) : null}
    </div>
  );
}
