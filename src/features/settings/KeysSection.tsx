import { useState } from 'react';
import { isApiError } from '@/api/client';
import {
  useDeleteLLMCredential,
  useLLMCredentials,
  useUpsertLLMCredential,
} from '@/api/hooks';
import type { LLMCredential } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { m } from '@/i18n';

const PROVIDERS = [
  {
    label: () => m.settings_llm_key_openai(),
    slug: 'openai',
    unlocks: () => m.settings_llm_key_openai_unlocks(),
  },
  {
    label: () => m.settings_llm_key_anthropic(),
    slug: 'anthropic',
    unlocks: () => m.settings_llm_key_anthropic_unlocks(),
  },
  {
    label: () => m.settings_llm_key_deepseek(),
    slug: 'deepseek',
    unlocks: () => m.settings_llm_key_deepseek_unlocks(),
  },
] as const;

function credentialError(error: unknown): string {
  if (isApiError(error) && error.status === 503) {
    return m.settings_llm_key_unavailable();
  }
  return m.settings_llm_key_invalid();
}

function ProviderRow({
  credential,
  label,
  slug,
  unlocks,
}: {
  credential?: LLMCredential;
  label: string;
  slug: string;
  unlocks: string;
}) {
  const [value, setValue] = useState('');
  const {
    isPending: saving,
    mutate: save,
    error: saveError,
  } = useUpsertLLMCredential();
  const { isPending: removing, mutate: remove } = useDeleteLLMCredential();

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-fg">{label}</p>
        {credential ? (
          <p className="text-fg-muted text-sm">
            {m.settings_llm_key_saved({ last4: credential.last4 })}
          </p>
        ) : null}
      </div>
      <p className="text-fg-muted text-sm">{unlocks}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Input
          aria-label={label}
          autoComplete="off"
          className="max-w-sm"
          onChange={(event) => setValue(event.target.value)}
          placeholder={m.settings_llm_key_placeholder()}
          spellCheck={false}
          type="password"
          value={value}
        />
        <Button
          disabled={saving || !value.trim()}
          onClick={() => {
            save(
              { apiKey: value.trim(), providerSlug: slug },
              { onSuccess: () => setValue('') }
            );
          }}
          size="sm"
        >
          {m.settings_llm_key_save()}
        </Button>
        {credential ? (
          <Button
            disabled={removing}
            onClick={() => remove(slug)}
            size="sm"
            variant="ghost"
          >
            {m.settings_llm_key_remove()}
          </Button>
        ) : null}
      </div>
      {saveError ? (
        <p className="text-sm text-tint-error-fg">
          {credentialError(saveError)}
        </p>
      ) : null}
    </div>
  );
}

export function KeysSection() {
  const { data, error, isError, refetch } = useLLMCredentials({
    errorBoundary: false,
  });
  const bySlug = new Map(
    (data?.credentials ?? []).map((item) => [item.providerSlug, item])
  );

  return (
    <div className="rounded-card border border-line bg-surface px-5 py-4">
      <p className="t-subtitle">{m.settings_llm_keys()}</p>
      <p className="mt-1 text-fg-secondary text-sm">
        {m.settings_llm_keys_hint()}
      </p>
      {isError ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-tint-error-fg">
            {error && isApiError(error) && error.status === 503
              ? credentialError(error)
              : m.settings_llm_keys_load_failed()}
          </p>
          <Button
            onClick={() => {
              void refetch();
            }}
            size="sm"
            variant="ghost"
          >
            {m.error_action_retry()}
          </Button>
        </div>
      ) : null}
      <div className="mt-4 flex flex-col gap-5">
        {PROVIDERS.map((provider) => (
          <ProviderRow
            credential={bySlug.get(provider.slug)}
            key={provider.slug}
            label={provider.label()}
            slug={provider.slug}
            unlocks={provider.unlocks()}
          />
        ))}
      </div>
    </div>
  );
}
