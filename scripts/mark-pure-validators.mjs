import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Marks each generated zod schema `/* @__PURE__ *\/`, so a bundle keeps only
 * the schemas it uses: zod's calls look side-effectful to Rollup, which
 * otherwise keeps every schema of a module it imports (one constant pulled
 * the whole file into the entry). Runs after orval in `gen:api`.
 */
const file = new URL('../src/api/gen/validators.ts', import.meta.url);
const source = readFileSync(file, 'utf8');
const marked = source.replaceAll(
  /^(export const \w+ = )zod\./gm,
  '$1/* @__PURE__ */ zod.'
);
if (!marked.includes('/* @__PURE__ */ zod.'))
  throw new Error('No zod schema found in src/api/gen/validators.ts.');
writeFileSync(file, marked);
