import {
  BoldPlugin,
  ItalicPlugin,
  UnderlinePlugin,
} from '@platejs/basic-nodes/react';
import { KEYS } from 'platejs';
import {
  createPlatePlugin,
  ParagraphPlugin,
  Plate,
  PlateContent,
  PlateElement,
  type PlateElementProps,
  useEditorRef,
  useEditorSelector,
  useFocused,
  usePlateEditor,
  useSelected,
} from 'platejs/react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Toolbar, ToolbarGroup } from '@/components/ui/Toolbar';
import { MathPreview } from '@/features/materials/MathPreview';
import { EditorIcon } from '@/features/notes/EditorIcon';
import {
  EquationPlugin,
  InlineEquationPlugin,
} from '@/features/notes/equationPlugins';
import { FormulaButton } from '@/features/notes/FormulaButton';
import { FormulaCaretPlugin } from '@/features/notes/formulaCaret';
import {
  EDITOR_SHORTCUTS,
  MarkToolbarButton,
  ToolbarButton,
} from '@/features/notes/toolbar/ToolbarButton';
import { ToolbarMathMenu } from '@/features/notes/toolbar/ToolbarMathMenu';
import { VoidBlockBreakPlugin } from '@/features/notes/voidBlockBreak';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { FormulaJoinPlugin, removeFormula } from './formulaJoin';
import { MathField, type MathFieldControls } from './MathField';
import {
  GAP_TYPE,
  gapIds,
  mathTextToValue,
  valueToMathText,
} from './mathTextValue';

export { mathTextToValue, valueToMathText } from './mathTextValue';

/** Formulas on ruled lines are underlined while edited, not outlined. */
const FormulaUnderline = createContext(false);

const FormulaControls = createContext<
  ((controls: MathFieldControls | null) => void) | undefined
>(undefined);

function Equation({ children, ...props }: PlateElementProps) {
  const editor = useEditorRef();
  const registerControls = useContext(FormulaControls);
  const underline = useContext(FormulaUnderline);
  const tex = String(props.element.texExpression ?? '');
  const [editing, setEditing] = useState(!tex);
  const [draft, setDraft] = useState(tex);
  const [editingHeight, setEditingHeight] = useState<number>();
  const display = props.element.type === 'equation';
  // A formula left empty goes, rather than saving as `$$$$`.
  const save = (next: string) => {
    const at = editor.api.findPath(props.element);
    if (at && !next.trim()) removeFormula(editor, at);
    else if (at) editor.tf.setNodes({ texExpression: next }, { at });
    setEditing(false);
  };
  return (
    <PlateElement {...props} as={display ? 'div' : 'span'}>
      <span contentEditable={false}>
        {editing ? (
          <MathField
            displayMode={display}
            minHeight={editingHeight}
            onCancel={() => {
              if (!tex.trim()) return save('');
              setDraft(tex);
              setEditing(false);
            }}
            onChange={setDraft}
            onCommit={save}
            onControlsReady={registerControls}
            underline={underline && !display}
            value={draft}
          />
        ) : (
          <FormulaButton
            display={display}
            element={props.element}
            label={m.question_ui_formula()}
            onEdit={(height) => {
              if (display) setEditingHeight(height);
              setDraft(tex);
              setEditing(true);
            }}
            underline={underline && !display}
          >
            <MathPreview displayMode={display} tex={tex} />
          </FormulaButton>
        )}
      </span>
      {children}
    </PlateElement>
  );
}

/** Where the editor's blanks start counting, and their ids in order. */
const GapNumbers = createContext<{ start: number; ids: string[] }>({
  ids: [],
  start: 1,
});

/** A gaps part's blank, "(n) ______" in the text: a click selects it, so
 * Delete or Backspace removes it as it does a formula. */
function Gap({ children, ...props }: PlateElementProps) {
  const editor = useEditorRef();
  const selected = useSelected();
  const focused = useFocused();
  const { start, ids } = useContext(GapNumbers);
  const number = start + ids.indexOf(String(props.element.id));
  return (
    <PlateElement {...props} as="span">
      <span
        className={cn(
          'mx-0.5 inline-flex cursor-default items-baseline gap-1 rounded-sm bg-surface-hover-bg px-1 font-medium text-sm outline-offset-1',
          selected && focused && 'outline-2 outline-action-accent'
        )}
        contentEditable={false}
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          editor.tf.focus();
          const at = editor.api.findPath(props.element);
          if (at) editor.tf.select(at);
        }}
      >
        ({number})
        <span className="inline-block w-10 border-current border-b" />
      </span>
      {children}
    </PlateElement>
  );
}

const GapPlugin = createPlatePlugin({
  key: GAP_TYPE,
  node: { isElement: true, isInline: true, isVoid: true },
}).withComponent(Gap);

/** The formula tools while no text is open (a table before a cell is
 * clicked): the same buttons, disabled, so opening a cell changes nothing
 * around them. */
export function IdleFormulaTools() {
  return (
    <>
      <ToolbarGroup>
        <ToolbarButton disabled label={m.editor_bold()}>
          <EditorIcon name="bold" />
        </ToolbarButton>
        <ToolbarButton disabled label={m.editor_italic()}>
          <EditorIcon name="italic" />
        </ToolbarButton>
        <ToolbarButton disabled label={m.editor_underline()}>
          <EditorIcon name="underline" />
        </ToolbarButton>
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolbarButton disabled label={m.question_ui_formula()}>
          <EditorIcon name="sigma" />
        </ToolbarButton>
        <ToolbarButton disabled label={m.question_ui_display_formula()}>
          <Icon name="displayFormula" />
        </ToolbarButton>
      </ToolbarGroup>
      <ToolbarGroup>
        <ToolbarButton disabled label={m.question_ui_formula_menu()}>
          <Icon name="menu" />
        </ToolbarButton>
      </ToolbarGroup>
    </>
  );
}

/** A click's place in `anchor`, an element that stays while the text opens
 * in its editor, read back as a viewport point when the editor places its
 * caret: whatever moved meanwhile (a text above closing its tools, a scroll)
 * moves the point with it. */
export function clickPoint(
  event: React.MouseEvent,
  anchor: HTMLElement
): () => { x: number; y: number } {
  const at = anchor.getBoundingClientRect();
  const dx = event.clientX - at.left;
  const dy = event.clientY - at.top;
  return () => {
    const now = anchor.getBoundingClientRect();
    return { x: now.left + dx, y: now.top + dy };
  };
}

/** Move up and Move down for the caret's paragraph or display formula. */
export type LineMoves = {
  /** Where the two buttons go (the open text's formatting row). */
  target: HTMLElement | null;
  /** Whether a block sits above or below the text to move past. */
  up: boolean;
  down: boolean;
  /** Whether a line may leave the text as a block of its own. */
  split: boolean;
  /** The line at the text's edge moves past the next block. */
  onLeave: (direction: -1 | 1, line: number) => void;
};

/** The caret's line moves within the text; at its edge it leaves it. */
function LineMoveButtons({ moves }: { moves: LineMoves }) {
  const editor = useEditorRef();
  const line = useEditorSelector(
    (current) => current.selection?.anchor.path[0] ?? null,
    []
  );
  const count = useEditorSelector((current) => current.children.length, []);
  // Nothing to move: one line alone in its column (a marking point).
  if (!moves.target || line === null) return null;
  if (count === 1 && !moves.up && !moves.down) return null;
  const leaves = (direction: -1 | 1) =>
    (direction < 0 ? moves.up : moves.down) && (count === 1 || moves.split);
  const go = (direction: -1 | 1) => {
    const to = line + direction;
    if (to < 0 || to >= count) return moves.onLeave(direction, line);
    editor.tf.moveNodes({ at: [line], to: [to] });
    editor.tf.focus();
  };
  return createPortal(
    <>
      <ToolbarButton
        disabled={line === 0 && !leaves(-1)}
        label={m.question_ui_move_up()}
        onClick={() => go(-1)}
      >
        <Icon name="arrowUp" />
      </ToolbarButton>
      <ToolbarButton
        disabled={line === count - 1 && !leaves(1)}
        label={m.question_ui_move_down()}
        onClick={() => go(1)}
      >
        <Icon name="arrowDown" />
      </ToolbarButton>
    </>,
    moves.target
  );
}

/** The DOM caret at a viewport point, where the browser offers one. */
function caretAtPoint(x: number, y: number): Range | null {
  const position = document.caretPositionFromPoint?.(x, y);
  if (!position) return document.caretRangeFromPoint?.(x, y) ?? null;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  return range;
}

export function TextEditor({
  value,
  onChange,
  compact = false,
  caretAt,
  maxLength,
  placeholder,
  toolbarTarget,
  gapStart,
  moves,
  display = true,
  answer = false,
}: {
  value: string;
  /** The text, and in a gaps part its blanks' ids in order. */
  onChange: (value: string, gaps: string[]) => void;
  compact?: boolean;
  /** Where the click that opened a compact editor landed (`clickPoint`): its
   * caret starts there, else at the end. */
  caretAt?: (() => { x: number; y: number }) | null;
  /** Characters the text holds at most: an edit past it is taken back. */
  maxLength?: number;
  placeholder?: string;
  toolbarTarget?: HTMLElement | null;
  /** A gaps part's text: its "(n) ______" blanks show as chips numbered from
   * here, and Add blank inserts one. */
  gapStart?: number;
  moves?: LineMoves;
  /** Display formulas besides inline ones (a marking point takes none). */
  display?: boolean;
  /** A learner's long answer (Epo 2026-11-16, mock B): text on ruled lines
   * with one Formula button and the formula keyboard, no marks or display
   * formulas. */
  answer?: boolean;
}) {
  const accepted = useRef(value);
  const gaps = gapStart !== undefined;
  const [controls, setControls] = useState<MathFieldControls | null>(null);
  const editor = usePlateEditor({
    plugins: [
      ParagraphPlugin,
      BoldPlugin,
      ItalicPlugin,
      UnderlinePlugin,
      InlineEquationPlugin.withComponent(Equation),
      EquationPlugin.withComponent(Equation),
      VoidBlockBreakPlugin,
      FormulaJoinPlugin,
      FormulaCaretPlugin,
      GapPlugin,
    ],
    value: mathTextToValue(value, { gaps }),
  });
  const [blankIds, setBlankIds] = useState(() => gapIds(editor.children));
  // A compact editor opens on a click (a table cell): the caret goes where it
  // landed, so typing starts at once. Once, on open.
  useEffect(() => {
    if (!compact) return;
    const point = caretAt?.();
    const native = point && caretAtPoint(point.x, point.y);
    const at =
      native && editor.api.hasTarget(native.startContainer)
        ? editor.api.toSlateRange(native, {
            exactMatch: false,
            suppressThrow: true,
          })
        : null;
    editor.tf.select(at ?? editor.api.end([]));
    editor.tf.focus();
  }, []);
  const displayFormula = () => {
    editor.tf.focus();
    editor.tf.insertNodes(
      { children: [{ text: '' }], texExpression: '', type: 'equation' },
      { select: true }
    );
  };
  const addBlank = () => {
    editor.tf.focus();
    editor.tf.insertNodes({
      children: [{ text: '' }],
      id: crypto.randomUUID(),
      type: GAP_TYPE,
    });
    // The caret goes past the blank, so typing carries on after it.
    editor.tf.move({ unit: 'offset' });
  };
  const formulaKeyboard = controls?.toggleKeyboard && (
    <ToolbarButton
      data-math-keyboard-toggle
      label={m.question_ui_formula_keyboard()}
      onClick={controls?.toggleKeyboard}
    >
      <Icon name="keyboard" />
    </ToolbarButton>
  );
  // The note toolbar's groups: bold, italic and underline, what inserts
  // formulas, then the controls of the formula being edited.
  const formulaMenu = (
    <ToolbarButton
      aria-haspopup="menu"
      disabled={!controls}
      label={m.question_ui_formula_menu()}
      onClick={controls?.showMenu}
    >
      <Icon name="menu" />
    </ToolbarButton>
  );
  // A learner's: Formula opens the templates the question editor's Σ has
  // (a blank formula first), then the formula's keyboard and menu
  // (Epo 2026-11-16).
  const tools = answer ? (
    <>
      <ToolbarMathMenu
        editor={editor}
        label={m.question_ui_formula()}
        trigger={
          <Button
            onMouseDown={(event) => event.preventDefault()}
            size="sm"
            type="button"
            variant="outline"
          >
            <EditorIcon name="sigma" />
            {m.question_ui_formula()}
          </Button>
        }
      />
      {formulaKeyboard}
      {formulaMenu}
    </>
  ) : (
    <>
      <ToolbarGroup>
        <MarkToolbarButton
          label={m.editor_bold()}
          markKey={KEYS.bold}
          shortcut={EDITOR_SHORTCUTS.bold}
        >
          <EditorIcon name="bold" />
        </MarkToolbarButton>
        <MarkToolbarButton
          label={m.editor_italic()}
          markKey={KEYS.italic}
          shortcut={EDITOR_SHORTCUTS.italic}
        >
          <EditorIcon name="italic" />
        </MarkToolbarButton>
        <MarkToolbarButton
          label={m.editor_underline()}
          markKey={KEYS.underline}
          shortcut={EDITOR_SHORTCUTS.underline}
        >
          <EditorIcon name="underline" />
        </MarkToolbarButton>
      </ToolbarGroup>
      {gaps && (
        <ToolbarGroup>
          {/* Shows the blank it adds, with the next number. */}
          <ToolbarButton
            className="w-auto gap-1.5 px-2 text-sm"
            label={m.question_ui_add_gap()}
            onClick={addBlank}
            tooltip={false}
          >
            <span className="font-medium">
              ({(gapStart ?? 1) + blankIds.length})
            </span>
            {m.question_ui_add_gap()}
          </ToolbarButton>
        </ToolbarGroup>
      )}
      <ToolbarGroup>
        <ToolbarMathMenu editor={editor} label={m.question_ui_formula()} />
        {display && (
          <ToolbarButton
            label={m.question_ui_display_formula()}
            onClick={displayFormula}
          >
            <Icon name="displayFormula" />
          </ToolbarButton>
        )}
      </ToolbarGroup>
      <ToolbarGroup>
        {formulaKeyboard}
        {formulaMenu}
      </ToolbarGroup>
    </>
  );
  return (
    <FormulaUnderline.Provider value={answer}>
      <FormulaControls.Provider value={setControls}>
        <Plate
          editor={editor}
          onValueChange={({ value: next }) => {
            const text = valueToMathText(next, gapStart);
            if (maxLength !== undefined && textLength(text) > maxLength) {
              // Past the cap the server refuses the text: the edit goes back.
              editor.tf.setValue(mathTextToValue(accepted.current, { gaps }));
              editor.tf.select(editor.api.end([]));
              return;
            }
            // A pasted blank is a new one: it takes an id of its own.
            const ids = gapIds(next);
            const seen = new Set<string>();
            for (const [node, path] of editor.api.nodes({
              at: [],
              match: { type: GAP_TYPE },
            })) {
              const id = String(node.id);
              if (seen.has(id)) {
                editor.tf.setNodes({ id: crypto.randomUUID() }, { at: path });
                return;
              }
              seen.add(id);
            }
            accepted.current = text;
            setBlankIds(ids);
            onChange(text, ids);
          }}
        >
          {toolbarTarget
            ? createPortal(tools, toolbarTarget)
            : !compact && (
                <Toolbar
                  aria-label={m.question_ui_formula_tools()}
                  className="scroll-fade-x min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  role="toolbar"
                >
                  {tools}
                </Toolbar>
              )}
          {moves && <LineMoveButtons moves={moves} />}
          <GapNumbers.Provider value={{ ids: blankIds, start: gapStart ?? 1 }}>
            <PlateContent
              aria-label={m.question_ui_text_and_formulas()}
              autoFocus={compact}
              // Slate sets an inline min-height while the placeholder shows;
              // the box keeps its own.
              className={cn(
                // Paragraphs (a blank line in the text) sit a line apart, as
                // the preview draws them.
                'min-w-0 outline-none [&_.slate-p+.slate-p]:mt-[1lh]',
                answer
                  ? 'ruled-lines max-h-[calc(var(--ruled-line)*8)] min-h-[calc(var(--ruled-line)*3)]! overflow-y-auto px-0.5'
                  : compact
                    ? 'min-h-8! py-1'
                    : 'min-h-40! p-3'
              )}
              // Enter is one new line, as one press reads in the preview; a
              // paragraph's blank line takes two. On a selected display formula
              // it opens a line below, as in notes.
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  const block = editor.api.block();
                  if (block && editor.api.isVoid(block[0]))
                    editor.tf.insertBreak();
                  else editor.tf.insertSoftBreak();
                }
              }}
              placeholder={placeholder}
              spellCheck={false}
            />
          </GapNumbers.Provider>
        </Plate>
      </FormulaControls.Provider>
    </FormulaUnderline.Provider>
  );
}
