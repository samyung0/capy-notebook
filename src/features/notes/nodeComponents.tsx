import { useLink } from '@platejs/link/react';
import { isOrderedList } from '@platejs/list';
import { useBlockSelected } from '@platejs/selection/react';
import { useTocElementState } from '@platejs/toc/react';
import { KEYS, NodeApi, type Path, type TLinkElement } from 'platejs';
import {
  type PlateEditor,
  PlateElement,
  type PlateElementProps,
  PlateLeaf,
  type PlateLeafProps,
  useEditorRef,
  useFocused,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import {
  type FocusEvent,
  type KeyboardEvent,
  memo,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/Button';
import { ContentSwap } from '@/components/ui/ContentSwap';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import { MathPreview } from '@/features/materials/MathPreview';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { MathField } from '@/features/questions/MathField';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { scrollIntoViewWithMotion } from '@/lib/scrollIntoViewWithMotion';
import { CalloutIcon } from './CalloutIcon';
import { Column, ColumnGroup } from './ColumnNodes';
import { MediaAssetElement, YouTubeEmbedElement } from './MediaNodes';
import { MentionInputElement } from './MentionInput';
import {
  BLOCKQUOTE_CLASS,
  BOLD_MARK_CLASS,
  CALLOUT_CLASS,
  CODE_BLOCK_CLASS,
  CODE_LINE_CLASS,
  CODE_MARK_CLASS,
  EQUATION_BLOCK_CLASS,
  HEADING_CLASS,
  HIGHLIGHT_MARK_CLASS,
  HR_CLASS,
  ITALIC_MARK_CLASS,
  KBD_MARK_CLASS,
  LI_CLASS,
  LINK_CLASS,
  MENTION_AT_CLASS,
  MENTION_CLASS,
  OL_CLASS,
  PARAGRAPH_CLASS,
  TOC_BOX_CLASS,
  TOC_EMPTY_CLASS,
  TOC_ITEM_CLASS,
  tocItemIndent,
  UL_CLASS,
} from './nodeStyles';
import {
  CALLOUT_CONTAINER_CLASS,
  CALLOUT_VARIANT_CLASS,
  CALLOUT_VARIANTS,
  CODE_BLOCK_LANGUAGES,
  getCodeBlockLanguageLabel,
  normalizeCalloutVariant,
} from './richBlockConfig';
import {
  TableCellElement,
  TableCellHeaderElement,
  TableElement,
  TableRowElement,
} from './TableNodes';
import { ToolbarButton } from './toolbar/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverRow,
} from './toolbar/ToolbarPopover';

/* ------------------------------------------------------------- block elements */

export function FloatingActionButton(
  props: React.ComponentProps<typeof ToolbarButton>
) {
  return <ToolbarButton tooltipSide="top" {...props} />;
}

function heading(tag: keyof HTMLElementTagNameMap, key: string) {
  return function Heading(props: PlateElementProps) {
    return (
      <PlateElement {...props} as={tag} className={HEADING_CLASS[key]}>
        {props.children}
      </PlateElement>
    );
  };
}

function Paragraph(props: PlateElementProps) {
  const element = props.element as { listStyleType?: string };
  const isNumberedList =
    element.listStyleType !== undefined &&
    element.listStyleType !== KEYS.listTodo &&
    isOrderedList(props.element);

  // Default PlateElement tag is `div`. Do not force `as="p"`: indent-list
  // belowNodes wrappers inject <ol>/<div> as children, which is illegal inside <p>.
  return (
    <PlateElement
      {...props}
      className={cn(PARAGRAPH_CLASS, isNumberedList && 'before:left-6')}
    >
      {props.children}
    </PlateElement>
  );
}

function Blockquote(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="blockquote" className={BLOCKQUOTE_CLASS}>
      {props.children}
    </PlateElement>
  );
}

function Hr(props: PlateElementProps) {
  const readOnly = useReadOnly();
  const selected = useSelected();
  const focused = useFocused();
  return (
    <PlateElement {...props}>
      <div className="py-6" contentEditable={false}>
        <hr
          className={cn(
            HR_CLASS,
            selected &&
              focused &&
              'ring-2 ring-line-strong ring-offset-2 ring-offset-surface',
            !readOnly && 'cursor-pointer'
          )}
        />
      </div>
      {props.children}
    </PlateElement>
  );
}

function BlockStyleMenu({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: string;
  options: readonly { label: string; value: string }[];
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const editor = useEditorRef();
  const restoreFocus = useRef(false);
  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={label}
          className="h-7 w-auto rounded-lg px-2 py-0 font-medium text-xs"
          data-block-style={value}
          data-plate-prevent-deselect
          size="sm"
          variant="ghost-muted"
        >
          {options.find((option) => option.value === value)?.label ?? value}
        </Button>
      </PopoverTrigger>
      <ToolbarPopoverContent
        align="end"
        aria-label={label}
        className="max-h-[min(18rem,var(--radix-popover-content-available-height))] w-48 overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (restoreFocus.current) {
            restoreFocus.current = false;
            // Native controls inside Slate can retain its logical focus flag.
            editor.tf.blur();
            editor.tf.focus();
          }
        }}
        open={open}
      >
        {options.map((option) => (
          <ToolbarPopoverRow
            className="shrink-0"
            key={option.value}
            label={option.label}
            onClick={() => {
              restoreFocus.current = true;
              onValueChange(option.value);
            }}
            selected={option.value === value}
          />
        ))}
      </ToolbarPopoverContent>
    </Popover>
  );
}

function CodeBlock(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const [copied, setCopied] = useState(false);
  const language = String((props.element as { lang?: string }).lang || 'auto');

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(NodeApi.string(props.element));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <PlateElement
      {...props}
      as="pre"
      className={CODE_BLOCK_CLASS}
      data-language={language}
    >
      <div
        className="absolute top-1 right-1 z-10 flex h-7 items-center gap-0.5 font-sans"
        contentEditable={false}
      >
        {readOnly ? (
          <span className="px-2 text-[11px] text-fg-muted">
            {getCodeBlockLanguageLabel(language)}
          </span>
        ) : (
          <BlockStyleMenu
            label={m.editor_code_language()}
            onValueChange={(value) => {
              const at = editor.api.findPath(props.element);
              if (at) {
                editor.tf.setNodes({ lang: value }, { at });
                editor.tf.focus({ at: editor.api.start(at) });
              }
            }}
            options={CODE_BLOCK_LANGUAGES.map((item) => ({
              label: getCodeBlockLanguageLabel(item.value),
              value: item.value,
            }))}
            value={language}
          />
        )}
        <button
          aria-label={copied ? m.editor_code_copied() : m.editor_copy_code()}
          className="flex size-6 items-center justify-center rounded-md bg-transparent text-fg-muted hover:bg-line/50 hover:text-fg focus-visible:ring-2 focus-visible:ring-action"
          data-plate-prevent-deselect
          onClick={() => void copy()}
          title={copied ? m.editor_copied() : m.editor_copy_code()}
          type="button"
        >
          <ContentSwap contentKey={String(copied)} kind="icon">
            {copied ? (
              <EditorIcon className="size-3.5" name="check" />
            ) : (
              <EditorIcon className="size-3.5" name="clipboard" />
            )}
          </ContentSwap>
        </button>
      </div>
      {props.children}
    </PlateElement>
  );
}
function CodeLine(props: PlateElementProps) {
  return (
    <PlateElement {...props} className={CODE_LINE_CLASS}>
      {props.children}
    </PlateElement>
  );
}

function LinkElement(props: PlateElementProps) {
  const [modifierDown, setModifierDown] = useState(false);
  const { props: linkProps } = useLink({
    element: props.element as TLinkElement,
  });
  const attributes = {
    ...props.attributes,
    onBlur: (_event: FocusEvent<HTMLAnchorElement>) => setModifierDown(false),
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (!(event.ctrlKey || event.metaKey) || !linkProps.href) return;
      window.open(linkProps.href, '_blank', 'noopener,noreferrer');
    },
    onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => {
      if (event.ctrlKey || event.metaKey) setModifierDown(true);
    },
    onKeyUp: (event: KeyboardEvent<HTMLAnchorElement>) => {
      if (!event.ctrlKey && !event.metaKey) setModifierDown(false);
    },
    onMouseEnter: (event: ReactMouseEvent<HTMLAnchorElement>) =>
      setModifierDown(event.ctrlKey || event.metaKey),
    onMouseLeave: () => setModifierDown(false),
    onMouseMove: (event: ReactMouseEvent<HTMLAnchorElement>) =>
      setModifierDown(event.ctrlKey || event.metaKey),
    rel: linkProps.target === '_blank' ? 'noopener noreferrer' : undefined,
    style: { cursor: modifierDown ? 'pointer' : 'text' },
  } as PlateElementProps['attributes'];

  return (
    <PlateElement
      {...props}
      {...linkProps}
      as="a"
      attributes={attributes}
      className={LINK_CLASS}
    >
      {props.children}
    </PlateElement>
  );
}

/* lists */
function Ul(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="ul" className={UL_CLASS}>
      {props.children}
    </PlateElement>
  );
}
function Ol(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="ol" className={OL_CLASS}>
      {props.children}
    </PlateElement>
  );
}
function Li(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="li" className={LI_CLASS}>
      {props.children}
    </PlateElement>
  );
}
function Lic(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="span">
      {props.children}
    </PlateElement>
  );
}

/* callout */
function Callout(props: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const variant = normalizeCalloutVariant(
    (props.element as { variant?: unknown }).variant
  );

  return (
    <PlateElement
      {...props}
      className={cn(
        CALLOUT_CLASS,
        CALLOUT_CONTAINER_CLASS,
        CALLOUT_VARIANT_CLASS[variant],
        !readOnly && 'pr-20'
      )}
      data-callout-variant={variant}
    >
      <CalloutIcon variant={variant} />
      <div className="min-w-0 flex-1 text-fg">{props.children}</div>
      {!readOnly && (
        <div className="absolute top-1 right-1" contentEditable={false}>
          <BlockStyleMenu
            label={m.editor_callout_style()}
            onValueChange={(value) => {
              const at = editor.api.findPath(props.element);
              if (at) {
                editor.tf.setNodes({ variant: value }, { at });
                editor.tf.focus({ at: editor.api.start(at) });
              }
            }}
            options={CALLOUT_VARIANTS}
            value={variant}
          />
        </div>
      )}
    </PlateElement>
  );
}

/* toc — read-only outline placeholder (headings are the source of truth) */
/** A document can carry hundreds of headings, and editing any one of their
 * titles produces a new heading list. Without a per-entry memo, retitling one
 * heading rebuilds every row on every keystroke. `path` arrives as a fresh
 * array each time, so it has to be compared by value. */
const TocEntry = memo(
  function TocEntry({
    editor,
    path,
    title,
    type,
  }: {
    editor: PlateEditor;
    path: Path;
    title: string;
    type: string;
  }) {
    return (
      <Button
        className={TOC_ITEM_CLASS}
        onClick={(event) => {
          event.preventDefault();
          const node = NodeApi.get(editor, path);
          if (!node) return;

          const element = editor.api.toDOMNode(node);
          if (!element) return;

          scrollIntoViewWithMotion(element);
          editor.tf.navigation.flashTarget({
            target: { path, type: 'node' },
          });
        }}
        size="xs"
        style={tocItemIndent(type)}
        type="button"
        variant="ghost-hover"
      >
        {title}
      </Button>
    );
  },
  (previous, next) =>
    previous.editor === next.editor &&
    previous.title === next.title &&
    previous.type === next.type &&
    previous.path.length === next.path.length &&
    previous.path.every((step, index) => step === next.path[index])
);

function Toc(props: PlateElementProps) {
  const state = useTocElementState();
  const isBlockSelected = useBlockSelected();
  const headings = state.headingList;

  return (
    <PlateElement
      {...props}
      className={cn(
        TOC_BOX_CLASS,
        isBlockSelected &&
          '[&_button:hover]:bg-action-accent/20 [&_button:hover]:text-fg'
      )}
    >
      <div contentEditable={false}>
        {headings.length ? (
          <nav aria-label={m.toc_title()} className="flex flex-col gap-0">
            {headings.map((heading) => (
              <TocEntry
                editor={state.editor}
                key={heading.id ?? heading.path.join('-')}
                path={heading.path}
                title={heading.title}
                type={heading.type}
              />
            ))}
          </nav>
        ) : (
          <p className={TOC_EMPTY_CLASS}>{m.toc_empty_create()}</p>
        )}
      </div>
      {props.children}
    </PlateElement>
  );
}

/* mention (inline void) */
function Mention(props: PlateElementProps) {
  const mention = props.element as { key?: string; value?: string };
  const value = String(mention.value ?? mention.key ?? '');
  return (
    <PlateElement {...props} as="span" className={MENTION_CLASS}>
      <span contentEditable={false}>
        <span className={MENTION_AT_CLASS}>@</span>
        {value}
      </span>
      {props.children}
    </PlateElement>
  );
}

function EquationBody({
  props,
  displayMode,
}: {
  props: PlateElementProps;
  displayMode: boolean;
}) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const selected = useSelected();
  const tex = String(
    (props.element as { texExpression?: string }).texExpression ?? ''
  );
  const [editing, setEditing] = useState(selected && !readOnly);
  const [draft, setDraft] = useState(tex);
  const [editingHeight, setEditingHeight] = useState<number>();
  function commit(value: string) {
    if (!readOnly) {
      const at = editor.api.findPath(props.element);
      if (at) editor.tf.setNodes({ texExpression: value }, { at });
    }
    setEditing(false);
  }
  if (editing && !readOnly) {
    return (
      <MathField
        displayMode={displayMode}
        minHeight={editingHeight}
        onCancel={() => setEditing(false)}
        onChange={setDraft}
        onCommit={commit}
        value={draft}
      />
    );
  }
  if (readOnly) return <MathPreview displayMode={displayMode} tex={tex} />;
  return (
    <button
      aria-label={m.editor_equation()}
      className={cn(
        'max-w-full cursor-text text-inherit',
        displayMode && 'block min-h-14 w-full px-6 py-4'
      )}
      onClick={(event) => {
        if (displayMode) {
          setEditingHeight(event.currentTarget.getBoundingClientRect().height);
        }
        setDraft(tex);
        setEditing(true);
      }}
      type="button"
    >
      {tex ? (
        <MathPreview displayMode={displayMode} tex={tex} />
      ) : (
        <span className="text-fg-muted">{m.editor_equation()}</span>
      )}
    </button>
  );
}

function BlockEquation(props: PlateElementProps) {
  return (
    <PlateElement {...props}>
      <div className={EQUATION_BLOCK_CLASS} contentEditable={false}>
        <EquationBody displayMode props={props} />
      </div>
      {props.children}
    </PlateElement>
  );
}
function InlineEquation(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="span">
      <span contentEditable={false}>
        <EquationBody displayMode={false} props={props} />
      </span>
      {props.children}
    </PlateElement>
  );
}

/* ------------------------------------------------------------- leaf marks */

function mark(tag: keyof HTMLElementTagNameMap, className?: string) {
  return function Mark(props: PlateLeafProps) {
    return (
      <PlateLeaf {...props} as={tag} className={className}>
        {props.children}
      </PlateLeaf>
    );
  };
}

const Code = mark('code', CODE_MARK_CLASS);
const Highlight = mark('mark', HIGHLIGHT_MARK_CLASS);
const Kbd = mark('kbd', KBD_MARK_CLASS);

function CodeSyntax(props: PlateLeafProps) {
  const tokenClassName = props.leaf.className as string | undefined;

  return (
    <PlateLeaf {...props} as="span" className={tokenClassName}>
      {props.children}
    </PlateLeaf>
  );
}

/* ------------------------------------------------------------- components map */

export const noteComponents = {
  a: LinkElement,
  audio: MediaAssetElement,
  blockquote: Blockquote,
  bold: mark('strong', BOLD_MARK_CLASS),
  callout: Callout,
  code: Code,
  code_block: CodeBlock,
  code_line: CodeLine,
  code_syntax: CodeSyntax,
  column: Column,
  column_group: ColumnGroup,
  equation: BlockEquation,
  file: MediaAssetElement,
  h1: heading('h1', 'h1'),
  h2: heading('h2', 'h2'),
  h3: heading('h3', 'h3'),
  h4: heading('h4', 'h4'),
  h5: heading('h5', 'h5'),
  h6: heading('h6', 'h6'),
  highlight: Highlight,
  hr: Hr,
  img: MediaAssetElement,
  inline_equation: InlineEquation,
  italic: mark('em', ITALIC_MARK_CLASS),
  kbd: Kbd,
  li: Li,
  lic: Lic,
  mention: Mention,
  mention_input: MentionInputElement,
  ol: Ol,
  p: Paragraph,
  strikethrough: mark('s'),
  subscript: mark('sub'),
  superscript: mark('sup'),
  table: TableElement,
  td: TableCellElement,
  th: TableCellHeaderElement,
  toc: Toc,
  tr: TableRowElement,
  ul: Ul,
  underline: mark('u'),
  video: YouTubeEmbedElement,
} as const;
