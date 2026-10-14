import { z } from 'zod';

/* Zod probes `new Function` when it builds its first object schema, to
   compile faster parsers. The app's pages run under script policies without
   eval (vite-image-policy.ts: enforced on the pages the site Worker renders,
   report-only on the SPA), and the browser reports even a probe that fails
   quietly, so schemas parse without compiling. The SPA's and the share pages'
   scripts (src/main.tsx, src/share/main.tsx) import this first, before any
   schema exists; the summary and error pages' script builds none. */
z.config({ jitless: true });
