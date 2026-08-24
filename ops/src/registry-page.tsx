import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { Plus, Save, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  type DraftConfig,
  draftConfigSchema,
  OpsApiError,
  type Registry,
  reasoningSchema,
  type Surface,
} from './api';
import { useOpsApp } from './app-context';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './components/ui/card';
import { Checkbox } from './components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table';
import { Textarea } from './components/ui/textarea';
import { cn } from './lib/utils';
import {
  EmptyState,
  ErrorState,
  formatDateTime,
  formatNumber,
  PageHeader,
  PageSkeleton,
  POLL_INTERVAL,
} from './ops-ui';
import {
  cellId,
  deriveRegistryDraft,
  formatTarget,
  matrixSurfaces,
  type RegistryCell,
  type RegistryDraft,
  type RegistryIssue,
  registryDraftChanged,
  targetId,
  validateRegistryDraft,
} from './registry-domain';

type CellSelection = { rowKey: string; surface: Surface };
type RegistryConfig = Registry['configs'][number];

function cloneDraft(draft: RegistryDraft): RegistryDraft {
  return {
    baseVersion: draft.baseVersion,
    cells: new Map(draft.cells),
    deprecations: new Map(draft.deprecations),
    drafts: new Map(draft.drafts),
    embeddingUpdates: new Map(draft.embeddingUpdates),
  };
}

function configForTarget(
  registry: Registry,
  draft: RegistryDraft,
  cell: RegistryCell | undefined
): RegistryConfig | DraftConfig | undefined {
  if (!cell) {
    return;
  }
  if (cell.target.kind === 'draft') {
    return draft.drafts.get(cell.target.draftId);
  }
  const target = cell.target;
  return registry.configs.find(
    (config) =>
      config.modelKey === target.modelKey && config.version === target.version
  );
}

function newDraftConfig(source?: RegistryConfig): DraftConfig {
  const id = crypto.randomUUID();
  if (source) {
    const {
      version: _version,
      surfaces: _surfaces,
      enabled: _enabled,
      isDefaultFor: _isDefaultFor,
      createdAt: _createdAt,
      credentialEnv: _credentialEnv,
      credentialConfigured: _credentialConfigured,
      ...config
    } = source;
    return { ...config, id, params: { ...config.params } };
  }
  return {
    authMode: 'platform',
    baseUrl: '',
    contextWindowTokens: 50_000,
    displayName: '',
    id,
    microsPerCachedInputToken: 1,
    microsPerInputToken: 1,
    microsPerOutputToken: 1,
    modelKey: '',
    params: {
      reasoning: {
        canDisable: true,
        defaultEffort: 'medium',
        defaultMode: 'on',
        efforts: ['medium'],
      },
    },
    providerModelId: '',
    providerSlug: '',
  };
}

function DraftDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: DraftConfig;
  onClose: () => void;
  onSave: (config: DraftConfig) => void;
}) {
  const [config, setConfig] = useState(initial);
  const reasoningResult = reasoningSchema.safeParse(config.params.reasoning);
  const reasoning = reasoningResult.success
    ? reasoningResult.data
    : {
        canDisable: true,
        defaultEffort: 'medium' as const,
        defaultMode: 'on' as const,
        efforts: ['medium' as const],
      };
  const otherParams = Object.fromEntries(
    Object.entries(config.params).filter(([key]) => key !== 'reasoning')
  );
  const [paramsText, setParamsText] = useState(
    JSON.stringify(otherParams, null, 2)
  );
  const [error, setError] = useState('');

  function updateReasoning(next: typeof reasoning): void {
    setConfig({
      ...config,
      params: { ...config.params, reasoning: next },
    });
  }

  function submit(): void {
    let parsedParams: unknown;
    try {
      parsedParams = JSON.parse(paramsText);
    } catch {
      setError('Other params must be valid JSON.');
      return;
    }
    if (
      typeof parsedParams !== 'object' ||
      parsedParams === null ||
      Array.isArray(parsedParams)
    ) {
      setError('Other params must be a JSON object.');
      return;
    }
    const candidate = {
      ...config,
      params: { ...parsedParams, reasoning },
    };
    const parsed = draftConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError('Complete every model field with valid non-negative numbers.');
      return;
    }
    if (!reasoning.efforts.includes(reasoning.defaultEffort)) {
      setError('Default effort must be included in the supported efforts.');
      return;
    }
    onSave(parsed.data);
  }

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create immutable model version</DialogTitle>
          <DialogDescription>
            Saving inserts a new version. Existing catalog pins are never
            rewritten.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="draft-key">Model key</Label>
            <Input
              id="draft-key"
              onChange={(event) =>
                setConfig({ ...config, modelKey: event.currentTarget.value })
              }
              value={config.modelKey}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="draft-name">Display name</Label>
            <Input
              id="draft-name"
              onChange={(event) =>
                setConfig({ ...config, displayName: event.currentTarget.value })
              }
              value={config.displayName}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="draft-provider">Provider slug</Label>
            <Input
              id="draft-provider"
              onChange={(event) =>
                setConfig({
                  ...config,
                  providerSlug: event.currentTarget.value,
                })
              }
              value={config.providerSlug}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="draft-provider-model">Provider model ID</Label>
            <Input
              id="draft-provider-model"
              onChange={(event) =>
                setConfig({
                  ...config,
                  providerModelId: event.currentTarget.value,
                })
              }
              value={config.providerModelId}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="draft-url">Base URL</Label>
            <Input
              id="draft-url"
              onChange={(event) =>
                setConfig({ ...config, baseUrl: event.currentTarget.value })
              }
              placeholder="https://api.example.com/v1"
              value={config.baseUrl}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="draft-auth">Authentication</Label>
            <Select
              onValueChange={(value) => {
                const parsed =
                  draftConfigSchema.shape.authMode.safeParse(value);
                if (parsed.success) {
                  setConfig({ ...config, authMode: parsed.data });
                }
              }}
              value={config.authMode}
            >
              <SelectTrigger id="draft-auth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="platform">Platform</SelectItem>
                <SelectItem value="user_key">User key</SelectItem>
                <SelectItem value="platform_or_user">
                  Platform or user key
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="draft-context">Context window</Label>
            <Input
              id="draft-context"
              min="1"
              onChange={(event) =>
                setConfig({
                  ...config,
                  contextWindowTokens: Number(event.currentTarget.value),
                })
              }
              type="number"
              value={config.contextWindowTokens}
            />
          </div>
          {(
            [
              ['microsPerInputToken', 'Input micros'],
              ['microsPerCachedInputToken', 'Cached-read micros'],
              ['microsPerOutputToken', 'Output micros'],
            ] as const
          ).map(([field, label]) => (
            <div className="space-y-2" key={field}>
              <Label htmlFor={`draft-${field}`}>{label}</Label>
              <Input
                id={`draft-${field}`}
                min="0"
                onChange={(event) =>
                  setConfig({
                    ...config,
                    [field]: Number(event.currentTarget.value),
                  })
                }
                type="number"
                value={config[field]}
              />
            </div>
          ))}
        </div>
        <div className="space-y-4 rounded-lg border p-4">
          <div>
            <h3 className="font-medium">Reasoning settings</h3>
            <p className="text-muted-foreground text-xs">
              Required when this version serves a language-model surface.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="reasoning-mode">Default mode</Label>
              <Select
                onValueChange={(value) => {
                  if (value === 'on' || value === 'off') {
                    updateReasoning({ ...reasoning, defaultMode: value });
                  }
                }}
                value={reasoning.defaultMode}
              >
                <SelectTrigger id="reasoning-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="on">On</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reasoning-effort">Default effort</Label>
              <Input
                id="reasoning-effort"
                onChange={(event) => {
                  const parsed = reasoningSchema.shape.defaultEffort.safeParse(
                    event.currentTarget.value
                  );
                  if (parsed.success) {
                    updateReasoning({
                      ...reasoning,
                      defaultEffort: parsed.data,
                    });
                  }
                }}
                value={reasoning.defaultEffort}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="reasoning-efforts">
                Supported efforts, comma-separated
              </Label>
              <Input
                id="reasoning-efforts"
                onChange={(event) => {
                  const parsed = reasoningSchema.shape.efforts.safeParse(
                    event.currentTarget.value
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean)
                  );
                  if (parsed.success) {
                    updateReasoning({ ...reasoning, efforts: parsed.data });
                  }
                }}
                value={reasoning.efforts.join(', ')}
              />
            </div>
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor="draft-can-disable"
            >
              <Checkbox
                checked={reasoning.canDisable}
                id="draft-can-disable"
                onCheckedChange={(checked) =>
                  updateReasoning({
                    ...reasoning,
                    canDisable: checked === true,
                  })
                }
              />
              Users may disable reasoning
            </label>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="draft-params">Other params</Label>
          <Textarea
            className="min-h-32 font-mono text-xs"
            id="draft-params"
            onChange={(event) => setParamsText(event.currentTarget.value)}
            value={paramsText}
          />
        </div>
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button onClick={submit} type="button">
            Add version to draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CellDialog({
  registry,
  draft,
  selection,
  editable,
  onChange,
  onClose,
  onNewVersion,
}: {
  registry: Registry;
  draft: RegistryDraft;
  selection: CellSelection;
  editable: boolean;
  onChange: (draft: RegistryDraft) => void;
  onClose: () => void;
  onNewVersion: (source?: RegistryConfig) => void;
}) {
  const id = cellId(selection.rowKey, selection.surface);
  const cell = draft.cells.get(id);
  const versions = registry.configs.filter(
    (config) => config.modelKey === selection.rowKey
  );
  const rowDrafts = [...draft.drafts.values()].filter(
    (config) => config.modelKey === selection.rowKey
  );
  const config = configForTarget(registry, draft, cell);
  const embedding = selection.surface === 'embedding';
  const embeddingTarget =
    embedding && cell?.target.kind === 'existing' ? cell.target : undefined;
  const embeddingUpdateKey = embeddingTarget
    ? `${embeddingTarget.modelKey}@${embeddingTarget.version}`
    : '';
  const embeddingUpdate = embeddingTarget
    ? draft.embeddingUpdates.get(embeddingUpdateKey)
    : undefined;

  function setEmbeddingEndpoint(
    field: 'providerSlug' | 'baseUrl',
    value: string
  ): void {
    if (!embeddingTarget || !config) {
      return;
    }
    const next = cloneDraft(draft);
    const update = {
      baseUrl: embeddingUpdate?.baseUrl ?? config.baseUrl,
      modelKey: embeddingTarget.modelKey,
      providerSlug: embeddingUpdate?.providerSlug ?? config.providerSlug,
      version: embeddingTarget.version,
      [field]: value,
    };
    if (
      update.providerSlug === config.providerSlug &&
      update.baseUrl === config.baseUrl
    ) {
      next.embeddingUpdates.delete(embeddingUpdateKey);
    } else {
      next.embeddingUpdates.set(embeddingUpdateKey, update);
    }
    onChange(next);
  }

  function setTarget(value: string): void {
    const next = cloneDraft(draft);
    const existing = versions.find(
      (item) => `existing:${item.modelKey}:${item.version}` === value
    );
    const local = rowDrafts.find((item) => `draft:${item.id}` === value);
    if (existing) {
      next.cells.set(id, {
        isDefault: cell?.isDefault ?? false,
        rowKey: selection.rowKey,
        surface: selection.surface,
        target: {
          kind: 'existing',
          modelKey: existing.modelKey,
          version: existing.version,
        },
      });
    } else if (local) {
      next.cells.set(id, {
        isDefault: cell?.isDefault ?? false,
        rowKey: selection.rowKey,
        surface: selection.surface,
        target: { draftId: local.id, kind: 'draft' },
      });
    }
    onChange(next);
  }

  function markDefault(): void {
    if (!cell) {
      return;
    }
    const next = cloneDraft(draft);
    for (const [key, item] of next.cells) {
      if (item.surface === selection.surface) {
        next.cells.set(key, { ...item, isDefault: false });
      }
    }
    next.cells.set(id, { ...cell, isDefault: true });
    onChange(next);
  }

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {selection.rowKey} / {selection.surface}
          </DialogTitle>
          <DialogDescription>
            Cell keys cannot alias another model key.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cell-target">Catalog pin</Label>
            <Select
              disabled={!editable || embedding}
              onValueChange={setTarget}
              value={cell ? targetId(cell.target) : ''}
            >
              <SelectTrigger id="cell-target">
                <SelectValue placeholder="Empty" />
              </SelectTrigger>
              <SelectContent>
                {versions.map((item) => (
                  <SelectItem
                    disabled={!item.enabled}
                    key={`${item.modelKey}-${item.version}`}
                    value={`existing:${item.modelKey}:${item.version}`}
                  >
                    v{item.version} · {item.displayName}{' '}
                    {item.enabled ? '' : '(disabled)'}
                  </SelectItem>
                ))}
                {rowDrafts.map((item) => (
                  <SelectItem key={item.id} value={`draft:${item.id}`}>
                    New version · {item.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {config ? (
            <div className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
              <p>
                <strong>{config.displayName}</strong>
              </p>
              <p className="font-mono text-muted-foreground text-xs">
                {config.providerSlug} / {config.providerModelId}
              </p>
              <p className="text-muted-foreground text-xs">
                {config.baseUrl || 'Provider default endpoint'}
              </p>
            </div>
          ) : (
            <EmptyState
              description="Choose a catalog pin or create a new immutable version."
              title="Cell is empty"
            />
          )}
          {cell ? (
            <label
              className="flex items-center gap-2 font-medium text-sm"
              htmlFor="cell-default"
            >
              <Checkbox
                checked={cell.isDefault}
                disabled={!editable || cell.isDefault}
                id="cell-default"
                onCheckedChange={(checked) => checked === true && markDefault()}
              />
              Default for {selection.surface}
            </label>
          ) : null}
          {embedding ? (
            <>
              <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 text-sm">
                Embedding pins cannot be cleared, replaced, or created here.
                Only the endpoint host may change in place; identity, params,
                rates, and vector space remain locked.
              </p>
              {editable && embeddingTarget && config ? (
                <div className="grid gap-3 rounded-lg border p-3">
                  <div className="space-y-2">
                    <Label htmlFor="embedding-provider">Provider slug</Label>
                    <Input
                      id="embedding-provider"
                      onChange={(event) =>
                        setEmbeddingEndpoint(
                          'providerSlug',
                          event.currentTarget.value
                        )
                      }
                      value={
                        embeddingUpdate?.providerSlug ?? config.providerSlug
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="embedding-base-url">Base URL</Label>
                    <Input
                      id="embedding-base-url"
                      onChange={(event) =>
                        setEmbeddingEndpoint(
                          'baseUrl',
                          event.currentTarget.value
                        )
                      }
                      value={embeddingUpdate?.baseUrl ?? config.baseUrl}
                    />
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            {editable && !embedding ? (
              <>
                <Button
                  onClick={() => {
                    const target = cell?.target;
                    const source =
                      target?.kind === 'existing'
                        ? versions.find(
                            (item) => item.version === target.version
                          )
                        : undefined;
                    onNewVersion(source);
                  }}
                  type="button"
                  variant="outline"
                >
                  New version
                </Button>
                <Button
                  disabled={!cell}
                  onClick={() => {
                    const next = cloneDraft(draft);
                    next.cells.delete(id);
                    onChange(next);
                    onClose();
                  }}
                  type="button"
                  variant="destructive"
                >
                  Clear
                </Button>
              </>
            ) : null}
          </div>
          <Button onClick={onClose} type="button">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeprecationFallbacks({
  registry,
  draft,
  editable,
  onChange,
}: {
  registry: Registry;
  draft: RegistryDraft;
  editable: boolean;
  onChange: (draft: RegistryDraft) => void;
}) {
  const original = deriveRegistryDraft(registry).cells;
  const retired = [...original.entries()].filter(
    ([id, cell]) =>
      ['chat', 'generate', 'editor', 'quiz'].includes(cell.surface) &&
      !draft.cells.has(id)
  );
  if (retired.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Deprecation fallbacks</CardTitle>
        <CardDescription>
          Users are remapped and notified in the same save transaction.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {retired.map(([id, cell]) => {
          const candidates = [...draft.cells.values()].filter(
            (candidate) =>
              candidate.surface === cell.surface &&
              candidate.rowKey !== cell.rowKey
          );
          return (
            <div
              className="grid items-center gap-3 rounded-lg border p-3 sm:grid-cols-2"
              key={id}
            >
              <p className="text-sm">
                Retire <strong>{cell.rowKey}</strong> from {cell.surface}
              </p>
              <Select
                disabled={!editable}
                onValueChange={(fallbackKey) => {
                  const next = cloneDraft(draft);
                  next.deprecations.set(id, fallbackKey);
                  onChange(next);
                }}
                value={draft.deprecations.get(id) ?? ''}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose fallback" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.rowKey} value={candidate.rowKey}>
                      {candidate.rowKey}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function RegistryEditor({ registry }: { registry: Registry }) {
  const { api, session } = useOpsApp();
  const queryClient = useQueryClient();
  const editable = session.role === 'admin';
  const [draft, setDraft] = useState(() => deriveRegistryDraft(registry));
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const [newVersion, setNewVersion] = useState<{
    config: DraftConfig;
    cell?: CellSelection;
  } | null>(null);
  const [issues, setIssues] = useState<RegistryIssue[]>([]);
  const [embeddingAcknowledged, setEmbeddingAcknowledged] = useState(false);
  const dirty = registryDraftChanged(registry, draft);
  const blocker = useBlocker({
    disabled: !dirty,
    enableBeforeUnload: dirty,
    shouldBlockFn: () => dirty,
    withResolver: true,
  });

  useEffect(() => {
    if (!dirty && registry.version !== draft.baseVersion) {
      setDraft(deriveRegistryDraft(registry));
    }
  }, [dirty, draft, registry]);

  const saveMutation = useMutation({
    mutationFn: api.saveRegistry,
    onError: (error) => {
      if (
        error instanceof OpsApiError &&
        error.status === 409 &&
        error.currentRegistry
      ) {
        queryClient.setQueryData(['ops', 'registry'], error.currentRegistry);
        setDraft(deriveRegistryDraft(error.currentRegistry));
        setEmbeddingAcknowledged(false);
        setIssues([
          {
            code: 'draft',
            message:
              'Another admin saved first. The grid was refreshed to the current registry.',
          },
        ]);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ops', 'registry'] });
      const fresh = await api.registry();
      queryClient.setQueryData(['ops', 'registry'], fresh);
      setDraft(deriveRegistryDraft(fresh));
      setIssues([]);
      setEmbeddingAcknowledged(false);
    },
  });

  const rows = useMemo(
    () =>
      [
        ...new Set([
          ...registry.configs.map((config) => config.modelKey),
          ...[...draft.drafts.values()].map((config) => config.modelKey),
        ]),
      ]
        .filter(Boolean)
        .sort(),
    [draft.drafts, registry.configs]
  );

  function save(): void {
    const result = validateRegistryDraft({
      draft,
      embeddingAcknowledged,
      registry,
    });
    if (!result.valid) {
      setIssues(result.issues);
      return;
    }
    saveMutation.mutate(result.request);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          editable ? (
            <div className="flex gap-2">
              <Button
                onClick={() => setNewVersion({ config: newDraftConfig() })}
                type="button"
                variant="outline"
              >
                <Plus aria-hidden="true" />
                Add model
              </Button>
              <Button
                disabled={!dirty || saveMutation.isPending}
                onClick={save}
                type="button"
              >
                <Save aria-hidden="true" />
                Save draft
              </Button>
            </div>
          ) : null
        }
        description={`Registry version ${registry.version}. One Save compiles the full grid transactionally.`}
        title="Model registry"
      />
      {editable ? null : (
        <div className="flex gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
          <ShieldAlert aria-hidden="true" className="size-5" />
          Viewer access: catalog and grid inspection only.
        </div>
      )}
      {issues.length > 0 ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"
          role="alert"
        >
          <h2 className="font-medium text-destructive">
            Draft needs attention
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {saveMutation.isError ? <ErrorState error={saveMutation.error} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Active grid</CardTitle>
          <CardDescription>
            Every cell independently selects a catalog pin. Row aliases are
            intentionally disabled for v1.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableCaption>
              Latest desired pin for each model key and product surface.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Model key</TableHead>
                {matrixSurfaces.map((surface) => (
                  <TableHead className="min-w-32" key={surface} scope="col">
                    {surface}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((rowKey) => (
                <TableRow key={rowKey}>
                  <TableHead className="font-mono text-xs" scope="row">
                    {rowKey}
                  </TableHead>
                  {matrixSurfaces.map((surface) => {
                    const cell = draft.cells.get(cellId(rowKey, surface));
                    return (
                      <TableCell key={surface}>
                        <button
                          className={cn(
                            'min-h-14 w-full rounded-md border p-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            cell
                              ? 'border-primary/30 bg-primary/5'
                              : 'border-dashed text-muted-foreground'
                          )}
                          onClick={() => setSelection({ rowKey, surface })}
                          type="button"
                        >
                          {cell ? formatTarget(cell.target) : 'Empty'}
                          {cell?.isDefault ? (
                            <Badge
                              className="mt-1 block w-fit"
                              variant="secondary"
                            >
                              Default
                            </Badge>
                          ) : null}
                        </button>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <DeprecationFallbacks
        draft={draft}
        editable={editable}
        onChange={setDraft}
        registry={registry}
      />

      <Card>
        <CardHeader>
          <CardTitle>Catalog</CardTitle>
          <CardDescription>
            Disabled versions remain inspectable for in-flight and historical
            pins. Provider secrets never reach the browser.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {registry.configs.length === 0 ? (
            <EmptyState
              description="No model configs were returned."
              title="Catalog is empty"
            />
          ) : (
            <Table>
              <TableCaption>
                All immutable model configuration rows.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Pin</TableHead>
                  <TableHead scope="col">Provider</TableHead>
                  <TableHead scope="col">Surfaces</TableHead>
                  <TableHead scope="col">Credential</TableHead>
                  <TableHead scope="col">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {registry.configs.map((config) => (
                  <TableRow key={`${config.modelKey}-${config.version}`}>
                    <TableCell>
                      <span className="font-mono text-xs">
                        {config.modelKey}@{config.version}
                      </span>
                      <span className="block text-muted-foreground text-xs">
                        {config.displayName} ·{' '}
                        {config.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </TableCell>
                    <TableCell>
                      {config.providerSlug}
                      <span className="block text-muted-foreground text-xs">
                        {config.providerModelId}
                      </span>
                    </TableCell>
                    <TableCell>{config.surfaces.join(', ')}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          config.credentialConfigured
                            ? 'secondary'
                            : 'destructive'
                        }
                      >
                        {config.credentialEnv}:{' '}
                        {config.credentialConfigured ? '••••••••' : 'missing'}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(config.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Embedding workspace pins</CardTitle>
          <CardDescription>
            These providers must remain reachable for the lifetime of every
            listed workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {registry.embeddingWorkspaceCounts.length === 0 ? (
            <EmptyState
              description="No workspaces currently use an embedding pin."
              title="No embedding pins"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Pin</TableHead>
                  <TableHead className="text-right" scope="col">
                    Dimension
                  </TableHead>
                  <TableHead className="text-right" scope="col">
                    Workspaces
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {registry.embeddingWorkspaceCounts.map((item) => (
                  <TableRow key={`${item.modelKey}-${item.version}`}>
                    <TableCell className="font-mono text-xs">
                      {item.modelKey}@{item.version}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(item.dim)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(item.count)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {editable ? (
        <label
          className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 text-sm"
          htmlFor="embedding-acknowledgement"
        >
          <Checkbox
            checked={embeddingAcknowledged}
            id="embedding-acknowledgement"
            onCheckedChange={(checked) =>
              setEmbeddingAcknowledged(checked === true)
            }
          />
          <span>
            I understand that existing workspaces keep their current embedding
            model forever, its provider must remain reachable, and retrieval
            quality may differ by workspace creation date.
          </span>
        </label>
      ) : null}

      {selection ? (
        <CellDialog
          draft={draft}
          editable={editable}
          onChange={setDraft}
          onClose={() => setSelection(null)}
          onNewVersion={(source) =>
            setNewVersion({
              cell: selection,
              config: {
                ...newDraftConfig(source),
                modelKey: source?.modelKey ?? selection.rowKey,
              },
            })
          }
          registry={registry}
          selection={selection}
        />
      ) : null}
      {newVersion ? (
        <DraftDialog
          initial={newVersion.config}
          onClose={() => setNewVersion(null)}
          onSave={(config) => {
            const next = cloneDraft(draft);
            next.drafts.set(config.id, config);
            if (newVersion.cell) {
              next.cells.set(
                cellId(newVersion.cell.rowKey, newVersion.cell.surface),
                {
                  isDefault:
                    next.cells.get(
                      cellId(newVersion.cell.rowKey, newVersion.cell.surface)
                    )?.isDefault ?? false,
                  rowKey: config.modelKey,
                  surface: newVersion.cell.surface,
                  target: { draftId: config.id, kind: 'draft' },
                }
              );
            }
            setDraft(next);
            setNewVersion(null);
            setSelection(null);
          }}
        />
      ) : null}
      {blocker.status === 'blocked' ? (
        <Dialog open>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Discard the registry draft?</DialogTitle>
              <DialogDescription>
                Unsaved grid changes will be lost.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => blocker.reset()} variant="outline">
                Keep editing
              </Button>
              <Button onClick={() => blocker.proceed()} variant="destructive">
                Discard and leave
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

export function RegistryPage() {
  const { api } = useOpsApp();
  const { data, error, isError, isPending, refetch } = useQuery({
    queryFn: api.registry,
    queryKey: ['ops', 'registry'],
    refetchInterval: POLL_INTERVAL,
  });
  if (isPending) {
    return <PageSkeleton />;
  }
  if (isError || !data) {
    return <ErrorState error={error} onRetry={() => refetch()} />;
  }
  return <RegistryEditor registry={data} />;
}
