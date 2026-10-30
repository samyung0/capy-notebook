import { useMemo } from 'react';
import type { Citation } from '@/api/types';
import { chartBlock, plotBlock } from './answer';
import { AskUser } from './blocks/AskUser';
import { Chart, Plot } from './blocks/ChatChart';
import { ChatHtmlEmbed } from './blocks/ChatHtmlEmbed';
import {
  CitationContext,
  type ElementNode,
  useCitationLookup,
} from './blocks/Cite';
import { CodeBlock } from './blocks/CodeBlock';
import { citedPassages } from './blocks/citeMarkers';
import { ChatTabs } from './blocks/layout';
import { Callout, Prose, Reveal } from './blocks/text';
import {
  fenceAttributes,
  parseMarkdownAnswer,
  type Segment,
} from './markdownSegments';
import {
  askUserProps,
  type CalloutProps,
  type ChartProps,
  type PlotProps,
} from './schema';

/**
 * A Markdown-format answer (markdownAnswer.ts) drawn with the same chat
 * blocks as an OpenUI program; the playground switches between the two.
 */
export function MarkdownAnswer({
  content,
  citations,
  onOpenCitation,
}: {
  content: string;
  citations?: Citation[];
  onOpenCitation?: (citation: Citation) => void;
}) {
  const segments = useMemo(() => parseMarkdownAnswer(content), [content]);
  const lookup = useCitationLookup(citations, onOpenCitation);
  return (
    <CitationContext.Provider value={lookup}>
      <div className="flex flex-col gap-5" data-chat-answer>
        <Segments segments={segments} />
      </div>
    </CitationContext.Provider>
  );
}

function Segments({ segments }: { segments: Segment[] }) {
  return segments.map((segment, index) => (
    <SegmentView key={index} segment={segment} />
  ));
}

const CALLOUT_KINDS: Record<string, CalloutProps['kind']> = {
  caution: 'warning',
  danger: 'danger',
  success: 'success',
  tip: 'tip',
  warning: 'warning',
};

function SegmentView({ segment }: { segment: Segment }) {
  switch (segment.type) {
    case 'md':
      return <Prose text={segment.text} />;
    case 'callout':
      return (
        <Callout
          props={{
            kind: CALLOUT_KINDS[segment.kind] ?? 'info',
            text: segment.text,
            title: segment.title,
          }}
        />
      );
    case 'reveal':
      return <Reveal props={{ text: segment.text, title: segment.title }} />;
    case 'tabs':
      return (
        <ChatTabs
          props={{
            items: segment.tabs.map((tab) =>
              node('Tab', { children: tab.segments, label: tab.label })
            ),
          }}
          renderNode={(children) => (
            <Segments segments={children as Segment[]} />
          )}
        />
      );
    case 'figure':
      return <Figure segment={segment} />;
  }
}

function node<P>(typeName: string, props: P): ElementNode<P> {
  return { partial: false, props, type: 'element', typeName };
}

function json(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object')
    : [];

const numbers = (value: unknown): number[] | undefined =>
  Array.isArray(value) ? value.filter(Number.isInteger) : undefined;

function chartProps(value: Record<string, unknown>): ChartProps {
  return {
    illustrative: value.illustrative === true,
    kind: value.kind as ChartProps['kind'],
    labels: Array.isArray(value.labels) ? value.labels.map(String) : [],
    passages: numbers(value.passages),
    series: list(value.series).map((series) => node('Series', series)),
    title: String(value.title ?? ''),
    xTitle: typeof value.xTitle === 'string' ? value.xTitle : undefined,
    yTitle: typeof value.yTitle === 'string' ? value.yTitle : undefined,
  };
}

function plotProps(value: Record<string, unknown>): PlotProps {
  return {
    illustrative: value.illustrative === true,
    kind: value.kind as PlotProps['kind'],
    lines: list(value.lines).map((line) => node('RefLine', line)),
    marks: list(value.marks).map((mark) => node('Point', mark)),
    passages: numbers(value.passages),
    series: list(value.series).map((curve) => node('Curve', curve)),
    title: String(value.title ?? ''),
    xTitle: String(value.xTitle ?? ''),
    yTitle: String(value.yTitle ?? ''),
  };
}

/** A figure fence; one whose content the block refuses shows as code, so a
 * bad figure is visible rather than missing. */
function Figure({
  segment,
}: {
  segment: Extract<Segment, { type: 'figure' }>;
}) {
  const { body, closed, info, lang } = segment;
  if (lang === 'html-embed') {
    const attributes = fenceAttributes(info);
    return (
      <ChatHtmlEmbed
        props={{
          // The frame mounts once the fence closes, not on every chunk.
          html: closed ? body : '',
          passages: citedPassages(attributes.passages ?? ''),
          title: attributes.title ?? '',
        }}
      />
    );
  }
  if (!closed) return null;
  if (lang === 'ask') {
    return body.split('\n').map((line, index) => {
      const ask = askUserProps.safeParse(json(line));
      return ask.success ? (
        <AskUser key={index} props={ask.data} />
      ) : (
        <CodeBlock code={line} key={index} language="ask" />
      );
    });
  }
  const value = json(body);
  if (lang === 'chart') {
    const props = value && chartProps(value);
    if (props && chartBlock(props)) return <Chart props={props} />;
  } else {
    const props = value && plotProps(value);
    if (props && plotBlock(props)) return <Plot props={props} />;
  }
  return <CodeBlock code={body} language={lang} />;
}
