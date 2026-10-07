import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { PublicNav } from './PublicHeader';

it('offers theme, sign-in and sign-up to every visitor, with no return path', () => {
  const html = renderToStaticMarkup(
    <ThemeProvider>
      <PublicNav />
    </ThemeProvider>
  );
  expect(html).toContain('Switch to dark theme');
  expect(html).toContain('href="/sign-in"');
  expect(html).toContain('href="/sign-up"');
});
