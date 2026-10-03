import { DRAWN_ICON_NAMES, TOOLBAR_ICON_NAMES } from '@betteroffice/xlsx-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { XLSX_ICONS, xlsxIcons } from './xlsxIcons';

it('maps every icon xlsx-react draws to a Capy icon, at most 16px', () => {
  const names = [...TOOLBAR_ICON_NAMES, ...DRAWN_ICON_NAMES];
  expect(Object.keys(XLSX_ICONS).sort()).toEqual([...names].sort());
  for (const name of names) {
    const Icon = xlsxIcons[name];
    expect(renderToStaticMarkup(<Icon size={20} />)).toContain('width="16"');
  }
});
