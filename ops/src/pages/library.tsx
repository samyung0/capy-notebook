import { useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import type { LibraryExcerpt, LibraryExcerptFilters } from '@/api';
import { libraryRoles, OpsApiError } from '@/api';
import { useOpsApp } from '@/app-context';
import {
  EmptyState,
  ErrorState,
  FreshnessNote,
  PageHeader,
  PageLoading,
} from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatBytes, formatCount, formatDateTime } from '@/format';

function jsonText(value: unknown): string {
  return value === null || value === undefined ? '—' : JSON.stringify(value);
}

function pageRange(pages: number[]): string {
  if (pages.length === 0) {
    return '—';
  }
  const first = pages[0];
  const last = pages.at(-1);
  return first === last ? String(first) : `${first}–${last}`;
}

// Firefox ignores a click on a detached anchor, and revoking the object URL in
// the same tick cancels the download, so the anchor joins the document and the
// URL is released once the browser has started reading it.
function saveExport(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function FilterSelect({
  children,
  id,
  label,
  onChange,
  value,
}: {
  children: ReactNode;
  id: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        className="flex h-9 w-full min-w-[180px] rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value}
      >
        {children}
      </select>
    </div>
  );
}

function Locator({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-all font-mono text-xs">{value}</dd>
    </div>
  );
}

function ExcerptDrawer({
  excerptId,
  onClose,
}: {
  excerptId: string;
  onClose: () => void;
}) {
  const { api } = useOpsApp();
  const { data, error, isPending } = useQuery({
    queryFn: () => api.libraryExcerpt(excerptId),
    queryKey: ['library-excerpt', excerptId],
  });

  return (
    <Sheet onOpenChange={(open) => (open ? undefined : onClose())} open>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-3xl"
        side="right"
      >
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">{excerptId}</SheetTitle>
          <SheetDescription>
            Every locator a reviewer needs to find the source and reparse it.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-6 p-5 pt-0">
          {isPending ? <PageLoading label="Loading excerpt" /> : null}
          {error ? <ErrorState error={error} /> : null}
          {data ? (
            <>
              <dl className="grid grid-cols-2 gap-3 rounded-md border p-4 sm:grid-cols-3">
                <Locator label="Book version" value={data.book.version} />
                <Locator label="Book" value={data.book.title} />
                <Locator label="Book id" value={data.book.id} />
                <Locator label="Edition" value={data.book.edition || '—'} />
                <Locator label="Book sha256" value={data.book.sha256} />
                <Locator
                  label="First content page"
                  value={data.book.firstContentPage}
                />
                <Locator
                  label="Parser"
                  value={data.book.parserFingerprint || '—'}
                />
                <Locator label="Chunker" value={data.book.chunkerVersion} />
                <Locator label="Licence" value={data.book.license || '—'} />
                <Locator
                  label="PDF pages"
                  value={pageRange(data.excerpt.pages)}
                />
                <Locator label="Section" value={data.excerpt.sectionPath} />
                <Locator
                  label="Source"
                  value={
                    data.book.sourceUrl ? (
                      <a
                        className="underline"
                        href={data.book.sourceUrl}
                        rel="noreferrer noopener"
                        target="_blank"
                      >
                        {data.book.sourceUrl}
                      </a>
                    ) : (
                      '—'
                    )
                  }
                />
              </dl>

              <section className="space-y-2">
                <h3 className="font-medium text-sm">Tags</h3>
                <div className="flex flex-wrap gap-2">
                  {data.excerpt.roles.map((role) => (
                    <Badge key={role} variant="secondary">
                      {role}
                    </Badge>
                  ))}
                  {data.excerpt.topicIds.map((topic) => (
                    <Badge key={topic} variant="outline">
                      {topic}
                    </Badge>
                  ))}
                </div>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Locator label="Tag status" value={data.excerpt.tagStatus} />
                  <Locator
                    label="Evidence verified"
                    value={String(data.excerpt.evidenceVerified)}
                  />
                  <Locator
                    label="Confidence"
                    value={data.excerpt.confidence ?? '—'}
                  />
                  <Locator
                    label="Proposed topic"
                    value={data.excerpt.proposedTopic || '—'}
                  />
                  <Locator
                    label="Review reasons"
                    value={data.excerpt.reviewReasons.join(', ') || '—'}
                  />
                  <Locator label="Regions" value={jsonText(data.regions)} />
                </dl>
                <p className="rounded-md bg-muted/40 p-3 text-sm">
                  {data.evidence || 'No evidence quote was recorded.'}
                </p>
              </section>

              <section className="space-y-2">
                <h3 className="font-medium text-sm">
                  Chunks ({data.chunks.length})
                </h3>
                {data.chunks.map((chunk) => (
                  <article className="rounded-md border p-3" key={chunk.id}>
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Locator label="Chunk id" value={chunk.id} />
                      <Locator label="Index" value={chunk.index} />
                      <Locator
                        label="Pages"
                        value={`${chunk.pageStart ?? '—'}–${chunk.pageEnd ?? '—'}`}
                      />
                      <Locator
                        label="Confidence"
                        value={`${chunk.confidence ?? '—'} ${chunk.confidenceReasons.join(', ')}`}
                      />
                      <Locator
                        label="Searchable"
                        value={String(chunk.searchable)}
                      />
                      <Locator
                        label="Reference list"
                        value={String(chunk.reference)}
                      />
                      <Locator label="Language" value={chunk.lang} />
                      <Locator
                        label="Regions"
                        value={jsonText(chunk.regions)}
                      />
                    </dl>
                    <p className="mt-2 whitespace-pre-wrap text-sm">
                      {chunk.text}
                    </p>
                  </article>
                ))}
              </section>

              <section className="space-y-2">
                <h3 className="font-medium text-sm">
                  Figures ({data.figures.length})
                </h3>
                {data.figures.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    This excerpt references no figure.
                  </p>
                ) : (
                  data.figures.map((figure) => (
                    <dl
                      className="grid grid-cols-2 gap-3 rounded-md border p-3 sm:grid-cols-4"
                      key={figure.id}
                    >
                      <Locator label="Figure id" value={figure.id} />
                      <Locator label="Page" value={figure.page} />
                      <Locator
                        label="Box on the 0–1000 grid"
                        value={figure.bbox.join(', ')}
                      />
                      <Locator
                        label="Caption box"
                        value={figure.captionBbox?.join(', ') ?? '—'}
                      />
                      <Locator
                        label="Caption"
                        value={jsonText(figure.originalCaption)}
                      />
                      <Locator
                        label="Excluded"
                        value={`${figure.excluded} ${jsonText(figure.exclusionEvidence)}`}
                      />
                      <Locator
                        label="Capture"
                        value={figure.capturePath || '—'}
                      />
                      <Locator label="Geometry" value={figure.geometryKind} />
                    </dl>
                  ))
                )}
              </section>

              <section className="space-y-2">
                <h3 className="font-medium text-sm">Excerpt text</h3>
                <p className="whitespace-pre-wrap rounded-md border p-3 text-sm">
                  {data.text}
                </p>
              </section>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function BooksTab() {
  const { api } = useOpsApp();
  const [note, setNote] = useState('');
  const { data, error, isPending, refetch } = useQuery({
    queryFn: api.libraryBooks,
    queryKey: ['library-books'],
  });
  const { isPending: exportPending, mutate: runExport } = useMutation({
    mutationFn: ({ bookId, version }: { bookId: string; version: number }) =>
      api.libraryExport(bookId, version),
    onError: (failure: Error) => setNote(failure.message),
    onSuccess: (result) => {
      saveExport(result.blob, result.fileName);
      setNote(`${result.fileName} — sha256 ${result.digest}`);
    },
  });

  if (isPending) {
    return <PageLoading label="Loading books" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Books</CardTitle>
        <CardDescription>
          Source identity and licence for every book, then its publish history:
          the current version learners read, the retained versions behind it and
          the receipts of each. The export is the machine-readable record for an
          independent reviewer; its sha256 is printed after the download.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Book</TableHead>
              <TableHead>Licence</TableHead>
              <TableHead>Pages</TableHead>
              <TableHead>Current version</TableHead>
              <TableHead>Identity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((book) => (
              <Fragment key={book.id}>
                <TableRow>
                  <TableCell className="align-top">
                    <span className="block font-medium">{book.title}</span>
                    <span className="text-muted-foreground text-xs">
                      {book.edition} · {jsonText(book.authors)}
                    </span>
                  </TableCell>
                  <TableCell className="align-top text-sm">
                    {book.licenseUrl ? (
                      <a
                        className="underline"
                        href={book.licenseUrl}
                        rel="noreferrer noopener"
                        target="_blank"
                      >
                        {book.license}
                      </a>
                    ) : (
                      book.license
                    )}
                  </TableCell>
                  <TableCell className="align-top tabular-nums">
                    {formatCount(book.pages)}
                    <span className="block text-muted-foreground text-xs">
                      from {book.firstContentPage} · {formatBytes(book.bytes)}
                    </span>
                  </TableCell>
                  <TableCell className="align-top text-sm tabular-nums">
                    <Badge variant="secondary">v{book.version}</Badge>
                    <span className="block text-muted-foreground text-xs">
                      {formatCount(book.excerptCount)} excerpts ·{' '}
                      {formatCount(book.chunkCount)} chunks ·{' '}
                      {formatCount(book.figureCount)} figures
                    </span>
                  </TableCell>
                  <TableCell className="max-w-56 align-top">
                    <code className="block truncate font-mono text-xs">
                      {book.sha256}
                    </code>
                    <span className="break-all text-muted-foreground text-xs">
                      {book.contentId}
                    </span>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="pt-0" colSpan={5}>
                    <div className="space-y-2">
                      {book.versions.map((item) => (
                        <div
                          className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                          key={item.version}
                        >
                          <dl className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
                            <Locator
                              label="Version"
                              value={`v${item.version} · ${item.status}`}
                            />
                            <Locator
                              label="Published"
                              value={formatDateTime(item.publishedAt)}
                            />
                            <Locator
                              label="Source run"
                              value={item.sourceRun}
                            />
                            <Locator
                              label="Parser"
                              value={`${item.parserRelease} · ${item.parserFingerprint}`}
                            />
                            <Locator
                              label="Chunker"
                              value={item.chunkerVersion}
                            />
                            <Locator
                              label="Corpus"
                              value={item.corpusIdentity}
                            />
                            <Locator
                              label="Object"
                              value={item.objectKey || '—'}
                            />
                            <Locator label="Note" value={item.note || '—'} />
                          </dl>
                          <Button
                            disabled={exportPending}
                            onClick={() =>
                              runExport({
                                bookId: book.id,
                                version: item.version,
                              })
                            }
                            size="sm"
                            variant="outline"
                          >
                            <Download aria-hidden="true" />
                            JSON
                          </Button>
                        </div>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              </Fragment>
            ))}
          </TableBody>
        </Table>
        {note ? (
          <p className="mt-3 break-all font-mono text-muted-foreground text-xs">
            {note}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TopicsTab() {
  const { api } = useOpsApp();
  const { data, error, isPending, refetch } = useQuery({
    queryFn: api.libraryTopics,
    queryKey: ['library-topics'],
  });

  if (isPending) {
    return <PageLoading label="Loading topics" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Topic catalog</CardTitle>
        <CardDescription>
          Excerpts carrying each topic, by role, as retrievable / verified /
          total. Retrievable applies the curate confidence floor of 0.8 on top
          of a verified evidence quote; that is what curate-mode search returns.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Topic</TableHead>
              <TableHead>Scope</TableHead>
              {libraryRoles.map((role) => (
                <TableHead className="text-right" key={role}>
                  {role.replace('_', ' ')}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((topic) => (
              <TableRow key={topic.id}>
                <TableCell className="align-top">
                  <span className="block font-medium">{topic.label}</span>
                  <code className="font-mono text-muted-foreground text-xs">
                    {topic.id}
                  </code>
                  <span className="block text-muted-foreground text-xs">
                    {jsonText(topic.aliases)}
                  </span>
                </TableCell>
                <TableCell className="max-w-64 align-top text-muted-foreground text-xs">
                  {topic.scope}
                </TableCell>
                {libraryRoles.map((role) => (
                  <TableCell
                    className="text-right align-top tabular-nums"
                    key={role}
                  >
                    {topic.retrievableByRole[role] ?? 0}
                    <span className="text-muted-foreground">
                      /{topic.verifiedByRole[role] ?? 0}/
                      {topic.byRole[role] ?? 0}
                    </span>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ExcerptsTab() {
  const { api } = useOpsApp();
  const [filters, setFilters] = useState<LibraryExcerptFilters>({ page: 1 });
  const [selected, setSelected] = useState('');
  const { data: books } = useQuery({
    queryFn: api.libraryBooks,
    queryKey: ['library-books'],
  });
  const { data: topics } = useQuery({
    queryFn: api.libraryTopics,
    queryKey: ['library-topics'],
  });
  const { data, error, isPending, refetch } = useQuery({
    queryFn: () => api.libraryExcerpts(filters),
    queryKey: ['library-excerpts', filters],
  });

  function narrow(change: Partial<LibraryExcerptFilters>) {
    setFilters((current) => ({ ...current, ...change, page: 1 }));
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Excerpts</CardTitle>
        <CardDescription>
          One section of one book. Open a row for the chunk, figure and parser
          locators.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-end gap-4">
          <FilterSelect
            id="library-book"
            label="Book"
            onChange={(value) => narrow({ book: value })}
            value={filters.book ?? ''}
          >
            <option value="">Every book</option>
            {(books ?? []).map((book) => (
              <option key={book.id} value={book.id}>
                {book.title}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            id="library-topic"
            label="Topic"
            onChange={(value) => narrow({ topic: value })}
            value={filters.topic ?? ''}
          >
            <option value="">Every topic</option>
            {(topics ?? []).map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            id="library-role"
            label="Role"
            onChange={(value) => narrow({ role: value })}
            value={filters.role ?? ''}
          >
            <option value="">Every role</option>
            {libraryRoles.map((role) => (
              <option key={role} value={role}>
                {role.replace('_', ' ')}
              </option>
            ))}
          </FilterSelect>
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-accent">
            <input
              checked={filters.review ?? false}
              className="size-4 accent-primary"
              onChange={(event) =>
                narrow({ review: event.currentTarget.checked })
              }
              type="checkbox"
            />
            Needs review only
          </label>
        </div>

        {isPending ? <PageLoading label="Loading excerpts" /> : null}
        {error ? (
          <ErrorState error={error} retry={() => void refetch()} />
        ) : null}
        {data ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Excerpt</TableHead>
                  <TableHead>Book</TableHead>
                  <TableHead>Pages</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Topics</TableHead>
                  <TableHead>Tagging</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((excerpt: LibraryExcerpt) => (
                  <TableRow
                    className="cursor-pointer"
                    key={excerpt.id}
                    onClick={() => setSelected(excerpt.id)}
                  >
                    <TableCell className="max-w-72 align-top">
                      <span className="block font-medium">
                        {excerpt.sectionPath}
                      </span>
                      <code className="font-mono text-muted-foreground text-xs">
                        {excerpt.id}
                      </code>
                      <span className="block text-muted-foreground text-xs">
                        {excerpt.synopsis}
                      </span>
                    </TableCell>
                    <TableCell className="align-top text-sm">
                      {excerpt.bookTitle}
                    </TableCell>
                    <TableCell className="align-top tabular-nums">
                      {pageRange(excerpt.pages)}
                    </TableCell>
                    <TableCell className="align-top text-xs">
                      {excerpt.roles.join(', ')}
                    </TableCell>
                    <TableCell className="align-top text-xs">
                      {excerpt.topicIds.join(', ')}
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge
                        variant={
                          excerpt.evidenceVerified &&
                          excerpt.reviewReasons.length === 0
                            ? 'secondary'
                            : 'outline'
                        }
                      >
                        {excerpt.tagStatus}
                        {excerpt.evidenceVerified ? '' : ' · unverified'}
                      </Badge>
                      <span className="block text-muted-foreground text-xs">
                        {excerpt.confidence ?? '—'}
                        {excerpt.reviewReasons.length > 0
                          ? ` · ${excerpt.reviewReasons.join(', ')}`
                          : ''}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {data.items.length === 0 ? (
              <EmptyState
                description="No excerpt matches these filters in the live library."
                title="No excerpts"
              />
            ) : null}
            <div className="flex items-center justify-between gap-3 border-t pt-4">
              <p className="text-muted-foreground text-sm tabular-nums">
                {formatCount(data.total)} excerpts · page {data.page} of{' '}
                {Math.max(1, Math.ceil(data.total / data.pageSize))}
              </p>
              <div className="flex gap-2">
                <Button
                  disabled={data.page <= 1}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      page: Math.max(1, (current.page ?? 1) - 1),
                    }))
                  }
                  size="sm"
                  variant="outline"
                >
                  Previous
                </Button>
                <Button
                  disabled={data.page * data.pageSize >= data.total}
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      page: (current.page ?? 1) + 1,
                    }))
                  }
                  size="sm"
                  variant="outline"
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        ) : null}
        {selected ? (
          <ExcerptDrawer excerptId={selected} onClose={() => setSelected('')} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function ModelRunsTab() {
  const { api } = useOpsApp();
  const { data, error, isPending, refetch } = useQuery({
    queryFn: api.libraryModelRuns,
    queryKey: ['library-model-runs'],
  });

  if (isPending) {
    return <PageLoading label="Loading model runs" />;
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle>Model runs</CardTitle>
        <CardDescription>
          Builder receipts of every book's current version: which model produced
          each stage, through which transport, at what usage and cost.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <EmptyState
            description="No published book version recorded a model run."
            title="No model runs"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Book</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Results</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((run) => (
                <TableRow key={`${run.bookId}-${run.stage}`}>
                  <TableCell className="align-top text-sm">
                    {run.bookId}
                    <span className="block text-muted-foreground text-xs">
                      v{run.version}
                    </span>
                  </TableCell>
                  <TableCell className="align-top font-medium">
                    {run.stage}
                  </TableCell>
                  <TableCell className="align-top text-sm">
                    {run.model}
                    <span className="block text-muted-foreground text-xs">
                      {run.transport}
                    </span>
                  </TableCell>
                  <TableCell className="align-top tabular-nums">
                    {run.attempts}
                  </TableCell>
                  <TableCell className="max-w-64 break-all align-top font-mono text-xs">
                    {jsonText(run.usage)}
                  </TableCell>
                  <TableCell className="align-top tabular-nums">
                    {run.approximateCostUsd === null
                      ? '—'
                      : `$${run.approximateCostUsd.toFixed(2)}`}
                  </TableCell>
                  <TableCell className="align-top text-muted-foreground text-xs">
                    {run.requestStartUtc || '—'} → {run.requestEndUtc || '—'}
                  </TableCell>
                  <TableCell className="max-w-56 break-all align-top font-mono text-xs">
                    {run.resultsPath}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function LibraryPage() {
  const { api } = useOpsApp();
  const [tab, setTab] = useState('books');
  const { data, error, isPending, refetch } = useQuery({
    queryFn: api.libraryOverview,
    queryKey: ['library'],
  });

  if (isPending) {
    return <PageLoading label="Loading the knowledge library" />;
  }
  if (error instanceof OpsApiError && error.status === 404) {
    return (
      <>
        <PageHeader
          description="Read-only review of the shared knowledge library."
          title="Library"
        />
        <EmptyState
          description="This deployment has no OPS_LIBRARY_DATABASE_URL, so no library database is reachable."
          title="Library not configured"
        />
      </>
    );
  }
  if (error || !data) {
    return <ErrorState error={error} retry={() => void refetch()} />;
  }

  return (
    <>
      <PageHeader
        actions={
          <FreshnessNote>
            One live library; the loader writes, this section only reads. Data
            as of {formatDateTime(data.dataAsOf)}.
          </FreshnessNote>
        }
        description="Books with their version history, topics, excerpts, chunks, figures and builder receipts, with the locators a reviewer needs to find the source and reparse it."
        title="Library"
      />

      {data.books > 0 ? (
        <>
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Live library</CardTitle>
              <CardDescription>
                What curate mode reads right now: every book at its current
                version. Retained versions stay exportable from the Books tab.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 rounded-md border p-4 sm:grid-cols-3 lg:grid-cols-5">
                <Locator label="Books" value={formatCount(data.books)} />
                <Locator label="Topics" value={formatCount(data.topics)} />
                <Locator label="Excerpts" value={formatCount(data.excerpts)} />
                <Locator label="Chunks" value={formatCount(data.chunks)} />
                <Locator label="Figures" value={formatCount(data.figures)} />
              </dl>
            </CardContent>
          </Card>

          <Tabs onValueChange={setTab} value={tab}>
            <TabsList aria-label="Library section">
              <TabsTrigger value="books">Books</TabsTrigger>
              <TabsTrigger value="topics">Topics</TabsTrigger>
              <TabsTrigger value="excerpts">Excerpts</TabsTrigger>
              <TabsTrigger value="model-runs">Model runs</TabsTrigger>
            </TabsList>
          </Tabs>

          {tab === 'books' ? <BooksTab /> : null}
          {tab === 'topics' ? <TopicsTab /> : null}
          {tab === 'excerpts' ? <ExcerptsTab /> : null}
          {tab === 'model-runs' ? <ModelRunsTab /> : null}
        </>
      ) : (
        <EmptyState
          description="The library database holds no published book yet."
          title="No books"
        />
      )}
    </>
  );
}
