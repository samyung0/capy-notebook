import { useMemo, useState } from 'react';
import {
  type Chapter,
  type DiagramType,
  type GenerateOptions,
  type MaterialRef,
  QUESTION_TYPES,
  type QuestionType,
  type SourceFile,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { DialogFooter, DialogPrimary } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { Menu } from '@/components/ui/Menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  selectTriggerVariants,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { GenerateSources, scopeOf, sourceGroups } from './GenerateSources';
import {
  GENERATE_TITLE_MAX,
  nextGenerateTitle,
  validateGenerateTitle,
} from './generateTitle';
export type GenerateMode = 'flashcards' | 'quiz' | 'mindmap' | 'diagram';

function questionTypeLabel(type: QuestionType): string {
  switch (type) {
    case 'boolean':
      return m.quiz_type_boolean();
    case 'matching':
      return m.quiz_type_matching();
    case 'mcq':
      return m.quiz_type_mcq();
    case 'ordering':
      return m.quiz_type_ordering();
    case 'short':
      return m.quiz_type_short();
    case 'open':
      return m.quiz_type_open();
    case 'gaps':
      return m.question_ui_fill_in_the_gaps();
  }
}

// Generation offers the server's question types; fill-in-the-gaps is authored only.
const GENERATE_TYPES = QUESTION_TYPES.filter((type) => type !== 'gaps');

const DIAGRAM_TYPES: DiagramType[] = [
  'auto',
  'flowchart',
  'sequence',
  'class',
  'state',
  'er',
];

function diagramTypeLabel(type: DiagramType): string {
  switch (type) {
    case 'auto':
      return m.generate_diagram_auto();
    case 'class':
      return m.generate_diagram_class();
    case 'er':
      return m.generate_diagram_er();
    case 'flowchart':
      return m.generate_diagram_flowchart();
    case 'sequence':
      return m.generate_diagram_sequence();
    case 'state':
      return m.generate_diagram_state();
  }
}

export function generateModeLabel(mode: GenerateMode): string {
  switch (mode) {
    case 'diagram':
      return m.generate_kind_diagram();
    case 'flashcards':
      return m.generate_flashcards();
    case 'mindmap':
      return m.generate_kind_mindmap();
    case 'quiz':
      return m.generate_quiz();
  }
}

type Detail = 'brief' | 'standard' | 'detailed';

function detailLabel(detail: Detail): string {
  switch (detail) {
    case 'brief':
      return m.generate_detail_brief();
    case 'detailed':
      return m.generate_detail_detailed();
    case 'standard':
      return m.generate_detail_standard();
  }
}

/** How many questions or cards: Less makes 5, More 10 (Epo 2026-10-14). */
const AMOUNTS = [
  { count: 5, label: m.generate_amount_less },
  { count: 10, label: m.generate_amount_more },
];

/** One option: its label on the left, its control on the right. */
function OptionRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <p className="font-semibold text-fg-secondary">{label}</p>
      {children}
    </div>
  );
}

/** A single-choice option as a dropdown. */
function OptionSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <OptionRow label={label}>
      <Select onValueChange={(v) => onChange(v as T)} value={value}>
        <SelectTrigger aria-label={label} layout="row">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </OptionRow>
  );
}

/** The generate options for one kind, with Cancel and Generate; the Add
 * file dialog shows it under its kind tiles and mounts it with `key={mode}`,
 * so each kind's options start fresh. */
export function GenerateForm({
  mode,
  chapters,
  files,
  materials,
  workspaceName,
  existingTitles,
  picked,
  onPickedChange,
  pending,
  onGenerate,
}: {
  mode: GenerateMode;
  chapters: Chapter[];
  files: SourceFile[];
  materials: MaterialRef[];
  workspaceName: string;
  existingTitles: string[];
  /** The ticked sources, null for the whole workspace; kept by the panel
   * so a pick survives switching kinds. */
  picked: ReadonlySet<string> | null;
  onPickedChange: (picked: ReadonlySet<string>) => void;
  pending: boolean;
  onGenerate: (opts: GenerateOptions) => Promise<unknown>;
}) {
  const [title, setTitle] = useState(() =>
    nextGenerateTitle(mode, workspaceName, existingTitles)
  );
  const [count, setCount] = useState(5);
  const [types, setTypes] = useState<QuestionType[]>(['mcq', 'boolean']);
  const [detail, setDetail] = useState<Detail>('standard');
  const [diagramType, setDiagramType] = useState<DiagramType>('auto');

  const groups = useMemo(
    () => sourceGroups(chapters, files, materials),
    [chapters, files, materials]
  );
  // Ticked items still listed: one trashed or no longer indexed since it
  // was ticked drops out, so a pick never empties into the whole workspace.
  const listed = groups.flatMap((g) => g.items.map((it) => it.id));
  const sources = new Set(
    picked ? listed.filter((id) => picked.has(id)) : listed
  );
  const titleError = useMemo(
    () => validateGenerateTitle(title, existingTitles),
    [existingTitles, title]
  );
  const ready =
    !titleError && sources.size > 0 && (mode !== 'quiz' || types.length > 0);

  async function run() {
    if (!ready) return;
    const scope = { ...scopeOf(groups, sources), title: title.trim() };
    let opts: GenerateOptions;
    if (mode === 'flashcards') opts = { count, kind: 'flashcards', ...scope };
    else if (mode === 'quiz') opts = { count, kind: 'quiz', types, ...scope };
    else if (mode === 'mindmap') opts = { detail, kind: 'mindmap', ...scope };
    else opts = { diagramType, kind: 'diagram', ...scope };
    await onGenerate(opts);
  }

  const amount = (
    <OptionSelect
      label={m.generate_amount()}
      onChange={(v) => setCount(Number(v))}
      options={AMOUNTS.map(({ count, label }) => ({
        label: label({ count }),
        value: String(count),
      }))}
      value={String(count)}
    />
  );

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto">
        <label className="flex flex-col gap-1.5">
          <InputTitle
            count={{ max: GENERATE_TITLE_MAX, value: textLength(title) }}
            required
          >
            {m.generate_file_name()}
          </InputTitle>
          <Input
            aria-invalid={!!titleError}
            autoComplete="off"
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            value={title}
          />
          {titleError && <InputError>{titleError}</InputError>}
        </label>

        <GenerateSources
          groups={groups}
          onChange={onPickedChange}
          picked={sources}
        />

        <div className="flex flex-col divide-y divide-divider">
          {(mode === 'quiz' || mode === 'flashcards') && amount}
          {mode === 'quiz' && (
            <OptionRow label={m.generate_question_types()}>
              <Menu
                align="end"
                items={GENERATE_TYPES.map((t) => ({
                  checked: types.includes(t),
                  closeOnSelect: false,
                  label: questionTypeLabel(t),
                  onClick: () =>
                    setTypes((s) =>
                      s.includes(t) ? s.filter((x) => x !== t) : [...s, t]
                    ),
                }))}
                trigger={
                  <button
                    aria-label={m.generate_question_types()}
                    className={cn(
                      selectTriggerVariants({ layout: 'row' }),
                      // Grows with the picked types from sm, up to 320px.
                      'group/select-trigger sm:w-auto sm:min-w-44 sm:max-w-80'
                    )}
                    type="button"
                  >
                    <span className="min-w-0 truncate">
                      {types.length
                        ? GENERATE_TYPES.filter((t) => types.includes(t))
                            .map(questionTypeLabel)
                            .join(', ')
                        : m.generate_no_question_types()}
                    </span>
                    <Icon
                      className="size-4 shrink-0 -translate-y-px text-fg-muted"
                      name="chevronDown"
                    />
                  </button>
                }
              />
            </OptionRow>
          )}
          {mode === 'mindmap' && (
            <OptionSelect
              label={m.common_detail()}
              onChange={setDetail}
              options={(['brief', 'standard', 'detailed'] as const).map(
                (d) => ({ label: detailLabel(d), value: d })
              )}
              value={detail}
            />
          )}
          {mode === 'diagram' && (
            <OptionSelect
              label={m.generate_diagram_type()}
              onChange={setDiagramType}
              options={DIAGRAM_TYPES.map((t) => ({
                label: diagramTypeLabel(t),
                value: t,
              }))}
              value={diagramType}
            />
          )}
        </div>
      </div>

      <DialogFooter>
        <DialogPrimary pending={pending}>
          <Button
            disabled={pending || !ready}
            iconLeft={pending ? undefined : 'sparkles'}
            onClick={run}
            size="lg"
            variant="accent"
          >
            {pending ? <Spinner /> : m.action_generate()}
          </Button>
        </DialogPrimary>
      </DialogFooter>
    </>
  );
}
