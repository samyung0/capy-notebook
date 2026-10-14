import { memo } from 'react';
import type {
  MaterialPreview,
  PreviewBlock,
  QuestionType,
  QuizPreviewQuestion,
} from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { orderItemsLabel } from '@/features/materials/countLabels';
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
/** Fronts longer than this wrap under an image, which shrinks to make room. */
const ONE_LINE_FRONT = 28;
const TEXT_LINES = 12;
const TABLE_ROWS = 8;
const TABLE_COLUMNS = 5;
const LINE_BREAK = /\r?\n/;

export const NoteLive = memo(function NoteLive({
  blocks,
}: Pick<NotePreview, 'blocks'>) {
  const big =
    blocks.length === 1 &&
    blocks[0].t === 'p' &&
    blocks[0].text.length <= BIG_PARAGRAPH;
  // A note that is only an image shows the frame over the whole page.
  if (blocks.length === 1 && blocks[0].t === 'image')
    return (
      <div className="pv-live">
        <div className="pv-paper">
          <ImageMark lone />
        </div>
      </div>
    );
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
      return <ImageMark />;
  }
}

/** Where a note or card front holds an image: previews carry no image bytes
 * (editor assets have no small copy), so a tinted frame with the image glyph. */
function ImageMark({ lone, short }: { lone?: boolean; short?: boolean }) {
  return (
    <div
      className={cn('pv-img', lone && 'pv-img-lone', short && 'pv-img-short')}
    >
      <Icon name="image" size={22} strokeWidth={1.6} />
    </div>
  );
}

const LETTERS = 'ABCD';

export const QuizLive = memo(function QuizLive({
  question,
}: {
  question: QuizPreviewQuestion;
}) {
  const { type, stem, options = [], prompts = [], itemCount } = question;
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
      {type === 'mcq' &&
        options.map((option, i) => (
          <p className="pv-opt" key={i}>
            <i>{LETTERS[i]}</i>
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
          {prompts.map((prompt, i) => (
            <span key={i}>{prompt}</span>
          ))}
        </p>
      )}
      {type === 'ordering' && itemCount !== undefined && (
        <p className="pv-ord">
          <span>⋮⋮</span>
          {orderItemsLabel(itemCount)}
        </p>
      )}
    </div>
  );
});

/** The answer-format line above the stem; single choice and written answers
 * need none. */
function typeLabel(type: QuestionType): string | undefined {
  switch (type) {
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
        {hasImage && <ImageMark short={front.length > ONE_LINE_FRONT} />}
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

/** A CSV or TSV file's opening rows as a small table, its first row the
 * header. Tab-separated when the first line has a tab. */
export const TableLive = memo(function TableLive({ text }: { text: string }) {
  const lines = text.split(LINE_BREAK).filter((line) => line.trim());
  const separator = lines[0]?.includes('\t') ? '\t' : ',';
  const rows = lines
    .slice(0, TABLE_ROWS)
    .map((line) => splitRow(line, separator).slice(0, TABLE_COLUMNS));
  return (
    <div className="pv-live pv-sheet">
      <table className="pv-table">
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) =>
                r === 0 ? <th key={c}>{cell}</th> : <td key={c}>{cell}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/** One delimited line's cells; a quoted cell may hold the separator and
 * doubled quotes. A quote left open at the cut ends the cell. */
function splitRow(line: string, separator: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (line[i + 1] === '"') {
        cell += char;
        i++;
      } else quoted = false;
    } else if (char === '"' && !cell) quoted = true;
    else if (char === separator) {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}
