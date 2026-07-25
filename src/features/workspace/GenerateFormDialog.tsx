import { useState } from 'react';
import type {
  Chapter,
  CognitiveLevel,
  DiagramType,
  GenerateOptions,
  QuestionType,
  SourceFile,
} from '@/api/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  Spinner,
  Text,
} from '@/components/ui';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { LEVEL_LABEL, LEVELS } from '@/lib/levels';

export type GenerateMode = 'flashcards' | 'quiz' | 'mindmap' | 'diagram';

const Q_TYPES: QuestionType[] = [
  'mcq',
  'multi',
  'boolean',
  'fill',
  'short',
  'matching',
  'ordering',
];
const Q_TYPE_LABEL: Record<QuestionType, string> = {
  boolean: 'True / false',
  fill: 'Fill blank',
  matching: 'Matching',
  mcq: 'Multiple choice',
  multi: 'Multi-select',
  ordering: 'Ordering',
  short: 'Short answer',
};

const DIAGRAM_TYPES: DiagramType[] = [
  'auto',
  'flowchart',
  'sequence',
  'class',
  'state',
  'er',
];
const DIAGRAM_LABEL: Record<DiagramType, string> = {
  auto: 'Auto',
  class: 'Class',
  er: 'Entity-relation',
  flowchart: 'Flowchart',
  sequence: 'Sequence',
  state: 'State',
};

const MODE_LABEL: Record<GenerateMode, string> = {
  diagram: 'diagram',
  flashcards: 'flashcards',
  mindmap: 'mindmap',
  quiz: 'quiz',
};

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
        'rounded-pill border px-2.5 py-1 font-medium text-xs transition-colors',
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
      <Text tone="muted" variant="label">
        {label}
      </Text>
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
      <Text tone="muted" variant="label">
        Count
      </Text>
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
  pending,
  onGenerate,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  mode: GenerateMode;
  chapters: Chapter[];
  files: SourceFile[];
  pending: boolean;
  onGenerate: (opts: GenerateOptions) => Promise<unknown>;
}) {
  const [chapterScope, setChapterScope] = useState<string[]>([]);
  const [fileScope, setFileScope] = useState<string[]>([]);
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

  const readyFiles = files.filter(
    (f) => f.status !== 'processing' && f.status !== 'failed'
  );

  async function run() {
    const scope = { chapters: chapterScope, fileIds: fileScope };
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
        <DialogTitle className="capitalize">
          {m.generate_title()} · {MODE_LABEL[mode]}
        </DialogTitle>

        <div className="flex max-h-[70vh] flex-col gap-5 overflow-auto">
          <div className="flex flex-col gap-1.5">
            <Text tone="muted" variant="label">
              Chapter scope
            </Text>
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
                <Text tone="muted" variant="meta">
                  No chapters
                </Text>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Text tone="muted" variant="label">
              File scope
            </Text>
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
                <Text tone="muted" variant="meta">
                  No files
                </Text>
              )}
            </div>
            {!chapterScope.length && !fileScope.length && (
              <Text tone="muted" variant="meta">
                Nothing selected — the whole workspace will be used.
              </Text>
            )}
          </div>

          {mode === 'flashcards' && (
            <>
              <CountRow onChange={setCount} value={count} />
              <OptionRow
                label="Style"
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
                <Text tone="muted" variant="label">
                  Question types
                </Text>
                <div className="flex flex-wrap gap-1.5">
                  {Q_TYPES.map((t) => (
                    <Chip
                      active={types.includes(t)}
                      key={t}
                      onClick={() =>
                        setTypes((s) =>
                          s.includes(t) ? s.filter((x) => x !== t) : [...s, t]
                        )
                      }
                    >
                      {Q_TYPE_LABEL[t]}
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Text tone="muted" variant="label">
                  Cognitive level
                </Text>
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
                      {LEVEL_LABEL[lvl]}
                    </Chip>
                  ))}
                </div>
              </div>
            </>
          )}
          {mode === 'mindmap' && (
            <OptionRow
              label="Detail"
              onChange={(v) => setDetail(v as typeof detail)}
              options={['brief', 'standard', 'detailed']}
              value={detail}
            />
          )}
          {mode === 'diagram' && (
            <div className="flex flex-col gap-1.5">
              <Text tone="muted" variant="label">
                Diagram type
              </Text>
              <div className="flex flex-wrap gap-1.5">
                {DIAGRAM_TYPES.map((t) => (
                  <Chip
                    active={diagramType === t}
                    key={t}
                    onClick={() => setDiagramType(t)}
                  >
                    {DIAGRAM_LABEL[t]}
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
            Cancel
          </Button>
          <Button
            disabled={pending || (mode === 'quiz' && !types.length)}
            iconLeft={pending ? undefined : 'sparkles'}
            onClick={run}
          >
            {pending ? <Spinner /> : `Generate ${MODE_LABEL[mode]}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
