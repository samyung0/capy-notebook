const compactNumber = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
});
const fullNumber = new Intl.NumberFormat('en-US');
const dateTime = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const shortDate = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
});

export function formatCredits(micros: number): string {
  return `${compactNumber.format(micros / 1_000_000)} cr`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatCount(value: number): string {
  return fullNumber.format(value);
}

export function formatDateTime(value: string | null): string {
  return value ? dateTime.format(new Date(value)) : 'Never';
}

export function formatShortDate(value: string): string {
  return shortDate.format(new Date(value));
}

export function percent(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return '0%';
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}
