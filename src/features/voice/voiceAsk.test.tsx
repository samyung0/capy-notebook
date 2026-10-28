import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';

const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { askByVoice, useVoiceAsk } = await import('./voiceAsk');

function Chat({ onAsk }: { onAsk: (text: string) => void }) {
  useVoiceAsk(onAsk);
  return null;
}

it('hands a spoken question to Chat once: held until it opens, at once while it is open', () => {
  const onAsk = vi.fn();
  askByVoice('Asked before Chat opened');
  const root = createRoot(document.getElementById('root') as never);
  act(() => root.render(<Chat onAsk={onAsk} />));
  expect(onAsk.mock.calls).toEqual([['Asked before Chat opened']]);

  act(() => askByVoice('Asked on Chat'));
  expect(onAsk.mock.calls).toEqual([
    ['Asked before Chat opened'],
    ['Asked on Chat'],
  ]);

  // Opening Chat again hands nothing over twice.
  act(() => root.unmount());
  const again = createRoot(document.getElementById('root') as never);
  act(() => again.render(<Chat onAsk={onAsk} />));
  expect(onAsk).toHaveBeenCalledTimes(2);
  act(() => again.unmount());
});
