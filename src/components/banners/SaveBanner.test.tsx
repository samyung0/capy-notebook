import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { DeletedDownload, SaveBanner } from './SaveBanner';

it('shows the outdated strip as one row, Reload in the close button’s place', () => {
  const html = renderToStaticMarkup(<SaveBanner state="outdated" />);
  expect(html).toContain('data-kind="outdated"');
  expect(html).toContain(m.editor_outdated());
  expect(html).toContain(`>${m.error_action_reload()}</button>`);
  expect(html).not.toContain(m.action_close());
});

// Epo 2026-11-20: the deleted strip downloads what the page shows, beside
// its Reload.
it('offers Download beside Reload on the deleted strip its page downloads from', () => {
  const html = renderToStaticMarkup(
    <DeletedDownload.Provider value={() => undefined}>
      <SaveBanner onReload={() => undefined} state="deleted" />
    </DeletedDownload.Provider>
  );
  expect(html).toContain(m.editor_deleted_strip());
  expect(html).toContain(`>${m.action_download()}</button><button`);
  expect(html).toContain(`>${m.error_action_reload()}</button>`);
});
