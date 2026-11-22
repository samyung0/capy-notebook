import { YjsEditor } from '@slate-yjs/core';
import { createPlatePlugin } from 'platejs/react';
import { useNoteEditorPrefs } from '../noteEditorPrefs';
import { TABLE_VIEW_TYPE } from '../tableView/model';
import { TableViewElement } from '../tableView/TableViewElement';
import { toastBlockCap, withinBlockCaps } from './countCaps';
import {
  FlashcardBackElement,
  FlashcardElement,
  FlashcardFrontElement,
  FlashcardsElement,
  HtmlEmbedElement,
  MaterialRefElement,
  MermaidCaptionElement,
  MermaidElement,
  QuizElement,
  QuizQuestionElement,
  VisualBlockElement,
} from './elements';
import { fixMermaidSelection, stampMermaidTheme } from './mermaidBlock';
import {
  FLASHCARDS_KEY,
  MATERIAL_REF_KEY,
  MERMAID_KEY,
  QUIZ_KEY,
} from './shared';

export const QuizElementPlugin = createPlatePlugin({
  key: QUIZ_KEY,
  node: { isElement: true, type: QUIZ_KEY },
}).withComponent(QuizElement);

export const QuizQuestionPlugin = createPlatePlugin({
  key: 'quiz_question',
  node: { isElement: true, isVoid: true, type: 'quiz_question' },
}).withComponent(QuizQuestionElement);

export const FlashcardsElementPlugin = createPlatePlugin({
  key: FLASHCARDS_KEY,
  node: { isElement: true, type: FLASHCARDS_KEY },
}).withComponent(FlashcardsElement);

export const FlashcardPlugin = createPlatePlugin({
  key: 'flashcard',
  node: { isElement: true, type: 'flashcard' },
}).withComponent(FlashcardElement);

export const FlashcardFrontPlugin = createPlatePlugin({
  key: 'flashcard_front',
  node: { isElement: true, type: 'flashcard_front' },
}).withComponent(FlashcardFrontElement);

export const FlashcardBackPlugin = createPlatePlugin({
  key: 'flashcard_back',
  node: { isElement: true, type: 'flashcard_back' },
}).withComponent(FlashcardBackElement);

export const MermaidElementPlugin = createPlatePlugin({
  key: MERMAID_KEY,
  node: { isElement: true, isVoid: true, type: MERMAID_KEY },
})
  .overrideEditor(({ editor, tf: { apply } }) => ({
    transforms: {
      apply(operation) {
        // Remote Yjs operations arrive already stamped by their creator.
        const local =
          !YjsEditor.isYjsEditor(editor) || YjsEditor.isLocal(editor);
        apply(
          fixMermaidSelection(
            editor,
            local
              ? stampMermaidTheme(
                  operation,
                  useNoteEditorPrefs.getState().mermaidTheme
                )
              : operation
          )
        );
      },
    },
  }))
  .withComponent(MermaidElement);

export const MermaidCaptionPlugin = createPlatePlugin({
  key: 'mermaid_caption',
  node: { isElement: true, type: 'mermaid_caption' },
}).withComponent(MermaidCaptionElement);

export const MaterialRefPlugin = createPlatePlugin({
  key: MATERIAL_REF_KEY,
  node: { isElement: true, isVoid: true, type: MATERIAL_REF_KEY },
})
  .overrideEditor(({ editor, tf: { normalizeNode } }) => ({
    transforms: {
      normalizeNode([node, path]) {
        // A reference pasted inside a container is lifted until it is a
        // top-level block, the only place the document contract allows it.
        if (
          'type' in node &&
          node.type === MATERIAL_REF_KEY &&
          path.length > 1
        ) {
          editor.tf.liftNodes({ at: path });
          return;
        }
        normalizeNode([node, path]);
      },
    },
  }))
  .withComponent(MaterialRefElement);

/** A note's table view: a top-level void (one nested by a paste is lifted
 * out). */
export const TableViewPlugin = createPlatePlugin({
  key: TABLE_VIEW_TYPE,
  node: { isElement: true, isVoid: true, type: TABLE_VIEW_TYPE },
})
  .overrideEditor(({ editor, tf: { normalizeNode } }) => ({
    transforms: {
      normalizeNode([node, path]) {
        if (
          'type' in node &&
          node.type === TABLE_VIEW_TYPE &&
          path.length > 1
        ) {
          editor.tf.liftNodes({ at: path });
          return;
        }
        normalizeNode([node, path]);
      },
    },
  }))
  .withComponent(TableViewElement);

/** Block Duplicate and paste stop at a note's caps of table views and
 * interactive blocks (`withinBlockCaps`), as the slash command does. */
export const BlockCountCapsPlugin = createPlatePlugin({
  key: 'blockCountCaps',
}).overrideEditor(({ editor, tf: { insertFragment, insertNodes } }) => ({
  transforms: {
    insertFragment(fragment, options) {
      const kept = withinBlockCaps(editor.children, fragment);
      for (const type of kept.dropped) toastBlockCap(type);
      insertFragment(kept.nodes, options);
    },
    insertNodes(nodes, options) {
      const kept = withinBlockCaps(
        editor.children,
        Array.isArray(nodes) ? nodes : [nodes]
      );
      for (const type of kept.dropped) toastBlockCap(type);
      if (kept.nodes.length) insertNodes(kept.nodes, options);
    },
  },
}));

export const customBlockPlugins = [
  // Top-level voids: one nested by a paste is lifted out.
  ...(
    [
      ['chart', VisualBlockElement],
      ['plot', VisualBlockElement],
      ['graph', VisualBlockElement],
      ['html_embed', HtmlEmbedElement],
    ] as const
  ).map(([key, component]) =>
    createPlatePlugin({
      key,
      node: { isElement: true, isVoid: true, type: key },
    })
      .overrideEditor(({ editor, tf: { normalizeNode } }) => ({
        transforms: {
          normalizeNode([node, path]) {
            if ('type' in node && node.type === key && path.length > 1) {
              editor.tf.liftNodes({ at: path });
              return;
            }
            normalizeNode([node, path]);
          },
        },
      }))
      .withComponent(component)
  ),
  TableViewPlugin,
  BlockCountCapsPlugin,
  MaterialRefPlugin,
  QuizElementPlugin,
  QuizQuestionPlugin,
  FlashcardsElementPlugin,
  FlashcardPlugin,
  FlashcardFrontPlugin,
  FlashcardBackPlugin,
  MermaidElementPlugin,
  MermaidCaptionPlugin,
];
