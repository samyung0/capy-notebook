import { readFile, writeFile } from 'node:fs/promises';
import { Y } from '../storage/lib.mjs';
const s = await readFile('dumps/jp_llm2.pptx/state.bin');
const d = new Y.Doc();
Y.applyUpdate(d, s);
d.getMap('pptx:meta').delete('media');
await writeFile('dumps/jp_llm2-nomedia.state.bin', Y.encodeStateAsUpdate(d));
