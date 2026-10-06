import { describe, expect, it } from 'vitest';
import { keepsFocus } from './useOfficeRuntime';

/** An element as `keepsFocus` reads it: its tag, editability, shadow focus and enclosing role. */
function element(
  tagName: string,
  {
    role,
    editable = false,
    shadowFocus,
  }: { role?: string; editable?: boolean; shadowFocus?: Element } = {}
): Element {
  return {
    closest: (selectors: string) =>
      role && selectors.split(',').includes(`[role=${role}]`) ? {} : null,
    isContentEditable: editable,
    shadowRoot: shadowFocus ? { activeElement: shadowFocus } : null,
    tagName,
  } as unknown as Element;
}

describe('the focus a newly opened DOCX leaves alone', () => {
  it('is a field taking typing, also behind a shadow root', () => {
    expect(keepsFocus(element('TEXTAREA'))).toBe(true);
    expect(keepsFocus(element('INPUT'))).toBe(true);
    expect(keepsFocus(element('DIV', { editable: true }))).toBe(true);
    const sink = element('SPAN', { editable: true });
    expect(keepsFocus(element('MATH-FIELD', { shadowFocus: sink }))).toBe(true);
  });

  it('is anything in an open dialog, alert dialog or menu', () => {
    for (const role of ['dialog', 'alertdialog', 'menu'])
      expect(keepsFocus(element('BUTTON', { role }))).toBe(true);
  });

  it('is not a button elsewhere, such as the Edit toggle, nor the page', () => {
    expect(keepsFocus(element('BUTTON'))).toBe(false);
    expect(keepsFocus(element('A', { role: 'navigation' }))).toBe(false);
    expect(keepsFocus(element('BODY'))).toBe(false);
    expect(keepsFocus(null)).toBe(false);
  });
});
