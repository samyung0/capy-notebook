import { getLocale } from '@/i18n';

/** One credit is 1e6 micros — the unit the ledger stores. */
export const MICROS_PER_CREDIT = 1_000_000;

function localeTag(): string {
  try {
    return getLocale();
  } catch {
    return 'en';
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

export function formatCredits(micros: number): string {
  const credits = micros / MICROS_PER_CREDIT;
  return credits.toLocaleString(localeTag(), {
    maximumFractionDigits: credits >= 10 ? 0 : 1,
  });
}

export function usagePercent(
  used: number,
  reserved: number,
  limit: number
): number {
  if (limit <= 0) return 0;
  return Math.min(100, ((used + reserved) / limit) * 100);
}

export function storageLimitLabel(bytes: number): string {
  const unit = bytes >= 1024 ** 3 ? 'GB' : 'MB';
  const divisor = unit === 'GB' ? 1024 ** 3 : 1024 ** 2;
  return `${Math.round(bytes / divisor)} ${unit}`;
}
