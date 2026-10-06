import { DRAWN_ICON_NAMES, TOOLBAR_ICON_NAMES } from '@betteroffice/xlsx-react';
import { expect, it } from 'vitest';
import { XLSX_ICONS } from './xlsxIcons';

it('maps every icon xlsx-react draws to a Capy icon', () => {
  const names = [...TOOLBAR_ICON_NAMES, ...DRAWN_ICON_NAMES];
  expect(Object.keys(XLSX_ICONS).sort()).toEqual([...names].sort());
});
