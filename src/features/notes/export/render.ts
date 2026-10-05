const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PERCENT = /^\d+(\.\d+)?%$/;
const CSS_VALUE = /^[\w\s#(),.%'-]+$/;
const HEADING = /^h[1-6]$/;

import type { QuestionBlock } from '@/api/types';
import type {
  MaterialElement,
  MaterialNode,
  MaterialValue,
} from '@/features/materials/document';
import { type ExportLabels, isText, plain, questionBlocks } from './content';

export type ExportFormat = 'markdown' | 'docx';
export interface TocEntry {
  anchor: string;
  level: number;
  text: string;
}
export type Figure =
  | { type: 'math'; tex: string; display: boolean; html?: string }
  | { type: 'mermaid'; source: string }
  | { type: 'chart'; block: Extract<QuestionBlock, { type: 'chart' }> }
  | { type: 'image'; source: string }
  | { type: 'youtube'; videoId: string };
export interface ExportImage {
  data: string;
  height: number;
  width: number;
}
export type FigureRenderer = (figure: Figure) => Promise<ExportImage>;
export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const escapeMd = (value: string) =>
  value
    .replace(/[\\`*_{}[\]<>#|~]/g, '\\$&')
    .replace(/^(\s*)([-+]|\d+[.)]) /gm, '$1\\$2 ');
const field = (node: MaterialElement, key: string) =>
  typeof node[key] === 'string' ? (node[key] as string) : '';
const caption = (node: MaterialElement) =>
  Array.isArray(node.caption)
    ? (node.caption as MaterialNode[]).map(plain).join('')
    : '';
export function safeExportUrl(source: string): string {
  if (source.startsWith('#')) return source;
  const url = new URL(source);
  if (!['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol))
    throw new Error('Unsupported link protocol.');
  return url.href;
}
const fence = (source: string, language: string) => {
  const marker = '`'.repeat(
    Math.max(
      3,
      ...Array.from(source.matchAll(/`+/g), (match) => match[0].length + 1)
    )
  );
  return `${marker}${language.replace(/[\r\n`]/g, '')}\n${source}\n${marker}\n\n`;
};

/** Resized media stores a percentage of the block; exports cap images at 560px. */
function exportWidth(width: unknown) {
  if (typeof width === 'number') return width;
  if (typeof width === 'string' && width.endsWith('%'))
    return (560 * Number.parseFloat(width)) / 100;
}

export async function renderExport(
  value: MaterialValue,
  format: ExportFormat,
  labels: ExportLabels,
  assetUrls: Record<string, string>,
  noteUrl: string,
  renderFigure: FigureRenderer
) {
  const md = format === 'markdown';
  const files: Record<string, Uint8Array> = {};
  const images = new Map<
    string,
    { index: number; promise: Promise<ExportImage> }
  >();
  const headings: { node: MaterialElement; id: string }[] = [];
  const slugs = new Map<string, number>();
  const anchors = new Map<string, string>();
  const scan = (nodes: MaterialNode[]) =>
    nodes.forEach((node) => {
      if (isText(node)) return;
      if (HEADING.test(node.type)) {
        const base =
          plain(node)
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .replace(/\s/g, '-') || 'section';
        const count = slugs.get(base) || 0;
        slugs.set(base, count + 1);
        const slug = count ? `${base}-${count}` : base;
        const id = md ? slug : `_CapyHeading${headings.length + 1}`;
        headings.push({ id, node });
        anchors.set(`#${slug}`, `#${id}`);
      }
      scan(node.children);
    });
  scan(value);
  let tocCount = 0;
  let labelCount = 0;
  const headingIds = new Map(
    headings.map((heading) => [heading.node, heading.id])
  );
  const counts = new Map<number, number>();
  const listWidths = new Map<number, number>();
  const join = async (
    nodes: MaterialNode[],
    html = !md,
    tableCell = false
  ): Promise<string> => {
    const parts: string[] = [];
    for (const node of nodes) parts.push(await render(node, html, tableCell));
    return parts.join('');
  };
  async function picture(
    figure: Figure,
    alt: string,
    html: boolean,
    width?: number
  ) {
    const key = JSON.stringify(figure);
    let image = images.get(key);
    if (!image) {
      const index = images.size + 1;
      image = { index, promise: renderFigure(figure) };
      images.set(key, image);
    }
    const result = await image.promise;
    const imageWidth = Math.min(
      width || result.width,
      560,
      (440 * result.width) / result.height
    );
    const height = (imageWidth * result.height) / result.width;
    if (!md)
      return `<img src="${result.data}" alt="${escapeHtml(alt)}" style="width:${imageWidth}px;height:${height}px" width="${imageWidth}" height="${height}"/>`;
    const path = `assets/figure-${image.index}.png`;
    if (!files[path])
      files[path] = Uint8Array.from(atob(result.data.split(',')[1]), (char) =>
        char.charCodeAt(0)
      );
    return html
      ? `<img src="${path}" alt="${escapeHtml(alt)}"/>`
      : `![${escapeMd(alt)}](${path})`;
  }
  function link(text: string, source: string, html: boolean) {
    const url = safeExportUrl(anchors.get(source) || source);
    return html
      ? `<a href="${escapeHtml(url)}">${text}</a>`
      : `[${text}](<${url.replaceAll('>', '%3E')}>)`;
  }
  async function render(
    node: MaterialNode,
    html: boolean,
    tableCell = false
  ): Promise<string> {
    const esc = html ? escapeHtml : escapeMd;
    if (isText(node)) {
      let text = esc(node.text);
      if (html) {
        for (const [mark, tag] of [
          ['bold', 'b'],
          ['italic', 'i'],
          ['underline', 'u'],
          ['strikethrough', 's'],
          ['code', 'code'],
          ['kbd', 'code'],
          ['highlight', 'mark'],
          ['subscript', 'sub'],
          ['superscript', 'sup'],
        ])
          if (node[mark]) text = `<${tag}>${text}</${tag}>`;
        const styles = Object.entries({
          'background-color': node.backgroundColor,
          color: node.color,
          'font-family': node.fontFamily,
          'font-size':
            typeof node.fontSize === 'number'
              ? `${node.fontSize}px`
              : node.fontSize,
        })
          .filter(([, v]) => typeof v === 'string' && CSS_VALUE.test(v))
          .map(([k, v]) => `${k}:${v}`)
          .join(';');
        return `<span${styles ? ` style="${escapeHtml(styles)}"` : ''}>${text.replaceAll('\n', '<br/>')}</span>`;
      }
      if (node.code || node.kbd) {
        const ticks = '`'.repeat(
          Math.max(
            1,
            ...Array.from(
              node.text.matchAll(/`+/g),
              (match) => match[0].length + 1
            )
          )
        );
        text = `${ticks} ${tableCell ? node.text.replaceAll('|', '\\|') : node.text} ${ticks}`;
      }
      if (node.bold) text = `**${text}**`;
      if (node.italic) text = `*${text}*`;
      if (node.strikethrough) text = `~~${text}~~`;
      for (const [mark, tag] of [
        ['underline', 'u'],
        ['highlight', 'mark'],
        ['subscript', 'sub'],
        ['superscript', 'sup'],
      ])
        if (node[mark]) text = `<${tag}>${text}</${tag}>`;
      return text.replaceAll('\n', '<br/>');
    }
    const type = node.type;
    if (type === 'a')
      return link(
        await join(node.children, html, tableCell),
        field(node, 'url'),
        html
      );
    if (type === 'mention') return esc(`@${field(node, 'value')}`);
    if (type === 'inline_equation' || type === 'equation') {
      const tex = field(node, 'texExpression');
      const display = type === 'equation' || node.displayMode === true;
      if (md) return display ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
      const img = await picture({ display, tex, type: 'math' }, tex, true);
      return display ? `<p style="text-align:center">${img}</p>` : img;
    }
    if (HEADING.test(type))
      return html
        ? `<${type}><span id="${headingIds.get(node)}"></span>${await join(node.children, html)}</${type}>`
        : `${'#'.repeat(Number(type[1]))} ${await join(node.children, html)}\n\n`;
    if (type === 'toc') {
      // The converter preserves bookmarks on heading tags; makeDocx replaces this marker.
      if (!md) return `<h6><span id="_CapyToc${++tocCount}"></span></h6>`;
      return (
        (
          await Promise.all(
            headings.map(({ node: h, id }) =>
              html
                ? `<p>${link(escapeHtml(plain(h)), `#${id}`, true)}</p>`
                : `${'  '.repeat(Number(h.type[1]) - 1)}- ${link(escapeMd(plain(h)), `#${id}`, false)}\n`
            )
          )
        ).join('') + (html ? '' : '\n')
      );
    }
    if (type === 'p') {
      const level = Math.max(0, Number(node.indent) || 0);
      let marker = '';
      if (node.listStyleType) {
        const style = field(node, 'listStyleType');
        if (style === 'todo')
          marker = html
            ? node.checked
              ? '☑ '
              : '☐ '
            : node.checked
              ? '- [x] '
              : '- [ ] ';
        else if (['disc', 'circle', 'square'].includes(style))
          marker = html ? '• ' : '- ';
        else {
          const number =
            Number(node.listRestart || node.listStart) ||
            (counts.get(level) || 0) + 1;
          counts.set(level, number);
          marker = `${number}. `;
        }
        for (const depth of counts.keys())
          if (depth > level) counts.delete(depth);
      } else {
        counts.clear();
        listWidths.clear();
      }
      if (marker)
        listWidths.set(
          level,
          node.listStyleType === 'todo' ? 2 : marker.length
        );
      const indentation = Array.from(
        { length: Math.max(0, level - 1) },
        (_, i) => ' '.repeat(listWidths.get(i + 1) || 4)
      ).join('');
      let content = await join(node.children, html);
      if (node.exportBold)
        content = html ? `<b>${content}</b>` : `**${content}**`;
      const align = ['left', 'center', 'right', 'justify'].includes(
        field(node, 'align')
      )
        ? `text-align:${node.align};`
        : '';
      const tag = node.exportBold ? 'h6' : 'p';
      return html
        ? `<${tag} style="${align}${node.exportBold ? 'font-size:11pt;margin-top:4px;margin-bottom:4px;' : ''}margin-left:${level * 18}px">${node.exportBold ? `<span id="_CapyKeepNext${++labelCount}"></span>` : ''}${marker}${content || '<br/>'}</${tag}>`
        : `${indentation}${marker}${content.replaceAll('\n', `\n${indentation}${' '.repeat(marker.length)}`)}\n\n`;
    }
    if (type === 'hr') return html ? '<hr/>' : '---\n\n';
    if (type === 'blockquote') {
      const body = await join(node.children, html);
      return html
        ? `<blockquote>${body}</blockquote>`
        : body
            .trim()
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n') + '\n\n';
    }
    if (type === 'callout') {
      const variant = field(node, 'variant');
      const colors: Record<string, [string, string]> = {
        danger: ['#f9eeeb', '#b96558'],
        info: ['#eff6ff', '#3b82f6'],
        success: ['#eef5f0', '#5f9174'],
        tip: ['#f3effa', '#8c7bd9'],
        warning: ['#faf4e8', '#be963f'],
      };
      if (!colors[variant]) throw new Error(`Unsupported callout: ${variant}`);
      const [bg, border] = colors[variant];
      const body = await join(node.children, html);
      const label = esc(labels.callouts[variant]);
      return html
        ? `<table style="border:0;width:100%"><tr><td style="background-color:${bg};border:0;border-left:3px solid ${border};padding:12px"><p><b>${label}</b></p>${body}</td></tr></table>`
        : `> **${label}**\n>\n${body
            .trim()
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')}\n\n`;
    }
    if (type === 'code_block') {
      const text = node.children.map(plain).join('\n');
      return html
        ? `<p style="font-family:Consolas;background-color:#f5f4f2">${escapeHtml(text).replaceAll('\n', '<br/>')}</p>`
        : fence(text, field(node, 'lang'));
    }
    if (type === 'column_group') {
      if (!html)
        return (
          await Promise.all(
            node.children.map(
              async (column, i) =>
                `**${labels.column} ${i + 1}**\n\n${isText(column) ? '' : await join(column.children, false)}`
            )
          )
        ).join('');
      return `<table style="width:100%;border:0"><tr>${(
        await Promise.all(
          node.children.map(async (column) => {
            if (isText(column)) throw new Error('Invalid column.');
            const width = PERCENT.test(field(column, 'width'))
              ? column.width
              : `${100 / node.children.length}%`;
            return `<td style="width:${width};border:0;vertical-align:top">${await join(column.children, true)}</td>`;
          })
        )
      ).join('')}</tr></table>`;
    }
    if (type === 'table') {
      const rows = node.children as MaterialElement[];
      const simple = rows.every((row) =>
        row.children.every(
          (cell) =>
            !isText(cell) &&
            !cell.colSpan &&
            !cell.rowSpan &&
            cell.children.length === 1 &&
            'type' in cell.children[0] &&
            cell.children[0].type === 'p'
        )
      );
      if (!html && simple && rows.length) {
        const cells = await Promise.all(
          rows.map((row) =>
            Promise.all(
              row.children.map(async (cell) =>
                (isText(cell)
                  ? ''
                  : await join(
                      (cell.children[0] as MaterialElement).children,
                      false,
                      true
                    )
                )
                  .replaceAll('\n', '<br/>')
                  .replace(/(?<!\\)\|/g, '\\|')
              )
            )
          )
        );
        const width = Math.max(...cells.map((row) => row.length));
        const header = (rows[0].children as MaterialElement[]).every(
          (cell) => cell.type === 'th'
        );
        const rowText = (row: string[]) =>
          `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |\n`;
        return (
          rowText(header ? cells.shift()! : []) +
          rowText(new Array(width).fill('---')) +
          cells.map(rowText).join('') +
          '\n'
        );
      }
      return `<table style="border-collapse:collapse;width:100%">${await join(node.children, true)}</table>\n\n`;
    }
    if (type === 'tr') return `<tr>${await join(node.children, true)}</tr>`;
    if (type === 'td' || type === 'th')
      return `<${type} colspan="${Number(node.colSpan) || 1}" rowspan="${Number(node.rowSpan) || 1}" style="border:1px solid #dad8d3;padding:8px;vertical-align:top;${type === 'th' ? 'background-color:#f0eeea;' : ''}">${await join(node.children, true)}</${type}>`;
    if (type === 'video') {
      const videoId = field(node, 'videoId');
      if (node.provider !== 'youtube' || !VIDEO_ID.test(videoId))
        throw new Error('Unsupported video.');
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      if (md) return `${link(esc(labels.video), url, html)}\n\n`;
      return `<p>${link(esc(labels.video), url, true)}</p><p>${await picture({ type: 'youtube', videoId }, `capy-video:${videoId}`, true)}</p>`;
    }
    if (type === 'html_embed') {
      // The snippet never runs here or reaches the rasteriser: the export
      // links back to the block in the note.
      const url = new URL(noteUrl);
      url.searchParams.set('block', field(node, 'id'));
      return md
        ? `${link(esc(labels.interactive), url.href, html)}\n\n`
        : `<p>${link(escapeHtml(labels.interactive), url.href, true)}</p>`;
    }
    if (type === 'mermaid') {
      const source = field(node, 'source');
      const description = plain(node);
      return md
        ? `${description ? `${escapeMd(description)}\n\n` : ''}${fence(source, 'mermaid')}`
        : `<p>${await picture({ source, type: 'mermaid' }, description || 'Diagram', true)}</p><p>${escapeHtml(description)}</p>`;
    }
    if (type === 'chart' || type === 'graph') {
      const block = node.block as Extract<
        QuestionBlock,
        { type: 'chart' | 'graph' }
      >;
      if (block.type === 'graph') {
        const source =
          'svg' in block.image
            ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(block.image.svg)}`
            : safeExportUrl(block.image.url);
        return `${await picture({ source, type: 'image' }, block.description, html)}${html ? `<p>${escapeHtml(block.attribution || '')}</p>` : `\n\n${escapeMd(block.attribution || '')}\n\n`}`;
      }
      const table = questionBlocks([
        {
          header: true,
          rows: [
            ['', ...block.series.map((series) => series.name)],
            ...block.labels.map((label, i) => [
              label,
              ...block.series.map((series) => String(series.values[i])),
            ]),
          ],
          type: 'table',
        },
      ]);
      const title = [block.title, block.unit, block.xTitle, block.yTitle]
        .filter(Boolean)
        .join(' · ');
      return (
        (html
          ? `<p><b>${escapeHtml(title)}</b></p>`
          : `**${escapeMd(title)}**\n\n`) +
        (await picture({ block, type: 'chart' }, title, html)) +
        '\n\n' +
        (await join(table, html))
      );
    }
    if (['img', 'image', 'audio', 'file'].includes(type)) {
      const assetId = field(node, 'assetId');
      const source = assetId ? assetUrls[assetId] : field(node, 'url');
      if (!source) throw new Error('An attachment is unavailable.');
      const name = field(node, 'name') || caption(node) || type;
      if (type === 'audio' || type === 'file') {
        if (!md)
          return `<p>${link(escapeHtml(name), assetId ? noteUrl : source, true)}</p>`;
        const response = await fetch(source);
        if (!response.ok)
          throw new Error(`Attachment download failed (${response.status}).`);
        const path = `assets/${Object.keys(files).length + 1}-${name.replace(/[^\p{L}\p{N}._-]/gu, '_')}`;
        files[path] = new Uint8Array(await response.arrayBuffer());
        return `[${escapeMd(name)}](<${path}>)\n\n`;
      }
      return (
        (await picture(
          { source, type: 'image' },
          name,
          html,
          exportWidth(node.width)
        )) +
        (html
          ? `<p>${escapeHtml(caption(node))}</p>`
          : `\n\n${escapeMd(caption(node))}\n\n`)
      );
    }
    if (['code_line', 'column', 'mermaid_caption'].includes(type))
      return join(node.children, html);
    throw new Error(`Unsupported export block: ${type}.`);
  }
  // Preserve list numbering while asynchronous assets are prepared.
  const parts: string[] = [];
  for (const node of value) parts.push(await render(node, !md));
  const toc: TocEntry[] = headings.map(({ node, id }) => ({
    anchor: id,
    level: Number(node.type[1]),
    text: plain(node),
  }));
  return { content: parts.join(''), files, toc };
}
