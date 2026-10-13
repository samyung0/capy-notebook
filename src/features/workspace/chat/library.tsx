/** The rich-answer library bound to Capy's chat components. */

import { createParser } from '@openuidev/lang-core';
import { ignoreEmptyExtras } from './answer';
import { AskUser } from './blocks/AskUser';
import { Chart, Plot } from './blocks/ChatChart';
import { Diagram } from './blocks/ChatDiagram';
import { Interactive } from './blocks/ChatInteractive';
import { ChatTable } from './blocks/ChatTable';
import { Accordion, Cards, ChatTabs, Facts } from './blocks/layout';
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
  Curve: leaf,
  Diagram,
  Fact: leaf,
  Facts,
  Interactive,
  Md,
  Plot,
  Point: leaf,
  RefLine: leaf,
  Reveal,
  Row: leaf,
  Series: leaf,
  Step: leaf,
  Steps,
  Tab: leaf,
  Table: ChatTable,
  Tabs: ChatTabs,
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
