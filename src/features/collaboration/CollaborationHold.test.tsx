import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/Dialog';
import { PopupMotion } from '@/components/ui/PopupMotion';
import { CollaborationHold, EditorHoldScope } from './CollaborationHold';
import { setHeld } from './held';
import { UndoButtons } from './LiveItemControls';

// The server renderer draws no portal; the dialog's content renders in place.
vi.mock('radix-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('radix-ui')>();
  return {
    ...actual,
    Dialog: {
      ...actual.Dialog,
      Portal: ({ children }: { children: React.ReactNode }) => children,
    },
  };
});

const holder = {};
afterEach(() => setHeld(holder, false));

const undo = {
  canRedo: () => true,
  canUndo: () => true,
  redo: () => {},
  subscribe: () => () => {},
  undo: () => {},
};

// Security regression (rate-limit review r3 S1/S7): while the tab holds back
// its collaboration messages nothing that edits takes input.
describe('a tab holding back its collaboration messages', () => {
  it('makes the editor inert and busy', () => {
    const wrapped = <CollaborationHold>editor</CollaborationHold>;
    expect(renderToStaticMarkup(wrapped)).not.toContain('inert');
    setHeld(holder, true);
    const html = renderToStaticMarkup(wrapped);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('inert=""');
  });

  it("makes an editor's portalled dialogs and floating menus inert", () => {
    setHeld(holder, true);
    const overlays = (
      <>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Insert</DialogTitle>
          </DialogContent>
        </Dialog>
        <PopupMotion open>menu</PopupMotion>
      </>
    );
    const inside = renderToStaticMarkup(
      <EditorHoldScope>{overlays}</EditorHoldScope>
    );
    expect(inside.match(/inert=""/g)).toHaveLength(2);
    // Outside an editor they stay usable.
    expect(renderToStaticMarkup(overlays)).not.toContain('inert');
  });

  it('disables the undo buttons that portal into the page header', () => {
    expect(
      renderToStaticMarkup(<UndoButtons header manager={undo} />)
    ).not.toContain('disabled=""');
    setHeld(holder, true);
    const html = renderToStaticMarkup(<UndoButtons header manager={undo} />);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
