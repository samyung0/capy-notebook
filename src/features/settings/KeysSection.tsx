import { useState } from 'react';
import { isApiError } from '@/api/client';
import { upsertLLMCredentialBodyApiKeyMax } from '@/api/gen/validators';
import {
  useDeleteLLMCredential,
  useLLMCredentials,
  useUpsertLLMCredential,
} from '@/api/hooks';
import type { LLMCredentialProvider } from '@/api/types';
import { Button, ErrorAction } from '@/components/ui/Button';
import { Skeleton, Spinner } from '@/components/ui/feedback';
import { Input, InputTitle } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { providerLabel } from './ModelPicker';

function credentialError(error: unknown): string {
  if (isApiError(error) && error.status === 503) {
    return m.settings_llm_key_unavailable();
  }
  return m.settings_llm_key_invalid();
}

/** Spinner over the hidden label, so the button keeps its width. */
function BusyLabel({ busy, label }: { busy: boolean; label: string }) {
  return (
    <span className="grid place-items-center *:col-start-1 *:row-start-1">
      <span className={cn(busy && 'invisible')}>{label}</span>
      {busy ? <Spinner /> : null}
    </span>
  );
}

function ProviderRow({ provider }: { provider: LLMCredentialProvider }) {
  const [value, setValue] = useState('');
  const {
    isPending: saving,
    mutate: save,
    error: saveError,
  } = useUpsertLLMCredential();
  const { isPending: removing, mutate: remove } = useDeleteLLMCredential();
  const label = providerLabel(provider.providerSlug);
  const unlocks =
    provider.unlocks.length > 0
      ? provider.unlocks.join(', ')
      : provider.reason || provider.providerSlug;

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <InputTitle>
            {m.settings_llm_key_label({ provider: label })}
          </InputTitle>
          <p className="t-meta text-fg-muted">{unlocks}</p>
        </div>
        {provider.last4 ? (
          <p className="t-meta text-fg-muted">
            {m.settings_llm_key_saved({ last4: provider.last4 })}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-3.5">
        <Input
          aria-label={label}
          autoComplete="off"
          disabled={!provider.eligible && !provider.last4}
          maxLength={upsertLLMCredentialBodyApiKeyMax}
          onChange={(event) => setValue(event.target.value)}
          placeholder={m.settings_llm_key_placeholder()}
          spellCheck={false}
          type="password"
          value={value}
          wrapperClassName="flex-1"
        />
        {/* md buttons with rounded="large" match the input, as in the
            sharing dialog's link row. */}
        <Button
          disabled={saving || !value.trim() || !provider.eligible}
          onClick={() => {
            save(
              { apiKey: value.trim(), providerSlug: provider.providerSlug },
              { onSuccess: () => setValue('') }
            );
          }}
          rounded="large"
          variant="dark"
        >
          <BusyLabel busy={saving} label={m.settings_llm_key_save()} />
        </Button>
        {provider.last4 ? (
          <Button
            disabled={removing}
            onClick={() => remove(provider.providerSlug)}
            rounded="large"
            variant="danger"
          >
            <BusyLabel busy={removing} label={m.settings_llm_key_remove()} />
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

/** Placeholder shaped like a ProviderRow: title, meta line, input and button. */
function ProviderRowSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="flex min-w-0 items-center gap-3.5">
        <Skeleton className="h-[42px] flex-1 rounded-input" />
        <Skeleton className="h-[42px] w-18 rounded-input" />
      </div>
    </div>
  );
}

export function KeysSection() {
  const { data, error, isError, isPending, refetch } = useLLMCredentials({
    errorBoundary: false,
  });
  const providers = data?.providers ?? [];

  return (
    <div className="flex flex-col gap-6">
      {isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-tint-error-fg">
            {error && isApiError(error) && error.status === 503
              ? credentialError(error)
              : m.settings_llm_keys_load_failed()}
          </p>
          <ErrorAction
            iconLeftClassName="me-1"
            onClick={() => {
              void refetch();
            }}
            size="sm"
          >
            {m.error_action_retry()}
          </ErrorAction>
        </div>
      ) : null}
      {isPending ? (
        <>
          <ProviderRowSkeleton />
          <ProviderRowSkeleton />
        </>
      ) : null}
      {providers.map((provider) => (
        <ProviderRow key={provider.providerSlug} provider={provider} />
      ))}
    </div>
  );
}
