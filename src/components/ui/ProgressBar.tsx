import type { UserColor } from '@/api/types';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';

export interface ProgressBarProps {
  className?: string;
  height?: number;
  showLabel?: boolean;
  tone?: UserColor;
  value?: number;
}

export function ProgressBar({
  value = 0,
  tone = 'graphite',
  height = 6,
  showLabel,
  className,
}: ProgressBarProps) {
  if (tone === 'transparent') tone = 'graphite';
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className="flex-1 overflow-hidden rounded-pill bg-surface-hover-bg"
        style={{ height }}
      >
        <div
          className={cn(
            'h-full rounded-pill transition-[width] duration-400 ease-[cubic-bezier(.2,.7,.2,1)]'
          )}
          style={{
            backgroundColor:
              userColorPair(tone)?.bg ?? userColorPair('graphite')?.bg,
            width: `${pct}%`,
          }}
        />
      </div>
      {showLabel && (
        <span className="t-label text-fg-muted tabular-nums">
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}
