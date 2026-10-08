import { Popover as PopoverPrimitive } from 'radix-ui';
import {
  type ComponentProps,
  type KeyboardEvent,
  useId,
  useState,
} from 'react';
import {
  CoverArt,
  coverBackground,
  useCoverPaint,
} from '@/components/ui/CoverArt';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Popover, PopoverContent } from '@/components/ui/Popover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { BankExam } from './bank';

// Corner fades (bank exam list mocks, round 3): white text stays readable on
// any art, and light covers such as paper need the darker one.
const FADE =
  'radial-gradient(ellipse 130% 190% at 0% 100%, rgb(0 0 0 / 0.74), rgb(0 0 0 / 0.4) 60%, rgb(0 0 0 / 0.1) 95%)';
const LIGHT_FADE =
  'radial-gradient(ellipse 140% 200% at 0% 100%, rgb(0 0 0 / 0.88), rgb(0 0 0 / 0.6) 60%, rgb(0 0 0 / 0.32) 95%)';

const topicCount = (exam: BankExam) => {
  const count = exam.subjects.reduce(
    (sum, subject) => sum + subject.topics.length,
    0
  );
  return count === 1
    ? m.question_ui_one_topic()
    : m.question_ui_topic_count({ count });
};

/**
 * An exam as a low cover strip: name, a description of at most two lines and
 * the topic count, centred against the text. Used by the panel's exam list,
 * its search and the exam switcher. `active` marks the keyboard's option.
 */
export function ExamStrip({
  exam,
  active,
  selected,
  className,
  ...rest
}: {
  exam: BankExam;
  active?: boolean;
  selected?: boolean;
} & Omit<ComponentProps<'button'>, 'children'>) {
  const paint = useCoverPaint(exam.id, exam.label, exam.cover);
  return (
    <button
      className={cn(
        'group relative flex min-h-15 w-full items-end overflow-hidden rounded-button px-3 pt-4.5 pb-2 text-left text-white outline-none focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg',
        active && 'ring-2 ring-white/70 ring-inset',
        className
      )}
      type="button"
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 transition-[filter] group-hover:brightness-110',
          active && 'brightness-110'
        )}
        style={coverBackground(paint)}
      />
      <span
        aria-hidden
        className="absolute inset-0"
        style={{ backgroundImage: paint.light ? LIGHT_FADE : FADE }}
      />
      <span className="relative flex w-full min-w-0 items-center gap-2.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold leading-snug">
            {exam.label}
          </span>
          <span className="t-meta line-clamp-2 text-white/85 leading-[1.3]">
            {exam.description}
          </span>
        </span>
        <span className="shrink-0 whitespace-nowrap font-bold text-white/90 text-xs tabular-nums [text-shadow:0_1px_3px_rgb(0_0_0/0.55)]">
          {topicCount(exam)}
        </span>
        {selected && <Icon className="size-4 shrink-0" name="tick" />}
      </span>
    </button>
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
  const paint = useCoverPaint(exam.id, exam.label, exam.cover);
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
          <CoverArt
            className="transition-[filter] group-hover:brightness-105"
            paint={paint}
          />
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
        className="gap-2 rounded-card p-2"
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
          className="py-0"
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
          className="flex max-h-96 flex-col gap-2.5 overflow-auto"
          id={listId}
          role="listbox"
        >
          {matches.map((item, i) => (
            <ExamStrip
              active={i === activeIdx}
              aria-selected={item.id === exam.id}
              exam={item}
              id={`${listId}-${i}`}
              key={item.id}
              onClick={() => pick(item.id)}
              onMouseEnter={() => setActive(i)}
              role="option"
              selected={item.id === exam.id}
              tabIndex={-1}
            />
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
