import { type HTMLAttributes, useState } from 'react';
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
  // Keyed by src so a new image starts loading again.
  return (
    <AvatarFrame
      className={className}
      key={src}
      name={name}
      src={src}
      {...rest}
    />
  );
}

/** Pulses like a skeleton until the image arrives; a failed image falls
 * back to initials. */
function AvatarFrame({ src, name, className, ...rest }: AvatarProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>(
    'loading'
  );
  const showImage = src && status !== 'error';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-tint-accent-1 font-bold text-tint-accent-1-fg',
        showImage &&
          status === 'loading' &&
          'animate-pulse bg-surface-hover-bg [animation-timing-function:var(--motion-ease-linear)]',
        className
      )}
      {...rest}
    >
      {showImage ? (
        <img
          alt={name ?? ''}
          className={cn(
            'h-full w-full object-cover',
            status === 'loading' && 'opacity-0'
          )}
          onError={() => setStatus('error')}
          onLoad={() => setStatus('loaded')}
          src={src}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
