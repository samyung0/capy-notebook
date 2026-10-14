import type { createLowlight } from 'lowlight';
import { type ReactNode, useEffect, useState } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';

type Lowlight = ReturnType<typeof createLowlight>;
type HastNode = ReturnType<Lowlight['highlight']>['children'][number];

// The notes' highlighter (highlight.js `common` languages), loaded with the
// first code block so chat does not carry it up front.
let loading: Promise<Lowlight> | undefined;
function loadLowlight() {
  loading ??= import('lowlight').then(({ common, createLowlight }) =>
    createLowlight(common)
  );
  return loading;
}

function render(nodes: HastNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value;
    if (node.type !== 'element') return null;
    const className = node.properties?.className;
    return (
      <span
        className={Array.isArray(className) ? className.join(' ') : undefined}
        key={index}
      >
        {render(node.children)}
      </span>
    );
  });
}

/** Highlighted tokens once the highlighter has loaded; plain text before, and
 * for languages it does not know. */
function useHighlighted(code: string, language?: string) {
  const [tokens, setTokens] = useState<ReactNode[] | null>(null);
  useEffect(() => {
    if (!language) {
      setTokens(null);
      return;
    }
    let live = true;
    loadLowlight().then((lowlight) => {
      if (!live) return;
      setTokens(
        lowlight.registered(language)
          ? render(lowlight.highlight(language, code).children)
          : null
      );
    });
    return () => {
      live = false;
    };
  }, [code, language]);
  return tokens;
}

const EXTENSIONS: Record<string, string> = {
  bash: 'sh',
  javascript: 'js',
  markdown: 'md',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  shell: 'sh',
  text: 'txt',
  typescript: 'ts',
};

function download(code: string, language?: string) {
  const ext = language ? (EXTENSIONS[language] ?? language) : 'txt';
  const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `code.${ext}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A fenced code block in a chat answer: one tinted block, the language and
 * its actions on a single row above the code. */
export function CodeBlock({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);
  const tokens = useHighlighted(code, language);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <div className="rounded-lg bg-page px-2.5 pt-1 pb-2.5">
      <div className="flex items-center gap-0.5 text-fg-muted text-xs">
        <span className="mr-auto font-mono lowercase">{language ?? ''}</span>
        <IconButton
          className="text-fg-muted hover:text-fg"
          icon="download"
          label={m.chat_code_download()}
          onClick={() => download(code, language)}
          size="xs"
        />
        <IconButton
          className="text-fg-muted hover:text-fg"
          icon={copied ? 'check' : 'copy'}
          label={copied ? m.editor_code_copied() : m.editor_copy_code()}
          onClick={() =>
            navigator.clipboard.writeText(code).then(
              () => setCopied(true),
              () => setCopied(false)
            )
          }
          size="xs"
        />
      </div>
      <pre className="hljs-tokens overflow-x-auto font-mono text-[13px] leading-relaxed">
        <code>{tokens ?? code}</code>
      </pre>
    </div>
  );
}
