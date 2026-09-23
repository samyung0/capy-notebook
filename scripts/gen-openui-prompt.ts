/**
 * Regenerate the model-facing OpenUI Lang prompt and the library spec the
 * Python service reads. Run with `pnpm gen:openui` after changing
 * `src/features/workspace/chat/schema.ts`; `library.test.ts` fails when the
 * committed files drift from the schema.
 */

import { writeFileSync } from 'node:fs';
import {
  PROMPT_PATH,
  renderPrompt,
  renderSpec,
  SPEC_PATH,
} from '../src/features/workspace/chat/generated';

writeFileSync(PROMPT_PATH, renderPrompt());
writeFileSync(SPEC_PATH, renderSpec());
process.stdout.write(`wrote ${PROMPT_PATH} and ${SPEC_PATH}\n`);
