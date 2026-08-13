import { getLocale } from '@/i18n';

export function monthName(d: Date, style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(getLocale(), { month: style }).format(d);
}

export function weekdayName(
  d: Date,
  style: 'short' | 'long' = 'short'
): string {
  return new Intl.DateTimeFormat(getLocale(), { weekday: style }).format(d);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** 6×7 grid of dates (Mon-first) covering the month containing `d`. */
export function monthGrid(d: Date): Date[] {
  const first = startOfMonth(d);
  const weekday = (first.getDay() + 6) % 7; // Mon = 0
  const start = new Date(first);
  start.setDate(first.getDate() - weekday);
  return Array.from({ length: 42 }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return day;
  });
}

/** Mon-first week containing `d`. */
export function weekDays(d: Date): Date[] {
  const weekday = (d.getDay() + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - weekday);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    return day;
  });
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(getLocale(), {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function hourOf(iso: string): number {
  const d = new Date(iso);
  return d.getHours() + d.getMinutes() / 60;
}

/** Locale-aware hour label for the time gutter (12h vs 24h follows locale). */
export function fmtHour(h: number): string {
  const d = new Date(2000, 0, 1, h % 24, 0, 0);
  return new Intl.DateTimeFormat(getLocale(), { hour: 'numeric' }).format(d);
}

/** Midnight of the given date — strips the time component. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
