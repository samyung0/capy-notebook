import {
  ParagraphPlugin,
  Plate,
  PlateContent,
  PlateElement,
  type PlateElementProps,
  useEditorRef,
  usePlateEditor,
} from 'platejs/react';
import { createContext, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
import { Toolbar, ToolbarGroup } from '@/components/ui/Toolbar';
import { MathPreview } from '@/features/materials/MathPreview';
import {
  EquationPlugin,
  InlineEquationPlugin,
} from '@/features/notes/equationPlugins';
import { FormulaButton } from '@/features/notes/FormulaButton';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { ToolbarMathMenu } from '@/features/notes/toolbar/ToolbarMathMenu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { MathField, type MathFieldControls } from './MathField';
import { mathTextToValue, valueToMathText } from './mathTextValue';

export { mathTextToValue, valueToMathText } from './mathTextValue';

const FormulaControls = createContext<
  ((controls: MathFieldControls | null) => void) | undefined
>(undefined);

function Equation({ children, ...props }: PlateElementProps) {
  const editor = useEditorRef();
  const registerControls = useContext(FormulaControls);
  const tex = String(props.element.texExpression ?? '');
  const [editing, setEditing] = useState(!tex);
  const [draft, setDraft] = useState(tex);
  const [editingHeight, setEditingHeight] = useState<number>();
  const display = props.element.type === 'equation';
  const save = (next: string) => {
    const at = editor.api.findPath(props.element);
    if (at) editor.tf.setNodes({ texExpression: next }, { at });
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
              setDraft(tex);
              setEditing(false);
            }}
            onChange={setDraft}
            onCommit={save}
            onControlsReady={registerControls}
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
          >
            <MathPreview displayMode={display} tex={tex} />
          </FormulaButton>
        )}
      </span>
      {children}
    </PlateElement>
  );
}

export function TextEditor({
  value,
  onChange,
  compact = false,
  maxLength,
  placeholder,
  toolbarTarget,
}: {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  /** Characters the text holds at most: an edit past it is taken back. */
  maxLength?: number;
  placeholder?: string;
  toolbarTarget?: HTMLElement | null;
}) {
  const accepted = useRef(value);
  const [controls, setControls] = useState<MathFieldControls | null>(null);
  const editor = usePlateEditor({
    plugins: [
      ParagraphPlugin,
      InlineEquationPlugin.withComponent(Equation),
      EquationPlugin.withComponent(Equation),
    ],
    value: mathTextToValue(value),
  });
  const displayFormula = () => {
    editor.tf.focus();
    editor.tf.insertNodes(
      { children: [{ text: '' }], texExpression: '', type: 'equation' },
      { select: true }
    );
  };
  // The note toolbar's groups: what inserts formulas, then the controls of
  // the formula being edited.
  const tools = (
    <>
      <ToolbarGroup>
        <ToolbarMathMenu editor={editor} label={m.question_ui_formula()} />
        <ToolbarButton
          label={m.question_ui_display_formula()}
          onClick={displayFormula}
        >
          <Icon name="displayFormula" />
        </ToolbarButton>
      </ToolbarGroup>
      <ToolbarGroup>
        {controls?.toggleKeyboard && (
          <ToolbarButton
            data-math-keyboard-toggle
            label={m.question_ui_formula_keyboard()}
            onClick={controls?.toggleKeyboard}
          >
            <Icon name="keyboard" />
          </ToolbarButton>
        )}
        <ToolbarButton
          aria-haspopup="menu"
          disabled={!controls}
          label={m.question_ui_formula_menu()}
          onClick={controls?.showMenu}
        >
          <Icon name="menu" />
        </ToolbarButton>
      </ToolbarGroup>
    </>
  );
  return (
    <FormulaControls.Provider value={setControls}>
      <Plate
        editor={editor}
        onValueChange={({ value: next }) => {
          const text = valueToMathText(next);
          if (maxLength !== undefined && textLength(text) > maxLength) {
            // Past the cap the server refuses the text: the edit goes back.
            editor.tf.setValue(mathTextToValue(accepted.current));
            editor.tf.select(editor.api.end([]));
            return;
          }
          accepted.current = text;
          onChange(text);
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
        <PlateContent
          aria-label={m.question_ui_text_and_formulas()}
          autoFocus={compact}
          // Slate sets an inline min-height while the placeholder shows;
          // the box keeps its own.
          className={cn(
            // Paragraphs (a blank line in the text) sit a line apart, as
            // the preview draws them.
            'min-w-0 outline-none [&_.slate-p+.slate-p]:mt-[1lh]',
            compact ? 'min-h-8! py-1' : 'min-h-40! p-3'
          )}
          // Enter is one new line, as one press reads in the preview; a
          // paragraph's blank line takes two.
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              editor.tf.insertSoftBreak();
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
        />
      </Plate>
    </FormulaControls.Provider>
  );
}
