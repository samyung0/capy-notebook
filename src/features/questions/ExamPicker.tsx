import { Popover as PopoverPrimitive } from 'radix-ui';
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useState,
} from 'react';
import { coverBackground, useCoverPaint } from '@/components/ui/CoverArt';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Popover, PopoverContent } from '@/components/ui/Popover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { type BankExam, soleSubject, soleTopic } from './bank';

// A soft corner fade keeps white text readable on dark art without the strip
// standing out against a light page; light covers take dark text and no fade,
// as in the switcher.
const FADE =
  'radial-gradient(ellipse 130% 190% at 0% 100%, rgb(0 0 0 / 0.42), rgb(0 0 0 / 0.18) 60%, transparent 95%)';

const questionCount = (exam: BankExam) => {
  const count = exam.subjects.reduce(
    (sum, subject) =>
      sum + subject.topics.reduce((total, topic) => total + topic.total, 0),
    0
  );
  return count === 1
    ? m.question_ui_one_question()
    : m.question_ui_question_count({ count });
};

/** The exam's topic count, or its question count when it has one topic. */
const topicCount = (exam: BankExam) => {
  const count = exam.subjects.reduce(
    (sum, subject) => sum + subject.topics.length,
    0
  );
  return count === 1
    ? questionCount(exam)
    : m.question_ui_topic_count({ count });
};

/**
 * An exam as a low cover strip: name, a description of at most two lines and
 * the topic count, centred against the text. Used by the panel's exam list,
 * its search, the exam switcher and (with `detail` and `trailing` swapped for
 * counts and a chevron) the switcher's trigger. `active` marks the keyboard's
 * option.
 */
export function ExamStrip({
  exam,
  active,
  selected,
  detail,
  trailing,
  className,
  ...rest
}: {
  exam: BankExam;
  active?: boolean;
  selected?: boolean;
  /** Replaces the description. */
  detail?: ReactNode;
  /** Replaces the topic count. */
  trailing?: ReactNode;
} & Omit<ComponentProps<'button'>, 'children'>) {
  const paint = useCoverPaint(exam.id, exam.label, exam.cover);
  return (
    <button
      className={cn(
        'group relative flex w-full items-end overflow-hidden rounded-button px-3 pt-3 pb-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg',
        paint.light ? 'text-[#1d1d1f]' : 'text-white',
        active &&
          (paint.light
            ? 'ring-2 ring-black/30 ring-inset'
            : 'ring-2 ring-white/70 ring-inset'),
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
      {!paint.light && (
        <span
          aria-hidden
          className="absolute inset-0"
          style={{ backgroundImage: FADE }}
        />
      )}
      <span className="relative flex w-full min-w-0 items-center gap-2.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold leading-snug">
            {exam.label}
          </span>
          <span
            className={cn(
              'line-clamp-2 text-xs leading-[1.3]',
              paint.light ? 'text-[#4b4b4b]' : 'text-white/85'
            )}
          >
            {detail ?? exam.description}
          </span>
        </span>
        <span
          className={cn(
            'shrink-0 whitespace-nowrap',
            paint.light
              ? 'text-[#4b4b4b]'
              : 'text-white/90 [text-shadow:0_1px_3px_rgb(0_0_0/0.55)]'
          )}
        >
          {trailing ?? topicCount(exam)}
        </span>
        {selected && <Icon className="size-4 shrink-0" name="tick" />}
      </span>
    </button>
  );
}

/** Subjects, or topics when the subject level is hidden, then questions. */
const examCounts = (exam: BankExam) =>
  [
    soleTopic(exam)
      ? undefined
      : soleSubject(exam)
        ? topicCount(exam)
        : m.question_ui_subject_count({ count: exam.subjects.length }),
    questionCount(exam),
  ]
    .filter(Boolean)
    .join(' · ');

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
        <ExamStrip
          aria-label={m.question_ui_switch_exam({ exam: exam.label })}
          detail={examCounts(exam)}
          exam={exam}
          ref={setAnchor}
          trailing={<Icon className="size-4" name="chevronDown" />}
        />
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
