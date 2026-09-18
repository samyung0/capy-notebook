import type { CSSProperties } from 'react';
import sprite from '@/assets/catppuccin.svg?no-inline';

/** Symbol ids in src/assets/catppuccin.svg. */
export const FILE_ICON_NAMES = [
  '_folder',
  '_folder_open',
  '_file',
  'pdf',
  'ms-word',
  'markdown',
  'markdown-mdx',
  'image',
  'text',
  'ms-excel',
  'ms-powerpoint',
  'audio',
  'video',
  'json',
  'typescript',
  'typescript-react',
  'javascript',
  'javascript-react',
  'html',
  'css',
  'sass',
  'less',
  'vue',
  'svelte',
  'graphql',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'c',
  'c-header',
  'cpp',
  'cpp-header',
  'csharp',
  'ruby',
  'php',
  'dart',
  'scala',
  'lua',
  'r',
  'julia',
  'haskell',
  'elixir',
  'erlang',
  'clojure',
  'zig',
  'bash',
  'powershell',
  'batch',
  'database',
  'proto',
  'http',
  'yaml',
  'toml',
  'xml',
  'csv',
  'properties',
  'env',
  'lock',
  'jupyter',
  'asciidoc',
  'latex',
  'org',
  'typst',
  'log',
  'diff',
  'license',
  'readme',
  'docker',
  'makefile',
  'cmake',
  'gradle',
  'git',
  'zip',
  'exe',
  'font',
  'binary',
  'svg',
  'stackblitz',
  'java-enum',
  'forgejo',
  'drawio',
] as const;

export type FileIconName = (typeof FILE_ICON_NAMES)[number];

/** Colored Catppuccin file/material glyph. The sprite's paths are stroke-only
 * and inherit `strokeWidth` and the `--ctp-*` palette from the page. */
export function FileIcon({
  name,
  strokeWidth = 1.3,
  className,
  style,
}: {
  name: FileIconName;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden
      className={className}
      strokeWidth={strokeWidth}
      style={{ display: 'block', flex: '0 0 auto', ...style }}
      viewBox="0 0 16 16"
    >
      <use href={`${sprite}#${name}`} />
    </svg>
  );
}
