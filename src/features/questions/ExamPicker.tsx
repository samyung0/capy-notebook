import { Popover as PopoverPrimitive } from 'radix-ui';
import { type KeyboardEvent, useId, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Popover, PopoverContent } from '@/components/ui/Popover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { BankExam } from './bank';
import {
  type CoverPaint,
  coverPaint,
  glyphFont,
  LEAD_GLYPH,
} from './examCover';

const useCoverPaint = (exam: BankExam) =>
  useMemo(
    () => coverPaint(exam.id, exam.label, exam.cover),
    [exam.id, exam.label, exam.cover]
  );

const background = (paint: CoverPaint) => ({
  backgroundColor: paint.color,
  backgroundImage: paint.image,
  backgroundPosition: paint.right ? 'right center' : 'center',
  backgroundSize: paint.repeat ? 'auto' : 'cover',
});

/**
 * An exam's small square: its cover art, or for symbols and paper covers,
 * whose art crops badly that small, the kind's lead glyph.
 */
export function ExamTile({ exam }: { exam: BankExam }) {
  const paint = useCoverPaint(exam);
  const { kind, style } = exam.cover;
  if ((style === 'symbols' || style === 'paper') && kind)
    return (
      <span
        aria-hidden
        className={cn(
          'grid size-7.5 shrink-0 place-items-center rounded-[8px] text-[15px] leading-none',
          kind !== 'kana' && 'italic'
        )}
        style={{
          backgroundColor: paint.light ? '#fbf9f3' : paint.color,
          color: paint.light ? paint.color : '#fff',
          fontFamily: glyphFont(kind),
        }}
      >
        {LEAD_GLYPH[kind]}
      </span>
    );
  return (
    <span
      aria-hidden
      className="size-7.5 shrink-0 rounded-[8px]"
      style={background(paint)}
    />
  );
}

const examCounts = (exam: BankExam) => {
  const questions = exam.subjects.reduce(
    (sum, subject) =>
      sum + subject.topics.reduce((total, topic) => total + topic.total, 0),
    0
  );
  return [
    exam.subjects.length === 1
      ? m.question_ui_one_subject()
      : m.question_ui_subject_count({ count: exam.subjects.length }),
    questions === 1
      ? m.question_ui_one_question()
      : m.question_ui_question_count({ count: questions }),
  ].join(' · ');
};

/**
 * The picked exam as a cover strip; it opens a searchable list of every exam.
 * Covers are theme-independent art, so their text colours are fixed.
 */
export function ExamPicker({
  exams,
  exam,
  onPick,
}: {
  exams: BankExam[];
  exam: BankExam;
  onPick: (id: string) => void;
}) {
  const paint = useCoverPaint(exam);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const listId = useId();
  const needle = query.trim().toLocaleLowerCase();
  const matches = exams.filter((item) =>
    [item.label, item.fullLabel].some((label) =>
      label.toLocaleLowerCase().includes(needle)
    )
  );
  const activeIdx = Math.min(active, matches.length - 1);
  function pick(id: string) {
    setOpen(false);
    if (id !== exam.id) onPick(id);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(Math.min(activeIdx + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(activeIdx - 1, 0));
    } else if (event.key === 'Enter' && matches[activeIdx]) {
      event.preventDefault();
      pick(matches[activeIdx].id);
    }
  }
  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        setQuery('');
        setActive(0);
      }}
      open={open}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          aria-label={m.question_ui_switch_exam({ exam: exam.label })}
          className="group relative flex h-[76px] w-full items-end gap-3 overflow-hidden rounded-button px-3 pb-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg"
          ref={setAnchor}
          type="button"
        >
          <span
            aria-hidden
            className="absolute inset-0 transition-[filter] group-hover:brightness-105"
            style={background(paint)}
          />
          {paint.shade && (
            <span
              aria-hidden
              className="absolute inset-0 bg-linear-to-t from-black/50 to-80% to-transparent"
            />
          )}
          <span
            className={cn(
              'relative min-w-0 flex-1',
              paint.light ? 'text-[#1d1d1f]' : 'text-white'
            )}
          >
            <span className="block truncate font-bold text-[1.0625rem] leading-snug">
              {exam.label}
            </span>
            <span
              className={cn(
                't-meta block truncate',
                paint.light ? 'text-[#4b4b4b]' : 'text-white/85'
              )}
            >
              {examCounts(exam)}
            </span>
          </span>
          <Icon
            className={cn(
              'relative mb-1 size-4 shrink-0',
              paint.light ? 'text-[#4b4b4b]' : 'text-white'
            )}
            name="unfold"
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverContent
        align="start"
        alignWidthToTrigger
        className="gap-1.5 rounded-card p-1.5"
        // Inside the phone sheet the list must render in the sheet's layer.
        container={anchor?.closest<HTMLElement>('[data-slot="drawer-content"]')}
        sideOffset={6}
      >
        <Input
          aria-activedescendant={
            matches.length ? `${listId}-${activeIdx}` : undefined
          }
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded
          aria-label={m.question_ui_find_an_exam()}
          autoComplete="off"
          leftIcon="search"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={m.question_ui_find_an_exam()}
          role="combobox"
          size="sm"
          value={query}
          wrapperClassName="h-9 w-full text-sm"
        />
        <div
          className="flex max-h-80 flex-col gap-0.5 overflow-auto"
          id={listId}
          role="listbox"
        >
          {matches.map((item, i) => (
            <button
              aria-selected={item.id === exam.id}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-button px-2 py-1.5 text-left',
                i === activeIdx ? 'bg-overlay-hover' : 'hover:bg-overlay-hover'
              )}
              id={`${listId}-${i}`}
              key={item.id}
              onClick={() => pick(item.id)}
              onMouseEnter={() => setActive(i)}
              role="option"
              tabIndex={-1}
              type="button"
            >
              <ExamTile exam={item} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">
                  {item.label}
                </span>
                <span className="t-meta block truncate text-fg-muted">
                  {item.fullLabel}
                </span>
              </span>
              {item.id === exam.id && (
                <Icon className="size-4 shrink-0" name="tick" />
              )}
            </button>
          ))}
        </div>
        {!matches.length && (
          <p className="px-2 py-1.5 text-fg-muted">
            {m.question_ui_no_exams_match()}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
