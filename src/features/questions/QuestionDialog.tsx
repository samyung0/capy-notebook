import { zodResolver } from '@hookform/resolvers/zod';
import { useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { FloatingToolbar } from '@/components/ui/BlockToolbar';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon } from '@/components/ui/Icon';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { ToolbarGroup } from '@/components/ui/Toolbar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { userToast } from '@/components/ui/userToast';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { CopyError, errorCopy } from '@/lib/errors';
import { BlockEditor, type UploadQuestionAsset } from './BlockEditor';
import { warnComputationalOpenParts } from './computationCheck';
import {
  AnswerEditor,
  answerLabels,
  emptyAnswer,
  SelectField,
  StringList,
} from './editorFields';
import { renderGraphSvg } from './graph';
import { type BlockSection, QuestionBlockView } from './QuestionView';
import { TextView } from './TextView';
import {
  blankQuestion,
  QUESTION_TYPES,
  type Question,
  type QuestionBlock,
  type QuestionPart,
} from './types';
import { questionSchema, validateQuestion } from './validation';

const blockLabels = {
  chart: m.question_ui_chart,
  graph: m.question_ui_graph,
  image: m.question_ui_image,
  part: m.question_ui_part,
  table: m.question_ui_table,
  text: m.question_ui_text,
};
const marksLabel = (count: number) =>
  count === 1 ? m.question_ui_one_mark() : m.question_ui_marks({ count });
const blockSummary = (block: QuestionBlock) =>
  (block.type === 'text'
    ? block.text
    : block.type === 'chart'
      ? block.title
      : block.type === 'graph' || block.type === 'image'
        ? block.description
        : '') || blockLabels[block.type]();

type Location = BlockSection & { index: number };
type Row =
  | { kind: 'block'; location: Location }
  | { kind: 'part' | 'solution'; partId: string };
type Editing =
  | { kind: 'block'; location: Location; block: QuestionBlock }
  | { kind: 'part'; part: QuestionPart };
export interface QuestionDialogProps {
  bankAssetsUrl?: string;
  context?: string;
  onClose: () => void;
  onReload?: () => Promise<Question>;
  onSave: (question: Question) => void | Promise<void>;
  open: boolean;
  policy?: 'quiz' | 'bank';
  question: Question;
  questionNumber?: number;
  uploadAsset?: UploadQuestionAsset;
}

export function newQuestionBlock(type: QuestionBlock['type']): QuestionBlock {
  switch (type) {
    case 'text':
      return { text: '', type };
    case 'chart':
      return {
        kind: 'bar',
        labels: [''],
        series: [{ name: '', values: [0] }],
        title: '',
        type,
      };
    case 'graph':
      return {
        board: { axis: true, bbox: [-5, 5, 5, -5], grid: false },
        description: '',
        elements: [],
        height: 400,
        image: { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
        type,
        width: 600,
      };
    case 'table':
      return {
        header: true,
        rows: [
          ['', ''],
          ['', ''],
        ],
        type,
      };
    case 'image':
      return { description: '', height: 1, image: { url: '' }, type, width: 1 };
  }
}
function sectionBlocks(
  question: Question,
  section: BlockSection
): QuestionBlock[] {
  return section.partId
    ? (question.parts.find((part) => part.id === section.partId)?.[
        section.solution ? 'solution' : 'blocks'
      ] ?? [])
    : question.stem;
}
function changeBlocks(
  question: Question,
  section: BlockSection,
  blocks: QuestionBlock[]
): Question {
  return section.partId
    ? {
        ...question,
        parts: question.parts.map((part) =>
          part.id === section.partId
            ? { ...part, [section.solution ? 'solution' : 'blocks']: blocks }
            : part
        ),
      }
    : { ...question, stem: blocks };
}
const sameSection = (a: BlockSection, b: BlockSection) =>
  a.partId === b.partId && Boolean(a.solution) === Boolean(b.solution);
function rowKey(row: Row): string {
  return row.kind === 'block'
    ? `${row.location.partId ?? 'stem'}:${Boolean(row.location.solution)}:${row.location.index}`
    : `${row.kind}:${row.partId}`;
}

export function QuestionDialog(props: QuestionDialogProps) {
  return props.open ? (
    <QuestionDialogSession {...props} key={props.question.id} />
  ) : null;
}

function QuestionDialogSession({
  open,
  onClose,
  question,
  onSave,
  onReload,
  context,
  questionNumber,
  policy = 'quiz',
  bankAssetsUrl,
  uploadAsset,
}: QuestionDialogProps) {
  const {
    control,
    setValue,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ draft: Question }>({
    defaultValues: { draft: structuredClone(question) },
    resolver: zodResolver(z.object({ draft: questionSchema })),
  });
  const draft = useWatch({ control, name: 'draft' });
  const setDraft = (next: Question) =>
    setValue('draft', next, { shouldDirty: true });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [mobileTab, setMobileTab] = useState<'outline' | 'preview'>('outline');
  const [error, setError] = useState('');
  const [savingBlock, setSavingBlock] = useState(false);
  const [reloading, setReloading] = useState(false);
  const dragged = useRef<Row | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(
    null
  );
  const pending = isSubmitting || savingBlock || reloading;
  const [addOpen, setAddOpen] = useState(false);
  const [expandedSolutions, setExpandedSolutions] = useState<string[]>([]);

  const changePart = (part: QuestionPart) =>
    setDraft({
      ...draft,
      parts: draft.parts.map((item) => (item.id === part.id ? part : item)),
    });
  const openBlock = (location: Location) => {
    const block = sectionBlocks(draft, location)[location.index];
    if (!block) return;
    setError('');
    setSelected({ kind: 'block', location });
    setEditing({ block: structuredClone(block), kind: 'block', location });
  };
  const removeBlock = (location: Location) => {
    setDraft(
      changeBlocks(
        draft,
        location,
        sectionBlocks(draft, location).filter((_, i) => i !== location.index)
      )
    );
    setSelected(null);
    setEditing(null);
  };
  const removePart = (partId: string) => {
    setDraft({
      ...draft,
      parts: draft.parts.filter((part) => part.id !== partId),
    });
    setSelected(null);
    setEditing(null);
  };
  const move = (row: Row, direction: number) => {
    if (row.kind === 'solution') return;
    if (row.kind === 'part') {
      const index = draft.parts.findIndex((part) => part.id === row.partId);
      const target = index + direction;
      if (target < 0 || target >= draft.parts.length) return;
      const parts = [...draft.parts];
      [parts[index], parts[target]] = [parts[target], parts[index]];
      setDraft({ ...draft, parts });
      return;
    }
    if (row.kind !== 'block') return;
    const { location } = row;
    const blocks = [...sectionBlocks(draft, location)];
    const target = location.index + direction;
    if (target < 0 || target >= blocks.length) return;
    [blocks[location.index], blocks[target]] = [
      blocks[target],
      blocks[location.index],
    ];
    setDraft(changeBlocks(draft, location, blocks));
    setSelected({ kind: 'block', location: { ...location, index: target } });
  };
  const add = (type: QuestionBlock['type'] | 'part') => {
    setAddOpen(false);
    if (type === 'part') {
      const part = blankQuestion().parts[0];
      const id =
        selected?.kind === 'block'
          ? selected.location.partId
          : selected?.partId;
      const index = id
        ? draft.parts.findIndex((part) => part.id === id) + 1
        : draft.parts.length;
      const parts = [...draft.parts];
      parts.splice(index, 0, part);
      setDraft({ ...draft, parts });
      setSelected({ kind: 'part', partId: part.id });
      setEditing({ kind: 'part', part });
      return;
    }
    const section: BlockSection =
      selected?.kind === 'block'
        ? selected.location
        : selected
          ? { partId: selected.partId, solution: selected.kind === 'solution' }
          : {};
    const blocks = [...sectionBlocks(draft, section)];
    const index =
      selected?.kind === 'block' ? selected.location.index + 1 : blocks.length;
    const block = newQuestionBlock(type);
    blocks.splice(index, 0, block);
    setDraft(changeBlocks(draft, section, blocks));
    setSelected({ kind: 'block', location: { ...section, index } });
    setEditing({ block, kind: 'block', location: { ...section, index } });
  };
  const saveInner = async () => {
    if (!editing) return;
    setError('');
    if (editing.kind === 'part') {
      changePart(editing.part);
      setEditing(null);
      return;
    }
    setSavingBlock(true);
    try {
      let block = editing.block;
      if (block.type === 'graph') {
        const stage = document.createElement('div');
        stage.style.cssText = 'position:fixed;left:-20000px;top:0;';
        document.body.append(stage);
        let svg: string;
        try {
          svg = await renderGraphSvg(stage, block);
        } finally {
          stage.remove();
        }
        if (policy === 'bank') {
          if (!uploadAsset)
            throw new CopyError(
              m.question_ui_bank_image_uploads_are_unavailable()
            );
          const asset = await uploadAsset(
            new File([svg], 'graph.svg', { type: 'image/svg+xml' })
          );
          if (!('url' in asset))
            throw new CopyError(
              m.question_ui_bank_image_uploads_are_unavailable()
            );
          block = { ...block, image: asset };
        } else block = { ...block, image: { svg } };
      }
      const blocks = sectionBlocks(draft, editing.location).map((item, i) =>
        i === editing.location.index ? block : item
      );
      setDraft(changeBlocks(draft, editing.location, blocks));
      setEditing(null);
    } catch (error) {
      setError(errorCopy(error, m.question_ui_could_not_save_block()));
    } finally {
      setSavingBlock(false);
    }
  };
  const saveQuestion = handleSubmit(
    async ({ draft: value }) => {
      setError('');
      // The inline message keeps the conflict reload next to it.
      const fail = (message: string) => {
        setError(message);
        userToast({
          description: message,
          title: m.question_ui_could_not_save_question(),
          variant: 'error',
        });
      };
      let question: Question;
      try {
        question = validateQuestion(value, {
          bank: policy === 'bank',
          bankAssetsUrl,
        });
      } catch (error) {
        // validateQuestion's own checks carry copy; a schema failure does not.
        fail(errorCopy(error, m.question_ui_could_not_save_question()));
        return;
      }
      try {
        await onSave(question);
        onClose();
        if (policy === 'quiz') void warnComputationalOpenParts(question);
      } catch (error) {
        fail(errorCopy(error, m.question_ui_could_not_save_question()));
      }
    },
    (errors) => {
      const messages: string[] = [];
      const visit = (error: unknown) => {
        if (!error || typeof error !== 'object') return;
        if ('message' in error && typeof error.message === 'string')
          messages.push(error.message);
        for (const [key, value] of Object.entries(error))
          if (key !== 'ref' && key !== 'message') visit(value);
      };
      visit(errors);
      setError(
        messages.slice(0, 3).join(' · ') ||
          m.question_ui_complete_the_question_answer_and_marking_scheme_before_saving()
      );
    }
  );

  const dropRow = (target: Row, after: boolean) => {
    const source = dragged.current;
    dragged.current = null;
    setDrop(null);
    if (!source) return;
    if (source.kind === 'part' && target.kind === 'part') {
      const parts = draft.parts.filter((part) => part.id !== source.partId);
      const part = draft.parts.find((part) => part.id === source.partId);
      const index = parts.findIndex((part) => part.id === target.partId);
      if (!part || index < 0) return;
      parts.splice(index + Number(after), 0, part);
      setDraft({ ...draft, parts });
    }
    if (source.kind === 'block' && target.kind === 'block') {
      const block = sectionBlocks(draft, source.location)[
        source.location.index
      ];
      if (!block) return;
      let next = changeBlocks(
        draft,
        source.location,
        sectionBlocks(draft, source.location).filter(
          (_, i) => i !== source.location.index
        )
      );
      const blocks = [...sectionBlocks(next, target.location)];
      let index = target.location.index + Number(after);
      if (
        sameSection(source.location, target.location) &&
        source.location.index < index
      )
        index--;
      index = Math.max(0, index);
      blocks.splice(index, 0, block);
      next = changeBlocks(next, target.location, blocks);
      setDraft(next);
      setSelected({ kind: 'block', location: { ...target.location, index } });
    }
  };
  // Part labels only mean something when a question has several parts.
  const labelled = draft.parts.length > 1;
  const row = (
    item: Row,
    label: string,
    { mark, meta }: { mark?: string; meta?: string } = {}
  ) => {
    const key = rowKey(item);
    const part =
      item.kind === 'block'
        ? undefined
        : draft.parts.find((part) => part.id === item.partId);
    const block =
      item.kind === 'block'
        ? sectionBlocks(draft, item.location)[item.location.index]
        : undefined;
    const expanded =
      item.kind === 'solution' && expandedSolutions.includes(item.partId);
    return (
      <div
        className={cn(
          'group relative flex min-w-0 items-center gap-1 rounded-button hover:bg-surface-hover-bg',
          selected && rowKey(selected) === key && 'bg-tint-accent-1',
          drop?.key === key &&
            (drop.after
              ? 'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-action-accent'
              : 'before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-action-accent')
        )}
        draggable={item.kind !== 'solution'}
        key={key}
        onDragEnd={() => {
          dragged.current = null;
          setDrop(null);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          setDrop({ after: event.clientY > rect.top + rect.height / 2, key });
        }}
        onDragStart={(event) => {
          event.stopPropagation();
          dragged.current = item;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', key);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          dropRow(item, event.clientY > rect.top + rect.height / 2);
        }}
      >
        <button
          aria-expanded={item.kind === 'solution' ? expanded : undefined}
          className={cn(
            'grid min-w-0 flex-1 px-2 py-1.5 text-left text-sm',
            labelled ? 'grid-cols-[1.75rem_minmax(0,1fr)]' : 'grid-cols-1'
          )}
          onClick={() => {
            setSelected(item);
            if (item.kind === 'block') openBlock(item.location);
            else if (item.kind === 'part' && part)
              setEditing({ kind: 'part', part: structuredClone(part) });
            else if (item.kind === 'solution')
              setExpandedSolutions((current) =>
                expanded
                  ? current.filter((id) => id !== item.partId)
                  : [...current, item.partId]
              );
          }}
          type="button"
        >
          {labelled && <strong>{mark}</strong>}
          <span className="flex min-w-0 items-center gap-1.5">
            {item.kind === 'solution' && (
              <Icon
                className="size-3 shrink-0 text-fg-muted"
                name={expanded ? 'chevronDown' : 'chevronRight'}
              />
            )}
            <span className="min-w-0 truncate">
              {block?.type === 'text' ? (
                <TextView
                  className="whitespace-nowrap [&>span]:inline"
                  text={label}
                />
              ) : (
                label
              )}
            </span>
          </span>
          {meta && (
            <span
              className={cn('text-fg-muted text-xs', labelled && 'col-start-2')}
            >
              {meta}
            </span>
          )}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarButton
              className="shrink-0 data-[state=open]:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
              label={m.question_ui_actions({ label })}
            >
              <Icon name="moreVertical" />
            </ToolbarButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {part && item.kind === 'part' && (
              <>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {m.question_ui_answer_type()}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {QUESTION_TYPES.map((type) => (
                      <DropdownMenuItem
                        key={type}
                        onSelect={() =>
                          changePart({ ...part, answer: emptyAnswer(type) })
                        }
                      >
                        {answerLabels[type]()}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem
                  onSelect={() =>
                    setEditing({ kind: 'part', part: structuredClone(part) })
                  }
                >
                  {m.question_ui_answer_and_marking_scheme()}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {item.kind === 'block' && (
              <DropdownMenuItem onSelect={() => openBlock(item.location)}>
                {m.question_ui_edit()}
              </DropdownMenuItem>
            )}
            {item.kind !== 'solution' && (
              <>
                <DropdownMenuItem onSelect={() => move(item, -1)}>
                  {m.question_ui_move_up()}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => move(item, 1)}>
                  {m.question_ui_move_down()}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={item.kind === 'part' && draft.parts.length <= 1}
                  onSelect={() =>
                    item.kind === 'block'
                      ? removeBlock(item.location)
                      : removePart(item.partId)
                  }
                >
                  {item.kind === 'part'
                    ? m.question_ui_remove_part()
                    : m.question_ui_remove_block()}
                </DropdownMenuItem>
              </>
            )}
            {item.kind === 'solution' && (
              <DropdownMenuItem
                onSelect={() => {
                  setSelected(item);
                  setAddOpen(true);
                }}
              >
                {m.question_ui_add_block()}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };
  const previewBlock = (
    block: QuestionBlock,
    index: number,
    section: BlockSection
  ) => {
    const location = { ...section, index };
    const active =
      selected?.kind === 'block' &&
      rowKey(selected) === rowKey({ kind: 'block', location });
    return (
      <div
        aria-label={m.question_ui_select_block({
          type: blockLabels[block.type](),
        })}
        className={cn(
          'relative outline-offset-4',
          active && 'my-12 outline-2 outline-action-accent'
        )}
        onClick={() => setSelected({ kind: 'block', location })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') openBlock(location);
        }}
        role="button"
        tabIndex={0}
      >
        <FloatingToolbar
          aria-label={m.question_ui_block_actions()}
          className="scroll-fade-x max-w-full [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          open={active}
          positionClassName="absolute bottom-full left-0 z-10 mb-3 max-w-full"
          role="toolbar"
        >
          <ToolbarGroup>
            <ToolbarButton
              label={m.question_ui_edit()}
              onClick={(event) => {
                event.stopPropagation();
                openBlock(location);
              }}
            >
              <Icon name="pencil" />
            </ToolbarButton>
            {block.type === 'image' && (
              <ToolbarButton
                label={m.question_ui_replace()}
                onClick={(event) => {
                  event.stopPropagation();
                  openBlock(location);
                }}
              >
                <Icon name="image" />
              </ToolbarButton>
            )}
          </ToolbarGroup>
          <ToolbarGroup>
            <ToolbarButton
              label={m.question_ui_move_up()}
              onClick={(event) => {
                event.stopPropagation();
                move({ kind: 'block', location }, -1);
              }}
            >
              <Icon name="arrowUp" />
            </ToolbarButton>
            <ToolbarButton
              label={m.question_ui_move_down()}
              onClick={(event) => {
                event.stopPropagation();
                move({ kind: 'block', location }, 1);
              }}
            >
              <Icon name="arrowDown" />
            </ToolbarButton>
            <ToolbarButton
              label={m.question_ui_duplicate()}
              onClick={(event) => {
                event.stopPropagation();
                const blocks = [...sectionBlocks(draft, location)];
                blocks.splice(index + 1, 0, structuredClone(block));
                setDraft(changeBlocks(draft, section, blocks));
              }}
            >
              <Icon name="copy" />
            </ToolbarButton>
          </ToolbarGroup>
          <ToolbarGroup>
            <ToolbarButton
              label={m.question_ui_delete()}
              onClick={(event) => {
                event.stopPropagation();
                removeBlock(location);
              }}
              variant="danger-light"
            >
              <Icon name="trash" />
            </ToolbarButton>
          </ToolbarGroup>
        </FloatingToolbar>
        <QuestionBlockView block={block} />
      </div>
    );
  };
  return (
    <SimpleDialog
      cardClassName="min-h-0 rounded-t-card-xl rounded-b-none sm:rounded-card-lg"
      cardScrollContainerClassName="max-h-[92dvh] overflow-hidden px-4 py-5 sm:max-h-[88dvh] sm:px-5.5 sm:py-6.5 [&>[data-slot=dialog-title]]:shrink-0 [&>[data-slot=dialog-footer]]:shrink-0"
      className="top-auto bottom-0 left-0 max-h-[92dvh] translate-x-0 translate-y-0 grid-rows-[minmax(0,1fr)_auto] px-0 sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-h-[88dvh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:px-4 [&>.ML\_\_keyboard.is-visible]:h-[var(--_keyboard-height)]! [&>.ML\_\_keyboard]:h-0!"
      footer={
        editing ? (
          <>
            <Button
              className="rounded-input"
              disabled={
                pending || (editing.kind === 'part' && draft.parts.length <= 1)
              }
              onClick={() =>
                editing.kind === 'block'
                  ? removeBlock(editing.location)
                  : removePart(editing.part.id)
              }
              size="lg"
              type="button"
              variant="danger-light"
            >
              {editing.kind === 'part'
                ? m.question_ui_remove_part()
                : m.question_ui_remove_block()}
            </Button>
            <Button
              className="rounded-input"
              disabled={pending}
              onClick={() => void saveInner()}
              size="lg"
              type="button"
              variant="accent"
            >
              {m.question_ui_save()}
            </Button>
          </>
        ) : (
          <>
            <Button
              className="rounded-input"
              disabled={pending}
              onClick={onClose}
              size="lg"
              type="button"
              variant="ghost-hover"
            >
              {m.question_ui_cancel()}
            </Button>
            <Button
              className="rounded-input"
              disabled={pending}
              onClick={() => void saveQuestion()}
              size="lg"
              type="button"
              variant="accent"
            >
              {m.question_ui_save()}
            </Button>
          </>
        )
      }
      onClose={() => {
        if (!pending) onClose();
      }}
      open={open}
      title={
        <div>
          <span>{m.question_ui_edit_question()}</span>
          {context && !editing && (
            <p className="mt-1 font-normal text-fg-muted text-sm">{context}</p>
          )}
        </div>
      }
      width={920}
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
        {error && (
          <div className="mb-3 space-y-2 text-sm" role="alert">
            <p className="text-solid-error">{error}</p>
            {onReload && (
              <Button
                disabled={pending}
                onClick={async () => {
                  setReloading(true);
                  try {
                    const latest = await onReload();
                    reset({ draft: structuredClone(latest) });
                    setEditing(null);
                    setSelected(null);
                    setError('');
                  } catch (failure) {
                    setError(
                      errorCopy(
                        failure,
                        m.question_ui_could_not_save_question()
                      )
                    );
                  } finally {
                    setReloading(false);
                  }
                }}
                type="button"
                variant="ghost"
              >
                {m.question_ui_conflict_reload()}
              </Button>
            )}
          </div>
        )}
        {editing ? (
          <div className="space-y-4">
            <Button
              disabled={pending}
              iconLeft="navigationBack"
              onClick={() => {
                setEditing(null);
                setError('');
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {m.question_ui_back_to_question()}
            </Button>
            <h3 className="t-large-card-title">
              {editing.kind === 'part'
                ? m.question_ui_answer_and_marking_scheme()
                : blockLabels[editing.block.type]()}
            </h3>
            {editing.kind === 'block' ? (
              <BlockEditor
                block={editing.block}
                onBusyChange={setSavingBlock}
                onChange={(block) =>
                  setEditing((current) =>
                    current?.kind === 'block' &&
                    rowKey({ kind: 'block', location: current.location }) ===
                      rowKey({ kind: 'block', location: editing.location })
                      ? { ...current, block }
                      : current
                  )
                }
                uploadAsset={uploadAsset}
              />
            ) : (
              <div className="space-y-5">
                <AnswerEditor
                  answer={editing.part.answer}
                  onChange={(answer) =>
                    setEditing({
                      ...editing,
                      part: { ...editing.part, answer },
                    })
                  }
                />
                <StringList
                  label={m.question_ui_scheme_marks({
                    marks: marksLabel(editing.part.markscheme.length),
                  })}
                  onChange={(markscheme) =>
                    setEditing({
                      ...editing,
                      part: { ...editing.part, markscheme },
                    })
                  }
                  values={editing.part.markscheme}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="grid min-h-72 min-w-0 gap-5 md:grid-cols-[minmax(12rem,0.7fr)_minmax(0,1.7fr)]">
            <div
              className={cn(
                'min-w-0 space-y-1 md:block md:border-divider md:border-r md:pr-4',
                mobileTab !== 'outline' && 'hidden'
              )}
            >
              <div className="flex items-center gap-1">
                <span className="mr-auto px-2 font-semibold">
                  {questionNumber == null
                    ? m.question_ui_question()
                    : m.question_ui_question_number({
                        number: questionNumber,
                      })}
                </span>
                <Popover onOpenChange={setAddOpen} open={addOpen}>
                  <PopoverTrigger asChild>
                    <ToolbarButton label={m.question_ui_add_block_or_part()}>
                      <Icon name="plus" />
                    </ToolbarButton>
                  </PopoverTrigger>
                  <PopoverContent>
                    {(
                      [
                        'text',
                        'chart',
                        'graph',
                        'table',
                        ...(uploadAsset ? ['image' as const] : []),
                        'part',
                      ] as const
                    ).map((type) => (
                      <Button
                        key={type}
                        onClick={() => add(type)}
                        type="button"
                        variant="ghost"
                      >
                        {blockLabels[type]()}
                      </Button>
                    ))}
                  </PopoverContent>
                </Popover>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <ToolbarButton label={m.question_ui_question_settings()}>
                      <Icon name="moreVertical" />
                    </ToolbarButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <div className="space-y-3 p-2">
                      <SelectField
                        label={m.question_ui_layout()}
                        onChange={(layout) =>
                          setDraft({
                            ...draft,
                            layout: layout as Question['layout'],
                          })
                        }
                        options={[
                          {
                            label: m.question_ui_exam_paper(),
                            value: 'paper',
                          },
                          {
                            label: m.question_ui_split_view(),
                            value: 'split',
                          },
                        ]}
                        value={draft.layout}
                      />
                      <SelectField
                        label={m.question_ui_part_labels()}
                        onChange={(labels) =>
                          setDraft({
                            ...draft,
                            labels: labels as Question['labels'],
                          })
                        }
                        options={[
                          { label: '(a), (b)', value: 'letters' },
                          { label: '1, 2', value: 'numbers' },
                        ]}
                        value={draft.labels}
                      />
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {draft.stem.map((block, index) =>
                row(
                  { kind: 'block', location: { index } },
                  blockSummary(block),
                  { meta: blockLabels[block.type]() }
                )
              )}
              {draft.parts.map((part, i) => {
                // The part label sits on the part's first row: its first
                // block, or its answer row when it has no blocks.
                const mark =
                  draft.labels === 'letters'
                    ? `(${String.fromCharCode(97 + i)})`
                    : `${i + 1}.`;
                return (
                  <div
                    className={cn(labelled && i > 0 && 'mt-2')}
                    key={part.id}
                  >
                    {part.blocks.map((block, index) =>
                      row(
                        {
                          kind: 'block',
                          location: { index, partId: part.id },
                        },
                        blockSummary(block),
                        {
                          mark: index === 0 ? mark : undefined,
                          meta: blockLabels[block.type](),
                        }
                      )
                    )}
                    {row(
                      { kind: 'part', partId: part.id },
                      m.question_ui_answer_and_marking_scheme(),
                      {
                        mark: part.blocks.length ? undefined : mark,
                        meta: `${answerLabels[part.answer.type]()} · ${marksLabel(part.markscheme.length)}`,
                      }
                    )}
                    {row(
                      { kind: 'solution', partId: part.id },
                      m.question_ui_worked_solution(),
                      {
                        meta:
                          part.solution.length === 1
                            ? m.question_ui_one_block()
                            : m.question_ui_block_count({
                                count: part.solution.length,
                              }),
                      }
                    )}
                    {expandedSolutions.includes(part.id) &&
                      part.solution.map((block, index) =>
                        row(
                          {
                            kind: 'block',
                            location: {
                              index,
                              partId: part.id,
                              solution: true,
                            },
                          },
                          blockSummary(block),
                          { meta: blockLabels[block.type]() }
                        )
                      )}
                  </div>
                );
              })}
              {/* Phones show the outline first; the preview is one step in. */}
              <button
                className="mt-3 flex w-full items-center justify-between rounded-input border border-line px-3.5 py-3 text-left font-semibold md:hidden"
                onClick={() => setMobileTab('preview')}
                type="button"
              >
                {m.question_ui_preview_question()}
                <Icon name="navigationForward" size={16} />
              </button>
            </div>
            <div
              className={cn(
                'min-w-0 px-1.5 md:block',
                mobileTab !== 'preview' && 'hidden'
              )}
            >
              <Button
                className="mb-4 md:hidden"
                iconLeft="navigationBack"
                onClick={() => setMobileTab('outline')}
                size="sm"
                type="button"
                variant="ghost-hover"
              >
                {m.question_ui_back_to_outline()}
              </Button>
              <QuestionRunner
                answers={{}}
                disabled
                question={draft}
                questionNumber={questionNumber}
                renderBlock={previewBlock}
              />
              {selected?.kind === 'block' && selected.location.solution && (
                <section className="mt-8">
                  <h3 className="mb-4 font-semibold">
                    {m.question_ui_worked_solution()}
                  </h3>
                  {sectionBlocks(draft, selected.location).map(
                    (block, index) => (
                      <div key={index}>
                        {previewBlock(block, index, selected.location)}
                      </div>
                    )
                  )}
                </section>
              )}
            </div>
          </div>
        )}
      </div>
    </SimpleDialog>
  );
}
