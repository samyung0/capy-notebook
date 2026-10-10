import {
  useMe,
  useSetStudyPreferences,
  useSetStudyProgressDefault,
} from '@/api/hooks';
import type { StudyPreferences } from '@/api/types';
import { SettingRow, TabHeader } from '@/components/app/tabPanel';
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
  explainerStyle: 'standard',
  flashcardsPerChapter: 15,
  mainFormat: 'auto',
  miniChecks: true,
  practice: 'quiz',
  quizLength: 8,
  // Review defaults mirror reviewPrefsOf in server/internal/store/review_sessions.go.
  reviewFocus: 'balanced',
  reviewItems: 'both',
  reviewSize: 20,
  visualAids: 'more',
};

/** Fields saved as numbers. */
const NUMERIC = new Set(['quizLength', 'flashcardsPerChapter', 'reviewSize']);

type Choice = { label: () => string; value: string };

type Row = {
  field:
    | 'mainFormat'
    | 'explainerStyle'
    | 'practice'
    | 'quizLength'
    | 'flashcardsPerChapter'
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

const ROWS: Row[] = [
  {
    choices: [
      { label: m.study_pref_main_auto, value: 'auto' },
      { label: m.study_pref_main_note, value: 'note' },
      { label: m.study_pref_main_deck, value: 'deck' },
    ],
    field: 'mainFormat',
    hint: m.study_pref_main_hint,
    title: m.study_pref_main,
  },
  {
    choices: [
      { label: m.study_pref_explainer_brief, value: 'brief' },
      { label: m.study_pref_explainer_standard, value: 'standard' },
      { label: m.study_pref_explainer_detailed, value: 'detailed' },
    ],
    field: 'explainerStyle',
    hint: m.study_pref_explainer_hint,
    title: m.study_pref_explainer,
  },
  {
    choices: [
      { label: m.study_pref_practice_none, value: 'none' },
      { label: m.study_pref_practice_quiz, value: 'quiz' },
      { label: m.study_pref_practice_flashcards, value: 'flashcards' },
      { label: m.study_pref_practice_both, value: 'both' },
    ],
    field: 'practice',
    hint: m.study_pref_practice_hint,
    title: m.study_pref_practice,
  },
  {
    choices: [5, 8, 10, 15, 20].map((n) => ({
      label: () => m.study_pref_questions_count({ count: n }),
      value: String(n),
    })),
    field: 'quizLength',
    hint: m.study_pref_quiz_length_hint,
    title: m.study_pref_quiz_length,
  },
  {
    choices: [10, 15, 20, 30].map((n) => ({
      label: () => m.study_pref_cards_count({ count: n }),
      value: String(n),
    })),
    field: 'flashcardsPerChapter',
    hint: m.study_pref_cards_hint,
    title: m.study_pref_cards,
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
      <TabHeader
        description={m.settings_study_hint()}
        title={m.settings_tab_study()}
      />
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
        <TabHeader
          description={m.study_pref_review_hint()}
          title={m.study_pref_review_title()}
        />
        {REVIEW_ROWS.map(choiceRow)}
        <div className="border-divider border-t" />
        <TabHeader
          description={m.study_prefs_hint()}
          title={m.study_prefs_title()}
        />
        <SettingRow
          hint={m.study_pref_checks_hint()}
          title={m.study_pref_checks()}
        >
          <Switch
            aria-label={m.study_pref_checks()}
            checked={current.miniChecks}
            disabled={!saved}
            onCheckedChange={(checked) => set({ miniChecks: checked })}
          />
        </SettingRow>
        {ROWS.map(choiceRow)}
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
        <SelectTrigger aria-label={row.title()} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
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
