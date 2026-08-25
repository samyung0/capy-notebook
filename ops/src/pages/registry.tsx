import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Star, Trash2, TriangleAlert } from 'lucide-react';
import { type FormEvent, useMemo, useReducer, useState } from 'react';
import { useOpsApp } from '@/app-context';
import { ErrorState, PageHeader, PageLoading } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatCount } from '@/format';
import { cn } from '@/lib/utils';
import {
  assembleRegistryRequest,
  cellId,
  cloneCatalogToDraft,
  createRegistryState,
  embeddingChanged,
  type RegistryIssue,
  type RegistryState,
  registryReducer,
  removedPreferenceCells,
  targetForRow,
} from '@/registry-domain';
import type {
  AuthMode,
  CatalogConfig,
  DraftConfig,
  Registry,
  Surface,
} from '@/types';

const authModes: AuthMode[] = ['platform', 'user_key', 'platform_or_user'];

function latestConfig(registry: Registry, rowKey: string) {
  return registry.configs
    .filter((config) => config.modelKey === rowKey)
    .sort((left, right) => right.version - left.version)[0];
}

function targetLabel(
  cell: RegistryState['cells'] extends Map<string, infer Cell> ? Cell : never
) {
  if (cell.target.kind === 'draft') {
    return 'Draft';
  }
  return `v${cell.target.version}`;
}

function DraftDialog({
  config,
  open,
  onOpenChange,
  onCreate,
}: {
  config: CatalogConfig | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (draft: DraftConfig) => void;
}) {
  const initial = useMemo(
    () =>
      config ? cloneCatalogToDraft(config, crypto.randomUUID()) : undefined,
    [config]
  );
  const [draft, setDraft] = useState(initial);
  const [paramsText, setParamsText] = useState(
    initial ? JSON.stringify(initial.params, null, 2) : '{}'
  );
  const [error, setError] = useState('');

  if (!draft || !config) {
    return null;
  }
  const currentDraft = draft;
  const embedding = config.surfaces.includes('embedding');

  function numberField(
    key:
      | 'contextWindowTokens'
      | 'microsPerInputToken'
      | 'microsPerCachedInputToken'
      | 'microsPerOutputToken',
    value: string
  ) {
    setDraft((current) =>
      current ? { ...current, [key]: Number(value) } : current
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let params: unknown;
    try {
      params = JSON.parse(paramsText);
    } catch {
      setError('Params must be valid JSON.');
      return;
    }
    if (!params || Array.isArray(params) || typeof params !== 'object') {
      setError('Params must be a JSON object.');
      return;
    }
    const safeParams = Object.fromEntries(Object.entries(params));
    setError('');
    onCreate({ ...currentDraft, params: safeParams });
    onOpenChange(false);
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Clone {config.modelKey} to draft</DialogTitle>
          <DialogDescription>
            The draft is assigned to this model row. The server creates a new
            immutable version when you use the page-level Save action.
          </DialogDescription>
        </DialogHeader>
        <form id="draft-form" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="draft-model-key">Model key</Label>
              <Input
                id="draft-model-key"
                name="modelKey"
                readOnly
                value={draft.modelKey}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="draft-display-name">Display name</Label>
              <Input
                id="draft-display-name"
                name="displayName"
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, displayName: event.currentTarget.value }
                      : current
                  )
                }
                readOnly={embedding}
                required
                value={draft.displayName}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="draft-provider">Provider slug</Label>
              <Input
                id="draft-provider"
                name="providerSlug"
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, providerSlug: event.currentTarget.value }
                      : current
                  )
                }
                required
                value={draft.providerSlug}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="draft-provider-model">Provider model ID</Label>
              <Input
                id="draft-provider-model"
                name="providerModelId"
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          providerModelId: event.currentTarget.value,
                        }
                      : current
                  )
                }
                readOnly={embedding}
                required
                value={draft.providerModelId}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="draft-base-url">Base URL</Label>
              <Input
                id="draft-base-url"
                name="baseUrl"
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, baseUrl: event.currentTarget.value }
                      : current
                  )
                }
                type="url"
                value={draft.baseUrl}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="draft-auth-mode">Authentication mode</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={embedding}
                id="draft-auth-mode"
                name="authMode"
                onChange={(event) => {
                  const authMode = authModes.find(
                    (mode) => mode === event.currentTarget.value
                  );
                  if (authMode) {
                    setDraft((current) =>
                      current ? { ...current, authMode } : current
                    );
                  }
                }}
                value={draft.authMode}
              >
                {authModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="draft-context">Context window tokens</Label>
              <Input
                id="draft-context"
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
            <div className="space-y-2">
              <Label htmlFor="draft-input-rate">Micros / input token</Label>
              <Input
                id="draft-input-rate"
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
              <Label htmlFor="draft-cached-rate">
                Micros / cached input token
              </Label>
              <Input
                id="draft-cached-rate"
                min="0"
                name="microsPerCachedInputToken"
                onChange={(event) =>
                  numberField(
                    'microsPerCachedInputToken',
                    event.currentTarget.value
                  )
                }
                readOnly={embedding}
                required
                type="number"
                value={draft.microsPerCachedInputToken}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="draft-output-rate">Micros / output token</Label>
              <Input
                id="draft-output-rate"
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
              <Label htmlFor="draft-params">Params JSON</Label>
              <Textarea
                aria-describedby="draft-params-help"
                className="min-h-40 font-mono text-xs"
                id="draft-params"
                name="params"
                onChange={(event) => setParamsText(event.currentTarget.value)}
                readOnly={embedding}
                value={paramsText}
              />
              <p
                className="text-muted-foreground text-xs"
                id="draft-params-help"
              >
                {embedding
                  ? 'Embedding identity, parameters, rates, and surfaces are immutable.'
                  : 'Include provider options such as structured reasoning settings.'}
              </p>
            </div>
          </div>
          <p aria-live="polite" className="mt-3 text-destructive text-sm">
            {error}
          </p>
        </form>
        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button form="draft-form" type="submit">
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RegistryEditor({ registry }: { registry: Registry }) {
  const { api } = useOpsApp();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(
    registryReducer,
    registry,
    createRegistryState
  );
  const [cloneRow, setCloneRow] = useState<string>();
  const [issues, setIssues] = useState<RegistryIssue[]>([]);
  const [status, setStatus] = useState('');
  const {
    mutate,
    error: saveError,
    isPending: isSaving,
  } = useMutation({
    mutationFn: api.saveRegistry,
    onSuccess: async (result) => {
      setStatus(`Saved registry revision ${result.revision}.`);
      setIssues([]);
      await queryClient.invalidateQueries({ queryKey: ['registry'] });
    },
  });

  const removed = removedPreferenceCells(state);
  const changedEmbedding = embeddingChanged(state);

  function setCell(rowKey: string, surface: Surface) {
    const target = targetForRow(registry, state, rowKey);
    if (!target) {
      return;
    }
    dispatch({
      cell: { isDefault: false, rowKey, surface, target },
      type: 'set-cell',
    });
  }

  function createDraft(draft: DraftConfig) {
    dispatch({ draft, type: 'upsert-draft' });
    const currentCells = [...state.cells.values()].filter(
      (cell) => cell.rowKey === draft.modelKey
    );
    for (const cell of currentCells) {
      dispatch({
        cell: {
          ...cell,
          target: { draftId: draft.id, kind: 'draft' },
        },
        type: 'set-cell',
      });
    }
  }

  function save() {
    const assembled = assembleRegistryRequest(registry, state);
    if (!assembled.valid) {
      setIssues(assembled.issues);
      setStatus('');
      return;
    }
    mutate(assembled.request);
  }

  return (
    <>
      <PageHeader
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline">Revision {registry.revision}</Badge>
            <Badge
              variant={registry.aliasesAllowed ? 'destructive' : 'secondary'}
            >
              Aliases{' '}
              {registry.aliasesAllowed ? 'unexpectedly enabled' : 'disabled'}
            </Badge>
          </div>
        }
        description="Rows are model keys. Cells control serving, defaults, drafts, and retirement fallbacks."
        title="Model registry"
      />

      <div className="-mx-4 overflow-x-auto border-y bg-card sm:-mx-6 lg:-mx-8">
        <table className="w-full min-w-[1120px] border-collapse text-sm">
          <caption className="sr-only">
            Model keys by supported product surface
          </caption>
          <thead className="sticky top-0 z-10 bg-card shadow-sm">
            <tr>
              <th
                className="sticky left-0 z-20 min-w-64 border-r border-b bg-card p-3 text-left font-medium"
                scope="col"
              >
                Model key
              </th>
              {state.surfaces.map((surface) => (
                <th
                  className="min-w-36 border-r border-b p-3 text-left font-medium capitalize"
                  key={surface}
                  scope="col"
                >
                  {surface}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((rowKey) => {
              const config = latestConfig(registry, rowKey);
              const draft = [...state.drafts.values()].find(
                (item) => item.modelKey === rowKey
              );
              return (
                <tr className="hover:bg-muted/30" key={rowKey}>
                  <th
                    className="sticky left-0 z-[5] border-r border-b bg-card p-3 text-left"
                    scope="row"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono font-semibold text-xs">
                          {rowKey}
                        </p>
                        <p className="mt-1 truncate font-normal text-muted-foreground text-xs">
                          {draft
                            ? `${draft.providerSlug} · draft`
                            : config
                              ? `${config.providerSlug} · v${config.version}`
                              : 'Draft'}
                        </p>
                      </div>
                      {config ? (
                        <Button
                          aria-label={`Clone ${rowKey} to draft`}
                          onClick={() => setCloneRow(rowKey)}
                          size="icon"
                          title="Clone to draft"
                          type="button"
                          variant="ghost"
                        >
                          <Copy aria-hidden="true" />
                        </Button>
                      ) : null}
                    </div>
                  </th>
                  {state.surfaces.map((surface) => {
                    const id = cellId(rowKey, surface);
                    const cell = state.cells.get(id);
                    return (
                      <td
                        className="border-r border-b p-2 align-top"
                        key={surface}
                      >
                        {cell ? (
                          <div
                            className={cn(
                              'rounded-md border p-2',
                              cell.isDefault &&
                                'border-primary bg-primary/5 ring-1 ring-primary/30'
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <Badge
                                variant={
                                  cell.target.kind === 'draft'
                                    ? 'default'
                                    : 'secondary'
                                }
                              >
                                {targetLabel(cell)}
                              </Badge>
                              {cell.isDefault ? (
                                <span className="inline-flex items-center gap-1 font-medium text-primary text-xs">
                                  <Star
                                    aria-hidden="true"
                                    className="size-3 fill-current"
                                  />
                                  Default
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-2 flex gap-1">
                              <Button
                                aria-label={`Make ${rowKey} the ${surface} default`}
                                disabled={
                                  cell.isDefault ||
                                  (surface === 'embedding' &&
                                    !config?.embeddingDefaultEligible)
                                }
                                onClick={() =>
                                  dispatch({
                                    rowKey,
                                    surface,
                                    type: 'set-default',
                                  })
                                }
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                <Star aria-hidden="true" />
                                Default
                              </Button>
                              <Button
                                aria-label={`Clear ${surface} from ${rowKey}`}
                                onClick={() =>
                                  dispatch({
                                    rowKey,
                                    surface,
                                    type: 'clear-cell',
                                  })
                                }
                                size="icon"
                                title="Clear cell"
                                type="button"
                                variant="ghost"
                              >
                                <Trash2 aria-hidden="true" />
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button
                            className="w-full border-dashed"
                            disabled={!targetForRow(registry, state, rowKey)}
                            onClick={() => setCell(rowKey, surface)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Set
                          </Button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {removed.length > 0 ? (
        <section
          aria-labelledby="fallback-heading"
          className="rounded-lg border border-amber-300 bg-amber-50/60 p-5"
        >
          <div className="flex items-start gap-3">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-5 text-amber-700"
            />
            <div className="flex-1">
              <h2 className="font-semibold" id="fallback-heading">
                Deprecation fallbacks required
              </h2>
              <p className="mt-1 text-muted-foreground text-sm">
                Users pinned to a cleared model need a replacement.
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {removed.map((cell) => {
                  const fallbackId = `${cell.rowKey}-${cell.surface}-fallback`;
                  return (
                    <div className="space-y-2" key={fallbackId}>
                      <Label htmlFor={fallbackId}>
                        {cell.rowKey} · {cell.surface}
                      </Label>
                      <select
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        id={fallbackId}
                        onChange={(event) =>
                          dispatch({
                            fallbackKey: event.currentTarget.value,
                            modelKey: cell.rowKey,
                            surface: cell.surface,
                            type: 'set-deprecation',
                          })
                        }
                        value={
                          state.deprecations.get(
                            `${cell.rowKey}\u0000${cell.surface}`
                          ) ?? ''
                        }
                      >
                        <option value="">Choose fallback</option>
                        {state.rows
                          .filter(
                            (candidate) =>
                              candidate !== cell.rowKey &&
                              state.cells.has(cellId(candidate, cell.surface))
                          )
                          .map((candidate) => (
                            <option key={candidate} value={candidate}>
                              {candidate}
                            </option>
                          ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {changedEmbedding ? (
        <section className="rounded-lg border border-amber-300 bg-amber-50/60 p-5">
          <div className="flex items-start gap-3">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-5 text-amber-700"
            />
            <div>
              <h2 className="font-semibold">Embedding change warning</h2>
              <p className="mt-1 text-muted-foreground text-sm">
                Changing the embedding assignment can require workspace
                re-indexing. Current indexed workspace counts:
              </p>
              <ul className="mt-2 list-inside list-disc text-sm">
                {registry.embeddingWorkspaceCounts.map((item) => (
                  <li key={`${item.modelKey}:${item.version}:${item.dim}`}>
                    {item.modelKey} v{item.version}, {item.dim} dimensions:{' '}
                    {formatCount(item.count)}
                  </li>
                ))}
              </ul>
              <label
                className="mt-4 flex cursor-pointer items-start gap-3 font-medium text-sm"
                htmlFor="embedding-acknowledgement"
              >
                <Checkbox
                  aria-describedby="embedding-ack-help"
                  checked={state.embeddingAcknowledged}
                  id="embedding-acknowledgement"
                  onCheckedChange={(checked) =>
                    dispatch({
                      checked: checked === true,
                      type: 'acknowledge-embedding',
                    })
                  }
                />
                <span>
                  I acknowledge the re-indexing impact.
                  <span
                    className="mt-1 block font-normal text-muted-foreground"
                    id="embedding-ack-help"
                  >
                    This acknowledgement is included in the save request.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </section>
      ) : null}

      {issues.length > 0 ? (
        <div
          aria-live="assertive"
          className="rounded-lg border border-red-300 bg-red-50 p-4"
          role="alert"
        >
          <p className="font-semibold">Registry changes need attention</p>
          <ul className="mt-2 list-inside list-disc text-sm">
            {issues.map((issue, index) => (
              <li
                key={`${issue.code}:${issue.rowKey}:${issue.surface}:${index}`}
              >
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {saveError ? <ErrorState error={saveError} /> : null}

      <div className="sticky bottom-4 z-20 flex flex-col gap-3 rounded-xl border bg-background/95 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-medium text-sm">
            {state.dirty ? 'Unsaved registry changes' : 'No changes'}
          </p>
          <p aria-live="polite" className="text-muted-foreground text-xs">
            {status ||
              `${state.cells.size} active cells · ${state.drafts.size} drafts`}
          </p>
        </div>
        <Button
          disabled={!state.dirty || isSaving}
          onClick={save}
          type="button"
        >
          {isSaving ? (
            'Saving…'
          ) : (
            <>
              <Check aria-hidden="true" />
              Save
            </>
          )}
        </Button>
      </div>

      <DraftDialog
        config={cloneRow ? latestConfig(registry, cloneRow) : undefined}
        key={cloneRow ?? 'closed'}
        onCreate={createDraft}
        onOpenChange={(open) => {
          if (!open) {
            setCloneRow(undefined);
          }
        }}
        open={Boolean(cloneRow)}
      />
    </>
  );
}

export function RegistryPage() {
  const { api, session } = useOpsApp();
  const { data, error, isPending, refetch } = useQuery({
    enabled: session.role === 'admin',
    queryFn: api.registry,
    queryKey: ['registry'],
  });

  if (session.role !== 'admin') {
    return null;
  }
  if (isPending) {
    return <PageLoading label="Loading model registry" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }
  return <RegistryEditor key={data.revision} registry={data} />;
}
