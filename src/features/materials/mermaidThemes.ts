import { m } from '@/i18n';

/** Mermaid block themes; the configs live in mermaidPresets, loaded with mermaid. */
export const MERMAID_THEMES = [
  'linearLight',
  'linearDark',
  'brutalist',
  'handDrawn',
  'kawaii',
] as const;

export type MermaidTheme = (typeof MERMAID_THEMES)[number];

/** Blocks without a stored theme (server-generated ones), exports, and new
 * users until they pick a default in the editor settings. */
export const DEFAULT_MERMAID_THEME: MermaidTheme = 'linearLight';

export function mermaidTheme(
  value: unknown,
  fallback: MermaidTheme = DEFAULT_MERMAID_THEME
): MermaidTheme {
  return MERMAID_THEMES.includes(value as MermaidTheme)
    ? (value as MermaidTheme)
    : fallback;
}

export const MERMAID_THEME_LABEL: Record<MermaidTheme, () => string> = {
  brutalist: m.mermaid_theme_brutalist,
  handDrawn: m.mermaid_theme_hand_drawn,
  kawaii: m.mermaid_theme_kawaii,
  linearDark: m.mermaid_theme_linear_dark,
  linearLight: m.mermaid_theme_linear_light,
};

/** Panel, node fill and node border, for the theme menu swatches. */
export const MERMAID_THEME_SWATCH: Record<
  MermaidTheme,
  [panel: string, fill: string, border: string]
> = {
  brutalist: ['#f6f3e9', '#ffffff', '#000000'],
  handDrawn: ['#fffef9', '#ffffff', '#1a1a1a'],
  kawaii: ['#fff5f8', '#ffe9f5', '#ff9ec7'],
  linearDark: ['#09090b', '#18181b', '#27272a'],
  // Darker than the theme's #e5e5e5 node border so the swatch reads at 16px.
  linearLight: ['#ffffff', '#ffffff', '#a1a1aa'],
};
