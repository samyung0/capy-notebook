import { useDraggable, useDropLine } from '@platejs/dnd';
import { setColumns } from '@platejs/layout';
import {
  Columns2,
  Columns3,
  GripHorizontal,
  PanelLeft,
  PanelRight,
  Trash2,
} from 'lucide-react';
import { PathApi, type TColumnElement } from 'platejs';
import {
  PlateElement,
  type PlateElementProps,
  useComposedRef,
  useEditorRef,
  useEditorSelector,
  useElement,
  useFocusedLast,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import type { CSSProperties } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/Popover';
import { cn } from '@/lib/cn';
import { FloatingActionButton } from './nodeComponents';
import { COLUMN_CLASS, COLUMN_GROUP_CLASS } from './nodeStyles';
import { COLUMN_LAYOUTS } from './richBlockConfig';

export function ColumnGroup(props: PlateElementProps) {
  const readOnly = useReadOnly();

  const content = (
    <PlateElement {...props} className={COLUMN_GROUP_CLASS}>
      {props.children}
    </PlateElement>
  );

  if (readOnly) return content;

  return <ColumnFloatingToolbar>{content}</ColumnFloatingToolbar>;
}

function ColumnFloatingToolbar({ children }: { children: React.ReactElement }) {
  const selected = useSelected();
  const readOnly = useReadOnly();
  const isCollapsed = useEditorSelector(
    (editor) => editor.api.isCollapsed(),
    []
  );
  const isFocusedLast = useFocusedLast();
  const open = isFocusedLast && !readOnly && selected && isCollapsed;

  return (
    <Popover modal={false} open={open}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      {open && <ColumnFloatingToolbarContent />}
    </Popover>
  );
}

function ColumnFloatingToolbarContent() {
  const editor = useEditorRef();
  const element = useElement<TColumnElement>();
  const changeLayout = (widths: string[]) => {
    setColumns(editor, { at: element, widths });
  };

  const remove = () => {
    editor.tf.removeNodes({ at: element });
  };

  return (
    <PopoverContent
      align="center"
      avoidCollisions={false}
      className="w-auto min-w-14 max-w-[90vw] flex-row items-center justify-center gap-0.5 overflow-x-auto rounded-lg border border-line bg-surface p-1 shadow-pop"
      contentEditable={false}
      onOpenAutoFocus={(event) => event.preventDefault()}
      side="bottom"
      sideOffset={8}
    >
      {COLUMN_LAYOUTS.map((layout) => {
        const LayoutIcon =
          layout.value === 'equal-3'
            ? Columns3
            : layout.value === 'left-wide'
              ? PanelRight
              : layout.value === 'right-wide'
                ? PanelLeft
                : Columns2;
        return (
          <FloatingActionButton
            key={layout.value}
            label={layout.label}
            // className="flex size-7 items-center justify-center rounded-button text-fg-muted hover:bg-surface-hover-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-action"
            onClick={() => changeLayout(layout.widths)}
            type="button"
          >
            <LayoutIcon className="size-4" />
          </FloatingActionButton>
        );
      })}
      <div className="mx-0.5 h-4 w-px bg-divider" />
      <FloatingActionButton label="Delete table" onClick={remove}>
        <Trash2 />
      </FloatingActionButton>
    </PopoverContent>
  );
}

export function Column(props: PlateElementProps) {
  const readOnly = useReadOnly();
  const width = (props.element as { width?: string }).width;
  const draggable = useDraggable({
    canDropNode: ({ dragEntry, dropEntry }) =>
      PathApi.equals(
        PathApi.parent(dragEntry[1]),
        PathApi.parent(dropEntry[1])
      ),
    element: props.element,
    orientation: 'horizontal',
    type: 'column',
  });
  const { dropLine } = useDropLine({ orientation: 'horizontal' });

  return (
    <PlateElement
      {...props}
      className={cn(COLUMN_CLASS, draggable.isDragging && 'opacity-45')}
      ref={useComposedRef(props.ref, draggable.previewRef, draggable.nodeRef)}
      style={width ? ({ '--column-width': width } as CSSProperties) : undefined}
    >
      {!readOnly && (
        <button
          aria-label="Drag to reorder column"
          className="absolute bottom-full left-1/2 z-10 flex h-5 -translate-x-1/2 translate-y-1/2 cursor-grab items-center justify-center rounded-md px-1.5 text-fg-muted opacity-0 hover:bg-surface-hover-bg hover:text-fg active:cursor-grabbing group-hover/column:opacity-100"
          contentEditable={false}
          data-plate-prevent-deselect
          ref={draggable.handleRef}
          title="Drag to reorder column"
          type="button"
        >
          <GripHorizontal className="size-4" />
        </button>
      )}
      {props.children}
      {dropLine && (
        <div
          className={cn(
            'absolute inset-y-0 z-20 w-0.5 bg-action-accent',
            dropLine === 'left' ? '-left-1' : '-right-1'
          )}
          contentEditable={false}
        />
      )}
    </PlateElement>
  );
}
