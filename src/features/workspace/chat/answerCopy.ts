/**
 * Copying a chat answer into a note. The browser's own copy holds the
 * rendered DOM, which pastes as loose paragraphs (callouts, steps, charts and
 * math lost), so a copy inside one answer also writes ANSWER_CLIPBOARD_TYPE:
 * the selection as note Markdown. Only the blocks holding the selection's two
 * ends can be partly selected; every block between them is whole and comes
 * from its OpenUI props (every tab, a closed reveal's body, a chart's data).
 * A partly selected block is read from the DOM up to the selection's end and
 * keeps its block shape. Charts, plots, embeds and formulas copy whole once
 * touched; citations, buttons and asked questions are left out.
 */

import type { ClipboardEvent } from 'react';
import { HTML_EMBED_MAX_BYTES, htmlBytes } from '@/features/materials/document';
import {
  type CalloutVariant,
  normalizeCalloutVariant,
} from '@/features/notes/richBlockConfig';
import { chartBlock, plotBlock } from './answer';
import { ANSWER_CLIPBOARD_TYPE, type CopiedBlock } from './answerClipboard';
import { type ElementNode, elements } from './blocks/Cite';
import { prepareMath } from './blocks/math';
import type {
  AccordionItemProps,
  CardProps,
  ChartProps,
  HtmlEmbedProps,
  PlotProps,
  RowProps,
  StepProps,
  TableProps,
  TabProps,
} from './schema';

type Props = Record<string, unknown>;
type Out = string | { callout: CalloutVariant; md: string };

/** Each rendered block's element (a `display: contents` wrapper) and node. */
const rendered = new WeakMap<Element, ElementNode<Props>>();

export function registerBlock(
  element: Element | null,
  typeName: string,
  props: Props
) {
  if (element)
    rendered.set(element, { partial: false, props, type: 'element', typeName });
}

/** Blocks that copy whole once the selection touches them. */
const ATOMIC = new Set(['Chart', 'Plot', 'HtmlEmbed']);

const PUNCTUATION = /[!-/:-@[-`{-~]/g;
const PADDED = /^(\s*)([\s\S]*?)(\s*)$/;
const BACKTICKS = /`+/g;
const NEWLINE = /\n/g;
const WHITESPACE = /\s+/g;
const HEADING = /^H([1-6])$/;
const URL_UNSAFE = /[<>\s]/g;
/** Markdown escapes every ASCII punctuation mark, so text stays text. */
const escapeText = (text: string) => text.replace(PUNCTUATION, '\\$&');
/** `md` between `marker`s, its edge spaces kept outside; nothing when empty. */
const mark = (md: string, marker: string) => {
  const [, before, body, after] = md.match(PADDED)!;
  return body ? `${before}${marker}${body}${marker}${after}` : md;
};
const strong = (md: string) => mark(md, '**');
const title = (text: unknown) =>
  typeof text === 'string' && text.trim()
    ? strong(escapeText(text.trim()))
    : '';
const prose = (text: unknown) =>
  typeof text === 'string' ? prepareMath(text).trim() : '';
const join = (parts: string[]) => parts.filter(Boolean).join('\n\n');

/** The longest run of backticks in `text`. */
const longestTicks = (text: string) =>
  Math.max(0, ...(text.match(BACKTICKS) ?? []).map((run) => run.length));

function fence(lang: string, body: string) {
  const ticks = '`'.repeat(Math.max(3, longestTicks(body) + 1));
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

const listItem = (marker: string, body: string) =>
  `${marker} ${body.replace(NEWLINE, `\n${' '.repeat(marker.length + 1)}`)}`;

function gfmTable(header: string[], rows: string[][]) {
  const line = (cells: string[]) =>
    `| ${header.map((_, index) => cells[index] || ' ').join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join(
    '\n'
  );
}

const children = (value: unknown) => elements<Props>(value).flatMap(fromNode);

/** A whole block, from its props. */
function fromNode(node: ElementNode<Props>): Out[] {
  const props = node.props;
  switch (node.typeName) {
    case 'Md':
      return [prose(props.text)];
    case 'Callout':
      return [
        {
          callout: normalizeCalloutVariant(props.kind),
          md: join([title(props.title), prose(props.text)]),
        },
      ];
    case 'Reveal':
      return [title(props.title), prose(props.text)];
    case 'Steps':
      return [
        elements<StepProps>(props.items)
          .map((step, index) =>
            listItem(
              `${index + 1}.`,
              join([title(step.props.title), prose(step.props.text)])
            )
          )
          .join('\n'),
      ];
    case 'Cards':
      return elements<CardProps>(props.items).flatMap((card) => [
        card.props.value
          ? `${title(`${card.props.title}:`)} ${escapeText(card.props.value)}`
          : title(card.props.title),
        prose(card.props.text),
      ]);
    case 'Table': {
      const table = props as unknown as TableProps;
      const cells = (row: string[]) =>
        row.map((cell) => escapeText(String(cell)).replace(WHITESPACE, ' '));
      return [
        title(table.caption),
        gfmTable(
          cells(table.columns ?? []),
          elements<RowProps>(table.rows).map((row) => cells(row.props.cells))
        ),
      ];
    }
    case 'Tabs':
      return elements<TabProps>(props.items).flatMap((tab) => [
        title(tab.props.label),
        ...children(tab.props.children),
      ]);
    case 'Accordion':
      return elements<AccordionItemProps>(props.items).flatMap((item) => [
        title(item.props.title),
        ...children(item.props.children),
      ]);
    case 'Chart': {
      const block = chartBlock(props as unknown as ChartProps);
      return block ? [fence('chart', JSON.stringify(block))] : [];
    }
    case 'Plot': {
      const block = plotBlock(props as unknown as PlotProps);
      return block ? [fence('plot', JSON.stringify(block))] : [];
    }
    case 'HtmlEmbed': {
      const embed = props as unknown as HtmlEmbedProps;
      const html = typeof embed.html === 'string' ? embed.html.trim() : '';
      if (!html || htmlBytes(html) > HTML_EMBED_MAX_BYTES) return [];
      // JSON is YAML, which the html-embed fence reads.
      return [
        fence(
          'html-embed',
          JSON.stringify(
            embed.title ? { caption: embed.title, html } : { html }
          )
        ),
      ];
    }
    default:
      // AskUser, and items their container reads.
      return [];
  }
}

/** The part of `node` inside the range. */
function clip(range: Range, node: Node) {
  const part = document.createRange();
  part.selectNodeContents(node);
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0)
    part.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0)
    part.setEnd(range.endContainer, range.endOffset);
  return part;
}

/** All of the element's text is selected. */
const covers = (range: Range, element: Element) =>
  clip(range, element).toString().trim() === (element.textContent ?? '').trim();

const skipped = (element: Element) =>
  element.tagName === 'BUTTON' ||
  element.tagName === 'svg' ||
  element.hasAttribute('data-copy-skip');

const BLOCK_TAGS =
  /^(?:P|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|DL|DETAILS|SUMMARY|DIV|FIGURE|SECTION|HR)$/;
const isBlock = (element: Element) =>
  BLOCK_TAGS.test(element.tagName) ||
  rendered.has(element) ||
  element.hasAttribute('data-display');

/** A run of inline content as Markdown. */
function inline(node: Node, range: Range): string {
  if (node.nodeType === Node.TEXT_NODE) {
    let text = (node as Text).data;
    if (node === range.endContainer) text = text.slice(0, range.endOffset);
    if (node === range.startContainer) text = text.slice(range.startOffset);
    return escapeText(text.replace(WHITESPACE, ' '));
  }
  if (!(node instanceof Element) || skipped(node)) return '';
  const tex = node.getAttribute('data-tex');
  if (tex !== null) return `$${tex}$`;
  const inner = () => inlines(node, range);
  switch (node.tagName) {
    case 'STRONG':
    case 'B':
      return strong(inner());
    case 'EM':
    case 'I':
      return mark(inner(), '*');
    case 'DEL':
    case 'S':
      return mark(inner(), '~~');
    case 'BR':
      return '\\\n';
    case 'CODE': {
      const code = clip(range, node).toString();
      if (!code) return '';
      const ticks = '`'.repeat(longestTicks(code) + 1);
      return `${ticks} ${code} ${ticks}`;
    }
    case 'A': {
      const href = (node.getAttribute('href') ?? '').replace(
        URL_UNSAFE,
        encodeURIComponent
      );
      return href ? `[${inner()}](<${href}>)` : inner();
    }
    default:
      return node.getAttribute('data-streamdown') === 'strong'
        ? strong(inner())
        : inner();
  }
}

function inlines(parent: Node, range: Range) {
  let md = '';
  for (const child of parent.childNodes)
    if (range.intersectsNode(child)) md += inline(child, range);
  return md;
}

/** The selected part of the element's children, block by block. */
function blocks(parent: Node, range: Range): Out[] {
  const out: Out[] = [];
  let line = '';
  const flush = () => {
    if (line.trim()) out.push(line.trim());
    line = '';
  };
  for (const child of parent.childNodes) {
    if (!range.intersectsNode(child)) continue;
    if (child instanceof Element && !skipped(child) && isBlock(child)) {
      flush();
      out.push(...block(child, range));
    } else line += inline(child, range);
  }
  flush();
  return out;
}

const texts = (out: Out[]) =>
  out.filter((part): part is string => typeof part === 'string');

function block(element: Element, range: Range): Out[] {
  const node = rendered.get(element);
  if (node) {
    if (ATOMIC.has(node.typeName) || covers(range, element))
      return fromNode(node);
    if (node.typeName === 'AskUser') return [];
    if (node.typeName === 'Callout')
      return [
        {
          callout: normalizeCalloutVariant(node.props.kind),
          md: join(texts(blocks(element, range))),
        },
      ];
    return blocks(element, range);
  }
  const tex = element.getAttribute('data-tex');
  if (tex !== null) return [`$$\n${tex}\n$$`];
  const lang = element.getAttribute('data-copy-code');
  if (lang !== null) {
    const pre = element.querySelector('pre');
    return pre ? [fence(lang, clip(range, pre).toString())] : [];
  }
  if (element.getAttribute('data-copy') === 'strong')
    return [strong(inlines(element, range).trim())];
  const heading = HEADING.exec(element.tagName);
  if (heading)
    return [`${'#'.repeat(Number(heading[1]))} ${inlines(element, range)}`];
  switch (element.tagName) {
    case 'P':
      return [inlines(element, range)];
    case 'HR':
      return ['---'];
    case 'UL':
    case 'OL':
      return [list(element, range)];
    case 'BLOCKQUOTE':
      return [
        join(texts(blocks(element, range)))
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
      ];
    case 'PRE':
      return [fence('', clip(range, element).toString())];
    case 'TABLE':
      return table(element, range);
    default:
      return blocks(element, range);
  }
}

function list(element: Element, range: Range) {
  const ordered = element.tagName === 'OL';
  let number = Number(element.getAttribute('start') ?? 1);
  const items: string[] = [];
  for (const item of element.children) {
    if (item.tagName !== 'LI') continue;
    const marker = ordered ? `${number++}.` : '-';
    if (!range.intersectsNode(item)) continue;
    const body = join(texts(blocks(item, range)));
    if (body) items.push(listItem(marker, body));
  }
  return items.join('\n');
}

/** Selected rows under the full header row. */
function table(element: Element, range: Range): string[] {
  const caption = element.querySelector('caption');
  const rows = [...element.querySelectorAll('tr')];
  const head = rows.find((row) => row.querySelector('th'));
  const cells = (row: Element, clipped: boolean) =>
    [...row.children].map((cell) =>
      (clipped
        ? inlines(cell, range)
        : escapeText(cell.textContent ?? '')
      ).replace(/\s+/g, ' ')
    );
  const body = rows
    .filter((row) => row !== head && range.intersectsNode(row))
    .map((row) => cells(row, true));
  const header = head ? cells(head, false) : body.shift();
  return [
    caption && range.intersectsNode(caption)
      ? strong(inlines(caption, range).trim())
      : '',
    header ? gfmTable(header, body) : '',
  ];
}

function copiedBlocks(out: Out[]): CopiedBlock[] {
  const copied: CopiedBlock[] = [];
  let md: string[] = [];
  const flush = () => {
    if (md.length) copied.push({ md: md.join('\n\n') });
    md = [];
  };
  for (const part of out) {
    if (typeof part === 'string') {
      if (part.trim()) md.push(part);
      continue;
    }
    flush();
    copied.push(part);
  }
  flush();
  return copied;
}

/** The selection within the answer: one ending past it in its own message's
 * model label or sources (a triple-click on the last line) stops at its end.
 * Null when the selection reaches anywhere else, leaving the copy to the
 * browser. */
function answerRange(root: Element, range: Range): Range | null {
  if (!root.contains(range.startContainer)) return null;
  if (root.contains(range.endContainer)) return range;
  const end = range.endContainer;
  const message = root.closest('[data-chat-message]');
  const element = end instanceof Element ? end : end.parentElement;
  if (!message?.contains(end) || element?.closest('[data-chat-answer]'))
    return null;
  const clamped = range.cloneRange();
  clamped.setEnd(root, root.childNodes.length);
  return clamped;
}

/** The copy's HTML for other apps: the selected DOM without its stylesheet,
 * so bold spans become `<strong>`, a formula its `$TeX$`, and controls go. */
function copiedHtml(range: Range) {
  const html = document.createElement('div');
  html.append(range.cloneContents());
  for (const skip of html.querySelectorAll('button, svg, [data-copy-skip]'))
    skip.remove();
  for (const formula of html.querySelectorAll('[data-tex]'))
    formula.replaceWith(`$${formula.getAttribute('data-tex')}$`);
  for (const bold of html.querySelectorAll('[data-streamdown="strong"]')) {
    const strongElement = document.createElement('strong');
    strongElement.append(...bold.childNodes);
    bold.replaceWith(strongElement);
  }
  return html.innerHTML;
}

/** onCopy of an answer (`data-chat-answer`): the selection's text, cleaned
 * HTML and its note blocks. */
export function copyAnswer(event: ClipboardEvent<HTMLElement>) {
  const selection = window.getSelection();
  if (selection?.rangeCount !== 1 || selection.isCollapsed) return;
  const range = answerRange(event.currentTarget, selection.getRangeAt(0));
  if (!range) return;
  const copied = copiedBlocks(blocks(event.currentTarget, range));
  if (!copied.length) return;
  event.preventDefault();
  event.clipboardData.setData('text/plain', range.toString());
  event.clipboardData.setData('text/html', copiedHtml(range));
  event.clipboardData.setData(ANSWER_CLIPBOARD_TYPE, JSON.stringify(copied));
}
