import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AdvancedSection } from './AdvancedSection';

const render = (open: boolean) =>
  renderToStaticMarkup(
    <AdvancedSection onToggle={() => {}} open={open}>
      <span>Inside</span>
    </AdvancedSection>
  );

it('keeps its panel mounted and inert while closed, so it animates both ways', () => {
  const closed = render(false);
  expect(closed).toContain('aria-expanded="false"');
  expect(closed).toContain('data-open="false"');
  expect(closed).toContain('inert');
  expect(closed).toContain('Inside');
  expect(closed).toContain('-rotate-90');
});

it('opens with the app accordion recipe', () => {
  const open = render(true);
  expect(open).toContain('aria-expanded="true"');
  expect(open).toContain('motion-accordion');
  expect(open).toContain('data-open="true"');
  expect(open).not.toContain('inert');
  expect(open).not.toContain('-rotate-90');
});
