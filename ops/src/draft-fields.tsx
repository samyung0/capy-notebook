import type { Dispatch, SetStateAction } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type {
  Capability,
  DraftConfig,
  EliteLLMProvider,
  ThinkingLevel,
} from './api';

export const THINKING_LEVELS: ThinkingLevel[] = [
  'instant',
  'low',
  'mid',
  'high',
  'max',
];

type DraftNumberKey =
  | 'contextWindowTokens'
  | 'microsPerCachedInputToken'
  | 'microsPerInputToken'
  | 'microsPerOutputToken';

export function applyProvider(
  draft: DraftConfig,
  provider: EliteLLMProvider | undefined
): DraftConfig {
  if (!provider) {
    return { ...draft, providerSlug: '', thinkingLevels: [] };
  }
  const allowed = new Set(provider.thinking);
  const thinkingLevels = THINKING_LEVELS.filter(
    (level) => allowed.has(level) && draft.thinkingLevels.includes(level)
  );
  const nextLevels =
    thinkingLevels.length > 0
      ? thinkingLevels
      : provider.thinking.includes('instant')
        ? (['instant'] satisfies ThinkingLevel[])
        : [...provider.thinking];
  const defaultThinking = nextLevels.includes(
    draft.defaultThinking as ThinkingLevel
  )
    ? draft.defaultThinking
    : (nextLevels[0] ?? '');
  return {
    ...draft,
    byokEnabled: provider.byok ? draft.byokEnabled : false,
    defaultThinking,
    providerName: draft.providerName || provider.name,
    providerSlug: provider.slug,
    thinkingLevels: nextLevels,
  };
}

export function DraftFields({
  capabilities,
  draft,
  embedding,
  idPrefix,
  paramsText,
  providers,
  setDraft,
  setParamsText,
}: {
  capabilities: Capability[];
  draft: DraftConfig;
  embedding: boolean;
  idPrefix: string;
  paramsText: string;
  providers: EliteLLMProvider[];
  setDraft: Dispatch<SetStateAction<DraftConfig>>;
  setParamsText: (value: string) => void;
}) {
  const provider = providers.find((item) => item.slug === draft.providerSlug);
  const allowedThinking = provider?.thinking ?? [];

  function numberField(key: DraftNumberKey, value: string) {
    setDraft((current) => ({ ...current, [key]: Number(value) }));
  }

  function toggleCapability(capability: Capability, checked: boolean) {
    setDraft((current) => ({
      ...current,
      capabilities: checked
        ? capabilities.filter(
            (item) => item === capability || current.capabilities.includes(item)
          )
        : current.capabilities.filter((item) => item !== capability),
    }));
  }

  function toggleThinking(level: ThinkingLevel, checked: boolean) {
    setDraft((current) => {
      const thinkingLevels = checked
        ? THINKING_LEVELS.filter(
            (item) => item === level || current.thinkingLevels.includes(item)
          )
        : current.thinkingLevels.filter((item) => item !== level);
      const defaultThinking = thinkingLevels.includes(
        current.defaultThinking as ThinkingLevel
      )
        ? current.defaultThinking
        : (thinkingLevels[0] ?? '');
      return { ...current, defaultThinking, thinkingLevels };
    });
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={embedding || idPrefix === 'draft'}
          id={`${idPrefix}-provider`}
          name="providerSlug"
          onChange={(event) => {
            const next = providers.find(
              (item) => item.slug === event.currentTarget.value
            );
            setDraft((current) => applyProvider(current, next));
          }}
          required
          value={draft.providerSlug}
        >
          <option value="">Choose provider</option>
          {providers.map((item) => (
            <option key={item.slug} value={item.slug}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-provider-name`}>Provider name</Label>
        <Input
          id={`${idPrefix}-provider-name`}
          name="providerName"
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              providerName: event.currentTarget.value,
            }))
          }
          readOnly={embedding}
          required
          value={draft.providerName}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-model-name`}>Model name</Label>
        <Input
          id={`${idPrefix}-model-name`}
          name="modelName"
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              modelName: event.currentTarget.value,
            }))
          }
          readOnly={embedding}
          required
          value={draft.modelName}
        />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-model-slug`}>Model slug</Label>
        <Input
          id={`${idPrefix}-model-slug`}
          name="modelSlug"
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              modelSlug: event.currentTarget.value,
            }))
          }
          placeholder="provider-model-id"
          readOnly={embedding || idPrefix === 'draft'}
          required
          value={draft.modelSlug}
        />
        <p className="text-muted-foreground text-xs">
          Exact provider model id. DeepInfra is only valid for
          Qwen/Qwen3-Embedding-4B.
        </p>
      </div>
      <div className="space-y-2">
        <span className="font-medium text-sm">Serving</span>
        <Label
          className="flex items-center gap-2 text-sm"
          htmlFor={`${idPrefix}-platform-enabled`}
        >
          <Checkbox
            checked={draft.platformEnabled}
            disabled={embedding}
            id={`${idPrefix}-platform-enabled`}
            onCheckedChange={(checked) =>
              setDraft((current) => ({
                ...current,
                platformEnabled: checked === true,
              }))
            }
          />
          Platform
          {provider ? (
            <span className="text-muted-foreground">
              ({provider.platformEnv})
            </span>
          ) : null}
        </Label>
        <Label
          className="flex items-center gap-2 text-sm"
          htmlFor={`${idPrefix}-byok-enabled`}
        >
          <Checkbox
            checked={draft.byokEnabled}
            disabled={embedding || provider?.byok === false}
            id={`${idPrefix}-byok-enabled`}
            onCheckedChange={(checked) =>
              setDraft((current) => ({
                ...current,
                byokEnabled: checked === true,
              }))
            }
          />
          BYOK
        </Label>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-context`}>Context window tokens</Label>
        <Input
          id={`${idPrefix}-context`}
          min="0"
          name="contextWindowTokens"
          onChange={(event) =>
            numberField('contextWindowTokens', event.currentTarget.value)
          }
          readOnly={embedding}
          required
          type="number"
          value={draft.contextWindowTokens}
        />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <span className="font-medium text-sm">Capabilities</span>
        <p className="text-muted-foreground text-xs">
          What the model can do. Retrieval needs embedding, captioning needs
          vision; chat needs an agentic-loop certificate, which comes from
          model:certify and cannot be ticked here.
        </p>
        <div className="flex flex-wrap gap-3">
          {capabilities.map((capability) => (
            <Label
              className="flex items-center gap-2 text-sm"
              htmlFor={`${idPrefix}-capability-${capability}`}
              key={capability}
            >
              <Checkbox
                checked={draft.capabilities.includes(capability)}
                disabled={embedding}
                id={`${idPrefix}-capability-${capability}`}
                onCheckedChange={(checked) =>
                  toggleCapability(capability, checked === true)
                }
              />
              {capability}
            </Label>
          ))}
        </div>
      </div>
      <div className="space-y-2 sm:col-span-2">
        <span className="font-medium text-sm">Thinking levels</span>
        <div className="flex flex-wrap gap-3">
          {THINKING_LEVELS.map((level) => (
            <Label
              className="flex items-center gap-2 text-sm"
              htmlFor={`${idPrefix}-thinking-${level}`}
              key={level}
            >
              <Checkbox
                checked={draft.thinkingLevels.includes(level)}
                disabled={embedding || !allowedThinking.includes(level)}
                id={`${idPrefix}-thinking-${level}`}
                onCheckedChange={(checked) =>
                  toggleThinking(level, checked === true)
                }
              />
              {level}
            </Label>
          ))}
        </div>
        <Label htmlFor={`${idPrefix}-default-thinking`}>Default thinking</Label>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={embedding || draft.thinkingLevels.length === 0}
          id={`${idPrefix}-default-thinking`}
          name="defaultThinking"
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              defaultThinking: event.currentTarget.value,
            }))
          }
          value={draft.defaultThinking}
        >
          {draft.thinkingLevels.length === 0 ? (
            <option value="">None</option>
          ) : (
            draft.thinkingLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))
          )}
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-input-rate`}>Micros / input token</Label>
        <Input
          id={`${idPrefix}-input-rate`}
          min="0"
          name="microsPerInputToken"
          onChange={(event) =>
            numberField('microsPerInputToken', event.currentTarget.value)
          }
          readOnly={embedding}
          required
          type="number"
          value={draft.microsPerInputToken}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-cached-rate`}>
          Micros / cached input token
        </Label>
        <Input
          id={`${idPrefix}-cached-rate`}
          min="0"
          name="microsPerCachedInputToken"
          onChange={(event) =>
            numberField('microsPerCachedInputToken', event.currentTarget.value)
          }
          readOnly={embedding}
          required
          type="number"
          value={draft.microsPerCachedInputToken}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-output-rate`}>Micros / output token</Label>
        <Input
          id={`${idPrefix}-output-rate`}
          min="0"
          name="microsPerOutputToken"
          onChange={(event) =>
            numberField('microsPerOutputToken', event.currentTarget.value)
          }
          readOnly={embedding}
          required
          type="number"
          value={draft.microsPerOutputToken}
        />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-params`}>Params JSON</Label>
        <Textarea
          className="min-h-40 font-mono text-xs"
          id={`${idPrefix}-params`}
          name="params"
          onChange={(event) => setParamsText(event.currentTarget.value)}
          readOnly={embedding}
          value={paramsText}
        />
      </div>
    </div>
  );
}
