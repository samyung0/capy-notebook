import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** The ways New quiz and New graded quiz make a quiz. */
export type QuizWay = 'existing' | 'convert' | 'generate' | 'bank' | 'create';

// Line drawings on a 120×72 grid, in theme colours so dark mode follows.
const DRAWINGS: Record<QuizWay, ReactNode> = {
  // An open archive box of folders, one document pulled up (Epo 2026-11-20).
  bank: (
    <>
      <path className="fill-surface-dark" d="M20 38 L26 29 H94 L100 38 Z" />
      <rect
        className="fill-surface stroke-fg-muted/50"
        height="6"
        rx="1.5"
        width="12"
        x="76"
        y="15"
      />
      <rect
        className="fill-surface stroke-fg-muted/50"
        height="18"
        rx="1.5"
        width="60"
        x="30"
        y="20"
      />
      <rect
        className="fill-surface stroke-fg-muted/50"
        height="6"
        rx="1.5"
        width="12"
        x="34"
        y="20"
      />
      <rect
        className="fill-surface stroke-fg-muted/50"
        height="13"
        rx="1.5"
        width="64"
        x="28"
        y="25"
      />
      <rect
        className="fill-surface stroke-solid-accent-1"
        height="42"
        rx="2"
        width="28"
        x="46"
        y="2"
      />
      <rect
        className="fill-tint-accent-1-fg stroke-none"
        height="3"
        rx="1.5"
        width="18"
        x="51"
        y="8"
      />
      {[
        [14, 14],
        [20, 16],
        [26, 12],
      ].map(([y, width]) => (
        <rect
          className="fill-solid-accent-1/60 stroke-none"
          height="3"
          key={y}
          rx="1.5"
          width={width}
          x="51"
          y={y}
        />
      ))}
      <path
        className="fill-surface-hover-bg"
        d="M20 38 H100 V63 Q100 66 97 66 H23 Q20 66 20 63 Z"
      />
      <rect
        className="fill-surface stroke-fg-muted/50"
        height="10"
        rx="1"
        width="14"
        x="27"
        y="44"
      />
      <rect
        className="fill-surface"
        height="7"
        rx="3.5"
        width="20"
        x="50"
        y="47"
      />
    </>
  ),
  // A page with a question lifted out of it.
  convert: (
    <>
      <rect
        className="fill-surface"
        height="60"
        rx="3"
        width="40"
        x="12"
        y="6"
      />
      <rect
        className="fill-line stroke-none"
        height="3"
        rx="1.5"
        width="26"
        x="18"
        y="12"
      />
      <rect
        className="fill-line stroke-none"
        height="3"
        rx="1.5"
        width="20"
        x="18"
        y="18"
      />
      <rect
        className="fill-tint-accent-1 stroke-solid-accent-1"
        height="20"
        rx="2.5"
        width="31"
        x="16.5"
        y="25"
      />
      <rect
        className="fill-solid-accent-1 stroke-none"
        height="3"
        rx="1.5"
        width="22"
        x="20"
        y="29.5"
      />
      <rect
        className="fill-solid-accent-1/60 stroke-none"
        height="3"
        rx="1.5"
        width="16"
        x="20"
        y="36.5"
      />
      <rect
        className="fill-line stroke-none"
        height="3"
        rx="1.5"
        width="26"
        x="18"
        y="51"
      />
      <rect
        className="fill-line stroke-none"
        height="3"
        rx="1.5"
        width="18"
        x="18"
        y="57"
      />
      <path className="stroke-fg-muted" d="M57 36 H68 M64 32 L68 36 L64 40" />
      <rect
        className="fill-surface stroke-solid-accent-1"
        height="40"
        rx="3"
        width="36"
        x="73"
        y="16"
      />
      <rect
        className="fill-tint-accent-1-fg stroke-none"
        height="3"
        rx="1.5"
        width="24"
        x="78"
        y="22"
      />
      <circle className="stroke-fg-muted/50" cx="80.5" cy="34" r="2.5" />
      <rect
        className="fill-line stroke-none"
        height="3"
        rx="1.5"
        width="18"
        x="85"
        y="32.5"
      />
      <circle className="stroke-fg-muted/50" cx="80.5" cy="44" r="2.5" />
      <rect
        className="fill-line stroke-none"
        height="3"
        rx="1.5"
        width="14"
        x="85"
        y="42.5"
      />
    </>
  ),
  // A wide empty card with a plus (Epo 2026-11-20).
  create: (
    <>
      <rect
        className="fill-surface stroke-fg-muted"
        height="48"
        rx="3"
        strokeDasharray="4 3"
        width="80"
        x="20"
        y="12"
      />
      <path
        className="stroke-solid-accent-1"
        d="M60 27 V45 M51 36 H69"
        strokeWidth={2}
      />
    </>
  ),
  // A list of the workspace's files, one picked.
  existing: (
    <>
      <rect
        className="fill-tint-accent-1 stroke-none"
        height="20"
        rx="4"
        width="96"
        x="12"
        y="6"
      />
      <circle className="stroke-solid-accent-1" cx="22" cy="16" r="5" />
      <circle
        className="fill-solid-accent-1 stroke-none"
        cx="22"
        cy="16"
        r="2.4"
      />
      <path
        className="fill-solid-accent-1 stroke-none"
        d="M39 10 L33.5 17 H37.5 L36.5 22 L42 15 H38 Z"
      />
      <rect
        className="fill-tint-accent-1-fg stroke-none"
        height="5"
        rx="2.5"
        width="46"
        x="48"
        y="13.5"
      />
      <circle className="stroke-fg-muted/50" cx="22" cy="37" r="5" />
      <path
        className="stroke-solid-info"
        d="M34 31.5 H39.5 L42.5 34.5 V42.5 H34 Z"
      />
      <rect
        className="fill-line stroke-none"
        height="5"
        rx="2.5"
        width="36"
        x="48"
        y="34.5"
      />
      <circle className="stroke-fg-muted/50" cx="22" cy="57" r="5" />
      <path
        className="stroke-solid-error"
        d="M34 51.5 H39.5 L42.5 54.5 V62.5 H34 Z"
      />
      <rect
        className="fill-line stroke-none"
        height="5"
        rx="2.5"
        width="42"
        x="48"
        y="54.5"
      />
    </>
  ),
  // Sparkles beside new question cards.
  generate: (
    <>
      <path
        className="fill-tint-accent-1 stroke-solid-accent-1"
        d="M32 16 C33.4 30 35.5 33 49 36 C35.5 39 33.4 42 32 56 C30.6 42 28.5 39 15 36 C28.5 33 30.6 30 32 16 Z"
      />
      <path
        className="fill-solid-accent-1 stroke-none"
        d="M50 8 C50.6 13.2 51.4 14 56 15 C51.4 16 50.6 16.8 50 22 C49.4 16.8 48.6 16 44 15 C48.6 14 49.4 13.2 50 8 Z"
      />
      <circle
        className="fill-solid-accent-1 stroke-none"
        cx="15"
        cy="15"
        r="2"
      />
      <rect
        className="fill-surface stroke-line"
        height="36"
        rx="3"
        width="36"
        x="72"
        y="8"
      />
      <rect
        className="fill-surface"
        height="42"
        rx="3"
        width="40"
        x="64"
        y="22"
      />
      <rect
        className="fill-fg stroke-none"
        height="3"
        rx="1.5"
        width="26"
        x="70"
        y="29"
      />
      <circle className="stroke-fg-muted/50" cx="72.5" cy="41" r="2.5" />
      <rect
        className="fill-line stroke-none"
        height="3"
        rx="1.5"
        width="20"
        x="77"
        y="39.5"
      />
      <circle className="stroke-fg-muted/50" cx="72.5" cy="51" r="2.5" />
      <rect
        className="fill-line stroke-none"
        height="3"
        rx="1.5"
        width="16"
        x="77"
        y="49.5"
      />
    </>
  ),
};

/** A way's drawing on its card (Epo 2026-11-20, board B): what the way does at
 * a glance. Decorative, as the card names and describes it. */
export function QuizWayArt({
  className,
  way,
}: {
  className?: string;
  way: QuizWay;
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn('shrink-0', className)}
      viewBox="0 0 120 72"
    >
      <g
        className="fill-none stroke-fg"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.4}
      >
        {DRAWINGS[way]}
      </g>
    </svg>
  );
}
