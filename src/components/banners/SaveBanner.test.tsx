import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { DeletedDownload, SaveBanner } from './SaveBanner';

const BUTTON = /<button[^>]*>[^<]*<\/button>/;
const DISABLED = / disabled=""/;

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

// Epo 2026-11-23: the refused (the size limit's too, Q827 A), changed and
// expired strips offer the deleted strip's Discard and Download in place of
// Reload, the page's own Download first. Fails with Reload kept, or with
// Download missing or out of order.
it('offers Discard then the page’s dark Download on every recovery strip', () => {
  for (const state of [
    'refused',
    'refused-size',
    'changed',
    'expired',
  ] as const) {
    const html = renderToStaticMarkup(
      <DeletedDownload.Provider value={null}>
        <SaveBanner
          onDiscard={() => undefined}
          onDownload={() => undefined}
          state={state}
        />
      </DeletedDownload.Provider>
    );
    expect(buttons(html)).toEqual([
      { label: m.action_discard(), underlined: false, variant: 'ghost-hover' },
      { label: m.action_download(), underlined: false, variant: 'dark' },
    ]);
    expect(html).not.toContain(m.error_action_reload());
    expect(html).not.toContain(m.action_close());
  }
  const alone = renderToStaticMarkup(
    <SaveBanner onDiscard={() => undefined} state="refused" />
  );
  expect(buttons(alone).map(({ label }) => label)).toEqual([
    m.action_discard(),
  ]);
});

// Epo 2026-11-21: the deleted strip's Discard (ghost-hover) comes before its
// Download (dark), neither underlined.
it('offers Discard then a dark Download on the deleted strip its page downloads from', () => {
  const html = renderToStaticMarkup(
    <DeletedDownload.Provider value={() => undefined}>
      <SaveBanner onDiscard={() => undefined} state="deleted" />
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
    <SaveBanner onDiscard={() => undefined} state="deleted" />
  );
  expect(buttons(html)).toEqual([
    { label: m.action_discard(), underlined: false, variant: 'ghost-hover' },
  ]);
});

// Epo 2026-11-23: a group dropped as late shows the save strip in the error
// tone with the deleted strip's Discard, then Retry filled as recovery's
// Download, no Download even where the page has one, and no close. Fails
// with a Download, without Discard, or with an underlined Retry.
it('offers Discard then a dark Retry on the unsynced strip, which cannot be closed', () => {
  const html = renderToStaticMarkup(
    <DeletedDownload.Provider value={() => undefined}>
      <SaveBanner
        onDiscard={() => undefined}
        onDownload={() => undefined}
        onRetry={() => undefined}
        state="unsynced"
      />
    </DeletedDownload.Provider>
  );
  expect(html).toContain(m.editor_late_unloaded().replace("'", '&#x27;'));
  expect(html).toContain('role="alert"');
  expect(buttons(html)).toEqual([
    { label: m.action_discard(), underlined: false, variant: 'ghost-hover' },
    { label: m.error_action_retry(), underlined: false, variant: 'dark' },
  ]);
  expect(html).not.toContain(m.action_close());
});

// Round 4, finding 4: while a Retry's join is pending, the strip's Retry is
// disabled, so a second click does nothing. Fails with Retry clickable then.
it('disables the unsynced strip’s Retry while its join is pending', () => {
  const retry = (retrying: boolean) =>
    renderToStaticMarkup(
      <SaveBanner
        onRetry={() => undefined}
        retrying={retrying}
        state="unsynced"
      />
    ).match(BUTTON)?.[0];
  // The attribute, not the class's `disabled:` styles.
  expect(retry(true)).toMatch(DISABLED);
  expect(retry(false)).not.toMatch(DISABLED);
});
