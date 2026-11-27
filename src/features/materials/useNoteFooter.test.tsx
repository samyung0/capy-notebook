import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it } from 'vitest';
import { qk } from '@/api/client';
import type { Provenance } from '@/api/types';
import { getLocale } from '@/i18n';

// As FileBanner.test: the locale first, then the document react-dom/client reads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
const { createRoot } = await import('react-dom/client');
const { useNoteFooter } = await import('./useNoteFooter');

const credit = (title: string): Provenance => ({
  books: [
    {
      authors: ['Author'],
      excerptIds: ['e_1'],
      id: title,
      license: 'CC BY 4.0',
      title,
      version: 1,
    },
  ],
});

const titles = (provenance: Provenance | undefined) =>
  provenance?.books?.map((book) => book.title);

async function render(client: QueryClient, Probe: () => null) {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )
  );
  return root;
}

// Q904: the footer once observed the embed's read with no query function,
// which stripped the embed block's own and failed its retry.
it("leaves the embed's read its own query function and error handling", async () => {
  const client = new QueryClient();
  const queryFn = () =>
    Promise.resolve({ provenance: credit('Embedded book') });
  let footer: Provenance | undefined;
  const root = await render(client, () => {
    useQuery({
      meta: { errorBoundary: false },
      queryFn,
      queryKey: qk.quiz('q1'),
    });
    footer = useNoteFooter({ provenance: credit('Own book') }, 'quiz:q1');
    return null;
  });
  await act(async () => {
    await client.getQueryCache().find({ queryKey: qk.quiz('q1') })?.promise;
  });
  expect(titles(footer)).toContain('Embedded book');
  const query = client.getQueryCache().find({ queryKey: qk.quiz('q1') });
  expect(query?.options.queryFn).toBe(queryFn);
  expect(query?.meta).toEqual({ errorBoundary: false });
  await act(async () => root.unmount());
});

it("uses the note read's credits until the embed's read answers", async () => {
  const client = new QueryClient();
  let footer: Provenance | undefined;
  const root = await render(client, () => {
    footer = useNoteFooter(
      { embedCredits: { s1: credit('Stored book') } },
      'flashcards:s1'
    );
    return null;
  });
  expect(titles(footer)).toEqual(['Stored book']);
  await act(async () => {
    client.setQueryData(qk.material('s1'), {
      provenance: credit('Fresh book'),
    });
  });
  expect(titles(footer)).toEqual(['Fresh book']);
  await act(async () => root.unmount());
});
