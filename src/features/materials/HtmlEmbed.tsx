/* Interactive HTML block (`html_embed`). The snippet runs only inside a frame
 * sandboxed to `allow-scripts`, loaded from VITE_EMBED_ORIGIN: a separate site,
 * so the snippet gets its own process, no access to the app and, by the
 * wrapper's CSP (embed/_headers), no network. Protocol with embed/index.html:
 * on load the host posts {type: 'render', html, theme, font} once, `font`
 * being the app's Fustat bytes (the frame cannot fetch them); the frame posts
 * back only {type: 'resize', height}. A frame navigated away (to a page
 * without that CSP) is removed. SECURITY.md attack path 11. */
import fustat from '@fontsource-variable/fustat/files/fustat-latin-wght-normal.woff2?url';
import { type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { MERMAID_CAPTION_CLASS } from '@/features/notes/nodeStyles';
import { m } from '@/i18n';
import { ThemeContext } from '@/theme/theme';
import { MediaFrame } from './MediaFrame';

/** The variables a snippet may use, read from the app's theme tokens. The
 * agent guidance names the same ones (agenttools.go). */
const THEME_TOKENS = {
  '--accent': '--action-accent-bg',
  '--bg': '--surface-page',
  '--border': '--border-default',
  '--fg': '--text-primary',
  '--font': '--font-sans',
  '--muted': '--text-muted',
} as const;
const MIN_HEIGHT = 32;
const MAX_HEIGHT = 600;
const INITIAL_HEIGHT = 240;
/** The page this load already scrolled to for `?block=`. */
let scrolledFor = '';
/** The same file the app's own CSS loads, so the browser cache serves it. A
 * failed fetch renders the snippet in the frame's default font. */
let fontBytes: Promise<ArrayBuffer | undefined> | undefined;
const loadFont = () => {
  fontBytes ??= fetch(fustat)
    .then((response) => (response.ok ? response.arrayBuffer() : undefined))
    .catch(() => undefined);
  return fontBytes;
};

/** The theme variables plus `--scheme`, the app's light or dark, which the
 * frame's base sheet uses as its color-scheme so the frame stays see-through. */
function frameTheme(element: Element): Record<string, string> {
  const style = getComputedStyle(element);
  return {
    ...Object.fromEntries(
      Object.entries(THEME_TOKENS).map(([name, token]) => [
        name,
        style.getPropertyValue(token).trim(),
      ])
    ),
    '--scheme': style.colorScheme,
  };
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
      onLoad={(event) => {
        loads.current += 1;
        if (loads.current > 2) onNavigate();
        if (loads.current !== 1) return;
        const frame = event.currentTarget;
        const theme = frameTheme(frame);
        loadFont().then((font) =>
          // The frame's origin is opaque, so no narrower target exists.
          frame.contentWindow?.postMessage(
            { font, html, theme, type: 'render' },
            '*'
          )
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

/** The block's frame, toolbar and caption. The frame loads with the page and
 * stays loaded, so it never reloads or resizes while the reader scrolls; a
 * theme change or a new snippet reloads it, and a snippet that navigates its
 * frame gets a notice in its place. */
export function HtmlEmbed({
  caption,
  html,
  id,
  toolbar,
}: {
  caption?: string;
  html: string;
  id: string;
  toolbar?: ReactNode;
}) {
  const origin: string | undefined = import.meta.env.VITE_EMBED_ORIGIN;
  const theme = useContext(ThemeContext);
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  // The frame mounts after hydration on shared pages: a server-rendered one
  // could finish loading before React listens, and never get its snippet.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // The snippet that navigated its frame stays stopped until it changes.
  const [stopped, setStopped] = useState<string | null>(null);
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
  return (
    <div ref={ref}>
      <MediaFrame fill toolbar={toolbar}>
        {!origin || stopped === html ? (
          <p className="p-3 text-fg-muted text-sm">
            {origin ? m.html_embed_navigated() : m.html_embed_not_configured()}
          </p>
        ) : mounted ? (
          <EmbedFrame
            height={height}
            html={html}
            key={`${theme?.theme}:${theme?.style}:${html}`}
            onHeight={setHeight}
            onNavigate={() => setStopped(html)}
            origin={origin}
            title={caption || m.editor_export_interactive()}
          />
        ) : (
          <div style={{ height }} />
        )}
      </MediaFrame>
      {caption && <p className={MERMAID_CAPTION_CLASS}>{caption}</p>}
    </div>
  );
}
