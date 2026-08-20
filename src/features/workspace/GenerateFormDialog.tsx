import { useMemo, useState } from 'react';
import {
  type Chapter,
  type CognitiveLevel,
  type DiagramType,
  type GenerateOptions,
  QUESTION_TYPES,
  type QuestionType,
  type SourceFile,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { LEVELS, levelLabel } from '@/lib/levels';
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
    case 'multi':
      return m.quiz_type_multi();
    case 'ordering':
      return m.quiz_type_ordering();
    case 'short':
      return m.quiz_type_short();
    case 'open':
      return m.quiz_type_open();
  }
}

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

function generateModeLabel(mode: GenerateMode): string {
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

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cn(
        'rounded-full border px-2.5 py-1 font-medium text-xs transition-colors',
        active
          ? 'border-accent bg-action-accent text-action-accent-fg'
          : 'border-line bg-surface text-fg-secondary hover:bg-surface-hover-bg'
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function OptionRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="t-label text-fg-muted">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <Chip active={value === o} key={o} onClick={() => onChange(o)}>
            {o}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function CountRow({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <p className="t-label text-fg-muted">{m.common_count()}</p>
      <div className="flex items-center gap-2">
        {[5, 10, 15, 20].map((n) => (
          <Chip active={value === n} key={n} onClick={() => onChange(n)}>
            {n}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/**
 * Config dialog for a single generate mode. State is local and short-lived —
 * the parent mounts this with `key={mode}` so each open starts fresh. On a
 * successful generate the parent closes the dialog and shows the result.
 *
 * Scope is dual: chapters (by id) and/or individual files (by id). Empty
 * scope means the whole workspace.
 */
export function GenerateFormDialog({
  open,
  setOpen,
  mode,
  chapters,
  files,
  workspaceName,
  existingTitles,
  pending,
  onGenerate,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  mode: GenerateMode;
  chapters: Chapter[];
  files: SourceFile[];
  workspaceName: string;
  existingTitles: string[];
  pending: boolean;
  onGenerate: (opts: GenerateOptions) => Promise<unknown>;
}) {
  const [chapterScope, setChapterScope] = useState<string[]>([]);
  const [fileScope, setFileScope] = useState<string[]>([]);
  const [title, setTitle] = useState(() =>
    nextGenerateTitle(mode, workspaceName, existingTitles)
  );
  const [count, setCount] = useState(10);
  const [style, setStyle] = useState<'term-def' | 'qa' | 'cloze'>('term-def');
  const [types, setTypes] = useState<QuestionType[]>(['mcq', 'boolean']);
  const [levels, setLevels] = useState<CognitiveLevel[]>([
    'recall',
    'application',
  ]);
  const [detail, setDetail] = useState<'brief' | 'standard' | 'detailed'>(
    'standard'
  );
  const [diagramType, setDiagramType] = useState<DiagramType>('auto');

  const readyFiles = files.filter((f) => f.indexed);
  const titleError = useMemo(
    () => validateGenerateTitle(title, existingTitles),
    [existingTitles, title]
  );

  async function run() {
    if (titleError) return;
    const scope = {
      chapters: chapterScope,
      fileIds: fileScope,
      title: title.trim(),
    };
    let opts: GenerateOptions;
    if (mode === 'flashcards')
      opts = { count, kind: 'flashcards', style, ...scope };
    else if (mode === 'quiz')
      opts = { count, kind: 'quiz', levels, types, ...scope };
    else if (mode === 'mindmap') opts = { detail, kind: 'mindmap', ...scope };
    else opts = { diagramType, kind: 'diagram', ...scope };
    await onGenerate(opts);
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="top-1/2 -translate-y-1/2">
        <DialogTitle>
          {m.generate_title()} · {generateModeLabel(mode)}
        </DialogTitle>

        <div className="flex max-h-[70vh] flex-col gap-5 overflow-auto">
          <label className="flex flex-col gap-1.5">
            <InputTitle required>{m.generate_file_name()}</InputTitle>
            <Input
              aria-invalid={!!titleError}
              autoComplete="off"
              autoFocus
              maxLength={GENERATE_TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              value={title}
            />
            {titleError && <InputError>{titleError}</InputError>}
          </label>

          <div className="flex flex-col gap-1.5">
            <p className="t-label text-fg-muted">
              {m.generate_chapter_scope()}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {chapters.map((c) => (
                <Chip
                  active={chapterScope.includes(c.id)}
                  key={c.id}
                  onClick={() =>
                    setChapterScope((s) =>
                      s.includes(c.id)
                        ? s.filter((x) => x !== c.id)
                        : [...s, c.id]
                    )
                  }
                >
                  {c.name}
                </Chip>
              ))}
              {!chapters.length && (
                <p className="t-meta text-fg-muted">
                  {m.generate_no_chapters()}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="t-label text-fg-muted">{m.generate_file_scope()}</p>
            <div className="flex flex-wrap gap-1.5">
              {readyFiles.map((f) => (
                <Chip
                  active={fileScope.includes(f.id)}
                  key={f.id}
                  onClick={() =>
                    setFileScope((s) =>
                      s.includes(f.id)
                        ? s.filter((x) => x !== f.id)
                        : [...s, f.id]
                    )
                  }
                >
                  {f.name}
                </Chip>
              ))}
              {!readyFiles.length && (
                <p className="t-meta text-fg-muted">{m.generate_no_files()}</p>
              )}
            </div>
            {!chapterScope.length && !fileScope.length && (
              <p className="t-meta text-fg-muted">
                {m.generate_nothing_selected()}
              </p>
            )}
          </div>

          {mode === 'flashcards' && (
            <>
              <CountRow onChange={setCount} value={count} />
              <OptionRow
                label={m.common_style()}
                onChange={(v) => setStyle(v as typeof style)}
                options={['term-def', 'qa', 'cloze']}
                value={style}
              />
            </>
          )}
          {mode === 'quiz' && (
            <>
              <CountRow onChange={setCount} value={count} />
              <div className="flex flex-col gap-1.5">
                <p className="t-label text-fg-muted">
                  {m.generate_question_types()}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {QUESTION_TYPES.map((t) => (
                    <Chip
                      active={types.includes(t)}
                      key={t}
                      onClick={() =>
                        setTypes((s) =>
                          s.includes(t) ? s.filter((x) => x !== t) : [...s, t]
                        )
                      }
                    >
                      {questionTypeLabel(t)}
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <p className="t-label text-fg-muted">
                  {m.generate_cognitive_level()}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {LEVELS.map((lvl) => (
                    <Chip
                      active={levels.includes(lvl)}
                      key={lvl}
                      onClick={() =>
                        setLevels((s) =>
                          s.includes(lvl)
                            ? s.filter((x) => x !== lvl)
                            : [...s, lvl]
                        )
                      }
                    >
                      {levelLabel(lvl)}
                    </Chip>
                  ))}
                </div>
              </div>
            </>
          )}
          {mode === 'mindmap' && (
            <OptionRow
              label={m.common_detail()}
              onChange={(v) => setDetail(v as typeof detail)}
              options={['brief', 'standard', 'detailed']}
              value={detail}
            />
          )}
          {mode === 'diagram' && (
            <div className="flex flex-col gap-1.5">
              <p className="t-label text-fg-muted">
                {m.generate_diagram_type()}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {DIAGRAM_TYPES.map((t) => (
                  <Chip
                    active={diagramType === t}
                    key={t}
                    onClick={() => setDiagramType(t)}
                  >
                    {diagramTypeLabel(t)}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-6">
          <Button
            disabled={pending}
            onClick={() => setOpen(false)}
            variant="ghost"
          >
            {m.action_cancel()}
          </Button>
          <Button
            disabled={
              pending || !!titleError || (mode === 'quiz' && !types.length)
            }
            iconLeft={pending ? undefined : 'sparkles'}
            onClick={run}
          >
            {pending ? <Spinner /> : m.workspace_tab_generate()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
