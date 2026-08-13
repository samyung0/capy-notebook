import { lazy, Suspense, useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';

const MaterialPreview = lazy(() =>
  import('@/features/materials/MaterialPreview').then((mod) => ({
    default: mod.MaterialPreview,
  }))
);

/** Markdown / plain-text / JSON viewer. Prefers inline `content` (legacy paste)
 * and otherwise fetches the stored blob. */
export default function TextView({
  content,
  markdown,
  url,
}: {
  content?: string | null;
  markdown?: boolean;
  url?: string;
}) {
  const [text, setText] = useState<string | null>(
    content == null ? null : content
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    if (content != null) {
      setText(content);
      setError(false);
      return;
    }
    if (!url) {
      setText(null);
      setError(true);
      return;
    }
    let cancelled = false;
    setText(null);
    setError(false);
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [content, url]);

  if (error) {
    return (
      <p className="py-8 text-center text-tint-error-fg">
        {m.files_text_failed()}
      </p>
    );
  }
  if (text == null) {
    return <Skeleton className="h-[60vh] w-full" />;
  }
  if (markdown) {
    return (
      <Suspense fallback={<Skeleton className="h-[60vh] w-full" />}>
        <MaterialPreview className="mx-auto max-w-175" content={text} />
      </Suspense>
    );
  }
  return (
    <article className="mx-auto max-w-175 whitespace-pre-wrap p-6 text-[0.95rem] text-fg leading-relaxed">
      {text}
    </article>
  );
}
