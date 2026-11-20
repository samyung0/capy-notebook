import * as Y from 'yjs';

/** Whether a canvas's synced room holds what its first state wrote: one page
 * with one canvas in it (the server seeds both; a tab never makes them). A
 * room without them cannot be opened. */
export function holdsBoard(doc: Y.Doc) {
  const blocks = [...doc.getMap<unknown>('blocks')].filter(
    (entry): entry is [string, Y.Map<unknown>] => entry[1] instanceof Y.Map
  );
  const of = (flavour: string) =>
    blocks.filter(([, block]) => block.get('sys:flavour') === flavour);
  const pages = of('affine:page');
  const canvases = of('affine:surface');
  if (pages.length !== 1 || canvases.length !== 1) return false;
  const children = pages[0][1].get('sys:children');
  return (
    children instanceof Y.Array && children.toArray().includes(canvases[0][0])
  );
}
