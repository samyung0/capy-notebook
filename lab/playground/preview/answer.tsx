/* One chat answer as the app draws it, at /preview/answer.html, through
 * MarkdownAnswer. ui.html posts {format, content, citations} into the frame
 * once it says it is ready, and sizes the frame from the heights it posts
 * back; a citation click asks the page to open that source. */
import '@/styles/tailwind.css';
import 'streamdown/styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Citation } from '@/api/types';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { MarkdownAnswer } from '@/features/workspace/chat/MarkdownAnswer';
import { ThemeProvider } from '@/theme/ThemeProvider';

interface Shown {
  citations: Citation[];
  content: string;
}

const post = (message: object) => parent.postMessage(message, location.origin);

function Answer() {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin === location.origin && event.source === parent)
        setShown(event.data as Shown);
    };
    addEventListener('message', receive);
    post({ type: 'answer-ready' });
    const observer = new ResizeObserver(() =>
      post({ height: document.body.scrollHeight, type: 'answer-height' })
    );
    observer.observe(document.body);
    return () => {
      removeEventListener('message', receive);
      observer.disconnect();
    };
  }, []);
  if (!shown) return null;
  const open = (citation: Citation) =>
    post({ n: citation.n, type: 'open-citation' });
  return (
    <MarkdownAnswer
      citations={shown.citations}
      complete
      content={shown.content}
      latest={false}
      onOpenCitation={open}
      streaming={false}
    />
  );
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    // Library figures load through React Query, as in the app's chat.
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>
        <TooltipProvider>
          <div className="p-1 text-fg">
            <Answer />
          </div>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
