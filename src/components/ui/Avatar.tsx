import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const WHITESPACE_PATTERN = /\s+/;

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name?: string;
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

export function Avatar({ src, name, className, ...rest }: AvatarProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-tint-accent-1 font-bold text-tint-accent-1-fg',
        className
      )}
      {...rest}
    >
      {src ? (
        <img
          alt={name ?? ''}
          className="h-full w-full object-cover"
          src={src}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
