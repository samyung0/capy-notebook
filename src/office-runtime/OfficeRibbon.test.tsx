import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { RibbonBanner } from './OfficeRibbon';

const strip = (inline: boolean) =>
  renderToStaticMarkup(
    <RibbonBanner
      banner={{
        actions: [{ label: 'Reload' }],
        closeable: true,
        inline,
        message: 'Paused',
        tone: 'neutral',
      }}
      onAction={() => {}}
    />
  );

it("takes the close button's place with an inline strip's actions only, as FileBanner", () => {
  const close = `aria-label="${m.action_close()}"`;
  expect(strip(false)).toContain(close);
  expect(strip(true)).not.toContain(close);
});
