import { rmSync } from 'node:fs';

rmSync(new URL('../src/api/gen', import.meta.url), {
  force: true,
  recursive: true,
});
