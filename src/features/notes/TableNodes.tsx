import { useDraggable, useDropLine } from '@platejs/dnd';
import { ResizeHandle } from '@platejs/resizable';
import { getTableColumnCount } from '@platejs/table';
import {
  TablePlugin,
  TableProvider,
  useTableCellElement,
  useTableCellElementResizable,
  useTableColSizes,
  useTableElement,
  useTableMergeState,
  useTableSelectionDom,
} from '@platejs/table/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Combine,
  GripVertical,
  Trash2,
  Ungroup,
  X,
} from 'lucide-react';
import { PathApi, type TTableCellElement, type TTableElement } from 'platejs';
import {
  PlateElement,
  type PlateElementProps,
  useComposedRef,
  useEditorPlugin,
  useEditorRef,
  useEditorSelector,
  useFocusedLast,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import { useMemo, useRef } from 'react';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/Popover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { FloatingActionButton } from './nodeComponents';
import {
  TABLE_CLASS,
  TABLE_WRAP_CLASS,
  TD_CLASS,
  TH_CLASS,
} from './nodeStyles';

const DEFAULT_COLUMN_WIDTH = 120;
const DEFAULT_ROW_HEIGHT = 48;
const TABLE_GRIP_COLUMN_WIDTH = 8;

export function TableElement(props: PlateElementProps) {
  return (
    <TableProvider>
      <TableElementContent {...props} />
    </TableProvider>
  );
}

function TableElementContent({ children, ...props }: PlateElementProps) {
  const readOnly = useReadOnly();
  const tableRef = useRef<HTMLTableElement>(null);
  const { marginLeft, props: tableProps } = useTableElement();
  const colSizes = useTableColSizes();
  const resolvedColSizes = useMemo(() => {
    const columnCount = getTableColumnCount(props.element as TTableElement);
    return Array.from(
      { length: columnCount },
      (_, index) => colSizes[index] || DEFAULT_COLUMN_WIDTH
    );
  }, [colSizes, props.element]);
  const tableWidth =
    resolvedColSizes.reduce((total, width) => total + width, 0) +
    (readOnly ? 0 : TABLE_GRIP_COLUMN_WIDTH);

  useTableSelectionDom(tableRef);

  const content = (
    <PlateElement
      {...props}
      as="div"
      className={TABLE_WRAP_CLASS}
      style={{
        ...props.style,
        paddingLeft: marginLeft,
      }}
    >
      <table
        {...tableProps}
        className={cn(
          TABLE_CLASS,
          'table-fixed data-[table-selecting=true]:[&_*::selection]:bg-transparent'
        )}
        ref={tableRef}
        style={{ width: tableWidth }}
      >
        <colgroup>
          {!readOnly && <col style={{ width: TABLE_GRIP_COLUMN_WIDTH }} />}
          {resolvedColSizes.map((width, index) => (
            <col key={index} style={{ width }} />
          ))}
        </colgroup>
        <tbody>{children}</tbody>
      </table>
    </PlateElement>
  );

  if (readOnly) return content;

  return <TableFloatingToolbar>{content}</TableFloatingToolbar>;
}

function TableFloatingToolbar({ children }: { children: React.ReactElement }) {
  const selected = useSelected();
  const focused = useFocusedLast();
  const collapsedInside = useEditorSelector(
    (editor) => selected && editor.api.isCollapsed(),
    [selected]
  );
  const selectedCellCount = useEditorSelector(
    (editor) =>
      editor.getApi(TablePlugin).table.getSelectedCellIds()?.length ?? 0,
    []
  );
  const open = focused && (collapsedInside || selectedCellCount > 1);

  return (
    <Popover modal={false} open={open}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      {open && (
        <TableFloatingToolbarContent multiCell={selectedCellCount > 1} />
      )}
    </Popover>
  );
}

function TableFloatingToolbarContent({ multiCell }: { multiCell: boolean }) {
  const { editor, tf } = useEditorPlugin(TablePlugin);
  const { canMerge, canSplit } = useTableMergeState();
  const action = (run: () => void) => {
    run();
    editor.tf.focus();
  };

  if (multiCell && !canMerge && !canSplit) return null;

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
      {canMerge && (
        <FloatingActionButton
          label={m.editor_merge_cells()}
          onClick={() => action(() => tf.table.merge())}
        >
          <Combine />
        </FloatingActionButton>
      )}
      {canSplit && (
        <FloatingActionButton
          label={m.editor_split_cell()}
          onClick={() => action(() => tf.table.split())}
        >
          <Ungroup />
        </FloatingActionButton>
      )}

      {!multiCell && (
        <>
          {(canMerge || canSplit) && <TableActionSeparator />}
          <FloatingActionButton
            label={m.editor_insert_row_before()}
            onClick={() => action(() => tf.insert.tableRow({ before: true }))}
          >
            <ArrowUp />
          </FloatingActionButton>
          <FloatingActionButton
            label={m.editor_insert_row_after()}
            onClick={() => action(() => tf.insert.tableRow())}
          >
            <ArrowDown />
          </FloatingActionButton>
          <FloatingActionButton
            label={m.editor_delete_row()}
            onClick={() => action(() => tf.remove.tableRow())}
          >
            <X />
          </FloatingActionButton>
          <TableActionSeparator />
          <FloatingActionButton
            label={m.editor_insert_col_before()}
            onClick={() =>
              action(() => tf.insert.tableColumn({ before: true }))
            }
          >
            <ArrowLeft />
          </FloatingActionButton>
          <FloatingActionButton
            label={m.editor_insert_col_after()}
            onClick={() => action(() => tf.insert.tableColumn())}
          >
            <ArrowRight />
          </FloatingActionButton>
          <FloatingActionButton
            label={m.editor_delete_col()}
            onClick={() => action(() => tf.remove.tableColumn())}
          >
            <X />
          </FloatingActionButton>
          <TableActionSeparator />
          <FloatingActionButton
            label={m.editor_delete_table()}
            onClick={() => action(() => tf.remove.table())}
          >
            <Trash2 />
          </FloatingActionButton>
        </>
      )}
    </PopoverContent>
  );
}

function TableActionSeparator() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-divider" />;
}

export function TableRowElement({ children, ...props }: PlateElementProps) {
  const editor = useEditorRef();
  const readOnly = useReadOnly();
  const { element } = props;
  const draggable = useDraggable({
    canDropNode: ({ dragEntry, dropEntry }) =>
      PathApi.equals(
        PathApi.parent(dragEntry[1]),
        PathApi.parent(dropEntry[1])
      ),
    element,
    type: element.type,
    // onDropHandler: (_, { dragItem }) => {
    //   const draggedElement = (dragItem as { element?: TElement }).element;
    //   if (draggedElement) editor.tf.select(draggedElement);
    // },
  });
  const { dropLine } = useDropLine();

  return (
    <PlateElement
      {...props}
      as="tr"
      className={cn(
        'group/row',
        draggable.isDragging && 'opacity-45',
        dropLine === 'top' &&
          '[&>td]:border-t-2! [&>td]:border-t-action-accent! [&>th]:border-t-2! [&>th]:border-t-action-accent!',
        dropLine === 'bottom' &&
          '[&>td]:border-b-2! [&>td]:border-b-action-accent! [&>th]:border-b-2! [&>th]:border-b-action-accent!'
      )}
      ref={useComposedRef(props.ref, draggable.previewRef, draggable.nodeRef)}
    >
      {!readOnly && (
        <td
          className="w-2 min-w-2 max-w-2 select-none p-0"
          contentEditable={false}
        >
          <button
            aria-label={m.editor_drag_row()}
            className="absolute top-1/2 left-0 z-40 flex size-5 -translate-y-1/2 cursor-grab items-center justify-center rounded-button border border-line bg-surface text-fg-muted opacity-0 shadow-sm outline-none transition-opacity hover:bg-surface-hover-bg hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus active:cursor-grabbing group-hover/row:opacity-100"
            contentEditable={false}
            data-plate-prevent-deselect
            onClick={() => editor.tf.select(element)}
            ref={draggable.handleRef}
            title={m.editor_drag_row()}
            type="button"
          >
            <GripVertical className="size-3.5" />
          </button>
        </td>
      )}
      {children}
    </PlateElement>
  );
}

export function TableCellElement({
  isHeader = false,
  ...props
}: PlateElementProps & { isHeader?: boolean }) {
  const { api } = useEditorPlugin(TablePlugin);
  const readOnly = useReadOnly();
  const element = props.element as TTableCellElement;
  const { colIndex, colSpan, minHeight, rowIndex } = useTableCellElement();
  const { rightProps } = useTableCellElementResizable({
    colIndex,
    colSpan,
    rowIndex,
  });
  const rowSpan = api.table.getRowSpan(element);

  return (
    <PlateElement
      {...props}
      as={isHeader ? 'th' : 'td'}
      attributes={{
        ...props.attributes,
        colSpan,
        'data-table-cell-id': element.id,
        rowSpan,
      }}
      className={cn(
        isHeader ? TH_CLASS : TD_CLASS,
        'relative p-0 data-[table-cell-selected=true]:bg-tint-accent-1'
      )}
    >
      <div
        className="box-border min-h-12 px-3 py-2"
        style={{ minHeight: Math.max(DEFAULT_ROW_HEIGHT, minHeight ?? 0) }}
      >
        {props.children}
      </div>
      {!readOnly && (
        <ResizeHandle
          {...rightProps}
          className="group/column-resize absolute -top-px -right-1 z-30 h-[calc(100%+2px)] w-2 cursor-col-resize touch-none select-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-action-accent after:opacity-0 after:transition-opacity hover:after:opacity-100"
          contentEditable={false}
        />
      )}
    </PlateElement>
  );
}

export function TableCellHeaderElement(props: PlateElementProps) {
  return <TableCellElement {...props} isHeader />;
}
