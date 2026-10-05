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
  miniChecks: true,
  practice: 'quiz',
  quizLength: 8,
  visualAids: 'more',
};

type Choice = { label: () => string; value: string };

const ROWS: {
  field:
    | 'explainerStyle'
    | 'practice'
    | 'quizLength'
    | 'flashcardsPerChapter'
    | 'visualAids';
  title: () => string;
  hint: () => string;
  choices: Choice[];
}[] = [
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

/** The learner's study preferences: how the chat builds notes and practice. */
export function StudyPreferencesSection() {
  const { data: me } = useMe();
  const { mutate: save } = useSetStudyPreferences();
  const { mutate: setProgressDefault } = useSetStudyProgressDefault();
  const saved = me?.studyPreferences;
  const current = { ...DEFAULTS, ...saved };
  const set = (patch: StudyPreferences) => {
    if (saved) save({ ...saved, ...patch });
  };
  return (
    <div>
      <TabHeader
        description={m.study_prefs_hint()}
        title={m.study_prefs_title()}
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
        {ROWS.map((row) => (
          <ChoiceRow
            current={String(current[row.field])}
            disabled={!saved}
            key={row.field}
            onChange={(value) =>
              set({
                [row.field]:
                  row.field === 'quizLength' ||
                  row.field === 'flashcardsPerChapter'
                    ? Number(value)
                    : value,
              })
            }
            row={row}
          />
        ))}
      </div>
    </div>
  );
}

function ChoiceRow({
  row,
  current,
  disabled,
  onChange,
}: {
  row: (typeof ROWS)[number];
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
