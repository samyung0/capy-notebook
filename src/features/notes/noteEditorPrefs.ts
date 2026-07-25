import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/* ============================================================
   Per-user note-editor widget preferences. Users choose which optional Plate
   widget groups are visible in command surfaces. All parser and renderer
   plugins remain registered so hiding a command can never hide document data.
   ============================================================ */

export type WidgetGroupId =
  | 'table'
  | 'callout'
  | 'columns'
  | 'math'
  | 'media'
  | 'toc'
  | 'fontStyles'
  | 'quiz'
  | 'flashcards'
  | 'mermaid';

export interface WidgetGroupMeta {
  description: string;
  id: WidgetGroupId;
  label: string;
}

/** Display metadata for the settings popover. Order here = order in the UI.
 * These are the *optional* widgets; core editing (paragraphs, headings, marks,
 * lists, links, code, images, markdown, history, AI) is always available. */
export const WIDGET_GROUPS: WidgetGroupMeta[] = [
  { description: 'Grid tables with header rows', id: 'table', label: 'Tables' },
  { description: 'Highlighted note boxes', id: 'callout', label: 'Callouts' },
  { description: 'Multi-column layouts', id: 'columns', label: 'Columns' },
  {
    description: 'Inline and block equations (KaTeX)',
    id: 'math',
    label: 'Math',
  },
  { description: 'Image embeds', id: 'media', label: 'Media' },
  {
    description: 'Document outline block',
    id: 'toc',
    label: 'Table of contents',
  },
  {
    description: 'Color, size, alignment',
    id: 'fontStyles',
    label: 'Font styling',
  },
  { description: 'Embedded quizzes', id: 'quiz', label: 'Quiz blocks' },
  {
    description: 'Embedded flashcards',
    id: 'flashcards',
    label: 'Flashcard blocks',
  },
  { description: 'Mermaid diagrams', id: 'mermaid', label: 'Diagrams' },
];

type EnabledMap = Record<WidgetGroupId, boolean>;

const ALL_ENABLED: EnabledMap = WIDGET_GROUPS.reduce((acc, g) => {
  acc[g.id] = true;
  return acc;
}, {} as EnabledMap);

interface NoteEditorPrefsState {
  enabled: EnabledMap;
  setAll: (value: boolean) => void;
  setEnabled: (enabled: EnabledMap) => void;
  toggle: (id: WidgetGroupId) => void;
}

export const useNoteEditorPrefs = create<NoteEditorPrefsState>()(
  persist(
    (set) => ({
      enabled: { ...ALL_ENABLED },
      setAll: (value) =>
        set(() => ({
          enabled: WIDGET_GROUPS.reduce((acc, g) => {
            acc[g.id] = value;
            return acc;
          }, {} as EnabledMap),
        })),
      setEnabled: (enabled) => set({ enabled: { ...enabled } }),
      toggle: (id) =>
        set((s) => ({ enabled: { ...s.enabled, [id]: !s.enabled[id] } })),
    }),
    {
      // Merge persisted state with any newly-added groups (default on).
      merge: (persisted, current) => {
        const p = (persisted as Partial<NoteEditorPrefsState>) ?? {};
        return {
          ...current,
          ...p,
          enabled: { ...ALL_ENABLED, ...(p.enabled ?? {}) },
        };
      },
      name: 'evo-note-editor-prefs',
    }
  )
);

/** Stable preference summary used by diagnostics and tests. */
export function enabledKey(enabled: EnabledMap): string {
  return WIDGET_GROUPS.filter((g) => enabled[g.id])
    .map((g) => g.id)
    .join(',');
}
