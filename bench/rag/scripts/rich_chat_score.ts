/** Score saved synthetic replies against the shipped catalog and recovery rules. */
import { readFileSync } from 'node:fs';
import { createParser, type ParseResult } from '@openuidev/lang-core';
import {
  ignoreEmptyExtras,
  inspectAnswer,
  isLangAnswer,
  splitAnswer,
} from '../../../src/features/workspace/chat/answer';
import {
  buildLibrary,
  promptOptions,
  type Renderers,
} from '../../../src/features/workspace/chat/schema';

const spec = JSON.parse(
  readFileSync('pipeline/pipeline/generated/openui_library.json', 'utf8'),
) as { components: { name: string }[] };
const library = buildLibrary(
  Object.fromEntries(
    spec.components.map(({ name }) => [name, () => null]),
  ) as Renderers,
);
const parser = createParser(library.toJSONSchema(), library.root);
const rows = JSON.parse(readFileSync(0, 'utf8')) as {
  model: string;
  case: string;
  repeat: number;
  content: string;
  pythonValid: boolean;
  unknownPassages: number[];
  transportError?: string;
  protocolLeak: boolean;
}[];
const scored = rows.map((row) => {
  const source = splitAnswer(row.content).program;
  let raw: ParseResult | null = null;
  try {
    raw = parser.parse(source);
  } catch {
    // Match the browser's failed-parse path and keep scoring the other replies.
  }
  const parsed = raw
    ? ignoreEmptyExtras(raw, source, library.toJSONSchema())
    : null;
  const inspected = inspectAnswer(parsed);
  return {
    model: row.model,
    case: row.case,
    repeat: row.repeat,
    protocolLeak: row.protocolLeak,
    formatInvalid:
      !row.pythonValid ||
      !raw ||
      raw.meta.errors.length > 0 ||
      !!row.unknownPassages.length,
    invalid: !row.pythonValid || inspected.gap || !!row.unknownPassages.length,
    recovery:
      inspected.gap || !isLangAnswer(row.content)
        ? inspected.text
          ? 'partial'
          : 'unusable'
        : 'complete',
    metadata: parsed?.meta ?? null,
    unknownPassages: row.unknownPassages,
    transportError: row.transportError,
  };
});
const stock = library.prompt();
const capy = library.prompt(promptOptions);
process.stdout.write(
  JSON.stringify(
    {
      prompts: {
        stockCharacters: stock.length,
        capyCharacters: capy.length,
        stockLines: stock.split('\n').length,
        capyLines: capy.split('\n').length,
      },
      scored,
    },
    null,
    2,
  ),
);
