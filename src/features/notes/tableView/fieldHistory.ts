/* The table view's fields undo only their own typing. A field's native undo
   shares the page's one undo stack with the note's contenteditable, so a
   Cmd+Z past the field's own edits would undo the note's last typing
   underneath it (and slate-react runs editor.undo() on the historyUndo that
   follows). A field may undo while its text differs from the text it had
   when it took the focus, and redo after an undo until it is typed in; a
   shortcut otherwise does nothing. React events reach the block's wrapper
   from the portaled popovers and dialog too. */

type Field = HTMLInputElement | HTMLTextAreaElement;
type Held = { redo: number; start: string };

const held = new WeakMap<Field, Held>();

const isField = (target: EventTarget): target is Field =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

/** A field takes the focus: its text now is where its undo stops. */
export function startFieldHistory(event: React.FocusEvent) {
  const { target } = event;
  if (isField(target)) held.set(target, { redo: 0, start: target.value });
}

/** An input event in a field: an undo makes a redo; typing clears them. */
export function countFieldInput(event: React.FormEvent) {
  const { target } = event;
  if (!isField(target)) return;
  const field = held.get(target) ?? { redo: 0, start: '' };
  const type = (event.nativeEvent as InputEvent).inputType;
  const redo =
    type === 'historyUndo'
      ? field.redo + 1
      : type === 'historyRedo'
        ? field.redo - 1
        : 0;
  held.set(target, { ...field, redo });
}

/** Holds back Undo or Redo in a field with nothing of its own left. */
export function holdFieldHistory(event: React.KeyboardEvent) {
  const { target } = event;
  if (!(isField(target) && (event.metaKey || event.ctrlKey))) return;
  const key = event.key.toLowerCase();
  const redo = (key === 'z' && event.shiftKey) || key === 'y';
  if (!(redo || key === 'z')) return;
  const field = held.get(target);
  const room = redo
    ? (field?.redo ?? 0) > 0
    : field !== undefined && target.value !== field.start;
  if (!room) event.preventDefault();
}
