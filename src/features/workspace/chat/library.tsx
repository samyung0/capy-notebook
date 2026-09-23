/** The rich-answer library bound to Capy's chat components. */

import { createParser } from '@openuidev/lang-core';
import { ignoreEmptyExtras } from './answer';
import { AskUser } from './blocks/AskUser';
import { Chart, ScatterChart } from './blocks/ChatChart';
import { ChatTable } from './blocks/ChatTable';
import { Accordion, Cards, ChatTabs, Facts, Tags } from './blocks/layout';
import { Callout, Md, Reveal, Steps } from './blocks/text';
import { buildLibrary } from './schema';

const leaf = () => null;

export const chatLibrary = buildLibrary({
  Accordion,
  AccordionItem: leaf,
  Answer: ({ props, renderNode }) => (
    <div className="flex flex-col">{renderNode(props.children)}</div>
  ),
  AskUser,
  Callout,
  Card: leaf,
  Cards,
  Chart,
  Fact: leaf,
  Facts,
  Md,
  Point: leaf,
  Reveal,
  Row: leaf,
  ScatterChart,
  Series: leaf,
  Step: leaf,
  Steps,
  Tab: leaf,
  Table: ChatTable,
  Tabs: ChatTabs,
  Tags,
});

const schema = chatLibrary.toJSONSchema();
const parser = createParser(schema, chatLibrary.root);

export function parseAnswer(content: string) {
  try {
    return ignoreEmptyExtras(parser.parse(content), content, schema);
  } catch {
    return null;
  }
}
