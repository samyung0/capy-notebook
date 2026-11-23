import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it } from 'vitest';
import type { HeldStrip } from '@/features/collaboration/roomProvider';

// As FileBanner.test: the document react-dom/client reads.
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
const { createRoot } = await import('react-dom/client');
const { useHeldEdits } = await import('./useHeldEdits');

let seen: ReturnType<typeof useHeldEdits> | null = null;
function Probe({ swapping }: { swapping: boolean }) {
  seen = useHeldEdits(swapping);
  return null;
}

// Round 4, finding 3: a room swap clears the note's held edits, as the
// paused editor never reports that its room let them go, so no `unsynced`
// strip is left over the next editor. Fails with the strip kept.
it('clears the held edits when the editor swaps rooms', async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(<Probe swapping={false} />));
  const held: HeldStrip = {
    discard: () => {},
    retry: () => {},
    retrying: false,
  };
  await act(async () => seen?.[1](held));
  expect(seen?.[0]).toBe(held);
  await act(async () => root.render(<Probe swapping />));
  expect(seen?.[0]).toBeNull();
  await act(async () => root.unmount());
});
