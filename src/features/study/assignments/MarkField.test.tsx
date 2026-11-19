import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, {
  document,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
});
// React reads `oninput` on the document to know input events exist.
Object.assign(document, { oninput: null });

const { createRoot } = await import('react-dom/client');
const { MarkField } = await import('./MarkField');

const type = async (value: string) => {
  const host = document.createElement('div');
  document.body.append(host);
  const onChange = vi.fn();
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MarkField label="Mark" marks={2} onChange={onChange} value={null} />
    )
  );
  const field = host.querySelector('input') as HTMLInputElement;
  const proto = (
    window as unknown as { HTMLInputElement: { prototype: object } }
  ).HTMLInputElement.prototype;
  await act(async () => {
    // Past React's own value tracker, as typing would be.
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  return { field, host, onChange, root };
};

// Epo 2026-11-18: marks are typed, one decimal place at most, and the field
// refuses anything else rather than explaining it.
it('takes a mark with one decimal place', async () => {
  const { onChange, root } = await type('0.6');
  expect(onChange).toHaveBeenLastCalledWith(0.6);
  act(() => root.unmount());
});

it('refuses a second decimal place and a mark above the marks', async () => {
  for (const refused of ['0.65', '3']) {
    const { field, onChange, root } = await type(refused);
    expect(onChange).not.toHaveBeenCalled();
    expect(field.value).toBe('');
    act(() => root.unmount());
  }
});
