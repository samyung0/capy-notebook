/* Interactive HTML block (`html_embed`). The snippet runs only inside a frame
 * sandboxed to `allow-scripts`, loaded from VITE_EMBED_ORIGIN: a separate site,
 * so the snippet gets its own process, no access to the app and, by the
 * wrapper's CSP (embed/_headers), no network. Protocol with embed/index.html:
 * on load the host posts {type: 'render', html, theme} once; the frame posts
 * back only {type: 'resize', height}. A frame navigated away (to a page
 * without that CSP) is removed. SECURITY.md attack path 11. */
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { MERMAID_CAPTION_CLASS } from '@/features/notes/nodeStyles';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { ThemeContext } from '@/theme/theme';
import { MediaFrame } from './MediaFrame';

/** The variables a snippet may use, read from the app's theme tokens. The
 * agent guidance names the same ones (agenttools.go). */
const THEME_TOKENS = {
  '--accent': '--action-accent-bg',
  '--bg': '--surface-page',
  '--border': '--border-default',
  '--fg': '--text-primary',
  '--muted': '--text-muted',
} as const;
const MIN_HEIGHT = 32;
const MAX_HEIGHT = 2000;
const INITIAL_HEIGHT = 240;
const SCROLLING = /auto|scroll|overlay/;
/** The page this load already scrolled to for `?block=`. */
let scrolledFor = '';

function frameTheme(element: Element): Record<string, string> {
  const style = getComputedStyle(element);
  return Object.fromEntries(
    Object.entries(THEME_TOKENS).map(([name, token]) => [
      name,
      style.getPropertyValue(token).trim(),
    ])
  );
}

/** The height a message reports, or null unless it is a resize posted by
 * `frame`'s own window. */
export function frameResizeHeight(
  event: Pick<MessageEvent, 'data' | 'source'>,
  frame: Pick<HTMLIFrameElement, 'contentWindow'> | null
): number | null {
  if (!frame?.contentWindow || event.source !== frame.contentWindow)
    return null;
  const data = event.data as { height?: unknown; type?: unknown } | null;
  if (data?.type !== 'resize') return null;
  const { height } = data;
  if (typeof height !== 'number' || !Number.isFinite(height)) return null;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)));
}

/** The sandboxed frame. Load 1 is the wrapper, which then gets the snippet,
 * once; load 2 follows the wrapper's document.close() (embed/index.html
 * writes the snippet in place); any later load means the snippet navigated
 * its frame, or rewrote it, so `onNavigate` replaces the frame. */
export function EmbedFrame({
  height,
  html,
  onHeight,
  onNavigate,
  origin,
  title,
}: {
  height: number;
  html: string;
  onHeight: (height: number) => void;
  onNavigate: () => void;
  origin: string;
  title: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const next = frameResizeHeight(event, ref.current);
      if (next !== null) onHeight(next);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onHeight]);
  return (
    <iframe
      className="block w-full border-0"
      loading="lazy"
      onLoad={(event) => {
        loads.current += 1;
        if (loads.current > 2) onNavigate();
        if (loads.current !== 1) return;
        // The frame's origin is opaque, so no narrower target exists.
        event.currentTarget.contentWindow?.postMessage(
          { html, theme: frameTheme(event.currentTarget), type: 'render' },
          '*'
        );
      }}
      ref={ref}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      src={`${origin}/`}
      style={{ height }}
      title={title}
    />
  );
}

function scrollParent(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement)
    if (SCROLLING.test(getComputedStyle(node).overflowY)) return node;
  return null;
}

/** The block's frame, toolbar and caption. The frame mounts only within a
 * screen of the visible area and unmounts beyond it; a theme change or a new
 * snippet reloads it, and a snippet that navigates its frame gets a notice
 * in its place. */
export function HtmlEmbed({
  html,
  id,
  title,
  toolbar,
}: {
  html: string;
  id: string;
  title?: string;
  toolbar?: ReactNode;
}) {
  const origin: string | undefined = import.meta.env.VITE_EMBED_ORIGIN;
  const theme = useContext(ThemeContext);
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  // The snippet that navigated its frame stays stopped until it changes.
  const [stopped, setStopped] = useState<string | null>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box || !origin) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { root: scrollParent(box), rootMargin: '100% 0px' }
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [origin]);
  // Export links point here with `?block=<id>`.
  useEffect(() => {
    if (
      scrolledFor === location.href ||
      new URLSearchParams(location.search).get('block') !== id
    )
      return;
    scrolledFor = location.href;
    ref.current?.scrollIntoView({ block: 'center' });
  }, [id]);
  const label = title || m.html_embed_label();
  return (
    <div ref={ref}>
      <MediaFrame fill toolbar={toolbar}>
        <div className="overflow-hidden rounded-card border border-line">
          {!origin || stopped === html ? (
            <p className="p-3 text-fg-muted text-sm">
              {origin
                ? m.html_embed_navigated()
                : m.html_embed_not_configured()}
            </p>
          ) : near ? (
            <EmbedFrame
              height={height}
              html={html}
              key={`${theme?.theme}:${theme?.style}:${html}`}
              onHeight={setHeight}
              onNavigate={() => setStopped(html)}
              origin={origin}
              title={label}
            />
          ) : (
            <div style={{ height }} />
          )}
        </div>
      </MediaFrame>
      <p
        className={cn(
          MERMAID_CAPTION_CLASS,
          'flex items-center justify-center gap-2'
        )}
      >
        <span className="rounded-sm bg-tint-accent-1 px-1.5 text-tint-accent-1-fg text-xs">
          {m.html_embed_label()}
        </span>
        {title}
      </p>
    </div>
  );
}
