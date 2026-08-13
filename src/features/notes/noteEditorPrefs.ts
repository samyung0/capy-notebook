import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { m } from '@/i18n';

/* ============================================================
  Per-user note-editor toolbar preferences. All parser and renderer plugins
  remain registered so hiding a command can never hide document data.
  ============================================================ */

export type EditorCommandGroup =
  | 'history'
  | 'fileOperations'
  | 'general'
  | 'fontStyles'
  | 'textDecorations'
  | 'inlineElements'
  | 'blockDecorations'
  | 'blockElements'
  | 'indentation';

export type WidgetGroupId = EditorCommandGroup;

export type EditorWidgetId =
  | 'table'
  | 'callout'
  | 'columns'
  | 'math'
  | 'media'
  | 'toc'
  | 'quiz'
  | 'flashcards'
  | 'mermaid';

export interface WidgetGroupMeta {
  defaultEnabled?: boolean;
  description: string;
  id: WidgetGroupId;
  label: string;
}

/** Display metadata for the settings popover. Order here = order in the UI. */
export const WIDGET_GROUPS: WidgetGroupMeta[] = [
  {
    get description() {
      return m.editor_prefs_history_desc();
    },
    id: 'history',
    get label() {
      return m.editor_prefs_history();
    },
  },
  {
    get description() {
      return m.editor_prefs_files_desc();
    },
    id: 'fileOperations',
    get label() {
      return m.editor_prefs_files();
    },
  },
  {
    get description() {
      return m.editor_prefs_general_desc();
    },
    id: 'general',
    get label() {
      return m.editor_prefs_general();
    },
  },
  {
    get description() {
      return m.editor_prefs_font_desc();
    },
    id: 'fontStyles',
    get label() {
      return m.editor_prefs_font();
    },
  },
  {
    get description() {
      return m.editor_prefs_decorations_desc();
    },
    id: 'textDecorations',
    get label() {
      return m.editor_prefs_decorations();
    },
  },
  {
    get description() {
      return m.editor_prefs_inline_desc();
    },
    id: 'inlineElements',
    get label() {
      return m.editor_prefs_inline();
    },
  },
  {
    get description() {
      return m.editor_prefs_block_dec_desc();
    },
    id: 'blockDecorations',
    get label() {
      return m.editor_prefs_block_dec();
    },
  },
  {
    get description() {
      return m.editor_prefs_block_el_desc();
    },
    id: 'blockElements',
    get label() {
      return m.editor_prefs_block_el();
    },
  },
  {
    defaultEnabled: false,
    get description() {
      return m.editor_prefs_indent_desc();
    },
    id: 'indentation',
    get label() {
      return m.editor_prefs_indent();
    },
  },
];

type EnabledMap = Record<WidgetGroupId, boolean>;

const ALL_ENABLED: EnabledMap = WIDGET_GROUPS.reduce((acc, g) => {
  acc[g.id] = g.defaultEnabled ?? true;
  return acc;
}, {} as EnabledMap);

const LEGACY_BLOCK_WIDGETS: readonly EditorWidgetId[] = [
  'table',
  'callout',
  'columns',
  'math',
  'toc',
  'quiz',
  'flashcards',
  'mermaid',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function mergeEnabledGroups(value: unknown): EnabledMap {
  if (!isRecord(value)) return { ...ALL_ENABLED };

  const hasNewGroup = WIDGET_GROUPS.some(
    ({ id }) => id !== 'fontStyles' && id in value
  );
  if (hasNewGroup) {
    return WIDGET_GROUPS.reduce((enabled, group) => {
      const persistedValue = value[group.id];
      enabled[group.id] =
        typeof persistedValue === 'boolean'
          ? persistedValue
          : ALL_ENABLED[group.id];
      return enabled;
    }, {} as EnabledMap);
  }

  const migrated = { ...ALL_ENABLED };
  if (typeof value.fontStyles === 'boolean') {
    migrated.fontStyles = value.fontStyles;
  }
  if (value.media === false) {
    migrated.fileOperations = false;
  }
  if (LEGACY_BLOCK_WIDGETS.some((id) => value[id] === false)) {
    migrated.blockElements = false;
  }
  return migrated;
}

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
      // Merge persisted state with new groups and migrate the old widget keys.
      merge: (persisted, current) => {
        const p = (persisted as Partial<NoteEditorPrefsState>) ?? {};
        return {
          ...current,
          ...p,
          enabled: mergeEnabledGroups(p.enabled),
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
