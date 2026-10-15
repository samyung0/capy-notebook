import {
  useMe,
  useSetStudyPreferences,
  useSetStudyProgressDefault,
} from '@/api/hooks';
import type { StudyPreferences } from '@/api/types';
import { SectionTitle, SettingRow, TabHeader } from '@/components/app/tabPanel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { m } from '@/i18n';

/** What an unset field means; mirrors pipeline/pipeline/prompts/preferences.py. */
const DEFAULTS: Required<Omit<StudyPreferences, '$schema'>> = {
  flashcards: 'off',
  knowledgeChecks: true,
  mainFormat: 'note',
  quiz: 'less',
  // Review defaults mirror reviewPrefsOf in server/internal/store/review_sessions.go.
  reviewFocus: 'balanced',
  reviewItems: 'both',
  reviewSize: 20,
  visualAids: 'more',
  writingStyle: 'normal',
};

/** Fields saved as numbers. */
const NUMERIC = new Set(['reviewSize']);

/** A practice item's amount (pipeline/prompts/preferences.py COUNT). */
const LEVELS: Choice[] = [
  { label: m.study_pref_level_more, value: 'more' },
  { label: m.study_pref_level_less, value: 'less' },
  { label: m.study_pref_level_off, value: 'off' },
];

type Choice = { label: () => string; value: string };

type Row = {
  field:
    | 'mainFormat'
    | 'writingStyle'
    | 'quiz'
    | 'flashcards'
    | 'visualAids'
    | 'reviewSize'
    | 'reviewItems'
    | 'reviewFocus';
  title: () => string;
  hint: () => string;
  choices: Choice[];
};

/** How review sessions are put together (human/study-progress.md, 2026-10-10). */
const REVIEW_ROWS: Row[] = [
  {
    choices: [10, 20, 30, 50].map((n) => ({
      label: () => m.review_items({ count: n }),
      value: String(n),
    })),
    field: 'reviewSize',
    hint: m.study_pref_review_size_hint,
    title: m.study_pref_review_size,
  },
  {
    choices: [
      { label: m.study_pref_review_items_both, value: 'both' },
      { label: m.study_pref_review_items_quiz, value: 'quiz' },
      { label: m.study_pref_review_items_cards, value: 'flashcards' },
    ],
    field: 'reviewItems',
    hint: m.study_pref_review_items_hint,
    title: m.study_pref_review_items,
  },
  {
    choices: [
      { label: m.study_pref_review_focus_balanced, value: 'balanced' },
      { label: m.review_mode_fading, value: 'fading' },
      { label: m.review_mode_tricky, value: 'tricky' },
      { label: m.review_mode_learned, value: 'learned' },
    ],
    field: 'reviewFocus',
    hint: m.study_pref_review_focus_hint,
    title: m.study_pref_review_focus,
  },
];

/** What the chat builds (human/agentic-retrieval.md, 2026-10-14). */
const ROWS: Row[] = [
  {
    choices: [
      { label: m.study_pref_main_note, value: 'note' },
      { label: m.study_pref_main_deck, value: 'deck' },
    ],
    field: 'mainFormat',
    hint: m.study_pref_main_hint,
    title: m.study_pref_main,
  },
  {
    choices: [
      { label: m.study_pref_writing_brief, value: 'brief' },
      { label: m.study_pref_writing_normal, value: 'normal' },
      { label: m.study_pref_writing_verbose, value: 'verbose' },
    ],
    field: 'writingStyle',
    hint: m.study_pref_writing_hint,
    title: m.study_pref_writing,
  },
  {
    choices: LEVELS,
    field: 'quiz',
    hint: m.study_pref_quiz_hint,
    title: m.study_pref_quiz,
  },
  {
    choices: LEVELS,
    field: 'flashcards',
    hint: m.study_pref_flashcards_hint,
    title: m.study_pref_flashcards,
  },
  {
    choices: [
      { label: m.study_pref_visuals_fewer, value: 'fewer' },
      { label: m.study_pref_visuals_more, value: 'more' },
    ],
    field: 'visualAids',
    hint: m.study_pref_visuals_hint,
    title: m.study_pref_visuals,
  },
];

/** Settings → Study: progress tracking, how reviews are put together, and
 * how the chat builds notes and practice. */
export function StudyPreferencesSection() {
  const { data: me } = useMe();
  const { mutate: save } = useSetStudyPreferences();
  const { mutate: setProgressDefault } = useSetStudyProgressDefault();
  const saved = me?.studyPreferences;
  const current = { ...DEFAULTS, ...saved };
  const set = (patch: StudyPreferences) => {
    if (saved) save({ ...saved, ...patch });
  };
  const choiceRow = (row: Row) => (
    <ChoiceRow
      current={String(current[row.field])}
      disabled={!saved}
      key={row.field}
      onChange={(value) =>
        set({ [row.field]: NUMERIC.has(row.field) ? Number(value) : value })
      }
      row={row}
    />
  );
  return (
    <>
      <TabHeader title={m.settings_tab_study()} />
      <div className="flex flex-col gap-6">
        <SettingRow
          hint={m.study_progress_default_hint()}
          title={m.study_progress_default()}
        >
          <Switch
            aria-label={m.study_progress_default()}
            checked={!!me?.studyProgress}
            disabled={!me}
            onCheckedChange={(checked) => setProgressDefault(checked)}
          />
        </SettingRow>
        <div className="border-divider border-t" />
        <SectionTitle title={m.study_pref_review_title()} />
        {REVIEW_ROWS.map(choiceRow)}
        <div className="border-divider border-t" />
        <SectionTitle title={m.study_prefs_title()} />
        {ROWS.map(choiceRow)}
        {/* Last: the least used (Epo 2026-10-14). */}
        <SettingRow
          hint={m.study_pref_checks_hint()}
          title={m.study_pref_checks()}
        >
          <Switch
            aria-label={m.study_pref_checks()}
            checked={current.knowledgeChecks}
            disabled={!saved}
            onCheckedChange={(checked) => set({ knowledgeChecks: checked })}
          />
        </SettingRow>
      </div>
    </>
  );
}

function ChoiceRow({
  row,
  current,
  disabled,
  onChange,
}: {
  row: Row;
  current: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <SettingRow hint={row.hint()} title={row.title()}>
      <Select
        disabled={disabled}
        onValueChange={(value) => onChange(value as string)}
        value={current}
      >
        <SelectTrigger aria-label={row.title()} layout="row">
          <SelectValue />
        </SelectTrigger>
        <SelectContent layout="row">
          {row.choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}
