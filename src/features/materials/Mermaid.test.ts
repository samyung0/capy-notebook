import { expect, it } from 'vitest';
import { renderMermaid, SUPERSEDED } from './Mermaid';

// REVIEW4 S2: a queued render whose source changed again before its turn
// does not run (it used to run and drop its result), so a live source draws
// only its latest text.
it('skips a render that is no longer wanted when its turn comes', async () => {
  let wanted = true;
  const render = renderMermaid(
    'graph TD\n  A --> B',
    undefined,
    undefined,
    () => wanted
  );
  wanted = false;
  await expect(render).rejects.toBe(SUPERSEDED);
});
