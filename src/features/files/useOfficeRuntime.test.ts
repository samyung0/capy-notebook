import { describe, expect, it } from 'vitest';
import { keepsFocus } from './useOfficeRuntime';

// Capy's vitest has no DOM, so these elements are outside any dialog or menu
// (`closest` finds nothing); the e2e checks an open menu.
function element(
  tagName: string,
  {
    editable = false,
    shadowFocus,
  }: { editable?: boolean; shadowFocus?: Element } = {}
): Element {
  return {
    closest: () => null,
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

  it('is not a button, a shadow host without a typing field, nor the page', () => {
    expect(keepsFocus(element('BUTTON'))).toBe(false);
    expect(
      keepsFocus(element('MATH-FIELD', { shadowFocus: element('BUTTON') }))
    ).toBe(false);
    expect(keepsFocus(element('BODY'))).toBe(false);
    expect(keepsFocus(null)).toBe(false);
  });
});
