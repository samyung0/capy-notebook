/**
 * Block-level interactions, ported from plate-playground-template
 * (block-draggable.tsx + block-context-menu.tsx) with app styling:
 *
 * - drag handle: click selects the block (block selection), drag moves it,
 *   multi-block drags render a stacked preview;
 * - right-click: Plate's injected handler adds the block to the block
 *   selection, then the Radix context menu operates on that selection;
 * - blocks nested in columns (path length 3) and table cells (path length 4)
 *   get their own drag handles.
 */

import { AIChatPlugin } from '@platejs/ai/react';
import { DndPlugin, useDraggable, useDropLine } from '@platejs/dnd';
import { expandListItemsWithChildren } from '@platejs/list';
import {
  BLOCK_CONTEXT_MENU_ID,
  BlockMenuPlugin,
  BlockSelectionPlugin,
} from '@platejs/selection/react';
import { GripVertical } from 'lucide-react';
import { getPluginByType, isType, KEYS, type TElement } from 'platejs';
import {
  MemoizedChildren,
  type PlateEditor,
  type PlateElementProps,
  type RenderNodeWrapper,
  useEditorPlugin,
  useEditorRef,
  useElement,
  usePluginOption,
  useReadOnly,
  useSelected,
} from 'platejs/react';
import * as React from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/ContextMenu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { openAiMenu } from './ai/aiMenuState';
import { useEditorRuntime } from './EditorRuntime';
import { toggleEditorBlock } from './editorTransforms';

const UNDRAGGABLE_KEYS = [KEYS.column, KEYS.tr, KEYS.td, KEYS.th];

export const BlockDraggable: RenderNodeWrapper = (props) => {
  const { editor, element, path } = props;

  if (editor.dom.readOnly) return;

  const draggable =
    (path.length === 1 && !isType(editor, element, UNDRAGGABLE_KEYS)) ||
    // Blocks inside a column keep their own handle.
    (path.length === 3 &&
      !isType(editor, element, UNDRAGGABLE_KEYS) &&
      editor.api.some({
        at: path,
        match: { type: editor.getType(KEYS.column) },
      })) ||
    // Blocks inside a table cell keep their own handle.
    (path.length === 4 &&
      !isType(editor, element, UNDRAGGABLE_KEYS) &&
      editor.api.some({
        at: path,
        match: { type: editor.getType(KEYS.table) },
      }));

  if (!draggable) return;

  return (nextProps) => <DraggableBlock {...nextProps} />;
};

function DraggableBlock(props: PlateElementProps) {
  const { children, editor, element, path } = props;
  const blockSelectionApi = editor.getApi(BlockSelectionPlugin).blockSelection;

  const { isAboutToDrag, isDragging, nodeRef, previewRef, handleRef } =
    useDraggable({
      element,
      onDropHandler: (_, { dragItem }) => {
        const id = (dragItem as { id: string[] | string }).id;
        if (blockSelectionApi) blockSelectionApi.add(id);
        resetPreview();
      },
    });

  const isInColumn = path.length === 3;
  const isInTable = path.length === 4;

  const [previewTop, setPreviewTop] = React.useState(0);
  const [handleTop, setHandleTop] = React.useState(3);

  const resetPreview = () => {
    if (previewRef.current) {
      previewRef.current.replaceChildren();
      previewRef.current.classList.add('hidden');
    }
  };

  // Clear the stacked multi-block preview when a drag ends.
  React.useEffect(() => {
    if (!isDragging) resetPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging]);

  React.useEffect(() => {
    if (isAboutToDrag) previewRef.current?.classList.remove('opacity-0');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAboutToDrag]);

  return (
    <div
      className={cn(
        'relative',
        isDragging && 'opacity-50',
        getPluginByType(editor, element.type)?.node.isContainer
          ? 'group/container'
          : 'group'
      )}
      data-slot="block-wrapper"
      onMouseEnter={() => {
        if (isDragging) return;
        const block = editor.api.toDOMNode(element);
        if (!block) return;
        const marginTop =
          Number.parseFloat(window.getComputedStyle(block).marginTop) || 0;
        setHandleTop(marginTop + 3);
      }}
    >
      {!isInTable && (
        <Gutter>
          <div className={cn('flex h-[1.5em]', isInColumn && 'h-4')}>
            <div
              className={cn(
                'pointer-events-auto relative mr-1 flex w-4.5 items-center',
                isInColumn && 'mr-1.5'
              )}
            >
              <button
                aria-label={m.editor_drag_block()}
                className="absolute left-0 flex h-6 w-full cursor-grab items-center justify-center rounded-button p-0 text-fg-muted hover:bg-surface-hover-bg active:cursor-grabbing"
                contentEditable={false}
                data-plate-prevent-deselect
                ref={handleRef}
                style={{ top: `${handleTop}px` }}
                type="button"
              >
                <DragHandle
                  isDragging={isDragging}
                  previewRef={previewRef}
                  resetPreview={resetPreview}
                  setPreviewTop={setPreviewTop}
                />
              </button>
            </div>
          </div>
        </Gutter>
      )}

      <div
        className="absolute left-0 hidden w-full"
        contentEditable={false}
        ref={previewRef}
        style={{ top: `${-previewTop}px` }}
      />

      <div
        className="slate-blockWrapper flow-root"
        onContextMenu={(event) =>
          editor
            .getApi(BlockSelectionPlugin)
            .blockSelection.addOnContextMenu({ element, event })
        }
        ref={nodeRef}
      >
        <MemoizedChildren>{children}</MemoizedChildren>
        <DropLine />
      </div>
    </div>
  );
}

function Gutter({
  children,
  className,
  ...props
}: React.ComponentProps<'div'>) {
  const editor = useEditorRef();
  const element = useElement();
  const isSelectionAreaVisible = usePluginOption(
    BlockSelectionPlugin,
    'isSelectionAreaVisible'
  );
  const selected = useSelected();

  return (
    <div
      {...props}
      className={cn(
        'slate-gutterLeft',
        'absolute top-0 z-50 flex h-full -translate-x-full cursor-text hover:opacity-100 sm:opacity-0',
        getPluginByType(editor, element.type)?.node.isContainer
          ? 'group-hover/container:opacity-100'
          : 'group-hover:opacity-100',
        isSelectionAreaVisible && 'hidden',
        !selected && 'opacity-0',
        className
      )}
      contentEditable={false}
    >
      {children}
    </div>
  );
}

const DragHandle = React.memo(function DragHandle({
  isDragging,
  previewRef,
  resetPreview,
  setPreviewTop,
}: {
  isDragging: boolean;
  previewRef: React.RefObject<HTMLDivElement | null>;
  resetPreview: () => void;
  setPreviewTop: (top: number) => void;
}) {
  const editor = useEditorRef();
  const element = useElement();

  return (
    // Interaction surface only; the parent <button aria-label="Drag block">
    // is the accessible control (nested buttons are invalid).
    <div
      className="flex size-full items-center justify-center"
      data-plate-prevent-deselect
      onClick={(event) => {
        event.preventDefault();
        editor.getApi(BlockSelectionPlugin).blockSelection.focus();
      }}
      onMouseDown={(event) => {
        // The plugin's editor-level onMouseDown deselects on left click; its
        // data-plate-prevent-deselect escape hatch checks event.target.dataset
        // directly (no closest()), which is unreliable across nested markup.
        // Stopping propagation here is deterministic.
        event.stopPropagation();
        resetPreview();
        if ((event.button !== 0 && event.button !== 2) || event.shiftKey)
          return;

        const blockSelection = editor
          .getApi(BlockSelectionPlugin)
          .blockSelection.getNodes({ sort: true });

        let selectionNodes =
          blockSelection.length > 0
            ? blockSelection
            : editor.api.blocks({ mode: 'highest' });

        // If this block is not part of the selection, it becomes the selection.
        if (!selectionNodes.some(([node]) => node.id === element.id)) {
          selectionNodes = [[element, editor.api.findPath(element)!]];
        }

        const blocks = expandListItemsWithChildren(editor, selectionNodes).map(
          ([node]) => node
        );

        if (blockSelection.length === 0) {
          editor.tf.blur();
          editor.tf.collapse();
        }

        const elements = createDragPreviewElements(editor, blocks);
        previewRef.current?.append(...elements);
        previewRef.current?.classList.remove('hidden');
        previewRef.current?.classList.add('opacity-0');
        editor.setOption(DndPlugin, 'multiplePreviewRef', previewRef);

        editor
          .getApi(BlockSelectionPlugin)
          .blockSelection.set(blocks.map((block) => block.id as string));
      }}
      onMouseEnter={() => {
        if (isDragging) return;

        const blockSelection = editor
          .getApi(BlockSelectionPlugin)
          .blockSelection.getNodes({ sort: true });

        let selectedBlocks =
          blockSelection.length > 0
            ? blockSelection
            : editor.api.blocks({ mode: 'highest' });

        if (!selectedBlocks.some(([node]) => node.id === element.id)) {
          selectedBlocks = [[element, editor.api.findPath(element)!]];
        }

        const processedBlocks = expandListItemsWithChildren(
          editor,
          selectedBlocks
        );
        const ids = processedBlocks.map((block) => block[0].id as string);

        if (ids.length > 1 && ids.includes(element.id as string)) {
          setPreviewTop(
            calculatePreviewTop(editor, {
              blocks: processedBlocks.map((block) => block[0]),
              element,
            })
          );
        } else {
          setPreviewTop(0);
        }
      }}
      onMouseUp={() => {
        resetPreview();
      }}
    >
      <GripVertical className="pointer-events-none size-4" />
    </div>
  );
});

const DropLine = React.memo(function DropLine({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  const { dropLine } = useDropLine();

  if (!dropLine) return null;

  return (
    <div
      {...props}
      className={cn(
        'slate-dropLine',
        'absolute inset-x-0 h-0.5 bg-action-accent opacity-100 transition-opacity',
        dropLine === 'top' && '-top-px',
        dropLine === 'bottom' && '-bottom-px',
        className
      )}
    />
  );
});

/* ------------------------------------------------- multi-block drag preview */

function createDragPreviewElements(
  editor: PlateEditor,
  blocks: TElement[]
): HTMLElement[] {
  const elements: HTMLElement[] = [];
  const ids: string[] = [];

  // Cloned DOM must not be recognized as live Slate nodes.
  const removeDataAttributes = (element: HTMLElement) => {
    Array.from(element.attributes).forEach((attr) => {
      if (
        attr.name.startsWith('data-slate') ||
        attr.name.startsWith('data-block-id')
      ) {
        element.removeAttribute(attr.name);
      }
    });
    Array.from(element.children).forEach((child) => {
      removeDataAttributes(child as HTMLElement);
    });
  };

  blocks.forEach((node, index) => {
    const domNode = editor.api.toDOMNode(node);
    if (!domNode) return;
    const newDomNode = domNode.cloneNode(true) as HTMLElement;

    // Compensate horizontally scrolled blocks (wide tables/code) so the
    // preview shows the visible viewport of the block.
    const scrollLeft = domNode.scrollLeft;
    if (scrollLeft > 0) {
      const scrollWrapper = document.createElement('div');
      scrollWrapper.style.overflow = 'hidden';
      scrollWrapper.style.width = `${domNode.clientWidth}px`;
      const innerContainer = document.createElement('div');
      innerContainer.style.transform = `translateX(-${scrollLeft}px)`;
      innerContainer.style.width = `${domNode.scrollWidth}px`;
      while (newDomNode.firstChild)
        innerContainer.append(newDomNode.firstChild);
      const originalStyles = window.getComputedStyle(domNode);
      newDomNode.style.padding = '0';
      innerContainer.style.padding = originalStyles.padding;
      scrollWrapper.append(innerContainer);
      newDomNode.append(scrollWrapper);
    }

    ids.push(node.id as string);
    const wrapper = document.createElement('div');
    wrapper.append(newDomNode);
    wrapper.style.display = 'flow-root';

    const lastBlock = blocks[index - 1];
    if (lastBlock) {
      const lastDom = editor.api.toDOMNode(lastBlock)?.parentElement;
      const currentDom = domNode.parentElement;
      if (lastDom && currentDom) {
        const distance =
          currentDom.getBoundingClientRect().top -
          lastDom.getBoundingClientRect().bottom;
        if (distance > 15) wrapper.style.marginTop = `${distance}px`;
      }
    }

    removeDataAttributes(newDomNode);
    elements.push(wrapper);
  });

  editor.setOption(DndPlugin, 'draggingId', ids);

  return elements;
}

function calculatePreviewTop(
  editor: PlateEditor,
  { blocks, element }: { blocks: TElement[]; element: TElement }
): number {
  const child = editor.api.toDOMNode(element);
  const editable = editor.api.toDOMNode(editor);
  const firstDomNode = editor.api.toDOMNode(blocks[0]);
  if (!child || !editable || !firstDomNode) return 0;

  const editorPaddingTop = Number(
    window.getComputedStyle(editable).paddingTop.replace('px', '')
  );
  const firstNodeToEditorDistance =
    firstDomNode.getBoundingClientRect().top -
    editable.getBoundingClientRect().top -
    editorPaddingTop;
  const marginTop = Number(
    window.getComputedStyle(firstDomNode).marginTop.replace('px', '')
  );
  const currentToEditorDistance =
    child.getBoundingClientRect().top -
    editable.getBoundingClientRect().top -
    editorPaddingTop;
  const currentMarginTop = Number(
    window.getComputedStyle(child).marginTop.replace('px', '')
  );

  return (
    currentToEditorDistance -
    firstNodeToEditorDistance +
    marginTop -
    currentMarginTop
  );
}

/* ---------------------------------------------------------- context menu */

const TURN_INTO_OPTIONS: Array<[string, () => string]> = [
  [KEYS.p, () => m.editor_block_paragraph()],
  [KEYS.h1, () => m.editor_heading_1()],
  [KEYS.h2, () => m.editor_heading_2()],
  [KEYS.h3, () => m.editor_heading_3()],
  [KEYS.blockquote, () => m.editor_blockquote()],
  [KEYS.codeBlock, () => m.editor_code_block()],
];

function useIsTouchDevice() {
  const [isTouch] = React.useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: coarse)').matches
  );
  return isTouch;
}

export function BlockContextMenu({ children }: { children: React.ReactNode }) {
  const { api, editor } = useEditorPlugin(BlockMenuPlugin);
  const readOnly = useReadOnly();
  const { allowExternalAssets } = useEditorRuntime();
  const isTouch = useIsTouchDevice();
  const [askAiPending, setAskAiPending] = React.useState(false);
  const openId = usePluginOption(BlockMenuPlugin, 'openId');
  const isOpen = openId === BLOCK_CONTEXT_MENU_ID;

  if (isTouch) {
    return children;
  }

  const turnInto = (type: string) => {
    editor
      .getApi(BlockSelectionPlugin)
      .blockSelection.getNodes()
      .forEach(([, path]) => {
        editor.tf.select(path);
        toggleEditorBlock(editor, type);
      });
    editor.getApi(BlockSelectionPlugin).blockSelection.focus();
  };

  const align = (value: 'center' | 'left' | 'right') => {
    editor
      .getTransforms(BlockSelectionPlugin)
      .blockSelection.setNodes({ align: value });
  };

  return (
    <ContextMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) api.blockMenu.hide();
      }}
    >
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          const target = event.target as HTMLElement;
          const dataset = target.dataset;
          const disabled =
            dataset?.slateEditor === 'true' ||
            readOnly ||
            dataset?.plateOpenContextMenu === 'false' ||
            !!target.closest(
              'input, textarea, [data-plate-open-context-menu="false"]'
            );

          if (disabled) return event.preventDefault();

          if (allowExternalAssets) {
            editor.getApi(AIChatPlugin).aiChat.hide({ focus: false });
          }
          setTimeout(() => {
            api.blockMenu.show(BLOCK_CONTEXT_MENU_ID, {
              x: event.clientX,
              y: event.clientY,
            });
          }, 0);
        }}
      >
        <div className="w-full">{children}</div>
      </ContextMenuTrigger>
      {isOpen && (
        <ContextMenuContent
          className="w-60"
          data-plate-prevent-deselect
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (askAiPending) {
              setAskAiPending(false);
              openAiMenu(editor, { selectCurrentBlock: true });
              return;
            }
            editor.getApi(BlockSelectionPlugin).blockSelection.focus();
          }}
        >
          <ContextMenuGroup>
            {allowExternalAssets && (
              <ContextMenuItem onClick={() => setAskAiPending(true)}>
                {m.editor_ask_ai()}
              </ContextMenuItem>
            )}
            <ContextMenuItem
              onClick={() => {
                editor
                  .getTransforms(BlockSelectionPlugin)
                  .blockSelection.removeNodes();
                editor.tf.focus();
              }}
            >
              {m.action_delete()}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                editor
                  .getTransforms(BlockSelectionPlugin)
                  .blockSelection.duplicate();
              }}
            >
              {m.editor_duplicate()}
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                {m.editor_turn_into()}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-48">
                {TURN_INTO_OPTIONS.map(([type, label]) => (
                  <ContextMenuItem key={type} onClick={() => turnInto(type)}>
                    {label()}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem
              onClick={() =>
                editor
                  .getTransforms(BlockSelectionPlugin)
                  .blockSelection.setIndent(1)
              }
            >
              {m.editor_indent()}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() =>
                editor
                  .getTransforms(BlockSelectionPlugin)
                  .blockSelection.setIndent(-1)
              }
            >
              {m.editor_outdent()}
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>{m.editor_align()}</ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-48">
                <ContextMenuItem onClick={() => align('left')}>
                  {m.editor_align_left()}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => align('center')}>
                  {m.editor_align_center()}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => align('right')}>
                  {m.editor_align_right()}
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuGroup>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
