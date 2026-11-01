import { HTML_EMBED_MAX_BYTES, htmlBytes } from '@/features/materials/document';
import { HtmlEmbed } from '@/features/materials/HtmlEmbed';
import { m } from '@/i18n';
import { CiteFooter } from './Cite';

export interface HtmlEmbedProps {
  html: string;
  passages?: number[];
  title: string;
}

/** The notes' sandboxed html-embed frame, under the same 64 KB cap. Empty
 * html holds the frame's place while its fence streams. */
export function HtmlEmbedFigure({ props }: { props: HtmlEmbedProps }) {
  const html = props.html.trim();
  return (
    <figure className="flex flex-col gap-1.5">
      {htmlBytes(html) > HTML_EMBED_MAX_BYTES ? (
        <p className="text-fg-muted text-sm">{m.html_embed_too_large()}</p>
      ) : html ? (
        <HtmlEmbed caption={props.title} html={html} id="chat" />
      ) : (
        <div className="grid h-40 place-items-center text-fg-muted">
          <span className="text-xs">{m.chat_interactive_pending()}</span>
        </div>
      )}
      <CiteFooter passages={props.passages} />
    </figure>
  );
}
