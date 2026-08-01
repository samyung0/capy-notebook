import { useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';

/** Word (.docx) viewer. docx-preview is imported on demand so it stays out of
 * the main bundle. Legacy binary .doc files are not supported. */
export default function DocxView({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const [{ renderAsync }, buf] = await Promise.all([
          import('docx-preview'),
          fetch(url).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          }),
        ]);
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        await renderAsync(buf, containerRef.current, undefined, {
          ignoreHeight: true,
          ignoreWidth: false,
          inWrapper: true,
        });
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state === 'error') {
    return (
      <p className="py-8 text-center text-tint-error-fg">
        Couldn't load this document.
      </p>
    );
  }
  return (
    <div className="mx-auto max-w-full">
      {state === 'loading' && <Skeleton className="h-[60vh] w-full" />}
      <div
        className="[&_.docx-wrapper>section.docx]:mb-4 [&_.docx-wrapper>section.docx]:max-w-full [&_.docx-wrapper>section.docx]:shadow-none [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-0"
        ref={containerRef}
      />
    </div>
  );
}
