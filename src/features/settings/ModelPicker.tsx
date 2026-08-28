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
import {
  joinModelLabel,
  modelRefValue,
  optionRef,
  parseModelRef,
  sameModel,
  sortModelOptions,
} from './llmOptions';
import { ReasoningControls } from './ReasoningControls';

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
        {joinModelLabel(option.providerName, option.modelName)}
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
  chat: 'chatModel',
  editor: 'editorModel',
  generate: 'generateModel',
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
  const selected = models.find((option) =>
    sameModel(
      optionRef(option),
      data?.selectedModel ?? { modelSlug: '', providerSlug: '' }
    )
  );
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <Select
          disabled={isPending || models.length === 0}
          onValueChange={(value) => {
            mutate({ [PREF_FIELD[surface]]: parseModelRef(value) });
          }}
          value={
            data?.selectedModel ? modelRefValue(data.selectedModel) : undefined
          }
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
                key={modelRefValue(optionRef(option))}
                title={
                  option.available
                    ? undefined
                    : m.settings_llm_locked({
                        provider: providerLabel(option.providerSlug),
                      })
                }
                value={modelRefValue(optionRef(option))}
              >
                <ModelOptionLabel option={option} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {surface === 'editor' ? (
          <Select disabled value="instant">
            <SelectTrigger
              aria-label={m.settings_llm_thinking()}
              className="w-30"
              size="md"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="instant">
                {m.settings_llm_thinking_instant()}
              </SelectItem>
            </SelectContent>
          </Select>
        ) : surface === 'chat' || surface === 'generate' ? (
          <ReasoningControls
            selected={selected}
            stored={data?.selectedThinking ?? ''}
            surface={surface}
          />
        ) : null}
      </div>
      {selected?.usesUserKey ? (
        <p className="text-fg-muted text-sm">
          {m.settings_llm_byok_disclaimer()}
        </p>
      ) : null}
    </div>
  );
}
