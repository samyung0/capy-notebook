import { memo } from 'react';
import type {
  MaterialPreview,
  PreviewBlock,
  QuestionType,
  QuizPreviewQuestion,
} from '@/api/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import './livePreview.css';

/** Static card previews drawn from a material's stored `preview` or a text
 * file's opening lines. Each lays out on the 240×165 design canvas
 * (`.pv-live`), which one CSS transform scales to the thumbnail panel; no
 * per-card measuring. */

type NotePreview = Extract<MaterialPreview, { kind: 'note' }>;

/** A lone short paragraph reads as a sticky note, in larger text. */
const BIG_PARAGRAPH = 140;
/** Fronts longer than this use the small, left-aligned style. */
const LONG_FRONT = 60;
const TEXT_LINES = 12;

export const NoteLive = memo(function NoteLive({
  blocks,
}: Pick<NotePreview, 'blocks'>) {
  const big =
    blocks.length === 1 &&
    blocks[0].t === 'p' &&
    blocks[0].text.length <= BIG_PARAGRAPH;
  return (
    <div className="pv-live">
      <div className="pv-paper">
        {blocks.map((block, i) => (
          <Block big={big} block={block} key={i} />
        ))}
      </div>
    </div>
  );
});

function Block({ block, big }: { block: PreviewBlock; big: boolean }) {
  switch (block.t) {
    case 'h':
      return (
        <p className={block.level <= 1 ? 'pv-h1' : 'pv-h2'}>{block.text}</p>
      );
    case 'p':
      return <p className={big ? 'pv-big' : 'pv-p'}>{block.text}</p>;
    case 'ul':
      return (
        <ul className="pv-ul">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case 'todo':
      return block.items.map((item, i) => (
        <p className={cn('pv-todo', item.done && 'pv-done')} key={i}>
          <i />
          <span>{item.text}</span>
        </p>
      ));
    case 'table':
      return (
        <table className="pv-table">
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) =>
                  r === 0 ? <th key={c}>{cell}</th> : <td key={c}>{cell}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'math':
      return <p className="pv-math">{block.tex}</p>;
    case 'code':
      return <pre className="pv-code">{block.text}</pre>;
    case 'quote':
      return <p className="pv-quote">{block.text}</p>;
    case 'image':
      return <div className="pv-img" />;
  }
}

const LETTERS = 'ABCD';

export const QuizLive = memo(function QuizLive({
  question,
}: {
  question: QuizPreviewQuestion;
}) {
  const { type, stem, options = [], pairs = [], items = [] } = question;
  const label = typeLabel(type);
  return (
    <div className="pv-live pv-quiz">
      {question.hasChart && <Chart />}
      {label && <p className="pv-lab">{label}</p>}
      {type === 'gaps' ? (
        <p className="pv-gaps">
          {stem.split('\u0001').map((part, i) => (
            <span key={i}>
              {i > 0 && <u />}
              {part}
            </span>
          ))}
        </p>
      ) : (
        <p className="pv-q">
          <b>1</b>
          {stem}
        </p>
      )}
      {(type === 'mcq' || type === 'multi') &&
        options.map((option, i) => (
          <p className="pv-opt" key={i}>
            {type === 'mcq' ? <i>{LETTERS[i]}</i> : <span className="pv-box" />}
            {option}
          </p>
        ))}
      {type === 'boolean' && (
        <p className="pv-tf">
          <span>{m.question_ui_true()}</span>
          <span>{m.question_ui_false()}</span>
        </p>
      )}
      {type === 'short' && (
        <p className="pv-input">{m.question_ui_your_answer()}</p>
      )}
      {type === 'open' && (
        <p className="pv-lines">
          <i />
          <i />
          <i />
        </p>
      )}
      {type === 'matching' && (
        <p className="pv-match">
          {pairs.map(([left, right], i) => (
            <span className="pv-pair" key={i}>
              <span>{left}</span>
              <i />
              <span>{right}</span>
            </span>
          ))}
        </p>
      )}
      {type === 'ordering' &&
        items.map((item, i) => (
          <p className="pv-ord" key={i}>
            <span>⋮⋮</span>
            {item}
          </p>
        ))}
    </div>
  );
});

/** The answer-format line above the stem; single choice and written answers
 * need none. */
function typeLabel(type: QuestionType): string | undefined {
  switch (type) {
    case 'multi':
      return m.question_ui_multiple_answers();
    case 'boolean':
      return m.question_ui_true_false();
    case 'matching':
      return m.question_ui_matching();
    case 'ordering':
      return m.question_ui_ordering();
    case 'gaps':
      return m.question_ui_fill_in_the_gaps();
  }
}

/** A generic two-curve plot standing in for a stem's chart or graph. */
function Chart() {
  return (
    <svg className="pv-chart" viewBox="0 0 208 62">
      <path className="pv-axis" d="M8 54H200M12 58V4" />
      <path
        className="pv-curve"
        d="M12 54 C 40 52, 60 20, 90 14 S 160 10, 200 9"
      />
      <path
        className="pv-curve pv-curve-2"
        d="M12 54 C 50 53, 90 34, 120 28 S 180 22, 200 21"
      />
    </svg>
  );
}

export const CardsLive = memo(function CardsLive({
  count,
  front,
  hasImage,
}: {
  count: number;
  front: string;
  hasImage: boolean;
}) {
  return (
    <div className="pv-live pv-cards">
      {count >= 2 && <div className="pv-card pv-back-1" />}
      {count >= 3 && <div className="pv-card pv-back-2" />}
      <div className="pv-card pv-front">
        {hasImage && <div className="pv-img" />}
        <p
          className={cn(
            hasImage ? 'pv-s' : 'pv-t',
            !hasImage && front.length > LONG_FRONT && 'pv-long'
          )}
        >
          {front}
        </p>
      </div>
    </div>
  );
});

/** A text file's opening lines in monospace; Markdown headings tinted. */
export const TextLive = memo(function TextLive({
  text,
  markdown,
}: {
  text: string;
  markdown: boolean;
}) {
  const lines = text.split('\n').slice(0, TEXT_LINES);
  return (
    <pre className="pv-live pv-text">
      {markdown
        ? lines.map((line, i) => (
            <span className={cn(line.startsWith('#') && 'pv-mdh')} key={i}>
              {line}
              {'\n'}
            </span>
          ))
        : lines.join('\n')}
    </pre>
  );
});
