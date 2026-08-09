import type {
  MaterialElement,
  MaterialText,
  MaterialValue,
} from '@/features/materials/document';

/** Lightweight builders for authored Plate note fixtures. */

export type TextLeaf = MaterialText;
/** Paragraph children may be text leaves or inline elements (link, mention, math). */
export type InlineChild = MaterialText | MaterialElement;

export function text(
  value: string,
  marks: Omit<TextLeaf, 'text'> = {}
): TextLeaf {
  return { ...marks, text: value };
}

export function p(
  children: InlineChild[] | string,
  extra: Record<string, unknown> = {}
) {
  return {
    children: typeof children === 'string' ? [text(children)] : children,
    type: 'p' as const,
    ...extra,
  };
}

export function heading(
  level: 1 | 2 | 3 | 4 | 5 | 6,
  value: string,
  extra: Record<string, unknown> = {}
) {
  return {
    children: [text(value)],
    type: `h${level}` as const,
    ...extra,
  };
}

export function bullet(value: string | InlineChild[], indent = 1) {
  return p(value, { indent, listStyleType: 'disc' });
}

export function numbered(value: string | InlineChild[], indent = 1) {
  return p(value, { indent, listStyleType: 'decimal' });
}

export function todo(
  value: string | InlineChild[],
  checked = false,
  indent = 1
) {
  return p(value, { checked, indent, listStyleType: 'todo' });
}

export function quote(value: string | InlineChild[]) {
  return {
    children: [p(value)],
    type: 'blockquote' as const,
  };
}

export function callout(
  value: string | InlineChild[],
  variant: 'info' | 'success' | 'warning' | 'danger' = 'info'
) {
  return {
    children: [p(value)],
    type: 'callout' as const,
    variant,
  };
}

export function codeBlock(lines: string[], lang = 'plaintext') {
  return {
    children: lines.map((line) => ({
      children: [text(line)],
      type: 'code_line' as const,
    })),
    lang,
    type: 'code_block' as const,
  };
}

export function hr() {
  return { children: [text('')], type: 'hr' as const };
}

export function toc() {
  return { children: [text('')], type: 'toc' as const };
}

export function link(label: string, url: string) {
  return {
    children: [text(label)],
    type: 'a' as const,
    url,
  };
}

export function mention(value: string) {
  return {
    children: [text('')],
    type: 'mention' as const,
    value,
  };
}

export function equation(texExpression: string) {
  return {
    children: [text('')],
    texExpression,
    type: 'equation' as const,
  };
}

export function inlineEquation(texExpression: string) {
  return {
    children: [text('')],
    texExpression,
    type: 'inline_equation' as const,
  };
}

export function youtube(videoId: string) {
  return {
    children: [text('')],
    provider: 'youtube' as const,
    type: 'video' as const,
    videoId,
  };
}

export function columns(
  widths: string[],
  cells: Array<string | ReturnType<typeof p>>
) {
  return {
    children: widths.map((width, index) => ({
      children: [
        typeof cells[index] === 'string'
          ? p(cells[index] as string)
          : ((cells[index] as ReturnType<typeof p>) ?? p('')),
      ],
      type: 'column' as const,
      width,
    })),
    type: 'column_group' as const,
  };
}

export function table(headers: string[], rows: string[][]) {
  return {
    children: [
      {
        children: headers.map((header) => ({
          children: [p(header)],
          type: 'th' as const,
        })),
        type: 'tr' as const,
      },
      ...rows.map((row) => ({
        children: row.map((cell) => ({
          children: [p(cell)],
          type: 'td' as const,
        })),
        type: 'tr' as const,
      })),
    ],
    type: 'table' as const,
  };
}

export type SeedNote = {
  chapterId: string | null;
  daysAgo: number;
  id: string;
  title: string;
  value: MaterialValue;
  workspaceId: string;
  workspaceName: string;
};
