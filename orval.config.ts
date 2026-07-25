import { defineConfig } from 'orval';

/**
 * Input is always the local ./openapi.yaml.
 * - One-shot: `pnpm gen:api:msw` regenerates the spec from source then runs orval.
 * - Live: `air` regenerates ./openapi.yaml on each rebuild (server/.air.toml) and
 *   `pnpm gen:api:watch` (orval --watch) picks up the file change.
 */
const input = './openapi.yaml';

export default defineConfig({
  // TypeScript model interfaces. orval v8 requires a target per project, so a
  // thin fetch "endpoints" file is emitted alongside — it is intentionally
  // unused; the hand-written src/api/client.ts + hooks.ts stay the source of
  // truth. The value we consume lives in src/api/gen/model/*.
  models: {
    hooks: { afterAllFilesWrite: 'pnpm run fmt' },
    input,
    output: {
      client: 'fetch',
      mode: 'single',
      schemas: 'src/api/gen/model',
      target: 'src/api/gen/endpoints.ts',
    },
  },
  // Standalone zod validators for request/response bodies, in a single file.
  zod: {
    hooks: { afterAllFilesWrite: 'pnpm run fmt' },
    input,
    output: {
      client: 'zod',
      mode: 'single',
      target: 'src/api/gen/validators.ts',
    },
  },
});
