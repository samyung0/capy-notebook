import {
  type ReactNode,
  useEffect,
  useId,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverGroup,
} from '@/components/ui/ToolbarPopover';
import { ButtonTooltip } from '@/components/ui/Tooltip';
import { userToast } from '@/components/ui/userToast';
import { boardCode, useCodeFailed } from '@/features/materials/blockCode';
import { CannotShow } from '@/features/materials/CannotShow';
import {
  CanvasField,
  canvasLoads,
} from '@/features/quizzes/drawing/CanvasField';
import {
  CanvasPreview,
  canvasBoard,
} from '@/features/quizzes/drawing/CanvasFrame';
import {
  sharingLabels,
  sharingParts,
} from '@/features/quizzes/drawing/canvasParts';
import type { PinnedQuestion } from '@/features/quizzes/drawing/DrawingBoardScreen';
import {
  DrawnSampleField,
  type UploadDrawnSample,
} from '@/features/quizzes/drawing/DrawnSample';
import { pinnedQuestion } from '@/features/quizzes/drawing/pinnedQuestion';
import { getLocale, m } from '@/i18n';
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
import type { FigureBinding } from './figureBinding';
import {
  addPart as addPartTo,
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
  ungroupCanvasIssue,
  withKeptPart,
} from './groups';
import { IssueSummary } from './IssueViews';
import { mathTextToValue, valueToMathText } from './mathTextValue';
import { stripMarks } from './parseMarkedText';
import { type BlockSection, QuestionBlockView } from './QuestionView';
import {
  type AddableBlock,
  answerAbove,
  answerOwn,
  bindFigure,
  changeBlocks,
  type FigureRoom,
  findBlock,
  isBlankPart,
  newPart,
  newQuestionBlock,
  sampleWithinCap,
  saveFigure,
  sectionBlocks,
  withAnswer,
} from './questionEdits';
import { hasSample } from './SampleBlock';
import { clickPoint, TextEditor } from './TextEditor';
import { TextView } from './TextView';
import {
  forgetCanvas,
  forgetGoneParts,
  forgetPart,
  giveMemory,
  heldSample,
  holdSample,
  type KeptCanvas,
  keepAnswer,
  keepCanvas,
  keepPart,
  keptAnswer,
  keptCanvas,
  keptPart,
} from './typeMemory';
import {
  type AnswerCanvas,
  type CanvasBlock,
  canvasCount,
  type DrawnSample,
  GAP_MARKER,
  gapListsByBlock,
  gapNumbers,
  modelMarked,
  partAnswerCanvas,
  type Question,
  type QuestionBlock,
  type QuestionPart,
  questionMarks,
  withGapsBlocks,
  withGapsText,
} from './types';
import { PART_CANVASES_MAX, questionCanvases } from './validation';

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
  canvas: 'shape',
  chart: 'chart',
  graph: 'graph',
  image: 'image',
  table: 'table',
  text: 'text',
};

/** A block list's canvases in the open card (Epo 2026-11-23): the stem's,
 * a group's or a part's text. */
type CanvasOptions = {
  /** Under its first canvas: what goes in it. */
  hint?: string;
  /** Its first canvas is a Canvas part's own, its question: no Remove. */
  keep?: boolean;
  /** Why its first canvas's Remove is off: the parts that answer in it, "(a)
   * and (b) answer in it" (Epo 2026-11-24). */
  answered?: string;
  /** Just before its first canvas: a Canvas part's Answer in. */
  before?: ReactNode;
  /** Why Insert's Canvas is off (a bank, the question's cap, the list's
   * one); none while it may take one. */
  off?: string;
  /** A quiz's: each canvas is drawn on its board from its card. */
  edit?: {
    pinned: PinnedQuestion;
    save: (figure: Figure, block: CanvasBlock) => void;
    upload: UploadDrawnSample;
  };
};

/** A figure the card shows and its dialog edits. */
type Figure = {
  block: QuestionBlock;
  /** A chart's or graph's, edited where it lives (`QuestionCard`). */
  binding?: FigureBinding;
  index: number;
  /** A table added from Insert: Save puts it in, closing leaves nothing. */
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
  canvas,
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
  /** The stem's, a group's or a part's text: Insert offers Canvas, and its
   * canvases show as their cards (`CanvasOptions`). */
  canvas?: CanvasOptions;
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
  const wide = useRef<HTMLDivElement>(null);
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
      if (
        !(target instanceof Element) ||
        box.current?.contains(target) ||
        wide.current?.contains(target)
      )
        return;
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
    // A canvas goes in empty, drawn from its card.
    if (type === 'text' || type === 'canvas') {
      grow([...blocks.slice(0, at), block, ...blocks.slice(at)]);
      if (type === 'text') edit(at, null);
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
    // Wide enough for why Canvas is off on one or two lines (E3).
    <ToolbarPopoverContent
      align="start"
      className={cn('w-44', canvas?.off && 'w-72')}
    >
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
      {canvas && (
        <MenuItem
          // Why it is off wraps under its label.
          className={cn(canvas.off && 'whitespace-normal')}
          disabled={!!canvas.off || !canvas.edit}
          hint={canvas.off}
          icon={<Icon name={insertIcons.canvas} />}
          label={blockLabels.canvas()}
          onClick={() => insert('canvas', at)}
        />
      )}
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
  /** A figure's tools: Insert below, Replace (an image), Move up, Move down
   * and Remove, off with why (`removeOff`); `under` its block in a row of
   * their own (a canvas, whose corner holds its Edit canvas), else at its top
   * right on hover. */
  const figureTools = (
    block: QuestionBlock,
    i: number,
    {
      removable = true,
      removeOff,
      under = false,
    }: { removable?: boolean; removeOff?: string; under?: boolean } = {}
  ) => (
    <div
      className={cn(
        'flex rounded-button bg-overlay shadow-pop md:opacity-0 md:group-hover/figure:opacity-100 md:focus-within:opacity-100',
        under
          ? 'ml-auto w-fit'
          : 'absolute top-1 right-0 max-md:static max-md:mt-1 max-md:ml-auto max-md:w-fit'
      )}
    >
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
      {removable && (
        <ToolbarButton
          disabled={!!removeOff}
          label={removeOff ?? m.question_ui_remove_block()}
          onClick={() => remove(i)}
          variant="danger-light"
        >
          <Icon name="trash" />
        </ToolbarButton>
      )}
    </div>
  );
  // A canvas (Epo 2026-11-23): its card, a quiz's drawn on its board, its
  // tools in the row under it.
  const canvasFigure = (block: CanvasBlock, i: number) => {
    const first = blocks.findIndex((item) => item.type === 'canvas') === i;
    // A Canvas part's own canvas, its first, is its question and stays; a
    // stem's or group's that parts answer in stays while they do.
    const tools = figureTools(block, i, {
      removable: !(first && canvas?.keep),
      removeOff: first ? canvas?.answered : undefined,
      under: true,
    });
    const edit = canvas?.edit;
    return (
      <div className="group/figure py-1">
        {first && canvas?.before && (
          <div className="mb-2.5">{canvas.before}</div>
        )}
        {edit ? (
          <CanvasField
            block={block}
            hint={first ? canvas?.hint : undefined}
            onChange={(next) =>
              edit.save(
                { before: blocks[i - 1], block, index: i, section },
                next
              )
            }
            pinned={edit.pinned}
            tools={tools}
            upload={edit.upload}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <CanvasPreview block={block} />
            {tools}
          </div>
        )}
      </div>
    );
  };
  const figure = (block: QuestionBlock, i: number) =>
    block.type === 'canvas' ? (
      canvasFigure(block, i)
    ) : (
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
        {figureTools(block, i)}
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
  const rows = (from: number, to: number) =>
    blocks.slice(from, to).map((block, j) => {
      const i = from + j;
      return (
        <div key={i}>
          {block.type === 'text' ? textBlock(block, i) : figure(block, i)}
          {open && editing === i && toolbar}
        </div>
      );
    });
  // A Canvas part's own canvas, with its Answer in, and what follows it run
  // the card's width under the type (E3).
  const wideAt = canvas?.before
    ? blocks.findIndex((block) => block.type === 'canvas')
    : -1;
  const row = (
    <div className="flex @min-[36rem]:flex-row flex-col @min-[36rem]:items-start gap-4">
      <div className="flex min-w-0 flex-1 gap-3" ref={box}>
        {/* At least 24px, so with its gap the text starts 36px in, where a
            part's answer does (pl-9). */}
        {lead && (
          <span className="min-w-6 shrink-0 pt-2 font-bold">{lead}</span>
        )}
        <div className="min-w-0 flex-1">
          {rows(0, wideAt < 0 ? blocks.length : wideAt)}
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
  if (wideAt < 0) return row;
  return (
    <div className="flex flex-col gap-2">
      {row}
      <div className={cn(lead && '@min-[36rem]:pl-9')} ref={wide}>
        {rows(wideAt, blocks.length)}
      </div>
    </div>
  );
}

/** The board asset of the canvas a Canvas part answers in: a new drawn
 * sample's start; none for none or an empty one. */
const answerCanvasBoard = (question: Question, part: QuestionPart) => {
  const at = partAnswerCanvas(question, part);
  return at ? canvasBoard(at.block) : undefined;
};

/** A Canvas part's answer with its drawn sample set, or gone for none;
 * where it answers stays. */
function withSample(
  answer: Extract<QuestionPart['answer'], { type: 'canvas' }>,
  sample: DrawnSample | undefined
): QuestionPart['answer'] {
  const { sample: _, ...rest } = answer;
  return sample ? { ...rest, sample } : rest;
}

/** The canvas a Canvas part would answer in above it (Same canvas, Epo
 * 2026-11-23): its group's, else the stem's; none when neither holds one. */
const canvasAbove = (question: Question, part: QuestionPart) =>
  part.answer.type === 'canvas'
    ? partAnswerCanvas(question, {
        ...part,
        answer: { ...part.answer, shared: true },
      })
    : null;

/** Where a Canvas part answers, in its folded line (E2, E3): "same canvas"
 * in the one above, "new canvas" in its own while one above could take it,
 * else nothing. */
function canvasWhere(question: Question, part: QuestionPart) {
  if (part.answer.type !== 'canvas') return;
  if (part.answer.shared) return m.question_canvas_line_same();
  return canvasAbove(question, part) ? m.question_canvas_line_new() : undefined;
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
    case 'canvas':
      return (part.markscheme ?? []).map((item) => item.text).join(' · ');
  }
}

/** A part of several in a line (board Parts): its label, first words, type
 * (a Canvas part's with where it answers) and marks, its key in short under
 * them. */
function partLine(
  question: Question,
  part: QuestionPart,
  label: string,
  keysPending?: boolean
) {
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
        {/* At least as wide as the open part's type menu, so its text wraps
            the same; a Canvas part's place ("same canvas") reads whole. */}
        <span className="@min-[36rem]:ml-1 @min-[36rem]:min-w-45 shrink-0 truncate whitespace-nowrap pt-px @min-[36rem]:text-right text-[13px] text-fg-muted">
          {[
            answerLabels[part.answer.type](),
            canvasWhere(question, part),
            marksLabel(part.marks),
          ]
            .filter(Boolean)
            .join(' · ')}
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
        {/* As the open card draws it, so opening only adds controls. */}
        {block.type === 'canvas' ? (
          <CanvasPreview block={block} />
        ) : (
          <QuestionBlockView block={block} />
        )}
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
                {partLine(question, item.part, item.label, keysPending)}
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
                      {partLine(question, sub.part, sub.label, keysPending)}
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

/**
 * A Canvas part's Answer in (Epo 2026-11-23, E2 option B), shown while a
 * canvas above could take it: Same canvas answers there, New canvas on its
 * own. On Same, a line says where, and the tip when other parts answer in
 * that canvas too.
 */
function CanvasAnswerIn({
  answers,
  crowded,
  newOff,
  onChange,
  own,
  shared,
  where,
}: {
  /** On Same: "Students answer (a) in the question's canvas, above." */
  answers: string;
  /** Two or more parts answer in that canvas. */
  crowded: boolean;
  /** Why New canvas is off: the question at its canvas cap. */
  newOff?: string;
  onChange: (shared: boolean) => void;
  /** New canvas's line: "A canvas of (a)'s own". */
  own: string;
  shared: boolean;
  /** Same canvas's line: "The question's canvas, above". */
  where: string;
}) {
  const id = useId();
  const option = (label: string, line: string) => (
    <span className="flex flex-col">
      <span>{label}</span>
      <span className="t-meta font-normal text-fg-muted">{line}</span>
    </span>
  );
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <label className="t-meta text-fg-muted" htmlFor={id}>
          {m.question_canvas_answer_in()}
        </label>
        <Select
          onValueChange={(value) => onChange(value === 'same')}
          value={shared ? 'same' : 'new'}
        >
          <SelectTrigger className="w-42.5" id={id}>
            <SelectValue>
              {shared ? m.question_canvas_same() : m.question_canvas_new()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start" className="max-w-[calc(100vw-2rem)]">
            <SelectItem textValue={m.question_canvas_same()} value="same">
              {option(m.question_canvas_same(), where)}
            </SelectItem>
            <SelectItem
              disabled={!!newOff}
              textValue={m.question_canvas_new()}
              value="new"
            >
              {option(m.question_canvas_new(), newOff ?? own)}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {shared && <p className="t-meta text-fg-muted">{answers}</p>}
      {shared && crowded && (
        <p className="t-meta flex items-start gap-2 text-tint-accent-1-fg">
          <Icon className="mt-px size-4 shrink-0" name="info" />
          {m.question_canvas_shared_tip()}
        </p>
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
  /** The quiz it is in: a part's type switched back restores what it held
   * then in this tab (`typeMemory.ts`). */
  quizId?: string;
  /** The footer's Topic; a phone puts it on its own row above the footer. */
  topic?: ReactNode;
  uploadAsset?: UploadQuestionAsset;
  /** A quiz's drawn boards: its canvases and drawn sample answers (Q3); the
   * bank has none. */
  uploadSample?: UploadDrawnSample;
  /** Writes the question: false when it did not go (a live quiz's write past
   * a cap, `editQuestion`). */
  write: (question: Question) => boolean;
}

/**
 * The open question card (Epo 2026-11-15, boards Main, Types1, Types2,
 * Matching, Parts): the question's text with its formula tools under it, Add
 * image and the answer type at its right; the answer below with the correct
 * one marked beside it; a long answer's or canvas part's marking points and
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
  quizId,
  topic,
  uploadAsset,
  uploadSample,
  write,
}: QuestionCardProps) {
  const phone = useIsPhone();
  const bank = policy === 'bank';
  // A quiz draws canvases; every bank editor (the shared bank, My bank and
  // class banks, none uploading boards) offers Canvas greyed out, as banks
  // hold none yet (Epo 2026-11-23).
  const canvases = !bank && !!uploadSample;
  const lone = isLonePart(question);
  // The number row's end, where a lone question's answer type goes.
  const [head, setHead] = useState<HTMLSpanElement | null>(null);
  const [openPart, setOpenPart] = useState(firstPart);
  // The part whose sample answer is being added: its text, or its board.
  const [sampleFor, setSampleFor] = useState<string | null>(null);
  // A drawn sample's board that could not load: "This block cannot be shown"
  // where Draw sample answer was.
  const boardFailed = useCodeFailed(boardCode);
  // The part whose Solution was just added, opened in its editor.
  const [solutionFor, setSolutionFor] = useState<string | null>(null);
  const [figure, setFigure] = useState<Figure | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // The question as it stands, for a write that lands after an await, or
  // after another write the card has yet to render.
  const latest = useRef(question);
  latest.current = question;
  const writing = useRef(write);
  writing.current = write;
  /** The question with a section's blocks changed, written at once. */
  const writeBlocks = (
    section: BlockSection,
    change: (blocks: QuestionBlock[]) => QuestionBlock[]
  ) => {
    const now = latest.current;
    const next = changeBlocks(
      now,
      section,
      change(sectionBlocks(now, section))
    );
    latest.current = next;
    writing.current(next);
    return next;
  };
  /** A chart's or graph's dialog opens bound to it where it lives
   * (`bindFigure`); a table's on its block. */
  const openFigure = (opened: Figure) => {
    if (opened.block.type !== 'chart' && opened.block.type !== 'graph')
      return setFigure(opened);
    const bound = bindFigure(opened, {
      figures,
      question: question.id,
      writeBlocks,
    });
    if (bound) setFigure({ ...opened, ...bound, isNew: false });
  };
  /** A figure's block saved where it lives: a live quiz's room entry (one a
   * co-editor removed meanwhile goes back in its place), else found in the
   * question as it stands. */
  const saveFigureBlock = (figure: Figure, block: QuestionBlock) => {
    if (figures) {
      const entry = figure.isNew ? undefined : figures.key(figure.block);
      const at = entry && {
        entry,
        question: question.id,
        section: figure.section,
      };
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
    writeBlocks(figure.section, (blocks) => saveFigure(blocks, figure, block));
  };
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
  // Add part on a lone question (Epo 2026-11-23, E1) and Add sub-part (Epo
  // 2026-11-24): the part's blocks go above and both parts start blank, what
  // it held kept for the tab once the write goes; one write, so Undo brings
  // it all back.
  const writeSplit = ({
    kept,
    question: next,
  }: ReturnType<typeof addPartTo>) => {
    if (write(next) && kept && quizId) keepPart(quizId, question.id, kept);
  };
  const addPart = () => {
    const part = newPart();
    writeSplit(addPartTo(question, part, newPart()));
    setOpenPart(part.id);
  };
  // A part left alone where Add part or Add sub-part split (`left`, by the
  // removal or Ungroup that leaves it) takes back what they kept, when they
  // made it and it is still blank as it read before (Ungroup puts the group's
  // text on top of it), with the blanked part's own memory, a drawn sample
  // past the canvas cap staying held for the tab as on a type switch (Epo
  // 2026-11-24). The tab's memory changes only once the write lands.
  const writeBack = (next: Question, left: string | undefined) => {
    const kept = quizId && left ? keptPart(quizId, question.id, left) : null;
    const before = question.parts.find((part) => part.id === left);
    const back = !!(kept && before && isBlankPart(before));
    const { held, question: written } =
      kept && left && back
        ? sampleWithinCap(withKeptPart(next, left, kept), left)
        : { held: undefined, question: next };
    if (!(write(written) && quizId && left && kept)) return;
    forgetPart(quizId, question.id, left);
    if (!back) return;
    if (kept.own) giveMemory(quizId, left, kept.own);
    // The sample it took back is its newest: one held before goes.
    if (kept.answer.type === 'canvas' && kept.answer.sample)
      holdSample(quizId, left, held);
  };
  // Undo of Add part brings back the part it blanked: what was kept for the
  // parts it made, gone now, goes (Epo 2026-11-24).
  const partIds = question.parts.map((part) => part.id).join(' ');
  useEffect(() => {
    if (quizId) forgetGoneParts(quizId, question.id, partIds.split(' '));
  }, [partIds, question.id, quizId]);
  // Canvases (Epo 2026-11-23): at most QUESTION_CANVASES_MAX, drawn samples
  // included, the editor stopping there.
  const canvasCap = m.question_canvas_cap({
    max: limits.QUESTION_CANVASES_MAX,
  });
  const atCanvasCap =
    questionCanvases(question) >= limits.QUESTION_CANVASES_MAX;
  /** A block list's canvas options: its hint, and Insert's Canvas off for a
   * bank, at the cap, or once the list holds its one (`hasOne`). */
  const canvasOptions = (
    blocks: QuestionBlock[],
    hasOne: string,
    pinned: () => PinnedQuestion,
    options: Pick<CanvasOptions, 'answered' | 'before' | 'hint' | 'keep'> = {}
  ): CanvasOptions => {
    if (!(canvases && uploadSample))
      return { off: m.question_validation_bank_canvas() };
    return {
      ...options,
      edit: { pinned: pinned(), save: saveFigureBlock, upload: uploadSample },
      off: atCanvasCap
        ? canvasCap
        : canvasCount(blocks) >= PART_CANVASES_MAX
          ? hasOne
          : undefined,
    };
  };
  /** The stem's or a group's canvas as its board pins the question: the
   * text and figures above it, its canvas left to the board. */
  const pinnedAbove = (
    blocks: QuestionBlock[],
    label: string,
    marks: number
  ): PinnedQuestion => {
    const shown = blocks.filter((block) => block.type !== 'canvas');
    const text = shown.find((block) => block.type === 'text');
    const title =
      number === undefined
        ? m.drawing_answer_question()
        : m.quiz_editor_question({ number });
    return {
      body: (
        <div className="flex flex-col gap-2 text-fg-secondary">
          {shown.map((block, i) => (
            <QuestionBlockView block={block} key={i} />
          ))}
        </div>
      ),
      marks: marksLabel(marks),
      short: [number, label].filter(Boolean).join(' '),
      summary: text?.type === 'text' ? stripMarks(text.text) : '',
      title: label ? `${title} ${label}` : title,
    };
  };
  /** The parts answering in the first canvas of the stem's or a group's
   * blocks, named as the attempt's hint names them (`sharingLabels`): its
   * Remove is off while they do (Epo 2026-11-24). */
  const answeredIn = (blocks: QuestionBlock[], section: BlockSection) => {
    const index = blocks.findIndex((block) => block.type === 'canvas');
    const parts = index < 0 ? [] : sharingParts(question, section, index);
    if (parts.length === 0) return;
    if (lone) return m.question_canvas_answered_lone();
    const names = sharingLabels(question, parts, section);
    return names.length === 1
      ? m.question_canvas_answered_part({ part: names[0] })
      : m.question_canvas_answered_parts({
          parts: new Intl.ListFormat(getLocale(), {
            type: 'conjunction',
          }).format(names),
        });
  };
  // Each part's label, and its group's for a sub-part.
  const labels = new Map<string, { group?: string; label: string }>();
  for (const item of questionItems(question))
    if (item.kind === 'part') labels.set(item.part.id, { label: item.label });
    else
      for (const sub of item.parts)
        labels.set(sub.part.id, { group: item.label, label: sub.label });
  // How many parts answer in each canvas, by where it sits.
  const placeKey = ({ place }: AnswerCanvas) =>
    place.section === 'stem'
      ? 'stem'
      : place.section === 'group'
        ? `group:${place.groupId}`
        : `part:${place.partId}`;
  const answered = new Map<string, number>();
  for (const part of question.parts) {
    const at = partAnswerCanvas(question, part);
    if (at) answered.set(placeKey(at), (answered.get(placeKey(at)) ?? 0) + 1);
  }
  // Same canvas: the part's own canvas goes into the tab's memory once the
  // write lands.
  const answerSame = (part: QuestionPart) => {
    const { kept, part: next } = answerAbove(part);
    if (changePart(next) && kept && quizId) keepCanvas(quizId, part.id, kept);
  };
  // A canvas of its own for a Canvas part (New canvas, or a canvas answer
  // with none above it now): a canvas the part holds becomes its own, what
  // Same took staying in the tab's memory; else the canvas Same took back,
  // else an empty one. A kept one whose board or picture no longer loads (the
  // server purges a quiz's unused assets a day after trashing them) is an
  // empty one, and says so. `turn` gives the part as it reads then, answering
  // on its own canvas (`answerOwn`), or none when it was switched again. The
  // kept canvas leaves the tab's memory once the write lands; true then.
  const answerOnOwn = async (
    part: QuestionPart,
    turn: (held: QuestionPart, kept?: KeptCanvas) => QuestionPart | undefined
  ) => {
    const holds = latest.current.parts.some(
      (item) => item.id === part.id && canvasCount(item.blocks) > 0
    );
    const kept = quizId && !holds ? keptCanvas(quizId, part.id) : null;
    const loads = !kept || (await canvasLoads(kept.block));
    if (!loads)
      userToast({ title: m.question_canvas_gone(), variant: 'warning' });
    const now = latest.current;
    const held = now.parts.find((item) => item.id === part.id);
    // Gone, or switched again, meanwhile.
    const restored = held && turn(held, (loads && kept) || undefined);
    if (!restored) return false;
    const next = {
      ...now,
      parts: now.parts.map((item) => (item.id === part.id ? restored : item)),
    };
    if (!writing.current(next)) return false;
    latest.current = next;
    // Back in its place, or an empty one in place of one that can't load.
    if (quizId && kept && (!loads || restored.blocks.includes(kept.block)))
      forgetCanvas(quizId, part.id);
    return true;
  };
  const answerNew = (part: QuestionPart) =>
    answerOnOwn(part, (held, kept) =>
      held.answer.type === 'canvas' && held.answer.shared
        ? answerOwn(held, kept)
        : undefined
    );
  /** A Canvas part's Answer in, while a canvas above could take it. */
  const answerIn = (part: QuestionPart) => {
    const above = canvasAbove(question, part);
    if (!(canvases && above && part.answer.type === 'canvas')) return null;
    const shared = !!part.answer.shared;
    const { group, label } = labels.get(part.id) ?? { label: '' };
    const inGroup = above.place.section === 'group' && group;
    const at = partAnswerCanvas(question, part);
    return (
      <CanvasAnswerIn
        answers={
          inGroup
            ? m.question_canvas_answers_group({ group, part: label })
            : lone
              ? m.question_canvas_answers_lone()
              : m.question_canvas_answers_question({ part: label })
        }
        crowded={!!at && (answered.get(placeKey(at)) ?? 0) >= 2}
        // Off only where New would add a canvas: one the part holds becomes
        // its own (Epo 2026-11-24).
        newOff={
          shared && atCanvasCap && !canvasCount(part.blocks)
            ? canvasCap
            : undefined
        }
        onChange={(same) => (same ? answerSame(part) : answerNew(part))}
        own={
          lone
            ? m.question_canvas_new_lone()
            : m.question_canvas_new_part({ part: label })
        }
        shared={shared}
        where={
          inGroup
            ? m.question_canvas_same_group({ group })
            : m.question_canvas_same_question()
        }
      />
    );
  };
  /** A Canvas part answering on its own canvas has its Answer in just above
   * that canvas (E3); otherwise it heads the answer. */
  const ownCanvas = (part: QuestionPart) =>
    part.answer.type === 'canvas' &&
    !part.answer.shared &&
    part.blocks.some((block) => block.type === 'canvas');
  const addSolution = (part: QuestionPart) => {
    changePart({ ...part, solution: [newQuestionBlock('text')] });
    setSolutionFor(part.id);
  };
  const canAddSample = (part: QuestionPart) =>
    !keysPending &&
    !hasSample(part) &&
    sampleFor !== part.id &&
    (part.answer.type === 'open' ||
      (part.answer.type === 'canvas' && !!uploadSample));
  // A drawn sample is one of the question's canvases.
  const sampleOff = (part: QuestionPart) =>
    part.answer.type === 'canvas' && atCanvasCap ? canvasCap : undefined;
  const canAddSolution = (part: QuestionPart) =>
    !keysPending && part.solution.length === 0;
  // The footer's Sample answer and Solution, each its own section
  // (Epo 2026-11-15).
  const solutionButtons = (part: QuestionPart) => (
    <>
      {canAddSample(part) &&
        (part.answer.type === 'canvas' && boardFailed ? (
          <CannotShow className="px-2.5" />
        ) : (
          footerButton(
            part.answer.type === 'canvas'
              ? m.drawing_sample_draw()
              : m.question_ui_sample_answer_heading(),
            () => setSampleFor(part.id),
            sampleOff(part)
          )
        ))}
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
  // the first one's icon lines up with the text above; off, why on hover.
  const footerButton = (label: string, onClick: () => void, off?: string) => {
    const button = (
      <Button
        className="px-2.5"
        disabled={!!off}
        iconLeft="plus"
        onClick={onClick}
        size="sm"
        type="button"
        variant="ghost-hover"
      >
        {label}
      </Button>
    );
    return off ? <ButtonTooltip label={off}>{button}</ButtonTooltip> : button;
  };
  const marksControl = (part: QuestionPart) => (
    <span className="flex items-center gap-2">
      {/* A long answer's marks are its marking points' total: one line with
          the label, "Marks 6" (Epo 2026-11-19). */}
      {modelMarked(part.answer.type) ? (
        <span className="t-meta font-semibold text-fg-secondary">
          {`${m.question_ui_part_marks()} ${part.marks}`}
        </span>
      ) : (
        <>
          <span className="t-meta font-semibold text-fg-secondary">
            {m.question_ui_part_marks()}
          </span>
          <MarksInput
            label={m.question_ui_part_marks()}
            onChange={(marks) => changePart({ ...part, marks })}
            value={part.marks}
          />
        </>
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
    // answer's written sample or a canvas part's drawn one, which marking reads
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
          onFigure={openFigure}
          placeholder={m.question_ui_sample_answer_heading()}
          section={{ partId: part.id }}
          textOnly
        />
      ) : answer.type === 'canvas' &&
        uploadSample &&
        (answer.sample || adding) ? (
        <DrawnSampleField
          onChange={(drawn) => {
            // A sample drawn or replaced: one held before goes.
            if (
              changePart({ ...part, answer: withSample(answer, drawn) }) &&
              quizId
            )
              holdSample(quizId, part.id, undefined);
          }}
          onOpenChange={(open) => !open && setSampleFor(null)}
          open={adding || undefined}
          pinned={pinnedQuestion(question, part, number)}
          // A new sample starts from the canvas the part answers in, as it
          // is now.
          question={answerCanvasBoard(question, part)}
          sample={answer.sample}
          upload={uploadSample}
        />
      ) : null;
    const removeSample = () => {
      setSampleFor(null);
      if (answer.type === 'open') setAnswer({ ...answer, accepted: [] });
      if (
        answer.type === 'canvas' &&
        setAnswer(withSample(answer, undefined)) &&
        quizId
      )
        holdSample(quizId, part.id, undefined);
    };
    return (
      <div className="flex flex-col gap-4.5">
        {!ownCanvas(part) && answerIn(part)}
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
              onFigure={openFigure}
              placeholder={m.question_ui_solution_placeholder()}
              section={{ partId: part.id, solution: true }}
              uploadAsset={uploadAsset}
            />
          </div>
        )}
      </div>
    );
  };

  // Switching to Canvas would add a canvas: the part holds none to answer on.
  const addsCanvas = (part: QuestionPart) =>
    atCanvasCap && !canvasCount(part.blocks);
  // Turned into a Canvas part, fresh or restored (Epo 2026-11-24): on a
  // canvas of its own (New canvas: the one it holds, else the one Same took,
  // else an empty one), or, where that would add one at the question's canvas
  // cap, in the canvas above (Same; with none above Canvas is off). A drawn
  // sample past the cap stays held for the tab, one held coming back once it
  // fits. `restore` turns the part with what it kept for the type. True once
  // the write lands.
  const toCanvas = async (
    part: QuestionPart,
    answer: Extract<QuestionPart['answer'], { type: 'canvas' }>,
    restore: (item: QuestionPart, to: QuestionPart['answer']) => QuestionPart
  ) => {
    const { sample: own, shared: _, ...rest } = answer;
    const above = { ...rest, shared: true as const };
    const held = quizId ? heldSample(quizId, part.id) : null;
    const sample = own ?? held ?? undefined;
    // With its sample, unless that takes the question past the cap (`hold`).
    const sampled = (now: Question, item: QuestionPart) => {
      if (!sample || item.answer.type !== 'canvas') return { part: item };
      const drawn = { ...item, answer: { ...item.answer, sample } };
      const { held: hold } = sampleWithinCap(
        {
          ...now,
          parts: now.parts.map((each) => (each.id === item.id ? drawn : each)),
        },
        item.id
      );
      return { hold, part: hold ? item : drawn };
    };
    // Once the write lands: the sample held now, else none, as it is back.
    const settle = (hold: DrawnSample | undefined) => {
      if (quizId && sample) holdSample(quizId, part.id, hold);
      return true;
    };
    if (addsCanvas(part)) {
      const { hold, part: next } = sampled(question, restore(part, above));
      return changePart(next) && settle(hold);
    }
    let hold: DrawnSample | undefined;
    const landed = await answerOnOwn(part, (item, canvas) => {
      if (item.answer.type !== part.answer.type) return;
      const turned = sampled(
        latest.current,
        answerOwn(restore(item, above), canvas)
      );
      hold = turned.hold;
      return turned.part;
    });
    return landed && settle(hold);
  };
  // Another type keeps what this one held for the tab, and a type held
  // before takes its answer and marking scheme back (Epo 2026-11-23).
  const typeSelect = (part: QuestionPart) => (
    <AnswerTypeSelect
      canvasOff={
        canvases
          ? part.answer.type !== 'canvas' &&
            addsCanvas(part) &&
            !canvasAbove(question, { ...part, answer: { type: 'canvas' } })
            ? canvasCap
            : undefined
          : m.question_validation_bank_canvas()
      }
      className={lone ? 'w-52.5 min-w-0' : '@min-[36rem]:w-45 w-full'}
      onChange={async (kind) => {
        const next = answerOfKind(part.answer, kind);
        if (next.type === part.answer.type)
          return changePart({ ...part, answer: next });
        const kept = quizId ? keptAnswer(quizId, part.id, next.type) : null;
        // Choices come back as single or multiple, as picked.
        const answer = kept
          ? kept.answer.type === 'mcq'
            ? answerOfKind(kept.answer, kind)
            : kept.answer
          : next;
        const scheme = kept?.markscheme;
        const restore = (item: QuestionPart, to: QuestionPart['answer']) =>
          withAnswer(
            scheme
              ? {
                  ...item,
                  marks: scheme.reduce((sum, mark) => sum + mark.marks, 0),
                  markscheme: scheme,
                }
              : item,
            to
          );
        const landed =
          answer.type === 'canvas'
            ? await toCanvas(part, answer, restore)
            : changePart(restore(part, answer));
        // The type it leaves is kept once the write lands.
        if (landed && quizId) keepAnswer(quizId, part);
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
      canvas={canvasOptions(
        part.blocks,
        m.question_canvas_part_has_one(),
        () => pinnedQuestion(question, part, number),
        // A Canvas part's own canvas is its question, its Answer in above it.
        ownCanvas(part)
          ? {
              before: answerIn(part),
              hint: m.question_canvas_hint_teacher(),
              keep: true,
            }
          : {}
      )}
      gaps={
        part.answer.type === 'gaps' ? { onChange: changePart, part } : undefined
      }
      imageButton={lone}
      lead={label}
      onChange={setBlocks({ partId: part.id })}
      onFigure={openFigure}
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
          {partLine(question, part, label, keysPending)}
        </button>
      );
    const ref: ItemRef = { part: part.id };
    // Removing a sub-part that leaves one ungroups it, the group's text going
    // to the one left: off while that one holds a canvas beside the group's
    // (Epo 2026-11-24).
    const siblings = question.parts.filter(
      (item) => item.group === part.group && item.id !== part.id
    );
    const rest = {
      ...question,
      parts: question.parts.filter((item) => item.id !== part.id),
    };
    const removeOff =
      part.group !== undefined &&
      siblings.length === 1 &&
      canUngroup(rest, part.group) &&
      ungroupCanvasIssue(rest, part.group) === 'canvas'
        ? m.question_canvas_ungroup_has_one({
            part: labels.get(siblings[0].id)?.label ?? '',
          })
        : undefined;
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
                      writeSplit(
                        splitPart(
                          question,
                          part.id,
                          crypto.randomUUID(),
                          newPart(),
                          next
                        )
                      );
                      setOpenPart(next.id);
                    }}
                  />
                )}
                {shuffleItem(part)}
                <MenuItem
                  className={cn(removeOff && 'whitespace-normal')}
                  disabled={!canRemovePart(question, part.id) || !!removeOff}
                  hint={removeOff}
                  icon={<Icon name="trash" />}
                  label={
                    part.group === undefined
                      ? m.question_ui_remove_part()
                      : m.question_ui_remove_sub_part()
                  }
                  onClick={() => {
                    const next = removePart(question, part.id);
                    // Left alone: the question's one part, or a group's
                    // one sub-part (ungrouped by then, where it fits).
                    writeBack(
                      next,
                      part.group === undefined
                        ? isLonePart(next)
                          ? next.parts[0].id
                          : undefined
                        : siblings.length === 1
                          ? siblings[0].id
                          : undefined
                    );
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
    // Ungroup gives the group's canvas to its first sub-part: off while that
    // holds one of its own, or while others answer in it (Epo 2026-11-24).
    const issue = ungroupCanvasIssue(question, group.id);
    const ungroupOff =
      issue === 'canvas'
        ? m.question_canvas_ungroup_has_one({ part: parts[0]?.label ?? '' })
        : issue === 'answered'
          ? answeredIn(group.blocks, { groupId: group.id })
          : undefined;
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
                  className={cn(ungroupOff && 'whitespace-normal')}
                  disabled={!canUngroup(question, group.id) || !!ungroupOff}
                  hint={ungroupOff}
                  label={m.question_ui_ungroup()}
                  // Its first sub-part takes the group's text back.
                  onClick={() =>
                    writeBack(ungroup(question, group.id), parts[0]?.part.id)
                  }
                />
                <MenuItem
                  disabled={!canRemoveGroup(question, group.id)}
                  label={m.question_ui_remove()}
                  onClick={() => {
                    const next = removeGroup(question, group.id);
                    writeBack(
                      next,
                      isLonePart(next) ? next.parts[0].id : undefined
                    );
                  }}
                />
              </ToolbarPopoverContent>
            </Popover>
          }
          blocks={group.blocks}
          canvas={canvasOptions(
            group.blocks,
            m.question_canvas_part_has_one(),
            () =>
              pinnedAbove(
                [...question.stem, ...group.blocks],
                label,
                parts.reduce((sum, { part }) => sum + part.marks, 0)
              ),
            {
              answered: answeredIn(group.blocks, { groupId: group.id }),
              hint: m.question_canvas_hint_question(),
            }
          )}
          lead={label}
          onChange={setBlocks({ groupId: group.id })}
          onFigure={openFigure}
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
  // The stem's canvas, the question's, which its parts may answer in.
  const stemCanvas = canvasOptions(
    question.stem,
    m.question_canvas_text_has_one(),
    () => pinnedAbove(question.stem, '', questionMarks(question)),
    {
      answered: answeredIn(question.stem, {}),
      hint: m.question_canvas_hint_question(),
    }
  );
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
          {(atCanvasCap || !lone) && (
            <span className="t-meta text-fg-muted">
              {[
                atCanvasCap &&
                  m.question_canvas_full({
                    max: limits.QUESTION_CANVASES_MAX,
                  }),
                !lone &&
                  m.question_ui_marks_in_parts({
                    count: question.parts.length,
                    marks: marksLabel(questionMarks(question)),
                  }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </span>
      </div>
      {showStem && (
        <div className={cn(!lone && 'pb-3.5')}>
          <BlocksColumn
            blocks={question.stem}
            canvas={stemCanvas}
            onChange={setBlocks({})}
            onFigure={openFigure}
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
              canvas={stemCanvas}
              imageButton
              onChange={setBlocks({})}
              onFigure={openFigure}
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
                  disabled={
                    (first.answer.type === 'canvas' && boardFailed) ||
                    !!sampleOff(first)
                  }
                  hint={sampleOff(first)}
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
          uploadAsset={uploadAsset}
          {...(figure.binding
            ? { binding: figure.binding }
            : {
                // A table: a live quiz's is written by its room entry, a
                // draft's found by its content in the question as it stands.
                onRemove: () => {
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
                  writeBlocks(figure.section, (blocks) => {
                    const at = findBlock(blocks, figure.block, figure.index);
                    return at < 0 ? blocks : blocks.filter((_, i) => i !== at);
                  });
                },
                onSave: (block: QuestionBlock) =>
                  saveFigureBlock(figure, block),
              })}
        />
      )}
    </div>
  );
}
