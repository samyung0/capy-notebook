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
import { copyAnswer } from './answerCopy';
import { LatestAnswerContext } from './blocks/AskUser';
import { InvalidChartContext } from './blocks/ChatChart';
import { CitationContext, useCitationLookup } from './blocks/Cite';
import { Prose } from './blocks/text';
import { chatLibrary, parseAnswer } from './library';

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

function Markdown({
  text,
  incomplete = false,
}: {
  text: string;
  incomplete?: boolean;
}) {
  return (
    <MarkdownBoundary text={text}>
      <div className="flex flex-col gap-5">
        <Prose text={text} />
        {incomplete ? <AnswerError partial /> : null}
      </div>
    </MarkdownBoundary>
  );
}

/**
 * The answer body of an assistant bubble: an OpenUI Lang program rendered
 * through the chat library, or plain Markdown for answers stored before the
 * program format. A copy inside it also carries the selection as note blocks.
 */
export function LangAnswer(props: Parameters<typeof AnswerBody>[0]) {
  return (
    <div className="contents" data-chat-answer onCopy={copyAnswer}>
      <AnswerBody {...props} />
    </div>
  );
}

function AnswerBody({
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
  const lookup = useCitationLookup(citations, onOpenCitation);

  if (!isLangAnswer(content)) return <Markdown text={content} />;
  if (!result?.root && !isProgramSyntax(content)) {
    return <Markdown text={content} />;
  }
  const gap = complete && !streaming && inspected.gap;
  return (
    <CitationContext.Provider value={lookup}>
      <div className="flex flex-col gap-5">
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
      </div>
    </CitationContext.Provider>
  );
}
