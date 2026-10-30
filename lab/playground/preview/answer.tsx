/* One chat answer as the app draws it, at /preview/answer.html: an OpenUI
 * program through LangAnswer, or the Markdown format through MarkdownAnswer
 * (the answer format switch in the playground's config). ui.html posts
 * {format, content, citations} into the frame once it says it is ready, and
 * sizes the frame from the heights it posts back; a citation click asks the
 * page to open that source. */
import '@/styles/tailwind.css';
import 'streamdown/styles.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Citation } from '@/api/types';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { LangAnswer } from '@/features/workspace/chat/LangAnswer';
import { MarkdownAnswer } from '@/features/workspace/chat/MarkdownAnswer';
import { ThemeProvider } from '@/theme/ThemeProvider';

interface Shown {
  citations: Citation[];
  content: string;
  format: 'markdown' | 'openui';
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
  return shown.format === 'markdown' ? (
    <MarkdownAnswer
      citations={shown.citations}
      content={shown.content}
      onOpenCitation={open}
    />
  ) : (
    <LangAnswer
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
    <ThemeProvider>
      <TooltipProvider>
        <div className="p-1 text-fg">
          <Answer />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
