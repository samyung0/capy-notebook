import type { UserColor } from '@/api/types';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';

export interface ProgressBarProps {
  className?: string;
  height?: number;
  /** Work with no measurable progress: a sweeping bar instead of `value`. */
  indeterminate?: boolean;
  segments?: { value: number; tone: UserColor; label: string }[];
  showLabel?: boolean;
  tone?: UserColor;
  value?: number;
}

export function ProgressBar({
  value = 0,
  tone = 'graphite',
  height = 6,
  indeterminate,
  showLabel,
  className,
  segments,
}: ProgressBarProps) {
  if (tone === 'transparent') tone = 'graphite';
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className="flex flex-1 overflow-hidden rounded-full bg-surface-hover-bg"
        style={{ height }}
      >
        {indeterminate ? (
          <div
            className="motion-indeterminate h-full w-1/3 rounded-full"
            style={{ backgroundColor: userColorPair(tone)?.bg }}
          />
        ) : segments ? (
          segments.map((segment) => (
            <div
              className="h-full"
              key={segment.label}
              style={{
                backgroundColor: userColorPair(segment.tone)?.bg,
                width: `${Math.max(0, Math.min(100, segment.value))}%`,
              }}
              title={segment.label}
            />
          ))
        ) : (
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-400 ease-(--motion-ease-smooth-out)'
            )}
            style={{
              backgroundColor:
                userColorPair(tone)?.bg ?? userColorPair('graphite')?.bg,
              width: `${pct}%`,
            }}
          />
        )}
      </div>
      {showLabel && (
        <span className="t-label text-fg-muted tabular-nums">
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}
