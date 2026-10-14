import { useIsStreaming } from '@openuidev/react-lang';
import { useEffect, useState } from 'react';
import { HTML_EMBED_MAX_BYTES, htmlBytes } from '@/features/materials/document';
import { HtmlEmbed } from '@/features/materials/HtmlEmbed';
import { m } from '@/i18n';
import type { HtmlEmbedProps } from '../schema';
import { CiteFooter } from './Cite';

/** While the answer streams, the frame mounts only once the html has stopped
 * changing for this long, so a half-written snippet is not run on every chunk. */
const SETTLE_MS = 1000;

/** The notes' sandboxed html-embed frame, under the same 64 KB cap. */
export function ChatHtmlEmbed({
  props,
  statementId,
}: {
  props: HtmlEmbedProps;
  statementId?: string;
}) {
  const streaming = useIsStreaming();
  const html = typeof props.html === 'string' ? props.html.trim() : '';
  const [settled, setSettled] = useState(streaming ? '' : html);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(html), streaming ? SETTLE_MS : 0);
    return () => clearTimeout(timer);
  }, [html, streaming]);
  const drawn = streaming ? settled : html;
  return (
    <figure className="flex flex-col gap-1.5">
      {htmlBytes(drawn) > HTML_EMBED_MAX_BYTES ? (
        <p className="text-fg-muted text-sm">{m.html_embed_too_large()}</p>
      ) : drawn ? (
        <HtmlEmbed
          caption={props.title}
          html={drawn}
          id={`chat-${statementId ?? ''}`}
        />
      ) : (
        <div className="grid h-40 place-items-center text-fg-muted">
          <span className="text-xs">{m.chat_interactive_pending()}</span>
        </div>
      )}
      <CiteFooter passages={props.passages} />
    </figure>
  );
}
