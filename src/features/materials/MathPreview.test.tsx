import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { inertTex } from './inertTex';
import { MathPreview } from './MathPreview';
import { loadedMathLive } from './mathLive';

/* A formula that is not being edited draws MathLive's static markup in its
   host's shadow root, labelled with its spoken text (Epo 2026-11-27, Q912);
   one with an empty template slot keeps a read-only field, which draws the
   slot's box (Q915). */

const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
Object.assign(globalThis, {
  customElements: window.customElements,
  document,
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
});

// Loaded already, as for every formula after the first. Node gets MathLive's
// server bundle, which has no field: a stand-in that speaks a fixed text.
vi.mock('./mathLive', async () => {
  function MathfieldElement() {
    const field = document.createElement('math-field');
    return Object.assign(field, { getValue: () => 'field speech' });
  }
  const loaded = {
    mathlive: { ...(await import('mathlive')), MathfieldElement },
    sheet: {},
  };
  return {
    loadedMathLive: () => loaded,
    loadMathLive: async () => loaded,
    loadMathLiveModule: async () => loaded.mathlive,
  };
});
// MathLive's browser bundle defines it; its spoken text reads the settings.
vi.stubGlobal('MathfieldElement', { textToSpeechRules: 'mathlive' });

async function render(tex: string, displayMode = false) {
  // react-dom/client reads the document once, as it loads.
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () =>
    createRoot(container).render(
      <MathPreview displayMode={displayMode} tex={tex} />
    )
  );
  const host = container.querySelector('[data-math-preview]');
  return { host, markup: host?.shadowRoot?.innerHTML ?? '' };
}

it('draws an inline formula as static markup labelled with its spoken text', async () => {
  const { host, markup } = await render(String.raw`x^2+\frac{a}{b}`);
  expect(host?.getAttribute('role')).toBe('math');
  expect(host?.getAttribute('aria-label')).toContain('squared');
  expect(host?.getAttribute('aria-label')).toContain('over');
  expect(markup).toContain('<span class="ML__latex">');
});

it('draws \\dots as an ellipsis and a display formula in its scrolling box', async () => {
  const { host, markup } = await render(String.raw`x_1,\dots,x_n`, true);
  expect(markup).toContain('…');
  expect(host?.className).toContain('scroll-fade-x');
});

// Security: the markup goes into the shadow root without a sanitizer, so the
// source passes inertTex and markup that trips the tripwire shows as its TeX.
it('draws MathLive from inert TeX and shows tripping markup as its TeX in text', async () => {
  const loaded = loadedMathLive();
  if (!loaded) throw new Error('MathLive mock not loaded');
  const convert = vi
    .spyOn(loaded.mathlive, 'convertLatexToMarkup')
    .mockReturnValue('<span class="ML__latex" onclick="alert(1)">x</span>');
  const tex = String.raw`\href{https://example.com}{x}`;
  try {
    const { host } = await render(tex);
    expect(inertTex(tex)).not.toBe(tex);
    expect(convert).toHaveBeenCalledWith(`\\textstyle ${inertTex(tex)}`);
    expect(host?.shadowRoot?.querySelector('*')).toBeNull();
    expect(host?.shadowRoot?.firstChild?.nodeValue).toBe(tex);
  } finally {
    convert.mockRestore();
  }
});

it('draws a formula with an empty template slot in a read-only field', async () => {
  const tex = String.raw`\frac{\placeholder{}}{\placeholder{}}`;
  const { host } = await render(tex);
  const field = host?.querySelector('math-field');
  expect(field).toHaveProperty('readOnly', true);
  expect(field?.getAttribute('value')).toBe(tex);
  expect(host?.getAttribute('aria-label')).toBe('field speech');
});
