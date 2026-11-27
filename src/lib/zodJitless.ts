/* Zod probes `new Function` when it builds its first object schema, to
   compile faster parsers. The app's pages run under script policies without
   eval (vite-image-policy.ts: enforced on the pages the site Worker renders,
   report-only on the SPA), and the browser reports even a probe that fails
   quietly, so schemas parse without compiling. The SPA's and the share pages'
   scripts (src/main.tsx, src/share/main.tsx) import this first, before any
   schema exists; the summary and error pages' script builds none.

   Zod keeps its settings on `globalThis.__zod_globalConfig` and reuses that
   object when it loads (zod/v4/core/core.js), so this sets them without
   importing zod, which stays out of the app's entry (Q908); zodJitless.test
   fails if a zod upgrade moves it. */
type ZodGlobal = { __zod_globalConfig?: Record<string, unknown> };

const holder = globalThis as ZodGlobal;
holder.__zod_globalConfig ??= {};
export const zodConfig = holder.__zod_globalConfig;
zodConfig.jitless = true;
