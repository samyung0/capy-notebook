import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
    description: 'Undo and redo',
    id: 'history',
    label: 'Editor history',
  },
  {
    description: 'Upload, import, export',
    id: 'fileOperations',
    label: 'File operations',
  },
  {
    description: 'Comments, Headings, dropdown menu',
    id: 'general',
    label: 'General',
  },
  {
    description: 'Font size and colors',
    id: 'fontStyles',
    label: 'Font styles',
  },
  {
    description: 'Bold, italic, underline, etc.',
    id: 'textDecorations',
    label: 'Text decorations',
  },
  {
    description: 'Inline equations, codes, links, mentions',
    id: 'inlineElements',
    label: 'Inline elements',
  },
  {
    description: 'Alignment and lists',
    id: 'blockDecorations',
    label: 'Block decorations',
  },
  {
    description: 'Tables, columns, callouts, etc.',
    id: 'blockElements',
    label: 'Block elements',
  },
  {
    defaultEnabled: false,
    description: 'Indent and outdent',
    id: 'indentation',
    label: 'Indentation',
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
