// Node module hooks for the corpus run: Vite's `?raw` imports (fixture SVGs)
// load as a string module, as Vite gives them.
import { readFile } from 'node:fs/promises';

export async function resolve(specifier, context, next) {
  if (!specifier.endsWith('?raw')) return next(specifier, context);
  const resolved = await next(specifier.slice(0, -4), context);
  return { format: 'module', shortCircuit: true, url: `${resolved.url}?raw` };
}

export async function load(url, context, next) {
  if (!url.endsWith('?raw')) return next(url, context);
  const text = await readFile(new URL(url.slice(0, -4)), 'utf8');
  return {
    format: 'module',
    shortCircuit: true,
    source: `export default ${JSON.stringify(text)};`,
  };
}
