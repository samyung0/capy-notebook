import { useQuery, useQueryClient } from '@tanstack/react-query';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useRef, useState } from 'react';
import { pdfjs } from 'react-pdf';
import { fileLinksQuery } from '@/api/hooks';
import type { SourceFile, SourceUploadPolicy } from '@/api/types';
import { SourceAnalysisQueue } from '@/features/workspace/sourceAnalysis';
import { storedSourceAnalysisInput } from '@/features/workspace/sourceDetails';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Reads a PDF's page count from its cross-reference table alone: range
 * requests, no pages fetched. */
async function pdfPageCount(url: string) {
  const task = pdfjs.getDocument({
    disableAutoFetch: true,
    disableStream: true,
    url,
  });
  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy();
  }
}

/** At most this many files are opened at once for their counts. */
const COUNT_CONCURRENCY = 3;
let counting = 0;
const countWaiting: (() => void)[] = [];
async function oneAtATime<T>(work: () => Promise<T>) {
  if (counting >= COUNT_CONCURRENCY)
    await new Promise<void>((resolve) => countWaiting.push(resolve));
  counting += 1;
  try {
    return await work();
  } finally {
    counting -= 1;
    countWaiting.shift()?.();
  }
}

/** A file's page count, "16 pages" in the menus (boards X0a, X0b). Files have
 * no stored count, so the browser reads it: an image is one page, a PDF its
 * table, and a Word or PowerPoint file its usual upload analysis. Text and
 * files that won't open show no count. */
export function useFilePages(
  file:
    | Pick<SourceFile, 'id' | 'indexed' | 'kind' | 'name' | 'revision'>
    | undefined,
  policy: SourceUploadPolicy | undefined,
  enabled = true
) {
  const qc = useQueryClient();
  const kind = file?.kind;
  const office = kind === 'doc' || kind === 'slides';
  const { data } = useQuery({
    enabled:
      enabled && !!file?.indexed && (kind === 'pdf' || (office && !!policy)),
    gcTime: 10 * 60_000,
    queryFn: () =>
      oneAtATime(async () => {
        if (!file) return null;
        const { url } = await qc.fetchQuery(fileLinksQuery(file.id));
        if (kind === 'pdf') return pdfPageCount(url);
        const input = policy && storedSourceAnalysisInput(file, url, policy);
        if (!input) return null;
        const queue = new SourceAnalysisQueue();
        try {
          return (await queue.enqueue({ id: file.id, input }).promise)
            .pageCount;
        } finally {
          queue.dispose();
        }
      }),
    queryKey: ['file-pages', file?.id, file?.revision],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return kind === 'image' ? 1 : (data ?? undefined);
}

/** Whether a row has scrolled into view, once; a long file list opens only the
 * files it shows. */
export function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (seen || !element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}
