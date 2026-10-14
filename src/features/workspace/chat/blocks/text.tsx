import { type ComponentProps, type ReactNode, useMemo } from 'react';
import { Streamdown } from 'streamdown';
import { Icon } from '@/components/ui/Icon';
import {
  CALLOUT_CONTAINER_CLASS,
  CALLOUT_ICON,
  CALLOUT_VARIANT_CLASS,
  normalizeCalloutVariant,
} from '@/features/notes/richBlockConfig';
import { cn } from '@/lib/cn';
import type { CalloutProps, MdProps, RevealProps, StepProps } from '../schema';
import { Cites, elements } from './Cite';
import { CodeBlock } from './CodeBlock';
import { chatMath, MathSpan, prepareMath } from './math';

const plugins = { math: chatMath };
const TRAILING_NEWLINE = /\n$/;
const LANGUAGE_CLASS = /language-(\S+)/;

/** Streamdown marks a fenced block's `code` with `data-block` (via `pre`). */
function Code({
  className,
  children,
  ...props
}: ComponentProps<'code'> & { 'data-block'?: string }) {
  if ('data-block' in props) {
    return (
      <CodeBlock
        code={String(children ?? '').replace(TRAILING_NEWLINE, '')}
        language={LANGUAGE_CLASS.exec(className ?? '')?.[1]}
      />
    );
  }
  return (
    <code className="rounded bg-code-inline px-1 py-px font-mono text-[0.9em] text-code-inline-fg">
      {children}
    </code>
  );
}

function Heading({ children }: { children?: ReactNode }) {
  return (
    <h2 className="mt-1 font-semibold text-[17px] tracking-tight first:mt-0">
      {children}
    </h2>
  );
}

const components = {
  a: ({ children, href }: ComponentProps<'a'>) => (
    <a
      className="text-link underline underline-offset-3 hover:text-link-hover"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="border-line border-l-2 pl-2.5 text-fg-secondary">
      {children}
    </blockquote>
  ),
  code: Code,
  h1: Heading,
  h2: Heading,
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mt-1 font-semibold text-[15px] first:mt-0">{children}</h3>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h4 className="font-semibold text-sm">{children}</h4>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className="[&+li]:mt-0.5 [&>p]:inline">{children}</li>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="ml-5 list-outside list-decimal whitespace-normal marker:[font-variant-numeric:normal]">
      {children}
    </ol>
  ),
  span: MathSpan,
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="ml-5 list-outside list-disc whitespace-normal">
      {children}
    </ul>
  ),
};

/**
 * Markdown inside a rich answer (and the plain-Markdown fallback), with
 * `$…$` / `$$…$$` math. Citation markers follow the last paragraph on its
 * line: Streamdown's root is `display: contents`, so that paragraph can sit
 * inline beside the markers while earlier blocks keep their 8px gap.
 */
export function Prose({
  text,
  passages,
  className,
  muted,
}: {
  text: string;
  passages?: number[];
  className?: string;
  muted?: boolean;
}) {
  const source = useMemo(() => prepareMath(text), [text]);
  return (
    <div
      className={cn(
        'streamdown-body max-w-none',
        muted && 'text-fg-secondary',
        className
      )}
    >
      <Streamdown
        className="contents [&>*:not(:last-child)]:mb-2 [&>p:last-child]:inline"
        components={components}
        plugins={plugins}
      >
        {source}
      </Streamdown>
      <Cites passages={passages} />
    </div>
  );
}

export function Md({ props }: { props: MdProps }) {
  return <Prose passages={props.passages} text={props.text} />;
}

export function Callout({ props }: { props: CalloutProps }) {
  const variant = normalizeCalloutVariant(props.kind);
  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-2.5',
        CALLOUT_CONTAINER_CLASS,
        CALLOUT_VARIANT_CLASS[variant]
      )}
    >
      <Icon className="mt-px" name={CALLOUT_ICON[variant]} size={16} />
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 font-semibold text-[13.5px]">{props.title}</p>
        <Prose
          className="text-fg text-sm"
          passages={props.passages}
          text={props.text}
        />
      </div>
    </div>
  );
}

export function Steps({ props }: { props: { items: unknown[] } }) {
  return (
    <ol className="flex flex-col gap-3">
      {elements<StepProps>(props.items).map((step, index) => (
        <li className="relative pl-6" key={index}>
          <span className="absolute top-px left-0 w-4 text-right font-semibold text-fg-muted text-xs">
            {index + 1}
          </span>
          <p className="font-semibold text-sm">{step.props.title}</p>
          <Prose
            className="mt-0.5 text-sm"
            muted
            passages={step.props.passages}
            text={step.props.text}
          />
        </li>
      ))}
    </ol>
  );
}

export function Reveal({ props }: { props: RevealProps }) {
  return (
    <details className="group">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 font-semibold text-link text-sm hover:text-link-hover [&::-webkit-details-marker]:hidden">
        <Icon
          className="transition-transform group-open:rotate-90"
          name="chevronRight"
          size={12}
        />
        {props.title}
      </summary>
      <Prose
        className="mt-3 pl-3 text-sm"
        muted
        passages={props.passages}
        text={props.text}
      />
    </details>
  );
}
