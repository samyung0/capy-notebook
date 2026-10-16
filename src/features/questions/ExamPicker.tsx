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
export const topicCount = (exam: BankExam) => {
  const count = exam.subjects.reduce(
    (sum, subject) => sum + subject.topics.length,
    0
  );
  return count === 1
    ? questionCount(exam)
    : m.question_ui_topic_count({ count });
};

/**
 * An exam as a low strip with its cover art fading in from the right: name, a
 * description of at most two lines and the topic count in a pill over the art.
 * Used by the panel's exam list, its search and (with `detail` and `trailing`
 * swapped for counts and a chevron) the exam switcher's trigger.
 */
export function ExamStrip({
  exam,
  detail,
  trailing,
  className,
  ...rest
}: {
  exam: BankExam;
  /** Replaces the description. */
  detail?: ReactNode;
  /** Replaces the topic count. */
  trailing?: ReactNode;
} & Omit<ComponentProps<'button'>, 'children'>) {
  const paint = useCoverPaint(exam.id, exam.label, exam.cover);
  return (
    <button
      className={cn(
        'group relative isolate flex w-full items-center gap-2.5 overflow-hidden rounded-button px-3 py-2.5 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg',
        className
      )}
      type="button"
      {...rest}
    >
      {/* Like a Discord nameplate: the art fills the right side and fades out
          before the text, so the text keeps the theme's colours. Paper covers
          are dimmed in dark mode so the cream does not glare. */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 right-0 left-[30%] -z-10 [mask-image:linear-gradient(to_right,transparent,#000_75%)] dark:opacity-85',
          paint.light && 'dark:brightness-55 dark:saturate-80'
        )}
        style={coverBackground(paint)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-bold leading-snug">
          {exam.label}
        </span>
        <span className="line-clamp-2 text-fg-muted text-xs leading-[1.3]">
          {detail ?? exam.description}
        </span>
      </span>
      <span className="flex shrink-0 items-center whitespace-nowrap rounded-md bg-surface/80 px-2 py-0.5 font-semibold text-xs backdrop-blur-sm">
        {trailing ?? topicCount(exam)}
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
          leftIcon="search"
          leftIconClassName="-translate-y-px"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={m.question_ui_find_an_exam()}
          role="combobox"
          value={query}
          variant="underline"
          wrapperClassName="h-9 w-full gap-2.5 px-2 text-sm"
        />
        <div
          className="flex max-h-96 flex-col overflow-auto"
          id={listId}
          role="listbox"
        >
          {matches.map((item, i) => (
            <button
              aria-selected={item.id === exam.id}
              className={cn(
                'flex w-full items-center gap-2 rounded-button px-2 py-1.5 text-left outline-none hover:bg-surface-hover-bg',
                i === activeIdx && 'bg-surface-hover-bg'
              )}
              id={`${listId}-${i}`}
              key={item.id}
              onClick={() => pick(item.id)}
              onMouseEnter={() => setActive(i)}
              role="option"
              tabIndex={-1}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {item.label}
              </span>
              <span className="shrink-0 text-fg-muted text-xs">
                {topicCount(item)}
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
