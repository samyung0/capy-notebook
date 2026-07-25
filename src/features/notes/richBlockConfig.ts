export type CalloutVariant = 'danger' | 'info' | 'success' | 'warning';

export const CALLOUT_VARIANTS: readonly {
  label: string;
  value: CalloutVariant;
}[] = [
  { label: 'Info', value: 'info' },
  { label: 'Success', value: 'success' },
  { label: 'Warning', value: 'warning' },
  { label: 'Danger', value: 'danger' },
];

export function normalizeCalloutVariant(value: unknown): CalloutVariant {
  return CALLOUT_VARIANTS.some((variant) => variant.value === value)
    ? (value as CalloutVariant)
    : 'info';
}

export const CALLOUT_VARIANT_CLASS: Record<CalloutVariant, string> = {
  danger: 'border-solid-error bg-tint-error text-tint-error-fg',
  info: 'border-solid-info bg-tint-info text-tint-info-fg',
  success: 'border-solid-success bg-tint-success text-tint-success-fg',
  warning: 'border-solid-warning bg-tint-warning text-tint-warning-fg',
};

export const CODE_BLOCK_LANGUAGES = [
  { label: 'Auto detect', value: 'auto' },
  { label: 'Plain Text', value: 'plaintext' },
  { label: 'Arduino', value: 'arduino' },
  { label: 'Bash', value: 'bash' },
  { label: 'C', value: 'c' },
  { label: 'C#', value: 'csharp' },
  { label: 'C++', value: 'cpp' },
  { label: 'CSS', value: 'css' },
  { label: 'Diff', value: 'diff' },
  { label: 'Go', value: 'go' },
  { label: 'GraphQL', value: 'graphql' },
  { label: 'HTML / XML', value: 'xml' },
  { label: 'INI', value: 'ini' },
  { label: 'Java', value: 'java' },
  { label: 'JavaScript', value: 'javascript' },
  { label: 'JSON', value: 'json' },
  { label: 'Kotlin', value: 'kotlin' },
  { label: 'Less', value: 'less' },
  { label: 'Lua', value: 'lua' },
  { label: 'Makefile', value: 'makefile' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'Objective-C', value: 'objectivec' },
  { label: 'Perl', value: 'perl' },
  { label: 'PHP', value: 'php' },
  { label: 'Python', value: 'python' },
  { label: 'R', value: 'r' },
  { label: 'Ruby', value: 'ruby' },
  { label: 'Rust', value: 'rust' },
  { label: 'SCSS', value: 'scss' },
  { label: 'Shell', value: 'shell' },
  { label: 'SQL', value: 'sql' },
  { label: 'Swift', value: 'swift' },
  { label: 'TypeScript', value: 'typescript' },
  { label: 'Visual Basic', value: 'vbnet' },
  { label: 'WebAssembly', value: 'wasm' },
  { label: 'YAML', value: 'yaml' },
] as const;

export function getCodeBlockLanguageLabel(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'Plain text';
  return (
    CODE_BLOCK_LANGUAGES.find((language) => language.value === value)?.label ??
    value
  );
}

export interface ColumnLayout {
  label: string;
  value: 'equal-2' | 'equal-3' | 'left-wide' | 'right-wide';
  widths: string[];
}

export const COLUMN_LAYOUTS: readonly ColumnLayout[] = [
  { label: 'Two equal columns', value: 'equal-2', widths: ['50%', '50%'] },
  {
    label: 'Three equal columns',
    value: 'equal-3',
    widths: ['33.333%', '33.333%', '33.334%'],
  },
  {
    label: 'Two columns, 2:1',
    value: 'left-wide',
    widths: ['66.667%', '33.333%'],
  },
  {
    label: 'Two columns, 1:2',
    value: 'right-wide',
    widths: ['33.333%', '66.667%'],
  },
];
