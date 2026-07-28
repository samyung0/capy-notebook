import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type NamedSize = 'xs' | 'sm' | 'md' | 'lg';
const SIZES: Record<NamedSize, number> = { lg: 48, md: 38, sm: 30, xs: 24 };
const WHITESPACE_PATTERN = /\s+/;

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name?: string;
  size?: NamedSize | number;
  src?: string;
}

function initials(name?: string): string {
  if (!name) return '·';
  return name
    .split(WHITESPACE_PATTERN)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

export function Avatar({
  src,
  name,
  size = 'md',
  className,
  style,
  ...rest
}: AvatarProps) {
  const px = typeof size === 'number' ? size : SIZES[size];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-tint-accent-1 font-bold text-tint-accent-1-fg",
        className,
      )}
      style={{ fontSize: px * 0.4, height: px, width: px, ...style }}
      {...rest}
    >
      {src ? (
        <img
          alt={name ?? ""}
          className="h-full w-full object-cover"
          src={src}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
