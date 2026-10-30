/**
 * The Markdown answer format (pipeline/pipeline/prompts/answer_markdown.txt)
 * split into the parts the chat blocks draw: Markdown runs, callouts
 * (`> [!TIP] Title`), reveals (`<details>`), `:::tabs` and the figure
 * fences (chart, plot, html-embed) plus the trailing `ask` fence. Anything
 * else stays Markdown, so a half-streamed or unusual answer still reads.
 */

export const FIGURE_LANGS = ['chart', 'plot', 'html-embed', 'ask'] as const;
export type FigureLang = (typeof FIGURE_LANGS)[number];

export type Segment =
  | { type: 'md'; text: string }
  | { type: 'callout'; kind: string; title: string; text: string }
  | { type: 'reveal'; title: string; text: string }
  | { type: 'tabs'; tabs: { label: string; segments: Segment[] }[] }
  | {
      type: 'figure';
      lang: FigureLang;
      /** The rest of the fence line, e.g. `title="…" passages=2,4`. */
      info: string;
      body: string;
      /** The closing fence arrived. */
      closed: boolean;
    };

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w-]*)(.*)$/;
const CALLOUT = /^ {0,3}>[ \t]*\[!(\w+)\][ \t]*(.*)$/;
const QUOTED = /^ {0,3}>[ \t]?(.*)$/;
const TABS_OPEN = /^ {0,3}:::[ \t]*tabs[ \t]*$/;
const TAB = /^ {0,3}::tab\[(.*)\][ \t]*$/;
const CONTAINER_CLOSE = /^ {0,3}:::[ \t]*$/;
const DETAILS_OPEN = /^ {0,3}<details>/i;
const DETAILS_CLOSE = /<\/details>/i;
const SUMMARY = /<summary>([\s\S]*?)<\/summary>/i;
const ATTRIBUTE = /(\w+)=(?:"([^"]*)"|(\S+))/g;

function isFigure(lang: string): lang is FigureLang {
  return (FIGURE_LANGS as readonly string[]).includes(lang);
}

/** The line index of the fence closing one opened with `marker`, or -1. */
function closingFence(lines: string[], from: number, marker: string): number {
  const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
  for (let i = from; i < lines.length; i++) if (close.test(lines[i])) return i;
  return -1;
}

export function parseMarkdownAnswer(text: string): Segment[] {
  return parseLines(text.split('\n'), true);
}

function parseLines(lines: string[], allowTabs: boolean): Segment[] {
  const out: Segment[] = [];
  let md: string[] = [];
  const flush = () => {
    const joined = md.join('\n');
    if (joined.trim()) out.push({ text: joined, type: 'md' });
    md = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker, lang, info] = fence;
      const end = closingFence(lines, i + 1, marker);
      const stop = end === -1 ? lines.length : end;
      if (isFigure(lang)) {
        flush();
        out.push({
          body: lines.slice(i + 1, stop).join('\n'),
          closed: end !== -1,
          info: info.trim(),
          lang,
          type: 'figure',
        });
      } else {
        md.push(...lines.slice(i, end === -1 ? stop : end + 1));
      }
      i = end === -1 ? stop : end + 1;
      continue;
    }
    const callout = CALLOUT.exec(line);
    if (callout) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const quoted = QUOTED.exec(lines[i]);
        if (!quoted) break;
        body.push(quoted[1]);
      }
      out.push({
        kind: callout[1].toLowerCase(),
        text: body.join('\n'),
        title: callout[2].trim(),
        type: 'callout',
      });
      continue;
    }
    if (allowTabs && TABS_OPEN.test(line)) {
      flush();
      const tabs: { label: string; lines: string[] }[] = [];
      for (i++; i < lines.length && !CONTAINER_CLOSE.test(lines[i]); i++) {
        const tab = TAB.exec(lines[i]);
        if (tab) tabs.push({ label: tab[1].trim(), lines: [] });
        else tabs.at(-1)?.lines.push(lines[i]);
      }
      i++;
      out.push({
        tabs: tabs.map((tab) => ({
          label: tab.label,
          segments: parseLines(tab.lines, false),
        })),
        type: 'tabs',
      });
      continue;
    }
    if (DETAILS_OPEN.test(line)) {
      flush();
      let end = i;
      while (end < lines.length && !DETAILS_CLOSE.test(lines[end])) end++;
      const block = lines.slice(i, end + 1).join('\n');
      out.push({
        text: block
          .replace(DETAILS_OPEN, '')
          .replace(SUMMARY, '')
          .replace(DETAILS_CLOSE, '')
          .trim(),
        title: SUMMARY.exec(block)?.[1].trim() ?? '',
        type: 'reveal',
      });
      i = end + 1;
      continue;
    }
    md.push(line);
    i++;
  }
  flush();
  return out;
}

/** A fence line's `key=value` / `key="value"` attributes. */
export function fenceAttributes(info: string): Record<string, string> {
  return Object.fromEntries(
    [...info.matchAll(ATTRIBUTE)].map((match) => [
      match[1],
      match[2] ?? match[3],
    ])
  );
}
