import { Renderer } from '@openuidev/react-lang';
import { Component, type ReactNode, useMemo, useState } from 'react';
import type { Citation } from '@/api/types';
import { m } from '@/i18n';
import {
  inspectAnswer,
  isLangAnswer,
  isProgramSyntax,
  splitAnswer,
} from './answer';
import { LatestAnswerContext } from './blocks/AskUser';
import { InvalidChartContext } from './blocks/ChatChart';
import { CitationContext, type CitationLookup } from './blocks/Cite';
import { Prose } from './blocks/text';
import { chatLibrary, parseAnswer } from './library';

function AnswerError({ partial = false }: { partial?: boolean }) {
  return (
    <p
      className="mt-2 rounded-card border border-tint-error bg-tint-error px-3 py-2 text-sm text-solid-error"
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

function Markdown({
  text,
  incomplete = false,
}: {
  text: string;
  incomplete?: boolean;
}) {
  return (
    <MarkdownBoundary text={text}>
      <Prose text={text} />
      {incomplete ? <AnswerError partial /> : null}
    </MarkdownBoundary>
  );
}

/**
 * The answer body of an assistant bubble: an OpenUI Lang program rendered
 * through the chat library, or plain Markdown for answers stored before the
 * program format (and for curate replies, which stay prose).
 */
export function LangAnswer({
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
  /** The message finished normally, so a parse gap is a real gap. */
  complete: boolean;
  latest: boolean;
  citations?: Citation[];
  onOpenCitation?: (citation: Citation) => void;
}) {
  const { prefix, program } = splitAnswer(content);
  const result = useMemo(
    () => (isLangAnswer(content) ? parseAnswer(program) : null),
    [content, program]
  );
  const inspected = useMemo(() => inspectAnswer(result), [result]);
  const [renderFailure, setRenderFailure] = useState<string | null>(null);
  const failed = renderFailure === content;
  const lookup = useMemo<CitationLookup>(() => {
    const byPassage = new Map<number, number>();
    citations?.forEach((citation, index) => {
      if (citation.n !== undefined && !byPassage.has(citation.n)) {
        byPassage.set(citation.n, index);
      }
    });
    return {
      numberOf: (n) => {
        const index = byPassage.get(n);
        return index === undefined ? undefined : index + 1;
      },
      open: (n) => {
        const index = byPassage.get(n);
        const citation = index === undefined ? undefined : citations?.[index];
        if (citation) onOpenCitation?.(citation);
      },
    };
  }, [citations, onOpenCitation]);

  if (!isLangAnswer(content)) return <Markdown text={content} />;
  if (!result?.root && !isProgramSyntax(content)) {
    return <Markdown text={content} />;
  }
  const gap = complete && !streaming && inspected.gap;
  return (
    <CitationContext.Provider value={lookup}>
      {prefix ? <Markdown text={prefix} /> : null}
      {failed ? (
        inspected.text ? (
          <Markdown incomplete={gap} text={inspected.text} />
        ) : gap ? (
          <AnswerError />
        ) : null
      ) : (
        <InvalidChartContext.Provider value={inspected.invalidCharts}>
          <LatestAnswerContext.Provider value={latest}>
            <Renderer
              isStreaming={streaming}
              library={chatLibrary}
              onError={(errors) => {
                if (errors.some((error) => error.source !== 'parser'))
                  setRenderFailure(content);
              }}
              response={program}
            />
          </LatestAnswerContext.Provider>
        </InvalidChartContext.Provider>
      )}
      {gap && !failed ? <AnswerError partial={!!inspected.text} /> : null}
    </CitationContext.Provider>
  );
}
