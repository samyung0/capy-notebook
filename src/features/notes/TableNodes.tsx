import { useDraggable, useDropLine } from '@platejs/dnd';
import { ResizeHandle } from '@platejs/resizable';
import { BlockSelectionPlugin } from '@platejs/selection/react';
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
  KEYS,
  PathApi,
  type TElement,
  type TTableCellElement,
  type TTableElement,
} from 'platejs';
import {
  type PlateEditor,
  PlateElement,
  type PlateElementProps,
  useComposedRef,
  useEditorPlugin,
  useEditorRef,
  useEditorSelector,
  useElement,
  useFocusedLast,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import { createContext, useContext, useMemo, useRef, useState } from 'react';
import { FloatingBlockToolbar } from '@/components/ui/BlockToolbar';
import {
  DropdownMenu,
  DropdownMenuAnchor,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from '@/components/ui/DropdownMenu';
import type { IconName } from '@/components/ui/Icon';
import { Popover, PopoverAnchor } from '@/components/ui/Popover';
import { isTableSize } from '@/features/materials/document';
import { tableColumnWidths } from '@/features/materials/tableColumns';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { BLOCK_MENU_CONTENT, BlockMenuItem } from './BlockInteractions';
import { useEditorScrollArea } from './editorScrollArea';
import { FloatingActionButton } from './nodeComponents';
import {
  TABLE_CLASS,
  TABLE_WRAP_CLASS,
  TD_CLASS,
  TH_CLASS,
} from './nodeStyles';

const DEFAULT_ROW_HEIGHT = 48;
const TABLE_GRIP_COLUMN_WIDTH = 8;

/** Every cell of the row is a header cell. */
function isHeaderRow(editor: PlateEditor, row: TElement) {
  const header = editor.getType(KEYS.th);
  return (
    row.children.length > 0 &&
    row.children.every((cell) => (cell as TElement).type === header)
  );
}

/** Turns a row's cells into header cells or plain ones. */
function setRowKind(
  editor: PlateEditor,
  path: number[],
  kind: typeof KEYS.td | typeof KEYS.th
) {
  const row = editor.api.node<TElement>(path)?.[0];
  if (!row) return;
  const type = editor.getType(kind);
  editor.tf.withoutNormalizing(() => {
    row.children.forEach((_, index) => {
      editor.tf.setNodes({ type }, { at: [...path, index] });
    });
  });
}

/** The column the pointer is over, whose pill shows above the first row. */
const HoveredColumn = createContext<number | null>(null);

/** A row's or column's hover pill (Epo 2026-11-10, mock T2): a press opens its
 * menu beside it. Stays shown while its menu is open. */
function TableHandle({
  children,
  className,
  handleRef,
  icon,
  label,
  side,
}: {
  children: React.ReactNode;
  className: string;
  /** The row pill also drags its row. */
  handleRef?: React.Ref<HTMLButtonElement>;
  icon: IconName;
  label: string;
  side: 'bottom' | 'right';
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuAnchor asChild>
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={label}
          className={cn(
            'absolute z-40 flex items-center justify-center rounded-full border border-line bg-surface text-fg-muted opacity-0 outline-none transition-opacity hover:bg-surface-hover-bg hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-action',
            open && 'opacity-100',
            className
          )}
          contentEditable={false}
          data-plate-prevent-deselect
          onClick={() => setOpen(true)}
          ref={handleRef}
          title={label}
          type="button"
        >
          <EditorIcon className="size-3.5" name={icon} />
        </button>
      </DropdownMenuAnchor>
      {open && (
        <DropdownMenuContent
          align="start"
          className={BLOCK_MENU_CONTENT}
          data-plate-prevent-deselect
          onCloseAutoFocus={(event) => event.preventDefault()}
          side={side}
          sideOffset={4}
        >
          {children}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

export function TableElement(props: PlateElementProps) {
  return (
    <TableProvider>
      <TableElementContent {...props} />
    </TableProvider>
  );
}

function TableElementContent({ children, ...props }: PlateElementProps) {
  const readOnly = useReadOnly();
  const { tf } = useEditorPlugin(TablePlugin);
  const editor = useEditorRef();
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const { marginLeft, props: tableProps } = useTableElement();
  const colSizes = useTableColSizes();
  const resolvedColSizes = useMemo(
    () => tableColumnWidths(props.element as TTableElement, colSizes),
    [colSizes, props.element]
  );
  const tableWidth =
    resolvedColSizes.reduce((total, width) => total + width, 0) +
    (readOnly ? 0 : TABLE_GRIP_COLUMN_WIDTH);

  useTableSelectionDom(tableRef);

  const table = (
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
  );
  const wrapStyle = {
    ...props.style,
    paddingLeft: isTableSize(marginLeft) ? marginLeft : undefined,
  };

  if (readOnly)
    return (
      <PlateElement
        {...props}
        as="div"
        className={TABLE_WRAP_CLASS}
        style={wrapStyle}
      >
        {table}
      </PlateElement>
    );

  // A line or column at the table's end, from its + bars (mock T2).
  const add = (run: (path: number[]) => void) => {
    const path = editor.api.findPath(props.element);
    if (!path) return;
    run(path);
    editor.tf.focus();
  };
  return (
    <TableFloatingToolbar>
      <PlateElement
        {...props}
        as="div"
        className={TABLE_WRAP_CLASS}
        style={wrapStyle}
      >
        <HoveredColumn.Provider value={hoveredColumn}>
          {/* The table's own box, for its + bars: one along the right edge
           * and one under the last row, shown while the pointer or the caret
           * is in the table. */}
          <div
            className="group/table relative w-fit pr-5"
            onMouseLeave={() => setHoveredColumn(null)}
            onMouseOver={(event) => {
              const cell = (event.target as Element).closest?.(
                '[data-table-column]'
              );
              const column = cell?.getAttribute('data-table-column');
              if (column != null) setHoveredColumn(Number(column));
            }}
          >
            {table}
            <button
              aria-label={m.editor_insert_col_after()}
              className="absolute top-0 right-0 bottom-0 flex w-4 items-center justify-center rounded-(--radius-toolbar-button) bg-surface-hover-bg text-fg-muted opacity-0 outline-none transition-opacity hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-action group-focus-within/table:opacity-100 group-hover/table:opacity-100"
              contentEditable={false}
              data-plate-prevent-deselect
              onClick={() =>
                add((path) => {
                  const row = props.element.children[0] as TElement;
                  tf.insert.tableColumn({
                    fromCell: [...path, 0, row.children.length - 1],
                  });
                })
              }
              title={m.editor_insert_col_after()}
              type="button"
            >
              <EditorIcon className="size-3.5" name="plus" />
            </button>
            <button
              aria-label={m.editor_insert_row_after()}
              className="absolute top-full right-5 left-2 mt-0.5 flex h-4 items-center justify-center rounded-(--radius-toolbar-button) bg-surface-hover-bg text-fg-muted opacity-0 outline-none transition-opacity hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-action group-focus-within/table:opacity-100 group-hover/table:opacity-100"
              contentEditable={false}
              data-plate-prevent-deselect
              onClick={() => add((path) => tf.insert.tableRow({ at: path }))}
              title={m.editor_insert_row_after()}
              type="button"
            >
              <EditorIcon className="size-3.5" name="plus" />
            </button>
          </div>
        </HoveredColumn.Provider>
      </PlateElement>
    </TableFloatingToolbar>
  );
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
  const scrollArea = useEditorScrollArea();

  return (
    <Popover modal={false} open={open}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <FloatingBlockToolbar
        className="empty:hidden"
        collisionBoundary={scrollArea}
        open={open}
      >
        <TableFloatingToolbarContent multiCell={selectedCellCount > 1} />
      </FloatingBlockToolbar>
    </Popover>
  );
}

function TableFloatingToolbarContent({ multiCell }: { multiCell: boolean }) {
  const { editor, tf } = useEditorPlugin(TablePlugin);
  const { canMerge, canSplit } = useTableMergeState();
  const table = useElement<TTableElement>();
  const action = (run: () => void) => {
    run();
    editor.tf.focus();
  };

  if (multiCell && !canMerge && !canSplit) return null;

  const first = table.children[0] as TElement | undefined;
  const header = !!first && isHeaderRow(editor, first);
  // The first row, as a header or back: its cells change kind.
  const toggleHeader = () => {
    const path = editor.api.findPath(table);
    if (path) setRowKind(editor, [...path, 0], header ? KEYS.td : KEYS.th);
  };

  // Rows and columns are added and removed from their own pills and + bars
  // (Epo 2026-11-10, mock T2); the bar acts on the table.
  return (
    <>
      {canMerge && (
        <FloatingActionButton
          label={m.editor_merge_cells()}
          onClick={() => action(() => tf.table.merge())}
        >
          <EditorIcon name="combine" />
        </FloatingActionButton>
      )}
      {canSplit && (
        <FloatingActionButton
          label={m.editor_split_cell()}
          onClick={() => action(() => tf.table.split())}
        >
          <EditorIcon name="ungroup" />
        </FloatingActionButton>
      )}
      {!multiCell && (
        <>
          <FloatingActionButton
            active={header}
            className="w-auto gap-1.5 px-1.5"
            label={m.question_ui_header_row()}
            onClick={() => action(toggleHeader)}
          >
            <EditorIcon name="table" />
            {m.question_ui_header_row()}
          </FloatingActionButton>
          <FloatingActionButton
            label={m.editor_duplicate()}
            onClick={() => {
              const blocks = editor.getApi(BlockSelectionPlugin).blockSelection;
              blocks.set([table.id as string]);
              editor
                .getTransforms(BlockSelectionPlugin)
                .blockSelection.duplicate();
            }}
          >
            <EditorIcon name="clone" />
          </FloatingActionButton>
          <FloatingActionButton
            label={m.editor_delete_table()}
            onClick={() => action(() => tf.remove.table())}
            variant="danger-light"
          >
            <EditorIcon name="trash" />
          </FloatingActionButton>
        </>
      )}
    </>
  );
}

export function TableRowElement({ children, ...props }: PlateElementProps) {
  const editor = useEditorRef();
  const { tf } = useEditorPlugin(TablePlugin);
  const readOnly = useReadOnly();
  const { element } = props;
  // A row menu's action, on this row, with the note focused after it.
  const row = (run: (path: number[]) => void) => {
    const path = editor.api.findPath(element);
    if (!path) return;
    run(path);
    editor.tf.focus();
  };
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
          {/* The row's pill: a drag moves the row, a press opens its menu. */}
          <TableHandle
            className="top-1/2 left-0 h-7 w-4 -translate-y-1/2 cursor-grab active:cursor-grabbing group-focus-within/row:opacity-100 group-hover/row:opacity-100"
            handleRef={draggable.handleRef}
            icon="moreVertical"
            label={m.editor_drag_row()}
            side="right"
          >
            <BlockMenuItem
              icon="arrowUp"
              label={m.editor_insert_row_before()}
              onSelect={() =>
                row((path) => {
                  // Over a header row, the new row is the header (a table's
                  // header is its first row, Epo 2026-11-10).
                  const header =
                    path.at(-1) === 0 && isHeaderRow(editor, element);
                  tf.insert.tableRow({ before: true, fromRow: path, header });
                  if (header) setRowKind(editor, PathApi.next(path), KEYS.td);
                })
              }
            />
            <BlockMenuItem
              icon="arrowDown"
              label={m.editor_insert_row_after()}
              onSelect={() =>
                row((path) => tf.insert.tableRow({ fromRow: path }))
              }
            />
            <DropdownMenuSeparator />
            <BlockMenuItem
              icon="trash"
              label={m.editor_delete_row()}
              onSelect={() =>
                row((path) => {
                  const header =
                    path.at(-1) === 0 && isHeaderRow(editor, element);
                  editor.tf.select(editor.api.start([...path, 0]));
                  tf.remove.tableRow();
                  // The next row takes a deleted header's place.
                  if (header && editor.api.node(path))
                    setRowKind(editor, path, KEYS.th);
                })
              }
            />
          </TableHandle>
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
  const { api, editor, tf } = useEditorPlugin(TablePlugin);
  const readOnly = useReadOnly();
  const element = props.element as TTableCellElement;
  const { colIndex, colSpan, minHeight, rowIndex } = useTableCellElement();
  const hoveredColumn = useContext(HoveredColumn);
  // A column menu's action, on this cell's column.
  const column = (run: (path: number[]) => void) => {
    const path = editor.api.findPath(element);
    if (!path) return;
    run(path);
    editor.tf.focus();
  };
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
        'data-table-column': colIndex,
        rowSpan,
      }}
      className={cn(
        isHeader ? TH_CLASS : TD_CLASS,
        'relative p-0 data-[table-cell-selected=true]:bg-tint-accent-1 sm:p-0'
      )}
    >
      <div
        className="box-border min-h-12 px-2 py-1.5 sm:px-3 sm:py-2"
        style={{ minHeight: Math.max(DEFAULT_ROW_HEIGHT, minHeight ?? 0) }}
      >
        {props.children}
      </div>
      {/* The column's pill, over the first row's cell while the pointer is in
       * its column or the caret is in the table. */}
      {!readOnly && rowIndex === 0 && (
        <TableHandle
          className={cn(
            '-top-2 left-1/2 h-4 w-7 -translate-x-1/2 group-focus-within/table:opacity-100',
            hoveredColumn === colIndex && 'opacity-100'
          )}
          icon="moreHorizontal"
          label={m.editor_column()}
          side="bottom"
        >
          <BlockMenuItem
            icon="arrowLeft"
            label={m.editor_insert_col_before()}
            onSelect={() =>
              column((path) =>
                tf.insert.tableColumn({ before: true, fromCell: path })
              )
            }
          />
          <BlockMenuItem
            icon="arrowRight"
            label={m.editor_insert_col_after()}
            onSelect={() =>
              column((path) => tf.insert.tableColumn({ fromCell: path }))
            }
          />
          <DropdownMenuSeparator />
          <BlockMenuItem
            icon="trash"
            label={m.editor_delete_col()}
            onSelect={() =>
              column((path) => {
                editor.tf.select(editor.api.start(path));
                tf.remove.tableColumn();
              })
            }
          />
        </TableHandle>
      )}
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
