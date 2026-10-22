import type { ComponentProps, ReactNode } from 'react';
import { coverBackground, useCoverPaint } from '@/components/ui/CoverArt';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { CoverPaint } from '@/lib/coverArt';
import { type BankExam, soleTopic } from './bank';

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

/** A mask from full to clear along `ease` (1 → 0 over t 0 → 1), with `at(t)`
 * placing each stop, in enough stops that no stop shows as an edge. */
const fade = (
  direction: string,
  at: (t: number) => string,
  ease: (t: number) => number
) => {
  const stops = Array.from({ length: 13 }, (_, i) => {
    const t = i / 12;
    return `rgb(0 0 0 / ${ease(t).toFixed(3)}) ${at(t)}`;
  });
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
};

// The art's strongest, behind the strip's name: short of full, so the
// cover's solid corner doesn't overpower the panel.
const PEAK = 0.9;

// The art fades out to the right so the panel's end of the strip stays plain.
const FADE_RIGHT = fade(
  'to right',
  (t) => `${12 + 80 * t}%`,
  (t) => PEAK * (1 - t * t * (3 - 2 * t))
);

// Down the art: full strength behind the strip, then a drop that starts flat
// (so it has no edge), is near half 30px past the strip in a full 320px wash
// so the rows stay readable, and tails off slowly to clear at the art's
// bottom, spreading the colour over several rows. The
// stops follow the art's height, so a closed exam (art only as tall as the
// strip) shows no fade and a short open exam fades out within its rows.
const STRIP = 44;
const DROP = 7;
const TAIL = 1 / (1 + DROP ** 2);
const FADE_DOWN = fade(
  'to bottom',
  (t) => `calc(${STRIP}px + (100% - ${STRIP}px) * ${t.toFixed(4)})`,
  (t) => (1 / (1 + (DROP * t) ** 2) - TAIL) / (1 - TAIL)
);

/**
 * The exam's cover art, drawn once behind its strip and tree: anchored left
 * where it stays visible, fading right and down, with its outer edges shaded
 * (a bottom shade made the strip look bulged). Drawings keep the strip's
 * scale and repeat downward, so the pattern fades out with the colour instead
 * of growing. It is as tall as its section up to 320px, so opening the exam
 * pours it down with the rows and the bottom corners ease square.
 */
function ExamArt({ paint, open }: { paint: CoverPaint; open: boolean }) {
  const background = coverBackground({ ...paint, right: false });
  return (
    // The mask and the rounding sit on separate elements: Chrome leaves a
    // hairline of a masked element's rounded corner where the mask is clear.
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[320px] max-h-full"
      style={{
        maskComposite: 'intersect',
        maskImage: `${FADE_RIGHT}, ${FADE_DOWN}`,
      }}
    >
      <span
        className={cn(
          'absolute inset-0 overflow-hidden rounded-2xl transition-[border-radius] duration-(--motion-duration-fast) ease-(--motion-ease-smooth-out)',
          open && 'rounded-b-none'
        )}
      >
        <span
          className="absolute inset-0"
          style={
            paint.repeat
              ? background
              : {
                  ...background,
                  // As `cover` draws it in a 44px strip (344×76 art, wider
                  // than tall there), centred on the strip.
                  backgroundPosition: 'left calc(22px - 100cqw * 38 / 344)',
                  backgroundRepeat: 'repeat-y',
                  backgroundSize: '100% auto',
                }
          }
        />
        <span
          className={cn(
            'absolute inset-0 rounded-[inherit]',
            paint.light
              ? 'shadow-[inset_0_0_10px_rgb(0_0_0/0.14)]'
              : 'shadow-[inset_0_0_14px_rgb(0_0_0/0.45)]'
          )}
        />
      </span>
    </span>
  );
}

/**
 * An exam as a 44px cover strip over its section's art. Covers look the same
 * in every theme, so the name takes the cover's text colour as on workspace
 * cards; the count and chevron sit on the panel. `open` turns the chevron up.
 */
function ExamStrip({
  exam,
  paint,
  open,
  className,
  ...rest
}: {
  exam: BankExam;
  paint: CoverPaint;
  open: boolean;
} & Omit<ComponentProps<'button'>, 'children'>) {
  return (
    <button
      className={cn(
        'relative flex h-11 w-full items-center gap-2 rounded-2xl pr-2.5 pl-3.5 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg',
        className
      )}
      type="button"
      {...rest}
    >
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-bold',
          paint.light ? 'text-[#1d1d1f]' : 'text-white'
        )}
      >
        {exam.label}
      </span>
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap font-semibold text-fg-secondary text-xs">
        {topicCount(exam)}
        {/* A sole-topic exam opens its topic, so it has nothing to expand. */}
        {!soleTopic(exam) && (
          <Icon
            className={cn(
              'motion-accordion-chevron size-3.5',
              open && '-scale-y-100'
            )}
            name="chevronDown"
          />
        )}
      </span>
    </button>
  );
}

/**
 * The bank tree's exam: its strip, then (open) its subjects and topics, with
 * the cover drawn once behind both so the strip runs down into the list.
 * `data-cover-wash` makes the row tints inside see-through (tailwind.css), so
 * a hover darkens the wash wherever it is instead of covering it.
 */
export function ExamSection({
  exam,
  open,
  children,
  ...rest
}: {
  exam: BankExam;
  open: boolean;
  children?: ReactNode;
} & Omit<ComponentProps<'button'>, 'children'>) {
  const paint = useCoverPaint(exam.id, exam.label, exam.cover);
  return (
    // A size container, so the art's cqw is the strip's width.
    <div className="@container relative isolate" data-cover-wash>
      <ExamArt open={open} paint={paint} />
      <ExamStrip exam={exam} open={open} paint={paint} {...rest} />
      {children}
    </div>
  );
}
