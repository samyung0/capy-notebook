import { zodResolver } from '@hookform/resolvers/zod';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import * as limits from '@/api/limits.generated';
import { FloatingBlockToolbar } from '@/components/ui/BlockToolbar';
import { Button } from '@/components/ui/Button';
import { SimpleDialog, useIsPhone } from '@/components/ui/Dialog';
import { Icon, type IconName } from '@/components/ui/Icon';
import {
  Popover,
  PopoverAnchor,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { Tabs } from '@/components/ui/Tabs';
import { ToolbarGroup } from '@/components/ui/Toolbar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverGroup,
} from '@/components/ui/ToolbarPopover';
import { userToast } from '@/components/ui/userToast';
import type { ItemRoomStatus } from '@/features/collaboration/itemRoom';
import {
  LiveStatus,
  UndoButtons,
} from '@/features/collaboration/LiveItemControls';
import type { UndoTarget } from '@/features/collaboration/undo';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { CopyError, errorCopy } from '@/lib/errors';
import { scrollIntoViewWithMotion } from '@/lib/scrollIntoViewWithMotion';
import { BlockEditor, type UploadQuestionAsset } from './BlockEditor';
import { warnComputationalOpenParts } from './computationCheck';
import {
  AnswerEditor,
  answerLabels,
  emptyAnswer,
  MarkschemeList,
  MarksField,
  MenuItem,
  SelectField,
} from './editorFields';
import { renderGraphSvg } from './graph';
import {
  addSubPart,
  appendGroup,
  canMoveItem,
  canPlaceItem,
  canRemoveGroup,
  canRemovePart,
  canUngroup,
  fullPartLabel,
  type ItemRef,
  isLonePart,
  moveItem,
  placeItem,
  questionItems,
  removeGroup,
  ungroup,
} from './groups';
import { IssueIcon, IssueSummary } from './IssueViews';
import { issueMessages, questionIssues } from './issues';
import {
  AnswerView,
  type BlockSection,
  QuestionBlockView,
} from './QuestionView';
import { TextView } from './TextView';
import {
  blankQuestion,
  gapNumbers,
  gapText,
  QUESTION_TYPES,
  type Question,
  type QuestionAnswer,
  type QuestionBlock,
  type QuestionPart,
  type QuestionType,
  schemeMarks,
  withGapsText,
  withoutBlanks,
  withoutGapsBlock,
} from './types';
import { questionSchema, validateQuestion } from './validation';

const blockLabels = {
  chart: m.question_ui_chart,
  graph: m.question_ui_graph,
  image: m.question_ui_image,
  plot: m.question_ui_plot,
  table: m.question_ui_table,
  text: m.question_ui_text,
};
const blockIcons: Record<keyof typeof blockLabels, IconName> = {
  chart: 'chart',
  graph: 'graph',
  image: 'image',
  plot: 'chart',
  table: 'table',
  text: 'text',
};
/** A part turned into blanks: one answer list for each blank its text has,
 * or a sample sentence holding one when it has none. */
function gapsAnswer(part: QuestionPart): QuestionPart {
  const blanks = gapNumbers(part.blocks).length;
  const blocks: QuestionBlock[] = blanks
    ? part.blocks
    : [
        ...part.blocks,
        {
          text: m.question_ui_gaps_sample({ blank: gapText(1) }),
          type: 'text',
        },
      ];
  return {
    ...part,
    answer: {
      accepted: Array.from({ length: blanks || 1 }, () => ['']),
      type: 'gaps',
    },
    blocks,
    itemAwards: undefined,
    markscheme: undefined,
  };
}
/** Open answers carry a marking scheme worth the part's marks; closed ones
 * drop it. Turned away from blanks, the text blocks holding them go. */
export function withAnswer(
  part: QuestionPart,
  answer: QuestionAnswer
): QuestionPart {
  if (answer.type === 'gaps')
    return part.answer.type === 'gaps'
      ? { ...part, answer, itemAwards: undefined, markscheme: undefined }
      : gapsAnswer(part);
  const blocks =
    part.answer.type === 'gaps'
      ? part.blocks.filter((block) => gapNumbers([block]).length === 0)
      : part.blocks;
  return answer.type === 'open'
    ? {
        ...part,
        answer,
        blocks,
        markscheme: part.markscheme ?? [{ marks: part.marks, text: '' }],
      }
    : { ...part, answer, blocks, itemAwards: undefined, markscheme: undefined };
}

// Only open parts have a marking scheme.
const answerTitle = (part: QuestionPart) =>
  part.answer.type === 'open'
    ? m.question_ui_answer_and_marking_scheme()
    : m.question_ui_answer_and_marks();

const draftResolver = zodResolver(z.object({ draft: questionSchema }));
const marksLabel = (count: number) =>
  count === 1 ? m.question_ui_one_mark() : m.question_ui_marks({ count });
// An empty text block shows what it is for until the author types.
const textPlaceholder = (section: BlockSection) =>
  section.solution
    ? m.question_ui_solution_placeholder()
    : m.question_ui_question_placeholder();
const blockSummary = (block: QuestionBlock, section: BlockSection) =>
  (block.type === 'text'
    ? block.text.trim() || textPlaceholder(section)
    : block.type === 'chart' || block.type === 'plot'
      ? block.title
      : block.type === 'graph' || block.type === 'image'
        ? block.description
        : '') || blockLabels[block.type]();

type Location = BlockSection & { index: number };
type Row =
  | { kind: 'block'; location: Location }
  | { kind: 'group'; groupId: string }
  | { kind: 'part' | 'solution'; partId: string };
/** The item a part or group row moves, or none for a block or solution row. */
const itemRef = (row: Row): ItemRef | null =>
  row.kind === 'part'
    ? { part: row.partId }
    : row.kind === 'group'
      ? { group: row.groupId }
      : null;
type Editing =
  | {
      kind: 'block';
      location: Location;
      block: QuestionBlock;
      /** A gaps part's text in the bank: its blanks' answers, staged with
       * it until Save. */
      lists?: string[][];
    }
  | { kind: 'part'; part: QuestionPart };
/** A live quiz question (Epo 2026-10-10): every change writes to the quiz's
 * documents at once; there is no Save, Cancel or Done, the dialog closes with
 * its X or Esc, and the footer holds Undo, Redo and the live state. */
export interface LiveQuestion {
  status: ItemRoomStatus;
  undo: UndoTarget | null;
  write: (question: Question) => void;
}

export interface QuestionDialogProps {
  bankAssetsUrl?: string;
  context?: string;
  live?: LiveQuestion;
  onClose: () => void;
  onReload?: () => Promise<Question>;
  /** Staged editing (the bank): the dialog's Save. */
  onSave?: (question: Question) => void | Promise<void>;
  open: boolean;
  policy?: 'quiz' | 'bank';
  question: Question;
  questionNumber?: number;
  uploadAsset?: UploadQuestionAsset;
}

/** A plot has no editor, so it is never added empty. */
type AddableBlock = Exclude<QuestionBlock['type'], 'plot'>;
export function newQuestionBlock(type: AddableBlock): QuestionBlock {
  switch (type) {
    case 'text':
      return { text: '', type };
    case 'chart':
      return {
        kind: 'bar',
        labels: [''],
        series: [{ name: '', values: [null] }],
        title: '',
        type,
      };
    case 'graph':
      return {
        board: { axis: true, bbox: [-7.5, 5, 7.5, -5], grid: false },
        description: '',
        // A new graph starts drawing y = x (Epo 2026-10-26).
        elements: [
          { id: crypto.randomUUID(), term: 'x', type: 'functiongraph' },
        ],
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
  if (section.groupId)
    return (
      question.groups?.find((group) => group.id === section.groupId)?.blocks ??
      []
    );
  return section.partId
    ? (question.parts.find((part) => part.id === section.partId)?.[
        section.solution ? 'solution' : 'blocks'
      ] ?? [])
    : question.stem;
}
export function changeBlocks(
  question: Question,
  section: BlockSection,
  blocks: QuestionBlock[]
): Question {
  if (section.groupId)
    return {
      ...question,
      groups: question.groups?.map((group) =>
        group.id === section.groupId ? { ...group, blocks } : group
      ),
    };
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
  a.partId === b.partId &&
  a.groupId === b.groupId &&
  Boolean(a.solution) === Boolean(b.solution);
function rowKey(row: Row): string {
  if (row.kind === 'group') return `group:${row.groupId}`;
  if (row.kind !== 'block') return `${row.kind}:${row.partId}`;
  const { groupId, index, partId, solution } = row.location;
  const owner = groupId ? `group:${groupId}` : (partId ?? 'stem');
  return `${owner}:${Boolean(solution)}:${index}`;
}

/** A row's element in the body. A blanks part has no answer controls of its
 * own: its text blocks holding the blanks stand for it (data-part-key). */
function rowElement(row: Row) {
  if (row.kind === 'group')
    return document.querySelector<HTMLElement>(
      `[data-group-id="${CSS.escape(row.groupId)}"]`
    );
  const key = CSS.escape(rowKey(row));
  return document.querySelector<HTMLElement>(
    `[data-row-key="${key}"], [data-part-key="${key}"]`
  );
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
  live,
}: QuestionDialogProps) {
  const {
    control,
    setValue,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<{ draft: Question }>({
    defaultValues: { draft: structuredClone(question) },
    // Blanks (empty text, a blank unit, hint or accepted answer, a blank
    // description, short table rows or chart series) are dropped or filled on
    // Save, so they never hold it up.
    resolver: (values, context, options) =>
      draftResolver({ draft: withoutBlanks(values.draft) }, context, options),
  });
  const staged = useWatch({ control, name: 'draft' });
  // Live: the question as the documents hold it now, and each change written
  // at once; staged: the form's draft until Save.
  const draft = live ? question : staged;
  const setDraft = (next: Question) =>
    live ? live.write(next) : setValue('draft', next, { shouldDirty: true });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [mobileTab, setMobileTab] = useState('outline');
  const phone = useIsPhone();
  const tabsRef = useRef<HTMLDivElement>(null);
  // The body column (from md) and the dialog body (phones) clip the toolbar.
  const [bodyColumn, setBodyColumn] = useState<HTMLDivElement | null>(null);
  const [dialogBody, setDialogBody] = useState<HTMLDivElement | null>(null);
  // The open block's heading row, where a graph puts its zoom tools.
  const [editorTools, setEditorTools] = useState<HTMLDivElement | null>(null);
  const bodyScrollers = [bodyColumn, dialogBody].filter(
    (element) => element !== null
  );
  // The row an outline click asked to bring into view; `seq` repeats a click.
  const [reveal, setReveal] = useState<{ row: Row; seq: number } | null>(null);
  // Runs after the click's render, once the Body tab holding the target is on
  // screen.
  useEffect(() => {
    if (!reveal) return;
    const element = rowElement(reveal.row);
    if (!element) return;
    // Room for the block's floating toolbar, below the phone's sticky tabs.
    scrollIntoViewWithMotion(
      element,
      64 + (tabsRef.current?.offsetHeight ?? 0)
    );
    element.focus({ preventScroll: true });
  }, [reveal]);
  const [error, setError] = useState('');
  const [savingBlock, setSavingBlock] = useState(false);
  // A graph row that cannot be drawn holds the block's Save.
  const [blockInvalid, setBlockInvalid] = useState(false);
  const [reloading, setReloading] = useState(false);
  const dragged = useRef<Row | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(
    null
  );
  const pending = isSubmitting || savingBlock || reloading;
  const [addOpen, setAddOpen] = useState(false);

  const changePart = (part: QuestionPart) =>
    setDraft({
      ...draft,
      parts: draft.parts.map((item) => (item.id === part.id ? part : item)),
    });
  const openBlock = (location: Location) => {
    const block = sectionBlocks(draft, location)[location.index];
    if (!block) return;
    // Left from the bank's answer editor (a gaps part's text): its staged
    // answer is kept.
    if (!live && editing?.kind === 'part') changePart(editing.part);
    setError('');
    setSelected({ kind: 'block', location });
    setEditing({ block: structuredClone(block), kind: 'block', location });
  };
  const openPart = (part: QuestionPart) => {
    setError('');
    setSelected({ kind: 'part', partId: part.id });
    setEditing({ kind: 'part', part: structuredClone(part) });
  };
  const removeBlock = (location: Location) => {
    const part = draft.parts.find((item) => item.id === location.partId);
    // A gaps part's text takes its blanks' answers with it; with no blank
    // left the part turns into a short answer.
    if (part?.answer.type === 'gaps' && !location.solution) {
      const next = withoutGapsBlock(part, location.index);
      changePart(
        gapNumbers(next.blocks).length
          ? next
          : withAnswer(next, emptyAnswer('short'))
      );
      setSelected(null);
      setEditing(null);
      return;
    }
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
  // Blocks move within their section; parts and groups among the top-level
  // items, a part inside a group among its group's. The outline menu, the
  // floating toolbar and dragging all follow these rules.
  const canMove = (row: Row, direction: number) => {
    if (row.kind === 'block') {
      const target = row.location.index + direction;
      return target >= 0 && target < sectionBlocks(draft, row.location).length;
    }
    const item = itemRef(row);
    return !!item && canMoveItem(draft, item, direction);
  };
  const canDrag = (row: Row) =>
    row.kind === 'block' || canMove(row, -1) || canMove(row, 1);
  // A block lands beside another block, at the end of a part's text (before
  // its answer), at the start of a group's (after its row) or of a worked
  // solution (after its title); a part or group lands beside another in the
  // same list.
  const canDrop = (source: Row | null, target: Row, after: boolean) => {
    if (source?.kind === 'block')
      return (
        target.kind === 'block' ||
        (target.kind === 'part' && !after) ||
        (target.kind !== 'part' && after)
      );
    const from = source && itemRef(source);
    const to = itemRef(target);
    return !!from && !!to && canPlaceItem(draft, from, to);
  };
  const move = (row: Row, direction: number) => {
    if (!canMove(row, direction)) return;
    const item = itemRef(row);
    if (item) {
      setDraft(moveItem(draft, item, direction));
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
  // Where Add puts a block: after the selected one, or in the selected section.
  const addSection = (): BlockSection => {
    if (selected?.kind === 'block') return selected.location;
    if (selected?.kind === 'group') return { groupId: selected.groupId };
    return selected
      ? { partId: selected.partId, solution: selected.kind === 'solution' }
      : {};
  };
  const blockFull = () =>
    sectionBlocks(draft, addSection()).length >= limits.QUESTION_BLOCKS_MAX;
  const partsFull =
    draft.parts.length >=
    (policy === 'bank'
      ? limits.QUESTION_PARTS_MAX
      : limits.QUIZ_QUESTION_PARTS_MAX);
  // A new part or sub-part shows selected in the question; its answer opens
  // from there.
  const revealPart = (partId: string) => {
    const row: Row = { kind: 'part', partId };
    setSelected(row);
    setReveal((current) => ({ row, seq: (current?.seq ?? 0) + 1 }));
  };
  const newPart = () => blankQuestion().parts[0];
  const addPart = () => {
    const part = newPart();
    setDraft({ ...draft, parts: [...draft.parts, part] });
    revealPart(part.id);
  };
  // A group has at least one part, so it starts with its first.
  const addGroup = () => {
    const part = newPart();
    setDraft(
      appendGroup(
        draft,
        {
          blocks: [newQuestionBlock('text')],
          id: crypto.randomUUID(),
        },
        part
      )
    );
    revealPart(part.id);
  };
  const addToGroup = (groupId: string) => {
    const part = newPart();
    setDraft(addSubPart(draft, groupId, part));
    revealPart(part.id);
  };
  const leaveGroup = (next: Question) => {
    setDraft(next);
    setSelected(null);
    setEditing(null);
  };
  const add = (type: AddableBlock, section: BlockSection = addSection()) => {
    setAddOpen(false);
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
    const gapsPart = draft.parts.find(
      (part) => part.id === editing.location.partId
    );
    if (editing.lists && gapsPart && editing.block.type === 'text') {
      changePart(
        withGapsText(
          gapsPart,
          editing.location.index,
          editing.block.text,
          editing.lists
        )
      );
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
        await onSave?.(question);
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

  const dropRow = (
    target: Row,
    after: boolean,
    source: Row | null = dragged.current
  ) => {
    dragged.current = null;
    setDrop(null);
    if (!source || !canDrop(source, target, after)) return;
    const from = itemRef(source);
    const to = itemRef(target);
    if (from && to) {
      setDraft(placeItem(draft, from, to, after));
      return;
    }
    if (source.kind === 'block' && target.kind !== 'block') {
      // Before an answer: after the part's last block; after a group's row or
      // a worked solution's title: before its first.
      const section: BlockSection =
        target.kind === 'group'
          ? { groupId: target.groupId }
          : target.kind === 'part'
            ? { partId: target.partId }
            : { partId: target.partId, solution: true };
      const count = sectionBlocks(draft, section).length;
      dropRow(
        count && target.kind === 'part'
          ? { kind: 'block', location: { ...section, index: count - 1 } }
          : { kind: 'block', location: { ...section, index: 0 } },
        target.kind === 'part' && count > 0,
        source
      );
      return;
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
  // Live, the open editor shows the documents' current part or block (a
  // co-editor's typing included); a chart or graph stays staged until Back
  // (one value per block, D8).
  const stagedBlock = (block: QuestionBlock) =>
    block.type === 'chart' || block.type === 'graph';
  const shown: Editing | null =
    live && editing
      ? editing.kind === 'part'
        ? {
            kind: 'part',
            part:
              draft.parts.find((part) => part.id === editing.part.id) ??
              editing.part,
          }
        : stagedBlock(editing.block)
          ? editing
          : {
              ...editing,
              block:
                sectionBlocks(draft, editing.location)[
                  editing.location.index
                ] ?? editing.block,
            }
      : editing;
  // Live, Undo (or a co-editor) can take away the open block or part, e.g.
  // undoing the add of a chart still staged here: back to the question then.
  // Blocks are known by place, so a different type there means it went.
  const editingGone =
    !!live &&
    !!editing &&
    (editing.kind === 'part'
      ? !draft.parts.some((part) => part.id === editing.part.id)
      : sectionBlocks(draft, editing.location)[editing.location.index]?.type !==
        editing.block.type);
  useEffect(() => {
    if (!editingGone) return;
    setEditing(null);
    setSelected(null);
    setError('');
  }, [editingGone]);
  const editPart = (part: QuestionPart) => {
    setEditing({ kind: 'part', part });
    if (live) changePart(part);
  };
  // A part turned into blanks around a new sample sentence goes straight to
  // that sentence's editor (in the bank, the part is kept first); any other
  // type opens its answer editor.
  const changeAnswerType = (part: QuestionPart, answer: QuestionAnswer) => {
    const next = withAnswer(part, answer);
    if (answer.type === 'gaps' && next.blocks.length > part.blocks.length) {
      const location = { index: next.blocks.length - 1, partId: part.id };
      changePart(next);
      setSelected({ kind: 'block', location });
      setEditing({
        block: next.blocks[location.index],
        kind: 'block',
        location,
      });
      return;
    }
    setSelected({ kind: 'part', partId: part.id });
    editPart(next);
  };
  const editBlock = (location: Location, block: QuestionBlock) => {
    setEditing((current) =>
      current?.kind === 'block' &&
      rowKey({ kind: 'block', location: current.location }) ===
        rowKey({ kind: 'block', location })
        ? { ...current, block }
        : current
    );
    if (live && !stagedBlock(block))
      setDraft(
        changeBlocks(
          draft,
          location,
          sectionBlocks(draft, location).map((item, i) =>
            i === location.index ? block : item
          )
        )
      );
  };
  const close = () => {
    if (live && policy === 'quiz') void warnComputationalOpenParts(draft);
    onClose();
  };
  // What keeps the question from being marked (Epo 2026-10-15): the first
  // issue at the top, a warning icon on each affected outline row, and one
  // right of each affected title, whose tooltip lists that title's issues. A
  // lone part's issues sit on the question's title (it has no title of its
  // own).
  const issues = questionIssues(draft, {
    bank: policy === 'bank',
    bankAssetsUrl,
  });
  const issueRows = new Set(
    issues.flatMap((issue) => (issue.row ? [rowKey(issue.row)] : []))
  );
  // The open editor's own issues, read with what it shows put in (a bank
  // edit is staged until Save); a graph lists its own.
  const editorIssues = (() => {
    if (!shown || (shown.kind === 'block' && shown.block.type === 'graph'))
      return [];
    const question =
      shown.kind === 'part'
        ? {
            ...draft,
            parts: draft.parts.map((part) =>
              part.id === shown.part.id ? shown.part : part
            ),
          }
        : changeBlocks(
            draft,
            shown.location,
            sectionBlocks(draft, shown.location).map((block, i) =>
              i === shown.location.index ? shown.block : block
            )
          );
    const key = rowKey(
      shown.kind === 'part'
        ? { kind: 'part', partId: shown.part.id }
        : { kind: 'block', location: shown.location }
    );
    return issueMessages(
      questionIssues(question, {
        bank: policy === 'bank',
        bankAssetsUrl,
      }).filter((issue) => issue.row && rowKey(issue.row) === key)
    );
  })();
  // A gaps part's text block edits its blanks' answers with it: live, each
  // change writes both; in the bank they wait for Save together.
  const blockGaps = (() => {
    if (
      shown?.kind !== 'block' ||
      shown.block.type !== 'text' ||
      shown.location.solution
    )
      return;
    const part = draft.parts.find((item) => item.id === shown.location.partId);
    if (part?.answer.type !== 'gaps') return;
    const { index } = shown.location;
    const stored = part.blocks[index];
    const start = gapNumbers(part.blocks.slice(0, index)).length;
    const count = stored ? gapNumbers([stored]).length : 0;
    return {
      lists:
        (!live && editing?.kind === 'block' && editing.lists) ||
        part.answer.accepted.slice(start, start + count),
      onChange: (text: string, lists: string[][]) => {
        if (live) changePart(withGapsText(part, index, text, lists));
        else
          setEditing((current) =>
            current?.kind === 'block' && current.block.type === 'text'
              ? { ...current, block: { ...current.block, text }, lists }
              : current
          );
      },
      start: start + 1,
    };
  })();
  // Part labels only mean something when a question has several parts, or its
  // one part sits in a group.
  const labelled = !isLonePart(draft);
  const titleIssues = (partId?: string) =>
    issueMessages(
      issues.filter((issue) => (labelled ? issue.partId === partId : !partId))
    );
  const row = (
    item: Row,
    label: string,
    { mark, meta }: { mark?: string; meta?: string } = {}
  ) => {
    const key = rowKey(item);
    const part =
      item.kind === 'block' || item.kind === 'group'
        ? undefined
        : draft.parts.find((part) => part.id === item.partId);
    const group =
      item.kind === 'group'
        ? draft.groups?.find((entry) => entry.id === item.groupId)
        : undefined;
    // A group's row reads as its first text, which it stands for here.
    const headLocation: Location | undefined =
      item.kind === 'group' && group?.blocks[0]?.type === 'text'
        ? { groupId: item.groupId, index: 0 }
        : undefined;
    const block =
      item.kind === 'block'
        ? sectionBlocks(draft, item.location)[item.location.index]
        : headLocation
          ? group?.blocks[0]
          : undefined;
    const location = item.kind === 'block' ? item.location : headLocation;
    const flagged =
      issueRows.has(key) ||
      (!!headLocation &&
        issueRows.has(rowKey({ kind: 'block', location: headLocation })));
    // A worked solution's title sits as close over its first row as a row's
    // title over its meta (2px, Epo 2026-11-04).
    const closeBelow = item.kind === 'solution' && !!part?.solution.length;
    const closeAbove =
      item.kind === 'block' &&
      item.location.solution &&
      item.location.index === 0;
    // Stem rows sit flush; a part's rows share the column its label sits in.
    const indented =
      labelled &&
      (item.kind !== 'block' ||
        !!item.location.partId ||
        !!item.location.groupId);
    return (
      <div
        className={cn(
          'group relative flex min-w-0 rounded-lg hover:bg-surface-hover-bg',
          drop?.key === key &&
            (drop.after
              ? 'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-action-accent'
              : 'before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-action-accent')
        )}
        draggable={canDrag(item)}
        key={key}
        onDragEnd={() => {
          dragged.current = null;
          setDrop(null);
        }}
        onDragOver={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const after = event.clientY > rect.top + rect.height / 2;
          // No line, and no drop, where the row cannot land.
          if (!canDrop(dragged.current, item, after)) {
            if (drop?.key === key) setDrop(null);
            return;
          }
          event.preventDefault();
          setDrop({ after, key });
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
          className={cn(
            'grid w-full min-w-0 py-1.5 pr-9 pl-2 text-left text-sm md:pr-2 md:pl-1',
            !indented && 'grid-cols-1',
            indented &&
              (draft.groups?.length
                ? 'grid-cols-[1.75rem_minmax(0,1fr)]'
                : 'grid-cols-[1.5rem_minmax(0,1fr)]'),
            // A header row: tall enough for its menu button; with rows under
            // it, its text stays where that height centres it.
            item.kind === 'solution' && !closeBelow && 'min-h-9 content-center',
            closeBelow && 'pt-[9.25px] pb-0',
            closeAbove && 'pt-0.5'
          )}
          onClick={() => {
            // Brings the block (or the part's answer or worked solution) into
            // view in the body; a block's editor opens from there.
            setSelected(item);
            setMobileTab('body');
            setReveal((current) => ({
              row: item,
              seq: (current?.seq ?? 0) + 1,
            }));
          }}
          // A double click edits, as Edit in the row's menu does.
          onDoubleClick={() => {
            if (location) openBlock(location);
            else if (part && item.kind === 'part') openPart(part);
          }}
          type="button"
        >
          {indented && <strong className="leading-tight">{mark}</strong>}
          {/* Rows the app names (not the author) take their own accent. */}
          <span
            className={cn(
              'flex min-w-0 items-start gap-1.5',
              item.kind === 'part' && 'text-tint-accent-1-fg',
              item.kind === 'solution' && 'text-tint-accent-2-fg'
            )}
          >
            <span
              className={cn(
                'line-clamp-2 min-w-0 break-words leading-tight',
                // An empty text block's placeholder, not the author's words.
                block?.type === 'text' && !block.text.trim() && 'text-fg-muted'
              )}
            >
              {block?.type === 'text' ? (
                <TextView
                  className="whitespace-normal [&>span]:my-0 [&>span]:inline"
                  text={label}
                />
              ) : (
                label
              )}
            </span>
            {flagged && (
              <span
                aria-label={m.question_issue_row()}
                className="mt-px shrink-0 text-tint-warning-fg"
                role="img"
              >
                <Icon className="size-3.5" name="alert" />
              </span>
            )}
          </span>
          {meta && (
            <span
              className={cn(
                'mt-0.5 text-fg-muted text-xs',
                indented && 'col-start-2'
              )}
            >
              {meta}
            </span>
          )}
        </button>
        <Popover>
          {/* The file panel's hover actions: a faded backing over the text,
              the row's full height so a second line never shows below it. */}
          <div className="scroll-fade-x absolute inset-y-0 right-0 animate-none! rounded-r-lg bg-overlay pt-0.5 pr-0.5 pl-3 transition-opacity ease-(--motion-ease-smooth-out) [--scroll-fade-on:1] [--scroll-fade-start:12px] group-hover:bg-surface-hover-bg has-data-[state=open]:opacity-100 md:opacity-0 md:has-focus-visible:opacity-100 md:group-hover:opacity-100">
            <PopoverTrigger asChild>
              <ToolbarButton
                className={cn('hover:bg-transparent', closeAbove && '-mt-1')}
                label={m.question_ui_actions({ label })}
                tooltip={false}
              >
                <Icon name="moreVertical" />
              </ToolbarButton>
            </PopoverTrigger>
          </div>
          <ToolbarPopoverContent align="end" className="w-56">
            {part && item.kind === 'part' && (
              <>
                <MenuItem
                  icon={<Icon name="pencil" />}
                  label={answerTitle(part)}
                  onClick={() => openPart(part)}
                />
                <ToolbarPopoverGroup label={m.question_ui_answer_type()}>
                  {QUESTION_TYPES.map((type) => (
                    <MenuItem
                      key={type}
                      label={answerLabels[type]()}
                      onClick={() =>
                        changePart(withAnswer(part, emptyAnswer(type)))
                      }
                      selected={part.answer.type === type}
                    />
                  ))}
                </ToolbarPopoverGroup>
                <hr className="my-1.5 border-divider" />
              </>
            )}
            {item.kind === 'block' && (
              <MenuItem
                icon={<Icon name="pencil" />}
                label={m.question_ui_edit()}
                onClick={() => openBlock(item.location)}
              />
            )}
            {item.kind === 'group' && (
              // Board U2: Move up, Move down, Add sub-part, Ungroup, Remove.
              <>
                <MenuItem
                  disabled={!canMove(item, -1)}
                  label={m.question_ui_move_up()}
                  onClick={() => move(item, -1)}
                />
                <MenuItem
                  disabled={!canMove(item, 1)}
                  label={m.question_ui_move_down()}
                  onClick={() => move(item, 1)}
                />
                <MenuItem
                  disabled={partsFull}
                  label={m.question_ui_add_sub_part()}
                  onClick={() => addToGroup(item.groupId)}
                />
                <MenuItem
                  disabled={!canUngroup(draft, item.groupId)}
                  label={m.question_ui_ungroup()}
                  onClick={() => leaveGroup(ungroup(draft, item.groupId))}
                />
                <MenuItem
                  disabled={!canRemoveGroup(draft, item.groupId)}
                  label={m.question_ui_remove()}
                  onClick={() => leaveGroup(removeGroup(draft, item.groupId))}
                />
              </>
            )}
            {(item.kind === 'block' || item.kind === 'part') && (
              <>
                <MenuItem
                  disabled={!canMove(item, -1)}
                  icon={<Icon name="arrowUp" />}
                  label={m.question_ui_move_up()}
                  onClick={() => move(item, -1)}
                />
                <MenuItem
                  disabled={!canMove(item, 1)}
                  icon={<Icon name="arrowDown" />}
                  label={m.question_ui_move_down()}
                  onClick={() => move(item, 1)}
                />
                <MenuItem
                  disabled={
                    item.kind === 'part' && !canRemovePart(draft, item.partId)
                  }
                  icon={<Icon name="trash" />}
                  label={
                    item.kind === 'part'
                      ? m.question_ui_remove_part()
                      : m.question_ui_remove_block()
                  }
                  onClick={() =>
                    item.kind === 'block'
                      ? removeBlock(item.location)
                      : removePart(item.partId)
                  }
                />
              </>
            )}
            {item.kind === 'solution' && (
              <MenuItem
                icon={<Icon name="plus" />}
                label={m.question_ui_add_block()}
                onClick={() => {
                  setSelected(item);
                  setAddOpen(true);
                }}
              />
            )}
          </ToolbarPopoverContent>
        </Popover>
      </div>
    );
  };
  // A block or part answer in the body: click selects it, a double click or
  // Enter edits it, and the selection shows the note editor's floating block
  // toolbar below it, portaled so selecting never moves the layout.
  // `part`: a blanks part's text block also shows that part selected, outlined
  // with the others holding its blanks; the last of them (`tools` given)
  // carries the part's toolbar.
  const selectable = (
    row: Row,
    label: string,
    onEdit: () => void,
    tools: ReactNode,
    children: ReactNode,
    part?: { row: Row; onEdit: () => void; tools?: ReactNode }
  ) => {
    const key = rowKey(row);
    const active = !!selected && rowKey(selected) === key;
    const partKey = part && rowKey(part.row);
    const partActive = !!selected && rowKey(selected) === partKey;
    const toolbar = active
      ? { onEdit, tools }
      : partActive && part?.tools
        ? { onEdit: part.onEdit, tools: part.tools }
        : null;
    return (
      <Popover
        modal={false}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        open={!!toolbar}
      >
        <PopoverAnchor asChild>
          <div
            aria-label={label}
            className={cn(
              // Disabled preview controls would swallow the click.
              'relative outline-offset-2 [&_:disabled]:pointer-events-none',
              (active || partActive) && 'outline-2 outline-action-accent'
            )}
            data-part-key={partKey}
            data-row-key={key}
            onClick={() => setSelected(row)}
            onDoubleClick={onEdit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.target === event.currentTarget)
                onEdit();
            }}
            role="button"
            tabIndex={0}
          >
            {children}
          </div>
        </PopoverAnchor>
        <FloatingBlockToolbar
          aria-label={m.question_ui_block_actions()}
          // Flips above a block whose bottom is scrolled past, off the footer.
          avoidCollisions
          collisionBoundary={bodyScrollers}
          // Clicking away clears the selection, except on controls: another
          // block or row selects itself, and Add places after this block.
          onInteractOutside={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest(
                'button, [role="button"], [role="menuitem"], [data-radix-popper-content-wrapper]'
              )
            )
              event.preventDefault();
          }}
          open={!!toolbar}
          role="toolbar"
        >
          <ToolbarGroup>
            <ToolbarButton
              label={m.question_ui_edit()}
              onClick={toolbar?.onEdit ?? onEdit}
            >
              <Icon name="pencil" />
            </ToolbarButton>
          </ToolbarGroup>
          {toolbar?.tools}
        </FloatingBlockToolbar>
      </Popover>
    );
  };
  const moveTools = (row: Row) => (
    <ToolbarGroup>
      <ToolbarButton
        disabled={!canMove(row, -1)}
        label={m.question_ui_move_up()}
        onClick={() => move(row, -1)}
      >
        <Icon name="arrowUp" />
      </ToolbarButton>
      <ToolbarButton
        disabled={!canMove(row, 1)}
        label={m.question_ui_move_down()}
        onClick={() => move(row, 1)}
      >
        <Icon name="arrowDown" />
      </ToolbarButton>
    </ToolbarGroup>
  );
  const previewBlock = (
    block: QuestionBlock,
    index: number,
    section: BlockSection,
    view?: ReactNode
  ) => {
    const location = { ...section, index };
    const row: Row = { kind: 'block', location };
    const part = draft.parts.find((item) => item.id === section.partId);
    // A blanks part's text blocks holding blanks; the last gets its tools.
    const gapBlocks =
      part?.answer.type === 'gaps' && !section.solution
        ? part.blocks.flatMap((item, i) =>
            gapNumbers([item]).length > 0 ? [i] : []
          )
        : [];
    return selectable(
      row,
      m.question_ui_select_block({ type: blockLabels[block.type]() }),
      () => openBlock(location),
      <>
        {moveTools(row)}
        <ToolbarGroup>
          <ToolbarButton
            label={m.question_ui_duplicate()}
            onClick={() => {
              const blocks = [...sectionBlocks(draft, location)];
              blocks.splice(index + 1, 0, structuredClone(block));
              setDraft(changeBlocks(draft, section, blocks));
            }}
          >
            <Icon name="copy" />
          </ToolbarButton>
          <ToolbarButton
            label={m.question_ui_delete()}
            onClick={() => removeBlock(location)}
            variant="danger-light"
          >
            <Icon name="trash" />
          </ToolbarButton>
        </ToolbarGroup>
      </>,
      block.type === 'text' && !block.text.trim() ? (
        <p className="text-fg-muted leading-relaxed">
          {textPlaceholder(section)}
        </p>
      ) : (
        (view ?? <QuestionBlockView block={block} />)
      ),
      part && gapBlocks.includes(index)
        ? {
            onEdit: () => openPart(part),
            row: { kind: 'part', partId: part.id },
            tools: index === gapBlocks.at(-1) ? partTools(part) : undefined,
          }
        : undefined
    );
  };
  const partTools = (part: QuestionPart) => (
    <>
      {moveTools({ kind: 'part', partId: part.id })}
      <ToolbarGroup>
        <ToolbarButton
          disabled={!canRemovePart(draft, part.id)}
          label={m.question_ui_remove_part()}
          onClick={() => removePart(part.id)}
          variant="danger-light"
        >
          <Icon name="trash" />
        </ToolbarButton>
      </ToolbarGroup>
    </>
  );
  const previewAnswer = (part: QuestionPart, answer: ReactNode) =>
    selectable(
      { kind: 'part', partId: part.id },
      m.question_ui_select_answer(),
      () => openPart(part),
      partTools(part),
      answer
    );
  // Editors see what learners only get after checking, between the waves:
  // each part's answer key and worked solution, a part's label before its own
  // when there are several.
  const hidden = (parts: QuestionPart[]) => (
    <section className="mt-8 space-y-4">
      <div className="flex items-center gap-2 font-medium text-fg-muted text-xs">
        <span className="wavy-rule flex-1 text-line-strong" />
        <Icon className="size-4" name="viewOff" />
        {m.question_ui_hidden_until_checked()}
        <span className="wavy-rule flex-1 text-line-strong" />
      </div>
      {parts.map((part) => {
        return (
          // One gap between sections, one between a heading and its content.
          <div
            className="space-y-5"
            data-row-key={rowKey({ kind: 'solution', partId: part.id })}
            key={part.id}
          >
            {parts.length > 1 && (
              <strong className="block">{fullPartLabel(draft, part.id)}</strong>
            )}
            {/* Learners see their own answer marked instead; the key is here
                for the editor. An open part shows its optional sample answer
                and its marking scheme. */}
            {(part.answer.type !== 'open' ||
              part.answer.accepted.length > 0 ||
              (part.markscheme?.length ?? 0) > 0) && (
              // The key lives in the part's answer: a click selects that
              // block, brought into view only as far as it needs.
              <div
                aria-label={m.question_ui_select_answer()}
                className="space-y-5"
                onClick={() => {
                  const row: Row = { kind: 'part', partId: part.id };
                  setSelected(row);
                  rowElement(row)?.scrollIntoView({ block: 'nearest' });
                }}
                onDoubleClick={() => openPart(part)}
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Enter' ||
                    event.target !== event.currentTarget
                  )
                    return;
                  openPart(part);
                }}
                role="button"
                tabIndex={0}
              >
                {part.answer.type === 'open' ? (
                  <>
                    {part.answer.accepted.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="font-semibold text-sm text-tint-accent-1-fg">
                          {m.question_ui_sample_answer_heading()}
                        </h4>
                        <AnswerView part={part} />
                      </div>
                    )}
                    {(part.markscheme?.length ?? 0) > 0 && (
                      <div className="space-y-2">
                        <h4 className="font-semibold text-sm text-tint-accent-1-fg">
                          {m.question_ui_marking_scheme()}
                        </h4>
                        <ul className="space-y-1">
                          {part.markscheme?.map((item, i) => (
                            <li className="flex items-baseline gap-4" key={i}>
                              <TextView
                                className="min-w-0 flex-1"
                                text={item.text}
                              />
                              <span className="shrink-0 text-fg-muted text-sm">
                                [{item.marks}]
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="space-y-2">
                    <h4 className="font-semibold text-sm text-tint-accent-1-fg">
                      {m.question_ui_correct_answer()}
                    </h4>
                    <AnswerView part={part} />
                  </div>
                )}
              </div>
            )}
            <div className="space-y-2">
              <h4 className="font-semibold text-sm text-tint-accent-2-fg">
                {m.question_ui_worked_solution()}
              </h4>
              {part.solution.length === 0 && (
                <button
                  className="block text-left text-fg-muted leading-relaxed hover:text-fg"
                  onClick={() =>
                    add('text', { partId: part.id, solution: true })
                  }
                  type="button"
                >
                  {m.question_ui_solution_add()}
                </button>
              )}
              {part.solution.map((block, i) => (
                <div key={i}>
                  {previewBlock(block, i, { partId: part.id, solution: true })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <div className="wavy-rule text-line-strong" />
    </section>
  );
  // Back to the question. Live, edits are already written, so Back only
  // leaves; a chart or graph commits its staged value first. Not live (the
  // bank), Cancel leaves and Save commits.
  const back = () => {
    setEditing(null);
    setError('');
  };
  const doneButton = (className?: string) =>
    editing && (
      <Button
        className={className}
        disabled={
          pending ||
          (editing.kind === 'block' &&
            stagedBlock(editing.block) &&
            blockInvalid)
        }
        onClick={() =>
          editing.kind === 'block' && stagedBlock(editing.block)
            ? void saveInner()
            : back()
        }
        rounded="large"
        size="md"
        type="button"
        variant="accent"
      >
        {m.action_back()}
      </Button>
    );
  const cancelButton = (
    <Button
      disabled={pending}
      onClick={editing ? back : onClose}
      rounded="large"
      size="md"
      type="button"
      variant="ghost-hover"
    >
      {m.question_ui_cancel()}
    </Button>
  );
  // Phones: Remove part/block ends the scrolling body, and the header holds
  // the save status, Undo and Save/Back.
  const removeButton = editing && (
    <Button
      disabled={
        pending ||
        (editing.kind === 'part' && !canRemovePart(draft, editing.part.id))
      }
      onClick={() =>
        editing.kind === 'block'
          ? removeBlock(editing.location)
          : removePart(editing.part.id)
      }
      rounded="large"
      size="md"
      type="button"
      variant="danger-light"
    >
      {editing.kind === 'part'
        ? m.question_ui_remove_part()
        : m.question_ui_remove_block()}
    </Button>
  );
  // The phone header drops its action 2px for a lone button; live, Back goes
  // back up 2px to sit level with the title and the cloud.
  const phoneAction = live ? (
    doneButton('-translate-y-0.5')
  ) : (
    <Button
      disabled={pending || (editing?.kind === 'block' && blockInvalid)}
      onClick={() => void (editing ? saveInner() : saveQuestion())}
      type="button"
      variant="accent"
    >
      {m.question_ui_save()}
    </Button>
  );
  return (
    <SimpleDialog
      action={phone && phoneAction}
      cardClassName="min-h-0"
      // The footer sits close under the columns, which scroll on their own.
      cardScrollContainerClassName="overflow-hidden max-sm:pb-0 md:h-[88dvh] [&_[data-slot=dialog-title]]:shrink-0 [&>[data-slot=dialog-footer]]:mt-0 [&>[data-slot=dialog-footer]]:shrink-0 [&>[data-slot=dialog-footer]]:pt-4"
      className="grid-rows-[minmax(0,1fr)_auto] [&>.ML\_\_keyboard.is-visible]:h-[var(--_keyboard-height)]! [&>.ML\_\_keyboard]:h-0!"
      footer={
        phone ? null : live ? (
          <>
            <div className="mr-auto flex items-center gap-2">
              {live.undo && <UndoButtons footer manager={live.undo} />}
              <LiveStatus status={live.status} />
            </div>
            {removeButton}
            {doneButton()}
          </>
        ) : editing ? (
          <>
            {removeButton}
            {cancelButton}
            <Button
              disabled={pending || (editing.kind === 'block' && blockInvalid)}
              onClick={() => void saveInner()}
              rounded="large"
              size="md"
              type="button"
              variant="accent"
            >
              {m.question_ui_save()}
            </Button>
          </>
        ) : (
          <>
            {cancelButton}
            <Button
              disabled={pending}
              onClick={() => void saveQuestion()}
              rounded="large"
              size="md"
              type="button"
              variant="accent"
            >
              {m.question_ui_save()}
            </Button>
          </>
        )
      }
      // While a block or answer is open, X and Esc go back to the question.
      onClose={() => {
        if (pending) return;
        if (editing) back();
        else close();
      }}
      open={open}
      status={live && <LiveStatus compact status={live.status} />}
      title={
        <div>
          <span>
            {questionNumber == null
              ? m.question_ui_edit_question()
              : m.question_ui_edit_question_number({ number: questionNumber })}
          </span>
          {context && !editing && (
            <p className="mt-1 font-normal text-fg-muted text-sm">{context}</p>
          )}
        </div>
      }
      width={1200}
    >
      <div
        // Room at the sides for a selected block's outline and the outline
        // rows' hover, which reaches past their text, nothing moved;
        // phones: the page's bottom padding moves inside this scroller.
        className="-mx-2 min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-2 max-sm:pb-[calc(--spacing(16)+max(env(safe-area-inset-bottom),var(--keyboard-inset,0px)))]"
        ref={setDialogBody}
      >
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
        {shown ? (
          <div className="space-y-4">
            {/* A step below the dialog's title, set off from it; a graph's
                zoom tools or a table cell's formula tools sit at its end. */}
            <div className="flex items-center justify-between gap-3 pt-2">
              <h3 className="t-card-title">
                {shown.kind === 'part'
                  ? answerTitle(shown.part)
                  : blockLabels[shown.block.type]()}
              </h3>
              <div className="flex items-center" ref={setEditorTools} />
            </div>
            {shown.kind === 'block' ? (
              <>
                {/* A blanks part's text keeps its answer type at hand. */}
                {blockGaps && (
                  <SelectField
                    className="w-44"
                    label={m.question_ui_answer_type()}
                    onChange={(type) => {
                      const part = draft.parts.find(
                        (item) => item.id === shown.location.partId
                      );
                      if (part && type !== 'gaps')
                        changeAnswerType(
                          part,
                          emptyAnswer(type as QuestionType)
                        );
                    }}
                    options={QUESTION_TYPES.map((value) => ({
                      label: answerLabels[value](),
                      value,
                    }))}
                    value="gaps"
                  />
                )}
                <BlockEditor
                  bank={policy === 'bank'}
                  block={shown.block}
                  gaps={blockGaps}
                  onBusyChange={setSavingBlock}
                  onChange={(block) => editBlock(shown.location, block)}
                  onInvalidChange={setBlockInvalid}
                  textPlaceholder={textPlaceholder(shown.location)}
                  toolbarTarget={editorTools}
                  uploadAsset={uploadAsset}
                />
              </>
            ) : (
              // Generous, but option rows stop short of the dialog's far edge.
              <div className="max-w-3xl space-y-5">
                <AnswerEditor
                  answer={shown.part.answer}
                  bank={policy === 'bank'}
                  // The text blocks holding its blanks, each selected and
                  // edited as in the question; editing one leaves for its
                  // own editor.
                  gapsText={
                    shown.part.answer.type === 'gaps' &&
                    shown.part.blocks.map(
                      (block, index) =>
                        gapNumbers([block]).length > 0 && (
                          <div key={index}>
                            {previewBlock(block, index, {
                              partId: shown.part.id,
                            })}
                          </div>
                        )
                    )
                  }
                  onChange={(answer) =>
                    answer.type === shown.part.answer.type
                      ? editPart(withAnswer(shown.part, answer))
                      : changeAnswerType(shown.part, answer)
                  }
                />
                {shown.part.markscheme ? (
                  <MarkschemeList
                    items={shown.part.markscheme}
                    label={m.question_ui_scheme_marks({
                      marks: marksLabel(shown.part.marks),
                    })}
                    max={
                      policy === 'bank'
                        ? limits.QUESTION_MARKSCHEME_MAX
                        : limits.QUIZ_MARKSCHEME_MAX
                    }
                    onChange={(markscheme) =>
                      editPart({
                        ...shown.part,
                        marks: schemeMarks(markscheme),
                        markscheme,
                      })
                    }
                  />
                ) : (
                  <MarksField
                    label={m.question_ui_part_marks()}
                    max={limits.QUESTION_MARKS_MAX}
                    onChange={(marks) => editPart({ ...shown.part, marks })}
                    value={shown.part.marks}
                  />
                )}
              </div>
            )}
            {/* Below the inputs, so it coming and going as they change
                moves none of them. */}
            <IssueSummary className="max-w-3xl" messages={editorIssues} />
          </div>
        ) : (
          <div className="grid min-h-72 min-w-0 gap-x-5 gap-y-4 md:h-full md:min-h-0 md:grid-cols-[minmax(15rem,0.8fr)_minmax(0,2fr)]">
            <div
              className="sticky top-0 z-20 bg-overlay md:hidden"
              ref={tabsRef}
            >
              <Tabs
                className="dialog-tabs-bleed w-auto bg-overlay"
                onChange={setMobileTab}
                tabs={[
                  { label: m.question_ui_outline(), value: 'outline' },
                  { label: m.question_ui_body(), value: 'body' },
                ]}
                value={mobileTab}
              />
            </div>
            <div
              className={cn(
                'min-w-0 space-y-1 md:block md:min-h-0 md:-translate-x-2 md:overflow-y-auto md:overscroll-contain md:border-divider md:border-r md:pr-4 md:pl-1',
                mobileTab !== 'outline' && 'hidden'
              )}
            >
              {/* Its buttons in line with each row's ⋮ below. */}
              <div className="flex items-center justify-end pr-0.5">
                {/* In line with the rows' text below. */}
                <p className="mr-auto min-w-0 truncate pl-2 text-fg-muted text-xs md:pl-1">
                  {m.question_ui_drag_to_reorder()}
                </p>
                <Popover onOpenChange={setAddOpen} open={addOpen}>
                  <PopoverTrigger asChild>
                    <ToolbarButton label={m.question_ui_add_block()}>
                      <Icon name="plus" />
                    </ToolbarButton>
                  </PopoverTrigger>
                  <ToolbarPopoverContent align="end" className="w-44">
                    {(
                      [
                        'text',
                        'chart',
                        'graph',
                        'table',
                        ...(uploadAsset ? ['image' as const] : []),
                      ] as const
                    ).map((type) => (
                      <MenuItem
                        disabled={blockFull()}
                        icon={<Icon name={blockIcons[type]} />}
                        key={type}
                        label={blockLabels[type]()}
                        onClick={() => add(type)}
                      />
                    ))}
                  </ToolbarPopoverContent>
                </Popover>
                <Popover>
                  <PopoverTrigger asChild>
                    <ToolbarButton label={m.question_ui_question_settings()}>
                      <Icon name="moreVertical" />
                    </ToolbarButton>
                  </PopoverTrigger>
                  <ToolbarPopoverContent align="end" className="w-52">
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
                          onClick={() => setDraft({ ...draft, layout })}
                          selected={draft.layout === layout}
                        />
                      ))}
                    </ToolbarPopoverGroup>
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
                          onClick={() => setDraft({ ...draft, labels })}
                          selected={draft.labels === labels}
                        />
                      ))}
                    </ToolbarPopoverGroup>
                  </ToolbarPopoverContent>
                </Popover>
              </div>
              {draft.stem.map((block, index) =>
                row(
                  { kind: 'block', location: { index } },
                  blockSummary(block, {}),
                  { meta: blockLabels[block.type]() }
                )
              )}
              {questionItems(draft).map((item, i) => {
                // A part's outline rows: its blocks, its answer, its solution.
                // The label sits on its first row: its first block, or its
                // answer row when it has no blocks.
                const partRows = (part: QuestionPart, mark: string) => (
                  <>
                    {part.blocks.map((block, index) =>
                      row(
                        {
                          kind: 'block',
                          location: { index, partId: part.id },
                        },
                        blockSummary(block, {}),
                        {
                          mark: index === 0 ? mark : undefined,
                          meta: blockLabels[block.type](),
                        }
                      )
                    )}
                    {row({ kind: 'part', partId: part.id }, answerTitle(part), {
                      mark: part.blocks.length ? undefined : mark,
                      meta: `${answerLabels[part.answer.type]()} · ${marksLabel(part.marks)}`,
                    })}
                    {row(
                      { kind: 'solution', partId: part.id },
                      m.question_ui_worked_solution()
                    )}
                    {part.solution.map((block, index) =>
                      row(
                        {
                          kind: 'block',
                          location: {
                            index,
                            partId: part.id,
                            solution: true,
                          },
                        },
                        blockSummary(block, { solution: true }),
                        { meta: blockLabels[block.type]() }
                      )
                    )}
                  </>
                );
                if (item.kind === 'part')
                  return (
                    <div
                      className={cn(labelled && i > 0 && 'mt-2')}
                      key={item.part.id}
                    >
                      {partRows(item.part, item.label)}
                    </div>
                  );
                // Its row reads as its first text, the rest of its blocks
                // follow, then its sub-parts, at the same place as (a), (b):
                // the outline has no room for a step (Epo 2026-11-04).
                const head = item.group.blocks[0];
                const startsWithText = head?.type === 'text';
                return (
                  <div
                    className={cn(labelled && i > 0 && 'mt-2')}
                    key={item.group.id}
                  >
                    {row(
                      { groupId: item.group.id, kind: 'group' },
                      startsWithText
                        ? blockSummary(head, {})
                        : m.question_ui_group(),
                      { mark: item.label }
                    )}
                    {item.group.blocks.map(
                      (block, index) =>
                        !(startsWithText && index === 0) &&
                        row(
                          {
                            kind: 'block',
                            location: { groupId: item.group.id, index },
                          },
                          blockSummary(block, {}),
                          { meta: blockLabels[block.type]() }
                        )
                    )}
                    {item.parts.map(({ label, part }) => (
                      <div className="mt-2" key={part.id}>
                        {partRows(part, label)}
                      </div>
                    ))}
                  </div>
                );
              })}
              {/* Board U2: Part or Group, at the end of the list. */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    className="mt-2"
                    disabled={partsFull}
                    iconLeft="plus"
                    iconRight="chevronDown"
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {m.question_ui_add_part()}
                  </Button>
                </PopoverTrigger>
                <ToolbarPopoverContent align="start" className="w-44">
                  <MenuItem label={m.question_ui_part()} onClick={addPart} />
                  <MenuItem label={m.question_ui_group()} onClick={addGroup} />
                </ToolbarPopoverContent>
              </Popover>
            </div>
            <div
              className={cn(
                'min-w-0 px-1 pt-1 pb-10 md:block md:min-h-0 md:overflow-y-auto md:overscroll-contain',
                mobileTab !== 'body' && 'hidden'
              )}
              ref={setBodyColumn}
            >
              <IssueSummary className="mb-4" messages={issueMessages(issues)} />
              <QuestionRunner
                answers={{}}
                disabled
                frameAnswer={(partId, answer) => {
                  const part = draft.parts.find((item) => item.id === partId);
                  if (!part) return answer;
                  return (
                    <>
                      {/* Blanks have no controls here: their text blocks
                          stand for the part (previewBlock). */}
                      {part.answer.type !== 'gaps' &&
                        previewAnswer(part, answer)}
                      {draft.layout !== 'split' && hidden([part])}
                    </>
                  );
                }}
                question={draft}
                questionNumber={questionNumber}
                renderBlock={previewBlock}
                titleAside={(partId) => (
                  <IssueIcon messages={titleIssues(partId)} />
                )}
              />
              {/* Split: under both columns, where the answer column has no
                  room for it. */}
              {draft.layout === 'split' && hidden(draft.parts)}
            </div>
          </div>
        )}
        {phone && removeButton && (
          <div className="mt-6 flex gap-2">
            {removeButton}
            {!live && cancelButton}
          </div>
        )}
      </div>
    </SimpleDialog>
  );
}
