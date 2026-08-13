import { m } from '@/i18n';

export type CalloutVariant = 'danger' | 'info' | 'success' | 'warning';

export const CALLOUT_VARIANTS: readonly {
  label: string;
  value: CalloutVariant;
}[] = [
  {
    get label() {
      return m.editor_callout_info();
    },
    value: 'info',
  },
  {
    get label() {
      return m.editor_callout_success();
    },
    value: 'success',
  },
  {
    get label() {
      return m.editor_callout_warning();
    },
    value: 'warning',
  },
  {
    get label() {
      return m.editor_callout_danger();
    },
    value: 'danger',
  },
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
  if (typeof value !== 'string' || !value) return m.editor_code_plain_text();
  if (value === 'auto') return m.editor_code_auto_detect();
  if (value === 'plaintext') return m.editor_code_plain_text();
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
  {
    get label() {
      return m.editor_columns_equal_2();
    },
    value: 'equal-2',
    widths: ['50%', '50%'],
  },
  {
    get label() {
      return m.editor_columns_equal_3();
    },
    value: 'equal-3',
    widths: ['33.333%', '33.333%', '33.334%'],
  },
  {
    get label() {
      return m.editor_columns_left_wide();
    },
    value: 'left-wide',
    widths: ['66.667%', '33.333%'],
  },
  {
    get label() {
      return m.editor_columns_right_wide();
    },
    value: 'right-wide',
    widths: ['33.333%', '66.667%'],
  },
];
