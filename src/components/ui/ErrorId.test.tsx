import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { RouteErrorComponent } from '@/components/app/AppErrorBoundary';
import { FileError } from '@/features/files/FileStates';
import { unexpectedErrorId } from '@/lib/errors';
import { FormAlert } from './FormAlert';

const id = 'a'.repeat(32);
const unexpected = new ApiError(500, 'Internal Server Error', undefined, {
  detail: 'Something went wrong',
  traceId: id,
});
const typed = new ApiError(
  503,
  'Service Unavailable',
  undefined,
  { code: 'ai_unavailable' },
  id
);

const boundary = (error: unknown) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouteErrorComponent
        error={error as ErrorComponentProps['error']}
        reset={() => {}}
      />
    </QueryClientProvider>
  );

describe('the error id shows only for unexpected errors', () => {
  it('on a boundary screen', () => {
    expect(boundary(unexpected)).toContain(`Error ID: ${id}`);
    expect(boundary(typed)).not.toContain('data-testid="error-id"');
  });

  it('on a failed pane with Retry', () => {
    const pane = (error: ApiError) =>
      renderToStaticMarkup(
        <FileError errorId={unexpectedErrorId(error)} onRetry={() => {}} />
      );
    expect(pane(unexpected)).toContain(`Error ID: ${id}`);
    expect(pane(typed)).not.toContain('data-testid="error-id"');
  });

  it('in a form alert', () => {
    const alert = (error: ApiError) =>
      renderToStaticMarkup(
        <FormAlert errorId={unexpectedErrorId(error)} message="Failed" />
      );
    expect(alert(unexpected)).toContain(`Error ID: ${id}`);
    expect(alert(typed)).not.toContain('data-testid="error-id"');
  });
});

it('keeps the id out of the alert announcement and announces a copy politely', () => {
  const html = renderToStaticMarkup(
    <FormAlert errorId={id} message="Failed" />
  );
  expect(html).toMatch(
    new RegExp(`<span aria-hidden="true"[^>]*>Error ID: ${id}</span>`)
  );
  expect(html).toContain('role="status"');
});
