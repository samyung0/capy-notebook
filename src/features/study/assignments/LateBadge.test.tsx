import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { LateBadge } from './LateBadge';

it('reads the penalty in the warning badge, or Late with none', () => {
  const late = renderToStaticMarkup(<LateBadge penaltyPct={20} />);
  expect(late).toContain(m.assignment_late_penalty({ percent: 20 }));
  expect(late).toContain('bg-tint-warning');
  expect(renderToStaticMarkup(<LateBadge penaltyPct={0} />)).toContain(
    `>${m.assignment_late()}<`
  );
});
