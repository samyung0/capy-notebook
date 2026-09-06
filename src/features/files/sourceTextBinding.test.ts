import { expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyTextInput,
  beginTextComposition,
  SOURCE_TEXT_INPUT,
} from './sourceTextBinding';

it('merges IME text with concurrent remote edits and undoes only authored changes', () => {
  const doc = new Y.Doc();
  const text = doc.getText('source');
  text.insert(0, 'alpha beta');
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
  const undo = new Y.UndoManager(text, {
    trackedOrigins: new Set([SOURCE_TEXT_INPUT]),
  });
  const composition = beginTextComposition(doc);
  applyTextInput(composition.text, 'alpha 日本語 beta');
  remote.getText('source').insert(10, '!');
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), 'remote');
  composition.commit();
  expect(text.toString()).toBe('alpha 日本語 beta!');
  undo.undo();
  expect(text.toString()).toBe('alpha beta!');
  composition.destroy();
  undo.destroy();
  doc.destroy();
  remote.destroy();
});
it('preserves CRLF source bytes when a textarea supplies LF offsets', () => {
  const doc = new Y.Doc();
  const text = doc.getText('source');
  text.insert(0, 'a\r\nb\r\nc');
  applyTextInput(text, 'a\nb!\nc');
  expect(text.toString()).toBe('a\r\nb!\r\nc');
  applyTextInput(text, 'a\nb!\nc\nd');
  expect(text.toString()).toBe('a\r\nb!\r\nc\r\nd');
  doc.destroy();
});
