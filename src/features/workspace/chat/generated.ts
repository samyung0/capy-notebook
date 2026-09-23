/**
 * The two generated files derived from `schema.ts`: the prompt text the
 * Python service appends to the chat system prompt, and the library spec it
 * parses answers against. Shared by the generator script and the freshness
 * test, with stub renderers so no React component is needed.
 */

import { join } from 'node:path';
import { buildLibrary, promptOptions, type Renderers } from './schema';

const stub = () => null;
const stubs = Object.fromEntries(
  [
    'Answer',
    'Md',
    'Callout',
    'Tabs',
    'Tab',
    'Steps',
    'Step',
    'Accordion',
    'AccordionItem',
    'Reveal',
    'Tags',
    'Facts',
    'Fact',
    'Cards',
    'Card',
    'Table',
    'Row',
    'Chart',
    'Series',
    'ScatterChart',
    'Point',
    'AskUser',
  ].map((name) => [name, stub])
) as unknown as Renderers;

const root = join(import.meta.dirname, '../../../..');
export const PROMPT_PATH = join(
  root,
  'pipeline/pipeline/prompts/openui_lang.txt'
);
export const SPEC_PATH = join(
  root,
  'pipeline/pipeline/generated/openui_library.json'
);

export function renderPrompt(): string {
  return `${buildLibrary(stubs).prompt(promptOptions).trim()}\n`;
}

/** Component names with their prop names in positional order, which is the
 * key order of each component's JSON schema. */
export function renderSpec(): string {
  const library = buildLibrary(stubs);
  const schema = library.toJSONSchema() as {
    properties: Record<string, unknown>;
    $defs: Record<string, { properties: Record<string, unknown> }>;
  };
  const components = Object.keys(schema.properties).map((name) => ({
    name,
    props: Object.keys(schema.$defs[name].properties),
  }));
  return `${JSON.stringify({ components, root: library.root }, null, 2)}\n`;
}
