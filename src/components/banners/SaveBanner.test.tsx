import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { SaveBanner } from './SaveBanner';

it('shows the outdated strip as one row, Reload in the close button’s place', () => {
  const html = renderToStaticMarkup(<SaveBanner state="outdated" />);
  expect(html).toContain('data-kind="outdated"');
  expect(html).toContain(m.editor_outdated());
  expect(html).toContain(`>${m.error_action_reload()}</button>`);
  expect(html).not.toContain(m.action_close());
});
