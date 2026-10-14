import { z } from 'zod';

/* Zod probes `new Function` when it builds its first object schema, to
   compile faster parsers. The pages the site Worker renders run under a script
   policy without eval (vite-image-policy.ts pagePolicy), and the browser
   reports even a probe that fails quietly, so their schemas parse without
   compiling. Each page script imports this first, before any schema exists. */
z.config({ jitless: true });
