/** The rich-answer library bound to Capy's chat components. */

import { createParser } from '@openuidev/lang-core';
import { ignoreEmptyExtras } from './answer';
import { registerBlock } from './answerCopy';
import { AskUser } from './blocks/AskUser';
import { Chart, Plot } from './blocks/ChatChart';
import { ChatHtmlEmbed } from './blocks/ChatHtmlEmbed';
import { ChatTable } from './blocks/ChatTable';
import { Accordion, Cards, ChatTabs, Facts } from './blocks/layout';
import { Callout, Md, Reveal, Steps } from './blocks/text';
import { buildLibrary, type Renderers } from './schema';

const leaf = () => null;

type Renderer = Renderers[keyof Renderers];

/** Each block renders inside a `display: contents` element that knows its
 * node, so a copy can rebuild the selected blocks (answerCopy.ts). */
function tagged(name: string, Render: Renderer): Renderer {
  return (args) => (
    <div
      className="contents"
      data-ui={name}
      ref={(element) => registerBlock(element, name, args.props)}
    >
      <Render {...args} />
    </div>
  );
}

const tagBlocks = (renderers: Renderers) =>
  Object.fromEntries(
    Object.entries(renderers).map(([name, render]) => [
      name,
      name === 'Answer' ? render : tagged(name, render),
    ])
  ) as Renderers;

export const chatLibrary = buildLibrary(
  tagBlocks({
    Accordion,
    AccordionItem: leaf,
    // Consecutive asked questions read as one group, not separate blocks.
    Answer: ({ props, renderNode }) => (
      <div className="flex flex-col gap-5 [&>[data-ui=AskUser]+[data-ui=AskUser]>[data-asked]]:-mt-4">
        {renderNode(props.children)}
      </div>
    ),
    AskUser,
    Callout,
    Card: leaf,
    Cards,
    Chart,
    Curve: leaf,
    Fact: leaf,
    Facts,
    HtmlEmbed: ChatHtmlEmbed,
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
  })
);

const schema = chatLibrary.toJSONSchema();
const parser = createParser(schema, chatLibrary.root);

export function parseAnswer(content: string) {
  try {
    return ignoreEmptyExtras(parser.parse(content), content, schema);
  } catch {
    return null;
  }
}
