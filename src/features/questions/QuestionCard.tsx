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
  canMoveItem,
  canRemoveGroup,
  canRemovePart,
  canUngroup,
  type ItemRef,
  isLonePart,
  moveItem,
  questionItems,
  removeGroup,
  removePart,
  splitPart,
  ungroup,
} from './groups';
import { IssueSummary } from './IssueViews';
import { mathTextToValue, valueToMathText } from './mathTextValue';
import { type BlockSection, QuestionBlockView } from './QuestionView';
import {
  type AddableBlock,
  changeBlocks,
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
  gapListsByBlock,
  gapNumbers,
  modelMarked,
  type Question,
  type QuestionBlock,
  type QuestionPart,
  questionMarks,
  withGapsBlocks,
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
  inline,
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
  /** Inline formulas only, no display ones (a marking point). */
  inline?: boolean;
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
  const [moveTarget, setMoveTarget] = useState<HTMLSpanElement | null>(null);
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
  // Where a picked image goes when it is inserted, not replacing one.
  const insertTo = useRef(0);
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
  const edit = (
    index: number,
    at: (() => { x: number; y: number }) | null,
    block = blocks[index]
  ) => {
    blankIds.current =
      block?.type === 'text' ? gapNumbers([block]).map((_, i) => `g${i}`) : [];
    setCaret(() => at);
    setEditing(index);
  };
  // Where Insert puts a block: after the open text, else at the end.
  const insertAt = editing === null ? blocks.length : editing + 1;
  const full = blocks.length >= limits.QUESTION_BLOCKS_MAX;
  const insert = (type: AddableBlock, at = insertAt) => {
    if (type === 'image') {
      replaceAt.current = null;
      insertTo.current = at;
      file.current?.click();
      return;
    }
    const block = newQuestionBlock(type);
    if (type === 'text') {
      grow([...blocks.slice(0, at), block, ...blocks.slice(at)]);
      edit(at, null);
      return;
    }
    onFigure({
      before: blocks[at - 1],
      block,
      index: at,
      isNew: true,
      section,
    });
  };
  // Insert's choices, the new block going in at `at`.
  const insertMenu = (at: number) => (
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
          onClick={() => insert(type, at)}
        />
      ))}
    </ToolbarPopoverContent>
  );
  // Each block's blanks' answers in a gaps part, else none.
  const blockLists = () =>
    gaps ? gapListsByBlock(gaps.part) : blocks.map(() => []);
  /** `next` in place of the blocks, `lists` their blanks' answers block by
   * block; the open text reopens as block `open`, else closes. */
  const rearrange = (
    next: QuestionBlock[],
    lists: string[][][],
    open?: number
  ) => {
    if (next.length !== blocks.length) ownLength.current = next.length;
    if (gaps) gaps.onChange(withGapsBlocks(gaps.part, next, lists));
    else onChange(next);
    if (open === undefined) setEditing(null);
    else edit(open, null, next[open]);
  };
  // A moved text stays open at its new place; moving a figure closes the
  // open text, whose place may change. Blanks keep their answers.
  const move = (index: number, to: number) => {
    const next = [...blocks];
    const lists = blockLists();
    [next[index], next[to]] = [next[to], next[index]];
    [lists[index], lists[to]] = [lists[to], lists[index]];
    rearrange(next, lists, editing === index ? to : undefined);
  };
  // The open text's paragraph or formula at its edge moves past the next
  // block as a text of its own (each line moves as a block would); a text
  // of one line moves whole.
  const leave = (direction: -1 | 1, line: number) => {
    const index = editing;
    const block = index === null ? undefined : blocks[index];
    if (index === null || block?.type !== 'text') return;
    const nodes = mathTextToValue(block.text, { gaps: !!gaps });
    if (nodes.length === 1) return move(index, index + direction);
    const lines = nodes.map((node) => valueToMathText([node]));
    const own = blockLists()[index];
    let at = 0;
    const lineLists = lines.map((text) => {
      const count = gapNumbers([{ text, type: 'text' }]).length;
      at += count;
      return own.slice(at - count, at);
    });
    const moved: QuestionBlock = { text: lines[line], type: 'text' };
    const rest: QuestionBlock = {
      text: lines.filter((_, j) => j !== line).join('\n\n'),
      type: 'text',
    };
    const restLists = lineLists.filter((_, j) => j !== line).flat();
    const lists = blockLists();
    if (direction < 0)
      rearrange(
        [
          ...blocks.slice(0, index - 1),
          moved,
          blocks[index - 1],
          rest,
          ...blocks.slice(index + 1),
        ],
        [
          ...lists.slice(0, index - 1),
          lineLists[line],
          lists[index - 1],
          restLists,
          ...lists.slice(index + 1),
        ],
        index - 1
      );
    else
      rearrange(
        [
          ...blocks.slice(0, index),
          rest,
          blocks[index + 1],
          moved,
          ...blocks.slice(index + 2),
        ],
        [
          ...lists.slice(0, index),
          restLists,
          lists[index + 1],
          lineLists[line],
          ...lists.slice(index + 2),
        ],
        index + 2
      );
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
            display={!inline}
            gapStart={start}
            maxLength={maxLength}
            moves={{
              down: i < blocks.length - 1,
              onLeave: leave,
              split: !full,
              target: moveTarget,
              up: i > 0,
            }}
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
        {/* A block under it, as the open text's + adds one under the text
            (Epo 2026-11-16). */}
        <Popover>
          <PopoverTrigger asChild>
            <ToolbarButton disabled={full} label={m.question_ui_insert_below()}>
              <Icon name="plus" />
            </ToolbarButton>
          </PopoverTrigger>
          {insertMenu(i + 1)}
        </Popover>
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
          {insertMenu(insertAt)}
        </Popover>
      )}
      {/* Move up and Move down for the caret's paragraph or formula, as a
          figure's hover tools have (`TextEditor`'s `moves`). */}
      <span
        className="ml-auto flex shrink-0 items-center"
        ref={setMoveTarget}
      />
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
              const to = insertTo.current;
              replaceAt.current = null;
              if (!(picked && uploadAsset)) return;
              setUploading({ at: at ?? to, replace: at !== null });
              setError('');
              try {
                const image = await uploadImage(picked, uploadAsset);
                if (at === null)
                  grow([
                    ...blocks.slice(0, to),
                    { description: '', type: 'image', ...image },
                    ...blocks.slice(to),
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
  // Its first text sits beside the number where the card has room (Epo
  // 2026-11-16); the open card puts it under the number, a shift Epo
  // accepted. A gaps part's text stays put, its blanks numbered in place.
  const own =
    question.stem.length > 0 ? question.stem : lone ? first.blocks : [];
  const head =
    own[0]?.type === 'text' &&
    own[0].text.trim() &&
    !(own === first.blocks && first.answer.type === 'gaps')
      ? own[0]
      : undefined;
  const stem =
    head && own === question.stem ? question.stem.slice(1) : question.stem;
  const firstBlocks =
    head && own === first.blocks ? first.blocks.slice(1) : first.blocks;
  return (
    <div className="@container flex min-w-0 flex-col">
      <div
        className={cn(
          'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2',
          !head && 'mb-1.5'
        )}
      >
        <span className="flex h-10 items-center font-bold">{number}.</span>
        {head && (
          <div className="@min-[32rem]:col-span-1 col-span-full @min-[32rem]:col-start-2 @min-[32rem]:row-start-1 row-start-2 border-transparent border-b py-2 leading-[1.7]">
            <TextView marks text={head.text} />
          </div>
        )}
        <span className="t-meta col-start-3 row-start-1 flex h-10 items-center gap-2 justify-self-end text-fg-muted">
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
          {stem.length > 0 && <BlocksView blocks={stem} />}
          {(firstBlocks.length > 0 ||
            (question.stem.length === 0 && !head)) && (
            <BlocksView
              blocks={firstBlocks}
              gaps={first.answer.type === 'gaps'}
            />
          )}
          <div className="mt-3.5">{answer(first)}</div>
        </>
      ) : (
        <>
          {stem.length > 0 && (
            <div className="pb-3.5">
              <BlocksView blocks={stem} />
            </div>
          )}
          {head && stem.length === 0 && <div className="pb-3.5" />}
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
  // Borderless (Epo 2026-11-16), the row pulled left by their padding so
  // the first one's icon lines up with the text above.
  const footerButton = (label: string, onClick: () => void) => (
    <Button
      className="px-2.5"
      iconLeft="plus"
      onClick={onClick}
      size="sm"
      type="button"
      variant="ghost-hover"
    >
      {label}
    </Button>
  );
  const marksControl = (part: QuestionPart) => (
    <span className="flex items-center gap-2">
      <span className="t-meta font-semibold text-fg-secondary">
        {m.question_ui_part_marks()}
      </span>
      {/* A long answer's marks are its marking points' total: the number
          alone, in the input's text (Epo 2026-11-16). */}
      {modelMarked(part.answer.type) ? (
        <span className="text-fg">{part.marks}</span>
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
            field={(text, onText, added) => (
              <BlocksColumn
                autoFocus={added}
                blocks={[{ text, type: 'text' }]}
                inline
                maxLength={limits.QUESTION_MARK_ITEM_MAX}
                onChange={([block]) =>
                  onText(block?.type === 'text' ? block.text : '')
                }
                onFigure={setFigure}
                placeholder={m.question_default_marking_point()}
                section={{ partId: part.id }}
                textOnly
              />
            )}
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
                className="ml-auto -translate-y-px"
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
                className="ml-auto -translate-y-px"
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
          {/* Pulled left by the borderless buttons' padding, as the card's
              footer is. */}
          <div className="mt-3 -ml-2.5 flex flex-wrap items-center gap-2.5">
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
                {/* Sub-parts go one level deep (Epo 2026-11-16). */}
                {part.group === undefined && (
                  <MenuItem
                    disabled={partsFull}
                    icon={<Icon name="indentIncrease" />}
                    label={m.question_ui_add_sub_part()}
                    onClick={() => {
                      const next = newPart();
                      write(
                        splitPart(question, part.id, crypto.randomUUID(), next)
                      );
                      setOpenPart(next.id);
                    }}
                  />
                )}
                {shuffleItem(part)}
                <MenuItem
                  disabled={!canRemovePart(question, part.id)}
                  icon={<Icon name="trash" />}
                  label={
                    part.group === undefined
                      ? m.question_ui_remove_part()
                      : m.question_ui_remove_sub_part()
                  }
                  onClick={() => {
                    write(removePart(question, part.id));
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
    const addSub = () => {
      const part = newPart();
      write(addSubPart(question, group.id, part));
      setOpenPart(part.id);
    };
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
                  onClick={addSub}
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
          {/* Under its sub-parts, as the card's Add part is under its parts. */}
          <div className="-ml-2.5 flex">
            <Button
              className="px-2.5"
              disabled={partsFull}
              iconLeft="plus"
              onClick={addSub}
              size="sm"
              type="button"
              variant="ghost-hover"
            >
              {m.question_ui_add_sub_part()}
            </Button>
          </div>
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
    <Button
      className="px-2.5"
      disabled={partsFull}
      iconLeft="plus"
      onClick={addPart}
      size="sm"
      type="button"
      variant="ghost-hover"
    >
      {m.question_ui_add_part()}
    </Button>
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
        {/* Kept mounted as the question gains parts: the portal into it
            unmounts after it. */}
        <span className="ml-auto flex min-w-0 items-center gap-1" ref={setHead}>
          {!lone && (
            <span className="t-meta text-fg-muted">
              {m.question_ui_marks_in_parts({
                count: question.parts.length,
                marks: marksLabel(questionMarks(question)),
              })}
            </span>
          )}
        </span>
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
      <div
        className={cn(
          'mt-5 flex flex-wrap items-center gap-2.5',
          !phone && '-ml-2.5'
        )}
      >
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
          // Both read the question as it stands now and find the figure by
          // its content, so a co-editor's change meanwhile stays.
          onRemove={() => {
            if (figure.isNew) return;
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
          // After a graph's image renders and uploads.
          onSave={(block) => {
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
