import { Component, type ReactNode, useMemo, useState } from 'react';
import { useLibraryFigure } from '@/api/hooks';
import type { Citation } from '@/api/types';
import { Mermaid } from '@/features/materials/Mermaid';
import { m } from '@/i18n';
import { useTheme } from '@/theme/theme';
import { chartFigure, plotFigure } from './answer';
import { copyAnswer, registerBlock } from './answerCopy';
import { AskUser, LatestAnswerContext } from './blocks/AskUser';
import { Chart, Plot } from './blocks/ChatChart';
import { HtmlEmbedFigure } from './blocks/ChatHtmlEmbed';
import { CitationContext, useCitationLookup } from './blocks/Cite';
import { CodeBlock } from './blocks/CodeBlock';
import { citedPassages } from './blocks/citeMarkers';
import { ChatTabs } from './blocks/layout';
import { Callout, Prose, Reveal } from './blocks/text';
import {
  type FigureSegment,
  fenceAttributes,
  parseMarkdownAnswer,
  type Segment,
  unfinished,
} from './markdownSegments';
import { askQuestions } from './questions';

function AnswerError({ partial = false }: { partial?: boolean }) {
  return (
    <p
      className="rounded-lg bg-tint-error px-2.5 py-1.5 text-sm text-tint-error-fg"
      data-copy-skip
      role="alert"
    >
      {partial ? m.chat_answer_incomplete() : m.chat_failed()}
    </p>
  );
}

// biome-ignore lint/style/useReactFunctionComponents: React error boundaries require a class.
class MarkdownBoundary extends Component<
  { children: ReactNode; text: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: { text: string }) {
    if (this.state.failed && previous.text !== this.props.text)
      this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? <AnswerError /> : this.props.children;
  }
}

/**
 * The answer body of an assistant bubble: a Markdown-format answer
 * (markdownSegments.ts) drawn with the chat blocks. A copy inside it also
 * carries the selection as note blocks.
 */
export function MarkdownAnswer({
  content,
  streaming,
  complete,
  latest,
  citations,
  onOpenCitation,
}: {
  content: string;
  /** Tokens are still arriving for this message. */
  streaming: boolean;
  /** The message finished normally, so a figure left open is a real gap. */
  complete: boolean;
  latest: boolean;
  citations?: Citation[];
  onOpenCitation?: (citation: Citation) => void;
}) {
  const segments = useMemo(() => parseMarkdownAnswer(content), [content]);
  const lookup = useCitationLookup(citations, onOpenCitation);
  return (
    <div className="flex flex-col gap-6" data-chat-answer onCopy={copyAnswer}>
      <MarkdownBoundary text={content}>
        <CitationContext.Provider value={lookup}>
          <LatestAnswerContext.Provider value={latest}>
            <Segments segments={segments} streaming={streaming} />
          </LatestAnswerContext.Provider>
        </CitationContext.Provider>
        {complete && !streaming && unfinished(segments) ? (
          <AnswerError partial={segments.length > 1} />
        ) : null}
      </MarkdownBoundary>
    </div>
  );
}

function Segments({
  segments,
  streaming,
}: {
  segments: Segment[];
  streaming: boolean;
}) {
  return segments.map((segment, index) => (
    // Each block knows its source, so a copy can rebuild the selected blocks
    // (answerCopy.ts).
    <div
      className="contents"
      key={index}
      ref={(element) => registerBlock(element, segment)}
    >
      <SegmentView segment={segment} streaming={streaming} />
    </div>
  ));
}

function SegmentView({
  segment,
  streaming,
}: {
  segment: Segment;
  streaming: boolean;
}) {
  switch (segment.type) {
    case 'md':
      return <Prose text={segment.text} />;
    case 'callout':
      return <Callout props={segment} />;
    case 'reveal':
      return <Reveal props={segment} />;
    case 'tabs':
      return (
        <ChatTabs
          tabs={segment.tabs.map(({ label, segments }) => ({
            content: <Segments segments={segments} streaming={streaming} />,
            label,
          }))}
        />
      );
    case 'figure':
      return <Figure segment={segment} streaming={streaming} />;
    case 'libraryFigure':
      return <LibraryFigureView caption={segment.caption} id={segment.id} />;
  }
}

/** A figure fence; one whose content the block refuses shows as code, so a
 * bad figure is visible rather than missing. An unclosed fence draws nothing,
 * but for an embed's frame, which holds its place while it streams. */
function Figure({
  segment,
  streaming,
}: {
  segment: FigureSegment;
  streaming: boolean;
}) {
  const { body, closed, info, lang } = segment;
  if (!(closed || (streaming && lang === 'html-embed'))) return null;
  if (lang === 'html-embed') {
    const attributes = fenceAttributes(info);
    return (
      <HtmlEmbedFigure
        props={{
          // The frame mounts once the fence closes, not on every chunk.
          html: closed ? body : '',
          passages: citedPassages(attributes.passages ?? ''),
          title: attributes.title ?? '',
        }}
      />
    );
  }
  if (lang === 'mermaid') return <ChatMermaid code={body} />;
  if (lang === 'ask') return <AskUser questions={askQuestions(body)} />;
  if (lang === 'chart') {
    const chart = chartFigure(body);
    if (chart) return <Chart props={chart} />;
  } else {
    const plot = plotFigure(body);
    if (plot) return <Plot props={plot} />;
  }
  return <CodeBlock code={body} language={lang} />;
}

/** A Mermaid fence drawn without a panel in the app's light or dark
 * neutral theme, never the notes' own (Epo 2026-10-30); a source mermaid
 * refuses shows as code like any refused figure. */
function ChatMermaid({ code }: { code: string }) {
  const { isDark } = useTheme();
  const [failed, setFailed] = useState(false);
  if (failed) return <CodeBlock code={code} language="mermaid" />;
  return (
    <Mermaid
      bare
      code={code}
      onError={(failure) => setFailed(failure != null)}
      theme={isDark ? 'linearDark' : 'linearLight'}
    />
  );
}

/** A library figure the answer places, `![caption](figure:<id>)`, with the
 * book's printed credit after the caption (Epo 2026-10-30). */
function LibraryFigureView({ caption, id }: { caption: string; id: string }) {
  const { data, isError } = useLibraryFigure(id, { errorBoundary: false });
  if (!data) {
    return (
      <p className="py-6 text-center text-fg-muted text-xs">
        {isError ? m.chat_figure_unavailable() : m.chat_figure_loading()}
      </p>
    );
  }
  const text = caption || data.label;
  const credit = data.credit && !text.includes(data.credit) && data.credit;
  return (
    <figure className="flex flex-col items-center gap-1.5">
      <img
        alt={text}
        // The chat's figure box (charts stop at 480px, diagrams at
        // min(60vh, 32rem)); a small figure still shows at a readable size.
        className="h-auto max-h-[min(60vh,32rem)] min-h-[96px] w-auto min-w-[160px] max-w-[min(100%,480px)] rounded-lg object-contain"
        height={data.height}
        src={`data:image/jpeg;base64,${data.image}`}
        width={data.width}
      />
      {(text || credit) && (
        <figcaption className="max-w-[480px] text-center text-[13.5px] text-fg-muted">
          {[text, credit && `(${credit})`].filter(Boolean).join(' ')}
        </figcaption>
      )}
    </figure>
  );
}
