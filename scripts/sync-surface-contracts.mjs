import { copyFileSync, mkdirSync } from 'node:fs';

const source = new URL('../src/api/gen/model/surface.ts', import.meta.url);
const destination = new URL('../ops/src/api-gen/surface.ts', import.meta.url);

mkdirSync(new URL('../ops/src/api-gen/', import.meta.url), { recursive: true });
copyFileSync(source, destination);
