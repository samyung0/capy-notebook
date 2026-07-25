import type { ElementType, HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant =
  | 'display'
  | 'page-title'
  | 'section'
  | 'card-title'
  | 'subtitle'
  | 'body'
  | 'meta'
  | 'label';
type Tone = 'primary' | 'secondary' | 'muted' | 'link' | 'inherit';

const VARIANT_CLASS: Record<Variant, string> = {
  body: 't-body',
  'card-title': 't-card-title',
  display: 't-display',
  label: 't-label',
  meta: 't-meta',
  'page-title': 't-page-title',
  section: 't-large-card-title',
  subtitle: 't-subtitle',
};

const TONE_CLASS: Record<Tone, string> = {
  inherit: '',
  link: 'text-link',
  muted: 'text-fg-muted',
  primary: 'text-fg',
  secondary: 'text-fg-secondary',
};

const DEFAULT_TAG: Record<Variant, ElementType> = {
  body: 'p',
  'card-title': 'h3',
  display: 'h1',
  label: 'span',
  meta: 'span',
  'page-title': 'h1',
  section: 'h2',
  subtitle: 'h4',
};

export interface TextProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  tone?: Tone;
  variant?: Variant;
}

export function Text({
  variant = 'body',
  tone = 'primary',
  as,
  className,
  children,
  ...rest
}: TextProps) {
  const Tag = (as ?? DEFAULT_TAG[variant]) as ElementType;
  return (
    <Tag
      className={cn(VARIANT_CLASS[variant], TONE_CLASS[tone], 'm-0', className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}
