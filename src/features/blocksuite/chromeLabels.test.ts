import { tr } from '@blocksuite/affine/shared/utils';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import './chromeLabels';

// BlockSuite's bars and menus ask for each English label through `tr`
// (vendor README local change 37); the table answers in the app's language.
it("gives BlockSuite's labels the app's messages", () => {
  expect(tr('Turn into')).toBe(m.editor_turn_into());
  expect(tr('Bring to Front')).toBe(m.chrome_bring_to_front());
  expect(tr('Clear row contents')).toBe(m.chrome_clear_row_contents());
});

it('leaves a label it does not know as written', () => {
  expect(tr('Frame section')).toBe('Frame section');
});
