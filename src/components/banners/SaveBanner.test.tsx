import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { DeletedDownload, SaveBanner } from './SaveBanner';

/** The strip's buttons in order: label, Button variant, underlined. */
const buttons = (html: string) =>
  [
    ...html.matchAll(
      /<button class="([^"]*)"[^>]*data-variant="([^"]+)"[^>]*>([^<]*)<\/button>/g
    ),
  ].map(([, className, variant, label]) => ({
    label,
    underlined: className.split(' ').includes('underline'),
    variant,
  }));

it('shows the outdated strip as one row, Reload in the close button’s place', () => {
  const html = renderToStaticMarkup(<SaveBanner state="outdated" />);
  expect(html).toContain('data-kind="outdated"');
  expect(html).toContain(m.editor_outdated());
  expect(html).toContain(`>${m.error_action_reload()}</button>`);
  expect(html).not.toContain(m.action_close());
});

it('keeps the underlined Reload on a refused strip', () => {
  const html = renderToStaticMarkup(
    <SaveBanner onReload={() => undefined} state="refused" />
  );
  expect(buttons(html)).toEqual([
    { label: m.error_action_reload(), underlined: true, variant: 'ghost' },
  ]);
});

// Epo 2026-11-21: the deleted strip's Discard (ghost-hover) comes before its
// Download (dark), neither underlined.
it('offers Discard then a dark Download on the deleted strip its page downloads from', () => {
  const html = renderToStaticMarkup(
    <DeletedDownload.Provider value={() => undefined}>
      <SaveBanner onReload={() => undefined} state="deleted" />
    </DeletedDownload.Provider>
  );
  expect(html).toContain(m.editor_deleted_strip());
  expect(buttons(html)).toEqual([
    { label: m.action_discard(), underlined: false, variant: 'ghost-hover' },
    { label: m.action_download(), underlined: false, variant: 'dark' },
  ]);
});

it('offers Discard alone on a deleted strip with no Download', () => {
  const html = renderToStaticMarkup(
    <SaveBanner onReload={() => undefined} state="deleted" />
  );
  expect(buttons(html)).toEqual([
    { label: m.action_discard(), underlined: false, variant: 'ghost-hover' },
  ]);
});
