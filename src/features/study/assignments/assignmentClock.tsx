import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';

export const HOUR = 60 * 60 * 1000;

/** The clock left, counted from the server's time at the read. With `within`,
 * it ticks each second only from that long before the end: until then it
 * rechecks once a minute, which also survives a sleeping laptop. */
export function useTimeLeft(
  deadlineAt: string | undefined,
  serverNow: string,
  within?: number
) {
  const offset = useRef(Date.parse(serverNow) - Date.now());
  const left = useCallback(
    () =>
      deadlineAt
        ? Date.parse(deadlineAt) - (Date.now() + offset.current)
        : null,
    [deadlineAt]
  );
  const [ms, setMs] = useState(left);
  useEffect(() => {
    // An end taken away (No late turned off) leaves no clock.
    setMs(left());
    if (!deadlineAt) return;
    let tick: ReturnType<typeof setInterval> | undefined;
    let later: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const wait = within === undefined ? 0 : (left() ?? 0) - within;
      if (wait > 0) {
        later = setTimeout(arm, Math.min(wait, 60_000));
        return;
      }
      setMs(left());
      tick = setInterval(() => setMs(left()), 1000);
    };
    arm();
    return () => {
      clearTimeout(later);
      clearInterval(tick);
    };
  }, [deadlineAt, left, within]);
  return ms;
}

/** The earliest of the times given, if any. */
export const earliest = (...times: (string | undefined)[]) =>
  times
    .filter((t): t is string => !!t)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];

function clockText(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** "12:34 left" in its chip: the take page's clock, and the running attempt's
 * on its assignment's page (Epo 2026-11-25). */
export function TimeLeft({ ms }: { ms: number }) {
  return (
    <ClockChip role="timer">
      <Icon name="clock" size={16} />
      {m.assignment_time_left({ time: clockText(ms) })}
    </ClockChip>
  );
}

/** The clock's chip, also In progress where a running attempt has no clock. */
export function ClockChip({
  children,
  role,
}: {
  children: ReactNode;
  role?: 'timer';
}) {
  return (
    <span
      aria-live={role && 'off'}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-page-hover px-3.5 font-bold"
      role={role}
    >
      {children}
    </span>
  );
}
