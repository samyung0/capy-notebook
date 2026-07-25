import { AIChatPlugin } from '@platejs/ai/react';
import {
  BlockMenuPlugin,
  BlockSelectionPlugin,
} from '@platejs/selection/react';
import type { PlateEditor } from 'platejs/react';

export function openAiMenu(
  editor: PlateEditor,
  { selectCurrentBlock = false }: { selectCurrentBlock?: boolean } = {}
) {
  const blockSelection = editor.getApi(BlockSelectionPlugin).blockSelection;
  if (
    selectCurrentBlock &&
    !editor.getOption(BlockSelectionPlugin, 'isSelectingSome')
  ) {
    const block = editor.api.block({ highest: true });
    const blockId = block?.[0].id;
    if (typeof blockId === 'string') blockSelection.set(blockId);
  }

  const selection = editor.getOption(BlockSelectionPlugin, 'isSelectingSome')
    ? null
    : editor.selection
      ? structuredClone(editor.selection)
      : null;

  editor.getApi(BlockMenuPlugin).blockMenu.hide();
  editor.getApi(AIChatPlugin).aiChat.show();
  editor.setOption(AIChatPlugin, 'chatSelection', selection);
}
