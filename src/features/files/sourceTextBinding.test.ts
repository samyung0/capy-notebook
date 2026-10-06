import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyTextEdit,
  applyTextInput,
  beginTextComposition,
  type InputStart,
  SOURCE_TEXT_INPUT,
  sourceLines,
  type TextEdit,
  textareaEdit,
} from './sourceTextBinding';

function sourceDoc(value: string) {
  const doc = new Y.Doc();
  const text = doc.getText('source');
  text.insert(0, value);
  return { doc, text };
}

/** What a textarea holds and does for one input, as the browser leaves it:
 * `value` with LF newlines, the caret after the edit. */
function textarea(value: string, caret: number) {
  return { selectionStart: caret, textLength: value.length, value };
}

const input = (inputType: string, data: string | null = null) =>
  ({ data, inputType }) as InputEvent;

/** The browser's edit of the display text, then the binding's. */
function typeInto(
  text: Y.Text,
  before: InputStart,
  event: InputEvent,
  after: string,
  caret: number
): TextEdit | null {
  const edit = textareaEdit(event, before, textarea(after, caret));
  if (edit) applyTextEdit(text, edit, sourceLines(text.toString()));
  return edit;
}

describe('textarea edits in O(edit)', () => {
  it('takes typing, paste, Enter, Backspace, Delete and cut from the selection and caret', () => {
    const { text } = sourceDoc('alpha beta');
    expect(
      typeInto(
        text,
        { end: 5, length: null, start: 5 },
        input('insertText', '!'),
        'alpha! beta',
        6
      )
    ).toEqual({ end: 5, insert: '!', start: 5 });
    expect(text.toString()).toBe('alpha! beta');
    // A paste over a selection; the textarea folds its CRLF to LF.
    typeInto(
      text,
      { end: 11, length: null, start: 7 },
      input('insertFromPaste', 'one\r\ntwo'),
      'alpha! one\ntwo',
      14
    );
    expect(text.toString()).toBe('alpha! one\ntwo');
    typeInto(
      text,
      { end: 0, length: null, start: 0 },
      input('insertLineBreak'),
      '\nalpha! one\ntwo',
      1
    );
    expect(text.toString()).toBe('\nalpha! one\ntwo');
    // Backspace at 7 takes the "!"; the caret says where the deletion began.
    typeInto(
      text,
      { end: 7, length: null, start: 7 },
      input('deleteContentBackward'),
      '\nalpha one\ntwo',
      6
    );
    expect(text.toString()).toBe('\nalpha one\ntwo');
    // Delete at 0: only the length says how much went.
    typeInto(
      text,
      { end: 0, length: 14, start: 0 },
      input('deleteContentForward'),
      'alpha one\ntwo',
      0
    );
    expect(text.toString()).toBe('alpha one\ntwo');
    typeInto(
      text,
      { end: 9, length: null, start: 5 },
      input('deleteByCut'),
      'alpha\ntwo',
      5
    );
    expect(text.toString()).toBe('alpha\ntwo');
  });

  it('keeps surrogate pairs whole', () => {
    const { text } = sourceDoc('a😀b');
    typeInto(
      text,
      { end: 3, length: null, start: 3 },
      input('deleteContentBackward'),
      'ab',
      1
    );
    expect(text.toString()).toBe('ab');
    typeInto(
      text,
      { end: 1, length: null, start: 1 },
      input('insertText', '👍🏽'),
      'a👍🏽b',
      5
    );
    expect(text.toString()).toBe('a👍🏽b');
    typeInto(
      text,
      { end: 1, length: 6, start: 1 },
      input('deleteContentForward'),
      'ab',
      1
    );
    expect(text.toString()).toBe('ab');
  });

  it('leaves input it cannot place to the whole-text diff', () => {
    const before = { end: 2, length: null, start: 2 };
    // Undo from the context menu, a drop, a transposition: the change is not
    // at the caret.
    for (const kind of ['historyUndo', 'insertFromDrop', 'insertTranspose'])
      expect(textareaEdit(input(kind), before, textarea('ab', 2))).toBeNull();
    // Inserted text that does not end at the caret.
    expect(
      textareaEdit(input('insertText', 'x'), before, textarea('abxx', 4))
    ).toBeNull();
  });

  it('preserves CRLF source bytes when a textarea supplies LF offsets', () => {
    const { doc, text } = sourceDoc('a\r\nb\r\nc');
    typeInto(
      text,
      { end: 3, length: null, start: 3 },
      input('insertText', '!'),
      'a\nb!\nc',
      4
    );
    expect(text.toString()).toBe('a\r\nb!\r\nc');
    typeInto(
      text,
      { end: 6, length: null, start: 6 },
      input('insertLineBreak'),
      'a\nb!\nc\n',
      7
    );
    expect(text.toString()).toBe('a\r\nb!\r\nc\r\n');
    // Backspace over a line break takes the whole CRLF.
    typeInto(
      text,
      { end: 2, length: null, start: 2 },
      input('deleteContentBackward'),
      'ab!\nc\n',
      1
    );
    expect(text.toString()).toBe('ab!\r\nc\r\n');
    // The whole-text diff keeps them too.
    applyTextInput(text, 'ab!\nc\nd', sourceLines(text.toString()));
    expect(text.toString()).toBe('ab!\r\nc\r\nd');
    doc.destroy();
  });

  it('adds LF lines to a source without CR, and CR lines to a CR source', () => {
    const plain = sourceDoc('one');
    applyTextEdit(
      plain.text,
      { end: 3, insert: '\ntwo', start: 3 },
      sourceLines('one')
    );
    expect(plain.text.toString()).toBe('one\ntwo');
    const old = sourceDoc('one\rtwo');
    applyTextEdit(
      old.text,
      { end: 7, insert: '\nthree', start: 7 },
      sourceLines('one\rtwo')
    );
    expect(old.text.toString()).toBe('one\rtwo\rthree');
  });
});

describe('IME composition', () => {
  it('merges the composed text with concurrent remote edits and undoes only authored changes', () => {
    const { doc, text } = sourceDoc('alpha beta');
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const undo = new Y.UndoManager(text, {
      trackedOrigins: new Set([SOURCE_TEXT_INPUT]),
    });
    const composition = beginTextComposition(text, 6, 6, sourceLines('x'));
    // Peers edit before and after the composition while it runs.
    remote.getText('source').insert(10, '!');
    remote.getText('source').insert(0, '> ');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), 'remote');
    composition.commit('日本語 ');
    expect(text.toString()).toBe('> alpha 日本語 beta!');
    undo.undo();
    expect(text.toString()).toBe('> alpha beta!');
    undo.destroy();
    doc.destroy();
    remote.destroy();
  });

  it('replaces the selection it started on, even after a peer edited inside it', () => {
    const { doc, text } = sourceDoc('one two three');
    const composition = beginTextComposition(text, 4, 7, sourceLines('x'));
    text.insert(5, 'X', 'remote');
    expect(composition.commit('二')).toBe(5);
    expect(text.toString()).toBe('one 二 three');
    doc.destroy();
  });

  it('merges an IME that rewrote text off the caret around a peer edit made meanwhile', () => {
    const { doc, text } = sourceDoc('one two three');
    const lines = sourceLines('x');
    // No peer edit: the whole value's difference from the live text.
    const quiet = beginTextComposition(text, 7, 7, lines);
    expect(quiet.rewrite('one 2 three')).toBeNull();
    expect(quiet.missed).toBe(false);
    expect(text.toString()).toBe('one 2 three');
    // A peer appends while composing (the editor calls `peerEdit` before
    // each transaction not its own); the textarea never saw it.
    const busy = beginTextComposition(text, 5, 5, lines);
    busy.peerEdit();
    text.insert(11, '!', 'remote');
    expect(busy.missed).toBe(true);
    expect(busy.rewrite('one two three')).toBeNull();
    expect(text.toString()).toBe('one two three!');
    doc.destroy();
  });

  it('composes into a CRLF source in source offsets', () => {
    const { doc, text } = sourceDoc('a\r\nb');
    const composition = beginTextComposition(
      text,
      2,
      2,
      sourceLines(text.toString())
    );
    composition.commit('漢\n字');
    expect(text.toString()).toBe('a\r\n漢\r\n字b');
    doc.destroy();
  });
});
