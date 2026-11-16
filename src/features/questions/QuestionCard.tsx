import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as limits from '@/api/limits.generated';
import { Button } from '@/components/ui/Button';
import { useIsPhone } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/feedback';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverGroup,
} from '@/components/ui/ToolbarPopover';
import {
  DrawnSampleField,
  type UploadDrawnSample,
} from '@/features/quizzes/drawing/DrawnSample';
import { pinnedQuestion } from '@/features/quizzes/drawing/pinnedQuestion';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { IMAGE_ACCEPT } from '@/lib/fitImage';
import { BlockDialog, blockLabels } from './BlockDialog';
import type { UploadQuestionAsset } from './BlockEditor';
import {
  AnswerEditor,
  AnswerTypeSelect,
  answerKind,
  answerLabels,
  answerOfKind,
  GapChip,
  MarkSchemeRows,
  MarksInput,
  MenuItem,
  withShuffle,
} from './editorFields';
import {
  addSubPart,
  appendGroup,
  canMoveItem,
  canRemoveGroup,
  canRemovePart,
  canUngroup,
  type ItemRef,
  isLonePart,
  moveItem,
  questionItems,
  removeGroup,
  ungroup,
} from './groups';
import { IssueSummary } from './IssueViews';
import { type BlockSection, QuestionBlockView } from './QuestionView';
import {
  type AddableBlock,
  changeBlocks,
  type FigureRoom,
  findBlock,
  newPart,
  newQuestionBlock,
  saveFigure,
  sectionBlocks,
  withAnswer,
} from './questionEdits';
import { hasSample } from './SampleBlock';
import { clickPoint, TextEditor } from './TextEditor';
import { TextView } from './TextView';
import {
  GAP_MARKER,
  gapNumbers,
  modelMarked,
  type Question,
  type QuestionBlock,
  type QuestionPart,
  questionMarks,
  withGapsText,
} from './types';

const marksLabel = (count: number) =>
  count === 1 ? m.question_ui_one_mark() : m.question_ui_marks({ count });

/** A gaps part's text with each blank as its numbered chip (board Types2). */
function GapTextView({ start, text }: { start: number; text: string }) {
  const pieces: ReactNode[] = [];
  let at = 0;
  let blank = start;
  for (const match of text.matchAll(GAP_MARKER)) {
    pieces.push(
      <TextView key={at} marks text={text.slice(at, match.index)} />,
      <span className="mx-0.5" key={`gap${blank}`}>
        <GapChip number={blank++} />
      </span>
    );
    at = match.index + match[0].length;
  }
  pieces.push(<TextView key={at} marks text={text.slice(at)} />);
  return <span className="leading-[1.7]">{pieces}</span>;
}

/** An image block's file uploaded, with its size read from it. */
async function uploadImage(
  file: File,
  uploadAsset: UploadQuestionAsset
): Promise<
  Pick<Extract<QuestionBlock, { type: 'image' }>, 'height' | 'image' | 'width'>
> {
  const local = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = local;
    await image.decode();
    return {
      height: image.naturalHeight,
      image: await uploadAsset(file),
      width: image.naturalWidth,
    };
  } finally {
    URL.revokeObjectURL(local);
  }
}

const insertIcons: Record<AddableBlock, IconName> = {
  chart: 'chart',
  graph: 'graph',
  image: 'image',
  table: 'table',
  text: 'text',
};

/** A figure the card shows and its dialog edits. */
type Figure = {
  block: QuestionBlock;
  index: number;
  /** Added from Insert: Save puts it in, Cancel leaves nothing behind. */
  isNew?: boolean;
  /** The block before it when the dialog opened, where Save puts it back. */
  before?: QuestionBlock;
  section: BlockSection;
};

/**
 * A section's blocks in the open card (board Main): each text reads as
 * written and edits in place on a click, its formula tools in a row under it
 * with Insert (+); a figure opens its dialog (an image changes in place) and
 * moves or goes from its hover tools. `aside` sits at its right (the answer
 * type), under the text on a phone.
 */
/** Text ending in a display formula: the formula's outline is its edge. */
const ENDS_IN_DISPLAY = /\$\$\s*$/;

function BlocksColumn({
  aside,
  asideTarget,
  autoFocus,
  blocks,
  gaps,
  imageButton,
  lead,
  maxLength = limits.QUESTION_TEXT_MAX,
  onChange,
  onFigure,
  placeholder,
  section,
  textOnly,
  uploadAsset,
}: {
  aside?: ReactNode;
  /** Where `aside` and Add image go instead of beside the text: the card's
   * number row, so the text keeps the closed card's width. Null until it
   * mounts, when they wait rather than show beside the text first. */
  asideTarget?: HTMLElement | null;
  /** Its first text opens in its editor (a card or solution just opened). */
  autoFocus?: boolean;
  blocks: QuestionBlock[];
  /** A gaps part's text: its blanks' answers change with it. */
  gaps?: { onChange: (part: QuestionPart) => void; part: QuestionPart };
  /** Add image beside `aside` (a lone part's, board Main). */
  imageButton?: boolean;
  /** A part's label before it: (a), (b). */
  lead?: string;
  maxLength?: number;
  onChange: (blocks: QuestionBlock[]) => void;
  onFigure: (figure: Figure) => void;
  placeholder: string;
  section: BlockSection;
  /** Text alone, with no Insert (a long answer's sample answer). */
  textOnly?: boolean;
  uploadAsset?: UploadQuestionAsset;
}) {
  const [editing, setEditing] = useState<number | null>(() =>
    autoFocus ? blocks.findIndex((block) => block.type === 'text') : null
  );
  const [caret, setCaret] = useState<(() => { x: number; y: number }) | null>(
    null
  );
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  // An image on its way: added at the end of the open text, or replacing the
  // image at `at`.
  const [uploading, setUploading] = useState<{
    at: number;
    replace: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  // The image the file picker replaces; none adds one.
  const replaceAt = useRef<number | null>(null);
  const pickReplacement = (index: number) => {
    replaceAt.current = index;
    file.current?.click();
  };
  // The blanks in the open text by id, as its editor read them in; each change
  // carries every list along with its blank (as BlockEditor does).
  const blankIds = useRef<string[]>([]);
  const open = editing !== null && blocks[editing]?.type === 'text';
  // Rows are keyed by place and the open text's editor reads its value once,
  // so a block added or removed by anyone else (a co-editor, the figure
  // dialog) closes it before it can write over the block now in its place.
  const ownLength = useRef<number | null>(null);
  const seenLength = useRef(blocks.length);
  useLayoutEffect(() => {
    if (seenLength.current === blocks.length) return;
    seenLength.current = blocks.length;
    if (ownLength.current !== blocks.length) setEditing(null);
    ownLength.current = null;
  }, [blocks.length]);
  /** A change of this column's own that adds a block. */
  const grow = (next: QuestionBlock[]) => {
    ownLength.current = next.length;
    onChange(next);
  };
  useEffect(() => {
    if (!open) return;
    // A press outside closes the text on its click, not its pointerdown: the
    // formula row going would move what was pressed (a Solution button under
    // it) before the release, and the click would miss it.
    let outside = false;
    const press = (event: PointerEvent) => {
      const target = event.target;
      outside = false;
      if (!(target instanceof Element) || box.current?.contains(target)) return;
      // A formula's keyboard and popovers, and another dialog over this one,
      // sit outside the column.
      const dialog = target.closest('[role="dialog"]');
      if (
        target.closest('[data-radix-popper-content-wrapper], .ML__keyboard') ||
        (dialog && box.current && !dialog.contains(box.current))
      )
        return;
      outside = true;
    };
    const leave = () => {
      if (outside) setEditing(null);
      outside = false;
    };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('click', leave, true);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('click', leave, true);
    };
  }, [open]);
  const edit = (index: number, at: (() => { x: number; y: number }) | null) => {
    const block = blocks[index];
    blankIds.current =
      block?.type === 'text' ? gapNumbers([block]).map((_, i) => `g${i}`) : [];
    setCaret(() => at);
    setEditing(index);
  };
  // Where Insert puts a block: after the open text, else at the end.
  const insertAt = editing === null ? blocks.length : editing + 1;
  const full = blocks.length >= limits.QUESTION_BLOCKS_MAX;
  const insert = (type: AddableBlock) => {
    if (type === 'image') {
      replaceAt.current = null;
      file.current?.click();
      return;
    }
    const block = newQuestionBlock(type);
    if (type === 'text') {
      grow([...blocks.slice(0, insertAt), block, ...blocks.slice(insertAt)]);
      edit(insertAt, null);
      return;
    }
    onFigure({
      before: blocks[insertAt - 1],
      block,
      index: insertAt,
      isNew: true,
      section,
    });
  };
  // Moving or removing a figure closes the open text, whose place changes.
  const move = (index: number, to: number) => {
    const next = [...blocks];
    [next[index], next[to]] = [next[to], next[index]];
    setEditing(null);
    onChange(next);
  };
  const remove = (index: number) => {
    setEditing(null);
    onChange(blocks.filter((_, j) => j !== index));
  };
  const textBlock = (
    block: Extract<QuestionBlock, { type: 'text' }>,
    i: number
  ) => {
    const start = gaps ? gapNumbers(blocks.slice(0, i)).length + 1 : undefined;
    if (editing === i)
      return (
        <div
          className={cn(
            // Its 2px line takes a pixel of the closed text's padding: no shift.
            'border-action-accent border-b-2 pt-1 pb-0.75 leading-[1.7]',
            // A display formula at the end has its own outline: no line under it.
            ENDS_IN_DISPLAY.test(block.text) && 'border-transparent'
          )}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(null);
          }}
          role="presentation"
        >
          <TextEditor
            caretAt={caret}
            compact
            gapStart={start}
            maxLength={maxLength}
            onChange={(text, ids) => {
              if (!gaps) {
                onChange(
                  blocks.map((item, j) => (j === i ? { ...block, text } : item))
                );
                return;
              }
              const before = blankIds.current;
              const offset = (start ?? 1) - 1;
              const used = new Set<number>();
              const lists = ids.map((id) => {
                const at = before.indexOf(id);
                if (at < 0 || used.has(at)) return [''];
                used.add(at);
                return (
                  (gaps.part.answer.type === 'gaps' &&
                    gaps.part.answer.accepted[offset + at]) || ['']
                );
              });
              blankIds.current = ids;
              gaps.onChange(withGapsText(gaps.part, i, text, lists));
            }}
            placeholder={placeholder}
            toolbarTarget={tools}
            value={block.text}
          />
        </div>
      );
    return (
      <button
        className="block w-full cursor-text border-transparent border-b py-2 text-left leading-[1.7] outline-none hover:border-line focus-visible:border-action-accent"
        onClick={(event) =>
          edit(
            i,
            // Kept against the block's row, which stays while it opens.
            event.detail && event.currentTarget.parentElement
              ? clickPoint(event, event.currentTarget.parentElement)
              : null
          )
        }
        type="button"
      >
        {block.text.trim() ? (
          start === undefined ? (
            // At the open text's 1.7 leading, not the view's relaxed one.
            <TextView marks text={block.text} />
          ) : (
            <GapTextView start={start} text={block.text} />
          )
        ) : (
          <span className="text-fg-muted">{placeholder}</span>
        )}
      </button>
    );
  };
  const figure = (block: QuestionBlock, i: number) => (
    <div className="group/figure relative py-1">
      {block.type === 'image' ? (
        // As the closed card draws it; Replace is in its hover tools.
        'url' in block.image && !block.image.url ? (
          <Button
            disabled={!uploadAsset || !!uploading}
            onClick={() => pickReplacement(i)}
            size="sm"
            type="button"
            variant="outline"
          >
            {m.quiz_editor_choose_image()}
          </Button>
        ) : (
          <div
            className={cn(
              uploading?.replace && uploading.at === i && 'opacity-50'
            )}
          >
            <QuestionBlockView block={block} />
          </div>
        )
      ) : (
        <button
          aria-label={m.question_ui_edit_block({
            type: blockLabels[block.type](),
          })}
          className="block w-full cursor-pointer rounded-md text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action"
          onClick={() =>
            onFigure({ before: blocks[i - 1], block, index: i, section })
          }
          type="button"
        >
          <QuestionBlockView block={block} />
        </button>
      )}
      <div className="absolute top-1 right-0 flex rounded-button bg-overlay shadow-pop max-md:static max-md:mt-1 max-md:ml-auto max-md:w-fit md:opacity-0 md:group-hover/figure:opacity-100 md:focus-within:opacity-100">
        {block.type === 'image' && uploadAsset && (
          <ToolbarButton
            disabled={!!uploading}
            label={m.question_ui_replace()}
            onClick={() => pickReplacement(i)}
          >
            <Icon name="upload" />
          </ToolbarButton>
        )}
        <ToolbarButton
          disabled={i === 0}
          label={m.question_ui_move_up()}
          onClick={() => move(i, i - 1)}
        >
          <Icon name="arrowUp" />
        </ToolbarButton>
        <ToolbarButton
          disabled={i === blocks.length - 1}
          label={m.question_ui_move_down()}
          onClick={() => move(i, i + 1)}
        >
          <Icon name="arrowDown" />
        </ToolbarButton>
        <ToolbarButton
          label={m.question_ui_remove_block()}
          onClick={() => remove(i)}
          variant="danger-light"
        >
          <Icon name="trash" />
        </ToolbarButton>
      </div>
    </div>
  );
  // The open text's formula tools and Insert, right under it.
  const toolbar = (
    <div
      aria-label={m.question_ui_formula_tools()}
      className="mt-1.5 -ml-1.5 flex h-9 min-w-0 items-center overflow-x-auto [scrollbar-width:none]"
      role="toolbar"
    >
      <div className="flex h-full items-center" ref={setTools} />
      {!textOnly && (
        <Popover>
          <PopoverTrigger asChild>
            <ToolbarButton
              disabled={full}
              label={m.question_ui_insert_figure()}
            >
              <Icon name="plus" />
            </ToolbarButton>
          </PopoverTrigger>
          <ToolbarPopoverContent align="start" className="w-44">
            {(
              [
                'text',
                'table',
                'chart',
                'graph',
                ...(uploadAsset ? ['image' as const] : []),
              ] as const
            ).map((type) => (
              <MenuItem
                icon={<Icon name={insertIcons[type]} />}
                key={type}
                label={blockLabels[type]()}
                onClick={() => insert(type)}
              />
            ))}
          </ToolbarPopoverContent>
        </Popover>
      )}
    </div>
  );
  return (
    <div className="flex @min-[36rem]:flex-row flex-col @min-[36rem]:items-start gap-4">
      <div className="flex min-w-0 flex-1 gap-3" ref={box}>
        {/* At least 24px, so with its gap the text starts 36px in, where a
            part's answer does (pl-9). */}
        {lead && (
          <span className="min-w-6 shrink-0 pt-2 font-bold">{lead}</span>
        )}
        <div className="min-w-0 flex-1">
          {blocks.map((block, i) => (
            <div key={i}>
              {block.type === 'text' ? textBlock(block, i) : figure(block, i)}
              {open && editing === i && toolbar}
            </div>
          ))}
          {blocks.length === 0 && (
            <button
              className="block w-full cursor-text border-line border-b py-2 text-left text-fg-muted outline-none hover:border-line-strong focus-visible:border-action-accent"
              onClick={() => {
                grow([newQuestionBlock('text')]);
                edit(0, null);
              }}
              type="button"
            >
              {placeholder}
            </button>
          )}
          <input
            accept={IMAGE_ACCEPT}
            className="hidden"
            onChange={async (event) => {
              const picked = event.target.files?.[0];
              if (file.current) file.current.value = '';
              const at = replaceAt.current;
              replaceAt.current = null;
              if (!(picked && uploadAsset)) return;
              setUploading({ at: at ?? insertAt, replace: at !== null });
              setError('');
              try {
                const image = await uploadImage(picked, uploadAsset);
                if (at === null)
                  grow([
                    ...blocks.slice(0, insertAt),
                    { description: '', type: 'image', ...image },
                    ...blocks.slice(insertAt),
                  ]);
                else
                  onChange(
                    blocks.map((item, j) =>
                      j === at && item.type === 'image'
                        ? { ...item, ...image }
                        : item
                    )
                  );
              } catch (failure) {
                setError(errorCopy(failure, m.question_ui_upload_failed()));
              } finally {
                setUploading(null);
              }
            }}
            ref={file}
            type="file"
          />
          {uploading && !uploading.replace && (
            <Skeleton className="mt-2 h-27.5 w-full" />
          )}
          {error && (
            <p className="t-meta mt-1 text-tint-error-fg" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      {asideTarget === undefined && (aside || imageButton) && (
        <div className="flex @min-[36rem]:w-auto w-full shrink-0 items-start gap-1">
          {imageButton && uploadAsset && (
            <ToolbarButton
              className="mt-0.5 @min-[36rem]:inline-flex hidden"
              disabled={full || !!uploading}
              label={m.question_ui_add_image()}
              onClick={() => insert('image')}
            >
              <Icon name="image" />
            </ToolbarButton>
          )}
          {aside}
        </div>
      )}
      {asideTarget &&
        createPortal(
          <>
            {imageButton && uploadAsset && (
              <ToolbarButton
                className="@min-[36rem]:inline-flex hidden"
                disabled={full || !!uploading}
                label={m.question_ui_add_image()}
                onClick={() => insert('image')}
              >
                <Icon name="image" />
              </ToolbarButton>
            )}
            {aside}
          </>,
          asideTarget
        )}
    </div>
  );
}

/** A closed part's answer in one line: its options with the correct ones
 * ticked, or its key in short. */
function answerLine(part: QuestionPart): string {
  const { answer } = part;
  switch (answer.type) {
    case 'mcq':
      return answer.options
        .map((option, i) =>
          answer.correct.includes(i) ? `${option} ✓` : option
        )
        .join(' · ');
    case 'boolean':
      return answer.correct ? m.question_ui_true() : m.question_ui_false();
    case 'short':
      return answer.accepted.filter(Boolean).join(' / ');
    case 'matching':
      return answer.pairs
        .map((pair) => `${pair.left} → ${answer.options[pair.right] ?? ''}`)
        .join(' · ');
    case 'ordering':
      return answer.items.join(' → ');
    case 'gaps':
      return answer.accepted
        .map((list, i) => `(${i + 1}) ${list.filter(Boolean).join(' / ')}`)
        .join(' · ');
    case 'open':
    case 'drawing':
      return (part.markscheme ?? []).map((item) => item.text).join(' · ');
  }
}

/** A part of several in a line (board Parts): its label, first words, type
 * and marks, its key in short under them. */
function partLine(part: QuestionPart, label: string, keysPending?: boolean) {
  return (
    <>
      <span className="flex items-start gap-3">
        <span className="min-w-6 shrink-0 font-bold">{label}</span>
        {/* At the open part's 1.7 leading. */}
        <span className="line-clamp-2 min-w-0 flex-1 leading-[1.7]">
          {part.blocks[0]?.type === 'text' && part.blocks[0].text.trim() ? (
            <TextView marks text={part.blocks[0].text} />
          ) : (
            <span className="text-fg-muted">
              {m.question_ui_question_placeholder()}
            </span>
          )}
        </span>
        {/* As wide as the open part's type menu, so its text wraps the same. */}
        <span className="@min-[36rem]:ml-1 @min-[36rem]:w-45 shrink-0 truncate whitespace-nowrap pt-px @min-[36rem]:text-right text-[13px] text-fg-muted">
          {`${answerLabels[part.answer.type]()} · ${marksLabel(part.marks)}`}
        </span>
      </span>
      {/* Its room kept while the keys come (Epo 2026-11-15): a choice part
          lists its options already, the rest a blank line. */}
      <span className="mt-1 block truncate pl-9 text-[13.5px] text-fg-muted">
        {(keysPending
          ? part.answer.type === 'mcq'
            ? part.answer.options.join(' · ')
            : ''
          : answerLine(part)) || '\u00a0'}
      </span>
    </>
  );
}

/** Blocks as the open card shows them before one is clicked into: text on
 * its row's padding, figures on theirs, a gaps part's blanks numbered. */
function BlocksView({
  blocks,
  gaps,
}: {
  blocks: QuestionBlock[];
  gaps?: boolean;
}) {
  if (blocks.length === 0)
    return (
      <p className="border-line border-b py-2 text-fg-muted">
        {m.question_ui_question_placeholder()}
      </p>
    );
  return blocks.map((block, i) =>
    block.type === 'text' ? (
      <div className="border-transparent border-b py-2 leading-[1.7]" key={i}>
        {block.text.trim() ? (
          gaps ? (
            <GapTextView
              start={gapNumbers(blocks.slice(0, i)).length + 1}
              text={block.text}
            />
          ) : (
            <TextView marks text={block.text} />
          )
        ) : (
          <span className="text-fg-muted">
            {m.question_ui_question_placeholder()}
          </span>
        )}
      </div>
    ) : (
      <div className="py-1" key={i}>
        <QuestionBlockView block={block} />
      </div>
    )
  );
}

/**
 * A closed card in the open card's own layout (Epo 2026-11-15, Google
 * Forms: opening only adds controls): the number row, the text as wide as
 * the open card's, then `answer`, the key; a question of parts lists its
 * parts in a line each, as the open card does its closed ones.
 */
export function QuestionCardView({
  answer,
  issue,
  keysPending,
  number,
  question,
}: {
  answer: (part: QuestionPart) => ReactNode;
  /** Before the marks: the question has an issue. */
  issue?: ReactNode;
  keysPending?: boolean;
  number: number;
  question: Question;
}) {
  const lone = isLonePart(question);
  const first = question.parts[0];
  return (
    <div className="@container flex min-w-0 flex-col">
      <div className="mb-1.5 flex min-h-10 items-center gap-2">
        <span className="font-bold">{number}.</span>
        <span className="t-meta ml-auto flex items-center gap-2 text-fg-muted">
          {issue}
          {lone
            ? marksLabel(questionMarks(question))
            : m.question_ui_marks_in_parts({
                count: question.parts.length,
                marks: marksLabel(questionMarks(question)),
              })}
        </span>
      </div>
      {lone ? (
        <>
          {question.stem.length > 0 && <BlocksView blocks={question.stem} />}
          {(first.blocks.length > 0 || question.stem.length === 0) && (
            <BlocksView
              blocks={first.blocks}
              gaps={first.answer.type === 'gaps'}
            />
          )}
          <div className="mt-3.5">{answer(first)}</div>
        </>
      ) : (
        <>
          {question.stem.length > 0 && (
            <div className="pb-3.5">
              <BlocksView blocks={question.stem} />
            </div>
          )}
          {questionItems(question).map((item) =>
            item.kind === 'part' ? (
              <div
                className="py-3.5"
                data-part-id={item.part.id}
                key={item.part.id}
              >
                {partLine(item.part, item.label, keysPending)}
              </div>
            ) : (
              <div className="pt-3.5" key={item.group.id}>
                {/* As the open card's group column, its ⋮'s room kept. */}
                <div className="flex @min-[36rem]:flex-row flex-col @min-[36rem]:items-start gap-4">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <span className="min-w-6 shrink-0 pt-2 font-bold">
                      {item.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <BlocksView blocks={item.group.blocks} />
                    </div>
                  </div>
                  <span
                    aria-hidden
                    className="flex @min-[36rem]:w-auto w-full shrink-0"
                  >
                    <span className="size-(--toolbar-button)" />
                  </span>
                </div>
                <div className="@min-[36rem]:pl-4">
                  {item.parts.map((sub) => (
                    <div
                      className="py-3.5"
                      data-part-id={sub.part.id}
                      key={sub.part.id}
                    >
                      {partLine(sub.part, sub.label, keysPending)}
                    </div>
                  ))}
                </div>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

export interface QuestionCardProps {
  /** The footer's end after a divider: Duplicate and Delete. */
  actions?: ReactNode;
  /** Add part beside Solution even for one part (the dialog, board Dialog). */
  addPartInFooter?: boolean;
  /** The question's text opens in its editor (a card just added). */
  autoFocus?: boolean;
  /** A live quiz's figures, written by their room entries; none in a draft. */
  figures?: FigureRoom;
  /** The first issue at its top. */
  issues?: string[];
  /** The read's question, whose keys are still to come: none is shown. */
  keysPending?: boolean;
  /** The ⋮ menu's own rows (Add to bank, Move up, Move down), given the
   * menu's close for a submenu that finishes it. */
  menu?: (close: () => void) => ReactNode;
  menuLabel?: string;
  /** Its number on its quiz, before a question of parts' marks. */
  number?: number;
  /** The part of several open at first; with none, each shows as a line, as
   * the closed card has them. */
  openPart?: string;
  policy?: 'quiz' | 'bank';
  question: Question;
  /** The footer's Topic; a phone puts it on its own row above the footer. */
  topic?: ReactNode;
  uploadAsset?: UploadQuestionAsset;
  /** A quiz's drawn sample answers (Q3); the bank has none. */
  uploadSample?: UploadDrawnSample;
  write: (question: Question) => void;
}

/**
 * The open question card (Epo 2026-11-15, boards Main, Types1, Types2,
 * Matching, Parts): the question's text with its formula tools under it, Add
 * image and the answer type at its right; the answer below with the correct
 * one marked beside it; a long answer's or drawing's marking points and
 * Sample answer; the Solution; a footer with Sample answer, Solution, Topic, Marks, the
 * caller's actions and ⋮. A question of parts shows them in the one card,
 * the open part with its own type, answer, marks and ⋮ in its line's place,
 * the others in a line each, no dividers between them. Every change goes to `write` at once: the quiz's rooms, or
 * the dialog's draft.
 */
export function QuestionCard({
  actions,
  addPartInFooter,
  autoFocus,
  figures,
  issues = [],
  keysPending,
  menu,
  menuLabel = m.question_ui_question_settings(),
  number,
  openPart: firstPart,
  policy = 'quiz',
  question,
  topic,
  uploadAsset,
  uploadSample,
  write,
}: QuestionCardProps) {
  const phone = useIsPhone();
  const bank = policy === 'bank';
  const lone = isLonePart(question);
  // The number row's end, where a lone question's answer type goes.
  const [head, setHead] = useState<HTMLSpanElement | null>(null);
  const [openPart, setOpenPart] = useState(firstPart);
  // The part whose sample answer is being added: its text, or its board.
  const [sampleFor, setSampleFor] = useState<string | null>(null);
  // The part whose Solution was just added, opened in its editor.
  const [solutionFor, setSolutionFor] = useState<string | null>(null);
  const [figure, setFigure] = useState<Figure | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // The question as it stands, for a write that lands after an await.
  const latest = useRef(question);
  latest.current = question;
  const shownPart = question.parts.find((part) => part.id === openPart);
  const partsFull =
    question.parts.length >=
    (bank ? limits.QUESTION_PARTS_MAX : limits.QUIZ_QUESTION_PARTS_MAX);
  const changePart = (part: QuestionPart) =>
    write({
      ...question,
      parts: question.parts.map((item) => (item.id === part.id ? part : item)),
    });
  const setBlocks = (section: BlockSection) => (blocks: QuestionBlock[]) =>
    write(changeBlocks(question, section, blocks));
  const addPart = () => {
    const part = newPart();
    write({ ...question, parts: [...question.parts, part] });
    setOpenPart(part.id);
  };
  // A group has at least one part, so it starts with its first.
  const addGroup = () => {
    const part = newPart();
    write(
      appendGroup(
        question,
        { blocks: [newQuestionBlock('text')], id: crypto.randomUUID() },
        part
      )
    );
    setOpenPart(part.id);
  };
  const addSolution = (part: QuestionPart) => {
    changePart({ ...part, solution: [newQuestionBlock('text')] });
    setSolutionFor(part.id);
  };
  const canAddSample = (part: QuestionPart) =>
    !keysPending &&
    !hasSample(part) &&
    sampleFor !== part.id &&
    (part.answer.type === 'open' ||
      (part.answer.type === 'drawing' && !!uploadSample));
  const canAddSolution = (part: QuestionPart) =>
    !keysPending && part.solution.length === 0;
  // The footer's Sample answer and Solution, each its own section
  // (Epo 2026-11-15).
  const solutionButtons = (part: QuestionPart) => (
    <>
      {canAddSample(part) &&
        footerButton(
          part.answer.type === 'drawing'
            ? m.drawing_sample_draw()
            : m.question_ui_sample_answer_heading(),
          () => setSampleFor(part.id)
        )}
      {canAddSolution(part) &&
        footerButton(m.quiz_editor_worked_solution(), () => addSolution(part))}
    </>
  );
  // Shuffle options in a choice part's ⋮ (Epo 2026-11-15, as Canvas).
  const shuffleItem = (part: QuestionPart) => {
    const { answer } = part;
    if (answer.type !== 'mcq' || keysPending) return null;
    return (
      <MenuItem
        icon={<Icon name="shuffle" />}
        label={m.question_ui_shuffle_options()}
        onClick={() =>
          changePart({ ...part, answer: withShuffle(answer, !answer.shuffle) })
        }
        selected={!!answer.shuffle}
      />
    );
  };
  const addMenu = (
    <ToolbarPopoverContent align="start" className="w-44">
      <MenuItem
        disabled={partsFull}
        label={m.question_ui_part()}
        onClick={addPart}
      />
      <MenuItem
        disabled={partsFull}
        label={m.question_ui_group()}
        onClick={addGroup}
      />
    </ToolbarPopoverContent>
  );
  const footerButton = (label: string, onClick: () => void) => (
    <Button
      iconLeft="plus"
      onClick={onClick}
      size="sm"
      type="button"
      variant="outline"
    >
      {label}
    </Button>
  );
  const marksControl = (part: QuestionPart) => (
    <span className="flex items-center gap-2">
      <span className="t-meta font-semibold text-fg-secondary">
        {m.question_ui_part_marks()}
      </span>
      {modelMarked(part.answer.type) ? (
        <>
          <span className="font-semibold">{part.marks}</span>
          <span className="text-[13px] text-fg-muted">
            {m.question_ui_from_mark_scheme()}
          </span>
        </>
      ) : (
        <MarksInput
          label={m.question_ui_part_marks()}
          onChange={(marks) => changePart({ ...part, marks })}
          value={part.marks}
        />
      )}
    </span>
  );

  // The open part's answer: its key, marking points and Solution.
  const answerArea = (part: QuestionPart) => {
    const { answer } = part;
    const setAnswer = (next: typeof answer) =>
      changePart(
        next.type === answer.type
          ? { ...part, answer: next }
          : withAnswer(part, next)
      );
    // An option's text is known without its key; every other answer is the key.
    if (keysPending && answer.type !== 'mcq')
      return (
        <div data-keys-pending="">
          <Skeleton className="h-9 w-full" />
        </div>
      );
    const adding = sampleFor === part.id;
    // Its own section after the marking scheme (Epo 2026-11-15): a long
    // answer's written sample or a drawing's drawn one, which marking reads
    // from the answer.
    const sample =
      answer.type === 'open' && (answer.accepted[0] || adding) ? (
        <BlocksColumn
          autoFocus={adding}
          blocks={[{ text: answer.accepted[0] ?? '', type: 'text' }]}
          maxLength={
            bank ? limits.QUESTION_TEXT_MAX : limits.QUIZ_OPEN_ANSWER_MAX
          }
          onChange={([block]) => {
            const text = block?.type === 'text' ? block.text : '';
            setAnswer({ ...answer, accepted: text ? [text] : [] });
          }}
          onFigure={setFigure}
          placeholder={m.question_ui_sample_answer_heading()}
          section={{ partId: part.id }}
          textOnly
        />
      ) : answer.type === 'drawing' &&
        uploadSample &&
        (answer.sample || adding) ? (
        <DrawnSampleField
          onChange={(drawn) =>
            changePart({
              ...part,
              answer: { type: 'drawing', ...(drawn && { sample: drawn }) },
            })
          }
          onOpenChange={(open) => !open && setSampleFor(null)}
          open={adding || undefined}
          pinned={pinnedQuestion(question, part, number)}
          sample={answer.sample}
          upload={uploadSample}
        />
      ) : null;
    const removeSample = () => {
      setSampleFor(null);
      setAnswer(
        answer.type === 'open'
          ? { ...answer, accepted: [] }
          : { type: 'drawing' }
      );
    };
    return (
      <div className="flex flex-col gap-4.5">
        <AnswerEditor answer={answer} onChange={setAnswer} />
        {modelMarked(answer.type) && (
          <MarkSchemeRows
            items={part.markscheme ?? []}
            max={
              bank ? limits.QUESTION_MARKSCHEME_MAX : limits.QUIZ_MARKSCHEME_MAX
            }
            onChange={(markscheme, marks) =>
              changePart({ ...part, marks, markscheme })
            }
          />
        )}
        {sample && (
          <div>
            <div className="mb-1 flex items-center gap-2">
              <h4 className="font-bold">
                {m.question_ui_sample_answer_heading()}
              </h4>
              <ToolbarButton
                className="ml-auto"
                label={m.question_ui_remove_sample()}
                onClick={removeSample}
                variant="danger-light"
              >
                <Icon name="trash" />
              </ToolbarButton>
            </div>
            {sample}
          </div>
        )}
        {part.solution.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-2">
              <h4 className="font-bold">{m.quiz_editor_worked_solution()}</h4>
              <ToolbarButton
                className="ml-auto"
                label={m.question_ui_remove_solution()}
                onClick={() => changePart({ ...part, solution: [] })}
                variant="danger-light"
              >
                <Icon name="trash" />
              </ToolbarButton>
            </div>
            <BlocksColumn
              autoFocus={solutionFor === part.id}
              blocks={part.solution}
              onChange={setBlocks({ partId: part.id, solution: true })}
              onFigure={setFigure}
              placeholder={m.question_ui_solution_placeholder()}
              section={{ partId: part.id, solution: true }}
              uploadAsset={uploadAsset}
            />
          </div>
        )}
      </div>
    );
  };

  const typeSelect = (part: QuestionPart) => (
    <AnswerTypeSelect
      className={lone ? 'w-52.5 min-w-0' : '@min-[36rem]:w-45 w-full'}
      onChange={(kind) => {
        const next = answerOfKind(part.answer, kind);
        changePart(
          next.type === part.answer.type
            ? { ...part, answer: next }
            : withAnswer(part, next)
        );
      }}
      value={answerKind(part.answer)}
    />
  );

  const partColumn = (part: QuestionPart, label?: string, focus?: boolean) => (
    <BlocksColumn
      aside={typeSelect(part)}
      asideTarget={lone ? head : undefined}
      autoFocus={focus}
      blocks={part.blocks}
      gaps={
        part.answer.type === 'gaps' ? { onChange: changePart, part } : undefined
      }
      imageButton={lone}
      lead={label}
      onChange={setBlocks({ partId: part.id })}
      onFigure={setFigure}
      placeholder={m.question_ui_question_placeholder()}
      section={{ partId: part.id }}
      uploadAsset={uploadAsset}
    />
  );

  // A part of several: open, its own controls in its line's place; closed, a line.
  const partBlock = (part: QuestionPart, label: string) => {
    if (part.id !== shownPart?.id)
      return (
        <button
          className="block w-full cursor-pointer py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-action"
          data-part-id={part.id}
          key={part.id}
          onClick={() => setOpenPart(part.id)}
          type="button"
        >
          {partLine(part, label, keysPending)}
        </button>
      );
    const ref: ItemRef = { part: part.id };
    return (
      <div
        // Its label and text where its line had them: 6px and its text's own
        // 8px make up the line's 14px.
        className="pt-1.5 pb-3.5"
        data-part-id={part.id}
        key={part.id}
      >
        {partColumn(part, label)}
        <div className="mt-3 @min-[36rem]:pl-9">
          {answerArea(part)}
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            {solutionButtons(part)}
            <span className="flex-1" />
            {marksControl(part)}
            <Popover>
              <PopoverTrigger asChild>
                <ToolbarButton label={m.question_ui_actions({ label })}>
                  <Icon name="moreVertical" />
                </ToolbarButton>
              </PopoverTrigger>
              <ToolbarPopoverContent align="end" className="w-48">
                <MenuItem
                  disabled={!canMoveItem(question, ref, -1)}
                  icon={<Icon name="arrowUp" />}
                  label={m.question_ui_move_up()}
                  onClick={() => write(moveItem(question, ref, -1))}
                />
                <MenuItem
                  disabled={!canMoveItem(question, ref, 1)}
                  icon={<Icon name="arrowDown" />}
                  label={m.question_ui_move_down()}
                  onClick={() => write(moveItem(question, ref, 1))}
                />
                {shuffleItem(part)}
                <MenuItem
                  disabled={!canRemovePart(question, part.id)}
                  icon={<Icon name="trash" />}
                  label={m.question_ui_remove_part()}
                  onClick={() => {
                    write({
                      ...question,
                      parts: question.parts.filter(
                        (item) => item.id !== part.id
                      ),
                    });
                    setOpenPart(undefined);
                  }}
                />
              </ToolbarPopoverContent>
            </Popover>
          </div>
        </div>
      </div>
    );
  };

  const groupBlock = (
    group: NonNullable<Question['groups']>[number],
    label: string,
    parts: { label: string; part: QuestionPart }[]
  ) => {
    const ref: ItemRef = { group: group.id };
    return (
      <div className="pt-3.5" data-group-id={group.id} key={group.id}>
        <BlocksColumn
          aside={
            <Popover>
              <PopoverTrigger asChild>
                <ToolbarButton label={m.question_ui_actions({ label })}>
                  <Icon name="moreVertical" />
                </ToolbarButton>
              </PopoverTrigger>
              <ToolbarPopoverContent align="end" className="w-48">
                <MenuItem
                  disabled={!canMoveItem(question, ref, -1)}
                  label={m.question_ui_move_up()}
                  onClick={() => write(moveItem(question, ref, -1))}
                />
                <MenuItem
                  disabled={!canMoveItem(question, ref, 1)}
                  label={m.question_ui_move_down()}
                  onClick={() => write(moveItem(question, ref, 1))}
                />
                <MenuItem
                  disabled={partsFull}
                  label={m.question_ui_add_sub_part()}
                  onClick={() => {
                    const part = newPart();
                    write(addSubPart(question, group.id, part));
                    setOpenPart(part.id);
                  }}
                />
                <MenuItem
                  disabled={!canUngroup(question, group.id)}
                  label={m.question_ui_ungroup()}
                  onClick={() => write(ungroup(question, group.id))}
                />
                <MenuItem
                  disabled={!canRemoveGroup(question, group.id)}
                  label={m.question_ui_remove()}
                  onClick={() => write(removeGroup(question, group.id))}
                />
              </ToolbarPopoverContent>
            </Popover>
          }
          blocks={group.blocks}
          lead={label}
          onChange={setBlocks({ groupId: group.id })}
          onFigure={setFigure}
          placeholder={m.question_ui_question_placeholder()}
          section={{ groupId: group.id }}
          uploadAsset={uploadAsset}
        />
        <div className="@min-[36rem]:pl-4">
          {parts.map((sub) => partBlock(sub.part, sub.label))}
        </div>
      </div>
    );
  };

  const first = question.parts[0];
  // A lone part's text is its question; one written into the stem instead
  // edits there.
  const headInStem =
    lone && first.blocks.length === 0 && question.stem.length > 0;
  const showStem = !lone || (!headInStem && question.stem.length > 0);
  const addPartButton = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          disabled={partsFull}
          iconLeft="plus"
          size="sm"
          type="button"
          variant="outline"
        >
          {m.question_ui_add_part()}
        </Button>
      </PopoverTrigger>
      {addMenu}
    </Popover>
  );
  const close = () => setMenuOpen(false);
  return (
    // Laid out by its own width: beside the question list a wide window can
    // still leave the card narrow.
    <div className="@container flex min-w-0 flex-col">
      <IssueSummary className="mb-3" messages={issues} />
      {/* Its number stays as the closed card shows it; marks are in the
          footer for a lone question. */}
      {/* Its number, as the closed card shows it; a lone question's Add
          image and answer type at its right (portaled from its text's
          column), so the text keeps the closed card's width. */}
      <div className="mb-1.5 flex min-h-10 items-center gap-2">
        {number !== undefined && <span className="font-bold">{number}.</span>}
        {lone ? (
          <span
            className="ml-auto flex min-w-0 items-center gap-1"
            ref={setHead}
          />
        ) : (
          <span className="t-meta ml-auto text-fg-muted">
            {m.question_ui_marks_in_parts({
              count: question.parts.length,
              marks: marksLabel(questionMarks(question)),
            })}
          </span>
        )}
      </div>
      {showStem && (
        <div className={cn(!lone && 'pb-3.5')}>
          <BlocksColumn
            blocks={question.stem}
            onChange={setBlocks({})}
            onFigure={setFigure}
            placeholder={m.question_ui_question_placeholder()}
            section={{}}
            uploadAsset={uploadAsset}
          />
        </div>
      )}
      {lone ? (
        <>
          {headInStem ? (
            <BlocksColumn
              aside={typeSelect(first)}
              asideTarget={head}
              autoFocus={autoFocus}
              blocks={question.stem}
              imageButton
              onChange={setBlocks({})}
              onFigure={setFigure}
              placeholder={m.question_ui_question_placeholder()}
              section={{}}
              uploadAsset={uploadAsset}
            />
          ) : (
            partColumn(first, undefined, autoFocus)
          )}
          <div className="mt-3.5">{answerArea(first)}</div>
        </>
      ) : (
        questionItems(question).map((item) =>
          item.kind === 'part'
            ? partBlock(item.part, item.label)
            : groupBlock(item.group, item.label, item.parts)
        )
      )}
      {phone && topic && <div className="mt-4">{topic}</div>}
      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        {!phone && lone && solutionButtons(first)}
        {!phone && (!lone || addPartInFooter) && addPartButton}
        {phone && lone && marksControl(first)}
        <span className="flex-1" />
        {!phone && topic}
        {!phone && lone && marksControl(first)}
        {/* Kept together, at the end of the row it wraps to. */}
        <span className="ml-auto flex items-center gap-2.5">
          {actions && (
            <span className="mx-1 @min-[36rem]:block hidden h-7 w-px bg-divider" />
          )}
          {actions}
          <Popover onOpenChange={setMenuOpen} open={menuOpen}>
            <PopoverTrigger asChild>
              <ToolbarButton label={menuLabel}>
                <Icon name="moreVertical" />
              </ToolbarButton>
            </PopoverTrigger>
            <ToolbarPopoverContent align="end" className="w-56">
              {phone && lone && canAddSolution(first) && (
                <MenuItem
                  icon={<Icon name="plus" />}
                  label={m.quiz_editor_worked_solution()}
                  onClick={() => addSolution(first)}
                />
              )}
              {phone && lone && canAddSample(first) && (
                <MenuItem
                  icon={<Icon name="plus" />}
                  label={m.question_ui_sample_answer_heading()}
                  onClick={() => setSampleFor(first.id)}
                />
              )}
              {(phone || (lone && !addPartInFooter)) && (
                <MenuItem
                  disabled={partsFull}
                  icon={<Icon name="plus" />}
                  label={m.question_ui_add_part()}
                  onClick={addPart}
                />
              )}
              {phone && !lone && (
                <MenuItem
                  disabled={partsFull}
                  icon={<Icon name="plus" />}
                  label={m.question_ui_group()}
                  onClick={addGroup}
                />
              )}
              {lone && shuffleItem(first)}
              {menu?.(close)}
              <ToolbarPopoverGroup label={m.question_ui_layout()}>
                {(
                  [
                    ['paper', m.question_ui_exam_paper()],
                    ['split', m.question_ui_split_view()],
                  ] as const
                ).map(([layout, label]) => (
                  <MenuItem
                    key={layout}
                    label={label}
                    onClick={() => write({ ...question, layout })}
                    selected={question.layout === layout}
                  />
                ))}
              </ToolbarPopoverGroup>
              {!lone && (
                <ToolbarPopoverGroup label={m.question_ui_part_labels()}>
                  {(
                    [
                      ['letters', '(a), (b)'],
                      ['numbers', '1, 2'],
                    ] as const
                  ).map(([labels, label]) => (
                    <MenuItem
                      key={labels}
                      label={label}
                      onClick={() => write({ ...question, labels })}
                      selected={question.labels === labels}
                    />
                  ))}
                </ToolbarPopoverGroup>
              )}
            </ToolbarPopoverContent>
          </Popover>
        </span>
      </div>
      {figure && (
        <BlockDialog
          bank={bank}
          block={figure.block}
          onClose={() => setFigure(null)}
          // A live quiz's figure is written by its room entry; a draft's is
          // found by its content in the question as it stands now.
          onRemove={() => {
            if (figure.isNew) return;
            if (figures) {
              const entry = figures.key(figure.block);
              if (entry)
                figures.remove({
                  entry,
                  question: question.id,
                  section: figure.section,
                });
              return;
            }
            const now = latest.current;
            const blocks = sectionBlocks(now, figure.section);
            const at = findBlock(blocks, figure.block, figure.index);
            if (at >= 0)
              write(
                changeBlocks(
                  now,
                  figure.section,
                  blocks.filter((_, i) => i !== at)
                )
              );
          }}
          onSave={(block) => {
            if (figures) {
              const entry = figure.isNew
                ? undefined
                : figures.key(figure.block);
              const at = entry && {
                entry,
                question: question.id,
                section: figure.section,
              };
              // One a co-editor removed meanwhile goes back in its place.
              if (at && figures.replace(at, block)) return;
              figures.insert(
                {
                  after: figure.before && figures.key(figure.before),
                  index: figure.index,
                  question: question.id,
                  section: figure.section,
                },
                block
              );
              return;
            }
            const now = latest.current;
            write(
              changeBlocks(
                now,
                figure.section,
                saveFigure(sectionBlocks(now, figure.section), figure, block)
              )
            );
          }}
          uploadAsset={uploadAsset}
        />
      )}
    </div>
  );
}
