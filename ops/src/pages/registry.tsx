import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Plus, Star, Trash2, TriangleAlert } from 'lucide-react';
import {
  type FormEvent,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from 'react';
import { useOpsApp } from '@/app-context';
import {
  ErrorState,
  FreshnessNote,
  PageHeader,
  PageLoading,
} from '@/components/common';
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
import { DraftFields } from '@/draft-fields';
import { formatCount } from '@/format';
import { cn } from '@/lib/utils';
import {
  assembleRegistryRequest,
  canMutateRegistry,
  cellId,
  cloneCatalogToDraft,
  createRegistryState,
  embeddingChanged,
  emptyDraft,
  modelRefId,
  modelRefLabel,
  type RegistryIssue,
  type RegistryState,
  registryReducer,
  targetForRow,
} from '@/registry-domain';
import type {
  Capability,
  CatalogConfig,
  DraftConfig,
  EliteLLMProvider,
  Registry,
  Slot,
} from '@/types';

function latestConfig(registry: Registry, rowId: string) {
  return registry.configs
    .filter((config) => modelRefId(config) === rowId)
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

function parseParams(
  text: string
):
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      return { error: 'Params must be a JSON object.', ok: false };
    }
    return { ok: true, params: Object.fromEntries(Object.entries(parsed)) };
  } catch {
    return { error: 'Params must be valid JSON.', ok: false };
  }
}

function DraftDialog({
  capabilities,
  config,
  onCreate,
  onOpenChange,
  open,
  providers,
}: {
  capabilities: Capability[];
  config: CatalogConfig | undefined;
  onCreate: (draft: DraftConfig) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  providers: EliteLLMProvider[];
}) {
  const initial = useMemo(
    () =>
      config
        ? cloneCatalogToDraft(config, crypto.randomUUID())
        : emptyDraft(crypto.randomUUID()),
    [config]
  );
  const [draft, setDraft] = useState(initial);
  const [paramsText, setParamsText] = useState(
    JSON.stringify(initial.params, null, 2)
  );
  const [error, setError] = useState('');

  if (!config) {
    return null;
  }
  const embedding = config.slots.includes('retrieval');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseParams(paramsText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError('');
    onCreate({ ...draft, params: parsed.params });
    onOpenChange(false);
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Clone {modelRefLabel(config)} to draft</DialogTitle>
          <DialogDescription>
            The draft is assigned to this model row. The server creates a new
            immutable version when you use the page-level Save action.
          </DialogDescription>
        </DialogHeader>
        <form id="draft-form" onSubmit={submit}>
          <DraftFields
            capabilities={capabilities}
            draft={draft}
            embedding={embedding}
            idPrefix="draft"
            paramsText={paramsText}
            providers={providers}
            setDraft={setDraft}
            setParamsText={setParamsText}
          />
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

function AddModelDialog({
  capabilities,
  onCreate,
  onOpenChange,
  open,
  providers,
}: {
  capabilities: Capability[];
  onCreate: (draft: DraftConfig) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  providers: EliteLLMProvider[];
}) {
  const [draft, setDraft] = useState(() => emptyDraft(crypto.randomUUID()));
  const [paramsText, setParamsText] = useState('{}');
  const [error, setError] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.providerSlug.trim() || !draft.modelSlug.trim()) {
      setError('Provider and model slug are required.');
      return;
    }
    const parsed = parseParams(paramsText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError('');
    onCreate({ ...draft, params: parsed.params });
    onOpenChange(false);
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) {
          setDraft(emptyDraft(crypto.randomUUID()));
          setParamsText('{}');
          setError('');
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add model</DialogTitle>
          <DialogDescription>
            Pick a first-party provider and the exact model slug, then assign
            slots on the grid and save.
          </DialogDescription>
        </DialogHeader>
        <form id="add-model-form" onSubmit={submit}>
          <DraftFields
            capabilities={capabilities}
            draft={draft}
            embedding={false}
            idPrefix="add"
            paramsText={paramsText}
            providers={providers}
            setDraft={setDraft}
            setParamsText={setParamsText}
          />
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
          <Button form="add-model-form" type="submit">
            Add draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RegistryEditor({ registry }: { registry: Registry }) {
  const { api } = useOpsApp();
  const queryClient = useQueryClient();
  const { data: providerPage } = useQuery({
    queryFn: api.providers,
    queryKey: ['ops-providers'],
  });
  const providers = providerPage?.providers ?? [];
  const [state, dispatch] = useReducer(
    registryReducer,
    registry,
    createRegistryState
  );
  const [cloneRow, setCloneRow] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [issues, setIssues] = useState<RegistryIssue[]>([]);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!state.dirty && state.expectedVersion !== registry.revision) {
      dispatch({ registry, type: 'reset' });
    }
  }, [registry, state.dirty, state.expectedVersion]);
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

  const changedEmbedding = embeddingChanged(state);

  function setCell(rowId: string, slot: Slot) {
    const target = targetForRow(registry, state, rowId);
    if (!target) {
      return;
    }
    dispatch({
      cell: { isDefault: false, rowId, slot, target },
      type: 'set-cell',
    });
  }

  function createDraft(draft: DraftConfig) {
    dispatch({ draft, type: 'upsert-draft' });
    const currentCells = [...state.cells.values()].filter(
      (cell) => cell.rowId === modelRefId(draft)
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
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <FreshnessNote>
              Database registry, refreshed every 30 seconds.
            </FreshnessNote>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Revision {registry.revision}</Badge>
              <Badge
                variant={registry.aliasesAllowed ? 'destructive' : 'secondary'}
              >
                Aliases{' '}
                {registry.aliasesAllowed ? 'unexpectedly enabled' : 'disabled'}
              </Badge>
              <Button
                onClick={() => setAdding(true)}
                type="button"
                variant="outline"
              >
                <Plus aria-hidden="true" />
                Add model
              </Button>
            </div>
          </div>
        }
        description="Rows are provider/model identities. Cells control serving, defaults, and drafts. Clearing a preference remaps users to the slot default."
        title="Model registry"
      />

      <div className="-mx-4 overflow-x-auto border-y bg-card sm:-mx-6 lg:-mx-8">
        <table className="w-full min-w-[1120px] border-collapse text-sm">
          <caption className="sr-only">
            Provider and model slugs by slot
          </caption>
          <thead className="sticky top-0 z-10 bg-card shadow-sm">
            <tr>
              <th
                className="sticky left-0 z-20 min-w-64 border-r border-b bg-card p-3 text-left font-medium"
                scope="col"
              >
                Provider / model
              </th>
              {state.slots.map((slot) => (
                <th
                  className="min-w-36 border-r border-b p-3 text-left font-medium capitalize"
                  key={slot}
                  scope="col"
                >
                  {slot}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((rowId) => {
              const config = latestConfig(registry, rowId);
              const draft = [...state.drafts.values()].find(
                (item) => modelRefId(item) === rowId
              );
              const model = draft ?? config;
              return (
                <tr className="hover:bg-muted/30" key={rowId}>
                  <th
                    className="sticky left-0 z-[5] border-r border-b bg-card p-3 text-left"
                    scope="row"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono font-semibold text-xs">
                          {model ? modelRefLabel(model) : rowId}
                        </p>
                        <p className="mt-1 truncate font-normal text-muted-foreground text-xs">
                          {draft
                            ? `${draft.modelSlug} · draft`
                            : config
                              ? `${config.modelSlug} · v${config.version}`
                              : 'Draft'}
                        </p>
                      </div>
                      {config ? (
                        <Button
                          aria-label={`Clone ${modelRefLabel(config)} to draft`}
                          onClick={() => setCloneRow(rowId)}
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
                  {state.slots.map((slot) => {
                    const id = cellId(rowId, slot);
                    const cell = state.cells.get(id);
                    return (
                      <td
                        className="border-r border-b p-2 align-top"
                        key={slot}
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
                                aria-label={`Make ${model ? modelRefLabel(model) : rowId} the ${slot} default`}
                                disabled={
                                  cell.isDefault ||
                                  (slot === 'retrieval' &&
                                    !config?.embeddingDefaultEligible)
                                }
                                onClick={() =>
                                  dispatch({
                                    rowId,
                                    slot,
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
                                aria-label={`Clear ${slot} from ${model ? modelRefLabel(model) : rowId}`}
                                onClick={() =>
                                  dispatch({
                                    rowId,
                                    slot,
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
                            disabled={!targetForRow(registry, state, rowId)}
                            onClick={() => setCell(rowId, slot)}
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
                  <li
                    key={`${item.providerSlug}:${item.modelSlug}:${item.version}:${item.dim}`}
                  >
                    {modelRefLabel(item)} v{item.version}, {item.dim}{' '}
                    dimensions: {formatCount(item.count)}
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
              <li key={`${issue.code}:${issue.rowId}:${issue.slot}:${index}`}>
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
        capabilities={registry.capabilities}
        config={cloneRow ? latestConfig(registry, cloneRow) : undefined}
        key={cloneRow ?? 'closed'}
        onCreate={createDraft}
        onOpenChange={(open) => {
          if (!open) {
            setCloneRow(undefined);
          }
        }}
        open={Boolean(cloneRow)}
        providers={providers}
      />
      <AddModelDialog
        capabilities={registry.capabilities}
        onCreate={createDraft}
        onOpenChange={setAdding}
        open={adding}
        providers={providers}
      />
    </>
  );
}

export function RegistryPage() {
  const { api, session } = useOpsApp();
  const { data, error, isPending, refetch } = useQuery({
    enabled: canMutateRegistry(session.permissions),
    queryFn: api.registry,
    queryKey: ['registry'],
  });

  if (!canMutateRegistry(session.permissions)) {
    return null;
  }
  if (isPending) {
    return <PageLoading label="Loading model registry" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }
  return <RegistryEditor registry={data} />;
}
