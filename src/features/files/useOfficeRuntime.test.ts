import { describe, expect, it, vi } from 'vitest';
import { keepsFocus, openRequestedPresenter } from './useOfficeRuntime';

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

// Security regression (pptx-presenter REVIEW-1 nit): the sandboxed runtime
// asks Capy to open the presenter window; Capy opens one only for a command
// its menus mark `popup: 'presenter'`, never for any other id.
describe('a presenter window the frame asks for', () => {
  const item = (id: string, popup?: 'presenter') => ({
    edits: false,
    id,
    kind: 'item' as const,
    label: id,
    popup,
  });
  const menus = {
    actions: [],
    menus: [
      {
        id: 'view',
        items: [
          item('view.presenterView', 'presenter'),
          item('view.speakerNotes'),
        ],
        label: 'View',
      },
    ],
  };

  it('opens for the presenter command', () => {
    const open = vi.fn();
    openRequestedPresenter(menus, 'view.presenterView', open);
    expect(open).toHaveBeenCalledWith('view.presenterView');
  });

  it('opens for no other id, and for nothing before the menus arrive', () => {
    const open = vi.fn();
    for (const id of ['view.speakerNotes', 'https://evil.example', ''])
      openRequestedPresenter(menus, id, open);
    openRequestedPresenter(null, 'view.presenterView', open);
    expect(open).not.toHaveBeenCalled();
  });
});
