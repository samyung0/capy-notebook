import { type ReactNode, useId } from 'react';
import { cn } from '@/lib/cn';
import './ActivityIcon.css';
import type { ActivityIconKind } from './trace';

/** Still glyphs for row states and receipts, on the same grid. */
export type StatusIconKind = 'alert' | 'unknown' | 'stop' | 'doc' | 'undone';

const PENCIL =
  'M0 0L.99-3.25 5.23-7.49A1.6 1.6 0 0 1 7.49-5.23L3.25-.99Z M.99-3.25 3.25-.99';
const GLASS_TOP =
  'M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2Z';
const GLASS_BOTTOM =
  'M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22Z';

/** The sand is clipped by the glass outline on a still parent group: a clip
 * on the moving rect would travel with it and cut nothing. */
function Hourglass() {
  const id = useId();
  return (
    <g className="hg">
      <defs>
        <clipPath id={`${id}t`}>
          <path d={GLASS_TOP} />
        </clipPath>
        <clipPath id={`${id}b`}>
          <path d={GLASS_BOTTOM} />
        </clipPath>
      </defs>
      <g fill="currentColor" stroke="none">
        <g clipPath={`url(#${id}t)`}>
          <rect className="hg-t" height="10" width="10" x="7" y="2" />
        </g>
        <g clipPath={`url(#${id}b)`}>
          <rect className="hg-b" height="10" width="10" x="7" y="12" />
        </g>
      </g>
      <path className="hg-s1" d="M12 12v7" strokeWidth="1" />
      <path className="hg-s2" d="M12 12V5" strokeWidth="1" />
      <path d="M5 2h14M5 22h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2" />
    </g>
  );
}

const pacman = (
  <g fill="currentColor" stroke="none">
    <circle className="pm-d pm-d1" cx="21" cy="12" r="1.4" />
    <circle className="pm-d pm-d2" cx="21" cy="12" r="1.4" />
    <circle className="pm-d pm-d3" cx="21" cy="12" r="1.4" />
    <path className="pm-up" d="M1.5 12a6.5 6.5 0 0 1 13 0Z" />
    <path className="pm-dn" d="M1.5 12a6.5 6.5 0 0 0 13 0Z" />
  </g>
);

const DRAWINGS: Record<
  Exclude<ActivityIconKind, 'think'> | StatusIconKind,
  ReactNode
> = {
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </>
  ),
  bouncy: (
    <g fill="currentColor" stroke="none">
      <g className="bc">
        <rect
          className="bci"
          height="4.4"
          rx="1.1"
          width="4.4"
          x="2"
          y="14.6"
        />
      </g>
      <g className="bc bc2">
        <rect
          className="bci"
          height="4.4"
          rx="1.1"
          width="4.4"
          x="9.8"
          y="14.6"
        />
      </g>
      <g className="bc bc3">
        <rect
          className="bci"
          height="4.4"
          rx="1.1"
          width="4.4"
          x="17.6"
          y="14.6"
        />
      </g>
    </g>
  ),
  doc: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </>
  ),
  edit: (
    <>
      <path
        className="ed-l"
        d="M4 19q1.67-2.5 3.33 0t3.33 0t3.34 0"
        pathLength={1}
      />
      <g className="ed-x">
        <g className="ed-y">
          <path d={PENCIL} transform="translate(4 19)" />
        </g>
      </g>
    </>
  ),
  list: (
    <>
      <rect
        className="ls1 ai-card"
        height="12"
        rx="1.6"
        width="9"
        x="3"
        y="8.5"
      />
      <rect className="ai-card" height="12" rx="1.6" width="9" x="7.5" y="6" />
      <rect
        className="ls3 ai-card"
        height="12"
        rx="1.6"
        width="9"
        x="12"
        y="3.5"
      />
    </>
  ),
  look: (
    <>
      <path
        className="lk-c"
        d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"
      />
      <circle cx="12" cy="12" r="3" />
      <circle
        className="lk-f"
        cx="12"
        cy="12"
        fill="currentColor"
        r="3"
        stroke="none"
      />
    </>
  ),
  read: (
    <>
      <path d="M12 7C10.2 5.6 7 5 3.5 5.3v13.2c3.5-.3 6.7.3 8.5 1.7" />
      <path d="M12 7c1.8-1.4 5-2 8.5-1.7v13.2c-3.5-.3-6.7.3-8.5 1.7" />
      <path d="M12 7v13.2" />
      <path
        className="bk-flip"
        d="M12 7c1.8-1.4 5-2 8.5-1.7v13.2c-3.5-.3-6.7.3-8.5 1.7Z"
      />
    </>
  ),
  restore: pacman,
  search: (
    <>
      <path d="M3 16.5c3-1.2 6-1.2 9 0 3-1.2 6-1.2 9 0V21c-3-1.2-6-1.2-9 0-3-1.2-6-1.2-9 0Z" />
      <path d="M12 16.5V21" />
      <g className="lb-x">
        <circle cx="10" cy="7.5" r="3.8" />
        <path d="m12.8 10.3 2.3 2.3" />
      </g>
    </>
  ),
  stop: (
    <>
      <circle cx="12" cy="12" r="9" />
      <rect height="6" rx="1" width="6" x="9" y="9" />
    </>
  ),
  trash: pacman,
  undone: (
    <>
      <path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7" />
      <path d="M4 4v4.7h4.7" />
    </>
  ),
  unknown: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2-2.4 3.6M12 17v.01" />
    </>
  ),
};

/** One 18px trace icon. `running` acts out the work; at rest it is the done
 * icon. Raised 1px so it lines up with the row text. */
export function ActivityIcon({
  kind,
  running = false,
  className,
}: {
  kind: ActivityIconKind | StatusIconKind;
  running?: boolean;
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      className={cn(
        'activity-icon size-4.5 -translate-y-px',
        running && 'run',
        className
      )}
      data-kind={kind}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
    >
      {kind === 'think' ? <Hourglass /> : DRAWINGS[kind]}
    </svg>
  );
}
