import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
} from 'react';
import remarkMath from 'remark-math';
import type { MathPlugin } from 'streamdown';
import { defaultRehypePlugins, Streamdown } from 'streamdown';
import { TableCell, TableFrame, TableHead, TableRow } from './ChatTable';
import { Cites } from './Cite';
import { CodeBlock } from './CodeBlock';
import { citedPassages, citeMarkers } from './citeMarkers';
import { MathSpan, prepareMath } from './math';

/* Streamdown and what it draws with: on demand, through `Prose` (text.tsx). */

interface HastNode {
  children?: HastNode[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
}

const isMathCode = (node: HastNode) =>
  node.type === 'element' &&
  node.tagName === 'code' &&
  Array.isArray(node.properties?.className) &&
  node.properties.className.includes('language-math');

const textOf = (node: HastNode): string =>
  node.type === 'text'
    ? (node.value ?? '')
    : (node.children ?? []).map(textOf).join('');

/** remark-math leaves `code.language-math` (inline) and `pre > code` (display). */
function rehypeChatMath() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      node.children?.forEach((child, index, siblings) => {
        const code =
          child.tagName === 'pre'
            ? child.children?.find(isMathCode)
            : isMathCode(child)
              ? child
              : undefined;
        if (!code) {
          visit(child);
          return;
        }
        siblings[index] = {
          children: [{ type: 'text', value: textOf(code) }],
          properties: { dataMath: code === child ? 'inline' : 'display' },
          tagName: 'span',
          type: 'element',
        } as HastNode;
      });
    };
    visit(tree);
  };
}

const chatMath: MathPlugin = {
  name: 'katex',
  rehypePlugin: rehypeChatMath,
  remarkPlugin: remarkMath,
  type: 'math',
};

const plugins = { math: chatMath };
const rehypePlugins = [...Object.values(defaultRehypePlugins), citeMarkers];
const TRAILING_NEWLINE = /\n$/;
const LANGUAGE_CLASS = /language-(\S+)/;

/** Streamdown marks a fenced block's `code` with `data-block` (via `pre`). */
function Code({
  className,
  children,
  ...props
}: ComponentProps<'code'> & { 'data-block'?: string }) {
  if ('data-block' in props) {
    return (
      <CodeBlock
        code={String(children ?? '').replace(TRAILING_NEWLINE, '')}
        language={LANGUAGE_CLASS.exec(className ?? '')?.[1]}
      />
    );
  }
  return (
    <code className="rounded bg-code-inline px-1 py-px font-mono text-[0.9em] text-code-inline-fg">
      {children}
    </code>
  );
}

function Heading({ children }: { children?: ReactNode }) {
  return (
    <h2 className="mt-3 font-semibold text-[17px] tracking-tight first:mt-0">
      {children}
    </h2>
  );
}

/** Inside a link, where an image is drawn as its alt text alone. */
const InLink = createContext(false);

function Link({ children, href }: ComponentProps<'a'>) {
  return (
    <a
      className="text-link underline underline-offset-3 hover:text-link-hover"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      <InLink value>{children}</InLink>
    </a>
  );
}

/** An answer draws no picture from a URL: an image becomes a link to it, as
 * in agent-written notes (inside a link, its alt text). */
function Image({ alt, src }: ComponentProps<'img'>) {
  const label = alt || src;
  return useContext(InLink) ? label : <Link href={src}>{label}</Link>;
}

const components = {
  a: Link,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="border-line border-l-2 pl-2.5 text-fg-secondary">
      {children}
    </blockquote>
  ),
  code: Code,
  h1: Heading,
  h2: Heading,
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mt-2 font-semibold text-[15px] first:mt-0">{children}</h3>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h4 className="mt-1 font-semibold text-sm first:mt-0">{children}</h4>
  ),
  img: Image,
  li: ({ children }: { children?: ReactNode }) => (
    <li className="[&+li]:mt-2 [&>p]:inline">{children}</li>
  ),
  ol: ({ children, start }: { children?: ReactNode; start?: number }) => (
    <ol
      className="ml-5 list-outside list-decimal whitespace-normal marker:[font-variant-numeric:normal]"
      start={start}
    >
      {children}
    </ol>
  ),
  // A `<picture>` source loads nothing.
  source: () => null,
  span: (props: ComponentProps<typeof MathSpan> & { 'data-cite'?: string }) =>
    props['data-cite'] === undefined ? (
      <MathSpan {...props} />
    ) : (
      <Cites passages={citedPassages(props['data-cite'])} />
    ),
  // Markdown tables take the chat's table look, without Streamdown's framed
  // card and its copy, download and full-screen buttons.
  table: TableFrame,
  tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
  td: TableCell,
  th: TableHead,
  thead: ({ children }: { children?: ReactNode }) => <thead>{children}</thead>,
  tr: TableRow,
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="ml-5 list-outside list-disc whitespace-normal">
      {children}
    </ul>
  ),
};

/** Markdown in a chat answer, with `$…$` / `$$…$$` math and `[#n]` citation
 * markers. Streamdown's root is `display: contents`, so its blocks sit in the
 * wrapper (`Prose`) with their 12px gap; a heading adds its own room above. */
export function ProseBody({ text }: { text: string }) {
  const source = useMemo(() => prepareMath(text), [text]);
  return (
    <Streamdown
      className="contents [&>*:not(:last-child)]:mb-4"
      components={components}
      plugins={plugins}
      rehypePlugins={rehypePlugins}
    >
      {source}
    </Streamdown>
  );
}
