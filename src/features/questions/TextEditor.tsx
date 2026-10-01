import { EquationPlugin, InlineEquationPlugin } from '@platejs/math/react';
import {
  ParagraphPlugin,
  Plate,
  PlateContent,
  PlateElement,
  type PlateElementProps,
  useEditorRef,
  usePlateEditor,
} from 'platejs/react';
import { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
import { Toolbar, ToolbarGroup } from '@/components/ui/Toolbar';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { MathPreview } from '@/features/materials/MathPreview';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
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
          <button
            aria-label={m.question_ui_formula()}
            className={cn(
              'cursor-text',
              display && 'block min-h-14 w-full px-6 py-4'
            )}
            onClick={(event) => {
              if (display) {
                setEditingHeight(
                  event.currentTarget.getBoundingClientRect().height
                );
              }
              setDraft(tex);
              setEditing(true);
            }}
            type="button"
          >
            <MathPreview displayMode={display} tex={tex} />
          </button>
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
  toolbarTarget,
}: {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  toolbarTarget?: HTMLElement | null;
}) {
  const [controls, setControls] = useState<MathFieldControls | null>(null);
  const editor = usePlateEditor({
    plugins: [
      ParagraphPlugin,
      InlineEquationPlugin.withComponent(Equation),
      EquationPlugin.withComponent(Equation),
    ],
    value: mathTextToValue(value),
  });
  const formula = (tex: string, display = false) => {
    editor.tf.focus();
    editor.tf.insertNodes(
      {
        children: [{ text: '' }],
        texExpression: tex,
        type: display ? 'equation' : 'inline_equation',
      },
      { select: true }
    );
  };
  const tools = (
    <>
      <ToolbarGroup>
        <ToolbarButton
          className="w-auto px-2"
          label={m.question_ui_formula()}
          onClick={() => formula('')}
          onMouseDown={(e) => e.preventDefault()}
        >
          {m.question_ui_formula()}
        </ToolbarButton>
        <ToolbarButton
          className="w-auto px-2"
          label={m.question_ui_display_formula()}
          onClick={() => formula('', true)}
          onMouseDown={(e) => e.preventDefault()}
        >
          {m.question_ui_display()}
        </ToolbarButton>
        <span className="flex flex-col justify-center">
          {controls?.toggleKeyboard && (
            <ToolbarButton
              className="h-4"
              data-math-keyboard-toggle
              label={m.question_ui_formula_keyboard()}
              onClick={controls?.toggleKeyboard}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Icon name="keyboard" />
            </ToolbarButton>
          )}
          <ToolbarButton
            aria-haspopup="menu"
            className="h-4"
            disabled={!controls}
            label={m.question_ui_formula_menu()}
            onClick={controls?.showMenu}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Icon name="menu" />
          </ToolbarButton>
        </span>
      </ToolbarGroup>
      <ToolbarGroup>
        {[
          ['∑', '\\sum_{n=1}^{\\infty}'],
          ['∫', '\\int_0^1'],
          ['lim', '\\lim_{x\\to 0}'],
          ['ⁿ√', '\\sqrt[n]{}'],
          ['logₐ', '\\log_a'],
          ['→', '\\vec{}'],
        ].map(([label, tex]) => (
          <ToolbarButton
            className="w-auto min-w-8 px-1"
            key={label}
            label={label}
            onClick={() => formula(tex)}
            onMouseDown={(e) => e.preventDefault()}
          >
            {label}
          </ToolbarButton>
        ))}
      </ToolbarGroup>
    </>
  );
  return (
    <FormulaControls.Provider value={setControls}>
      <Plate
        editor={editor}
        onValueChange={({ value: next }) => onChange(valueToMathText(next))}
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
          className={cn(
            'min-w-0 outline-none',
            compact ? 'min-h-8 py-1' : 'min-h-40 p-3'
          )}
          spellCheck={false}
        />
      </Plate>
    </FormulaControls.Provider>
  );
}
