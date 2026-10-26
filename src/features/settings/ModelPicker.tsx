import { useModels, useSetModelPrefs } from '@/api/hooks';
import type { ModelOption, ModelSlot, SetModelPrefsReq } from '@/api/types';
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
  modelRefValue,
  optionRef,
  parseModelRef,
  sameModel,
} from './llmOptions';
import { ReasoningControls } from './ReasoningControls';

export function ModelOptionLabel({ option }: { option: ModelOption }) {
  return (
    <span className="flex min-w-0 items-center gap-2 in-data-[slot=select-item]:pr-6">
      <span className="min-w-0 truncate">
        {option.modelName}
        {option.isDefault ? ` · ${m.settings_llm_default()}` : ''}
      </span>
    </span>
  );
}

const SLOT_LABEL: Record<ModelSlot, () => string> = {
  chat: () => m.settings_llm_chat(),
  editor: () => m.settings_llm_editor(),
};

const PREF_FIELD: Record<ModelSlot, keyof SetModelPrefsReq> = {
  chat: 'chatModel',
  editor: 'editorModel',
};

/** Preference picker for one slot. Changing it applies to the next request;
 * work already in flight keeps the model it ran with, and existing assistant
 * turns keep the model pinned onto them. */
export function ModelPicker({
  className,
  slot,
}: {
  className?: string;
  slot: ModelSlot;
}) {
  const { data, isPending: loading } = useModels(slot, {
    errorBoundary: false,
  });
  const { mutate } = useSetModelPrefs();
  const models = data?.models ?? [];
  const selected = models.find((option) =>
    sameModel(
      optionRef(option),
      data?.selectedModel ?? { modelSlug: '', providerSlug: '' }
    )
  );
  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col gap-1.5 sm:w-auto sm:shrink-0',
        className
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Select
          disabled={models.length === 0}
          onValueChange={(value) => {
            mutate({ [PREF_FIELD[slot]]: parseModelRef(value) });
          }}
          value={
            data?.selectedModel ? modelRefValue(data.selectedModel) : undefined
          }
        >
          <SelectTrigger
            aria-label={SLOT_LABEL[slot]()}
            className="min-w-36 flex-1 sm:w-64 sm:flex-none"
          >
            <SelectValue
              placeholder={loading ? undefined : m.model_picker_label()}
            />
          </SelectTrigger>
          <SelectContent>
            {models.map((option) => (
              <SelectItem
                key={modelRefValue(optionRef(option))}
                value={modelRefValue(optionRef(option))}
              >
                <ModelOptionLabel option={option} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {slot === 'editor' ? (
          <Select disabled value="instant">
            <SelectTrigger
              aria-label={m.settings_llm_thinking()}
              className="w-auto shrink-0 sm:w-30"
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
        ) : slot === 'chat' && loading ? (
          <Select disabled>
            <SelectTrigger
              aria-label={m.settings_llm_thinking()}
              className="w-auto shrink-0 sm:w-34"
              size="md"
            >
              <SelectValue />
            </SelectTrigger>
          </Select>
        ) : slot === 'chat' ? (
          <ReasoningControls
            onChange={(chatThinking) => mutate({ chatThinking })}
            selected={selected}
            stored={data?.selectedThinking ?? ''}
          />
        ) : null}
      </div>
    </div>
  );
}
