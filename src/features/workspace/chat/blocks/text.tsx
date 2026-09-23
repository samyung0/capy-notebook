import { Streamdown } from 'streamdown';
import { Icon, type IconName } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';
import type { CalloutProps, MdProps, RevealProps, StepProps } from '../schema';
import { Cites, elements } from './Cite';

/** Markdown inside a rich answer; the same list styling the plain answer had. */
export function Prose({
  text,
  className,
  muted,
}: {
  text: string;
  className?: string;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        'streamdown-body max-w-none [&_p]:my-1.5 [&_pre]:my-2',
        muted && 'text-fg-secondary',
        className
      )}
    >
      <Streamdown
        className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        components={{
          ol: ({ children }) => (
            <ol className="ml-4 list-outside list-decimal whitespace-normal">
              {children}
            </ol>
          ),
          ul: ({ children }) => (
            <ul className="ml-4 list-outside list-disc whitespace-normal">
              {children}
            </ul>
          ),
        }}
      >
        {text}
      </Streamdown>
    </div>
  );
}

export function Md({ props }: { props: MdProps }) {
  return (
    <div className="my-2">
      <Prose text={props.text} />
      <Cites passages={props.passages} />
    </div>
  );
}

const CALLOUT: Record<
  CalloutProps['kind'],
  { className: string; icon: IconName }
> = {
  danger: { className: 'bg-tint-error text-tint-error-fg', icon: 'error' },
  info: { className: 'bg-tint-info text-tint-info-fg', icon: 'info' },
  success: {
    className: 'bg-tint-success text-tint-success-fg',
    icon: 'circleCheck',
  },
  tip: {
    className: 'bg-tint-accent-1 text-tint-accent-1-fg',
    icon: 'sparkles',
  },
  warning: {
    className: 'bg-tint-warning text-tint-warning-fg',
    icon: 'warning',
  },
};

export function Callout({ props }: { props: CalloutProps }) {
  const style = CALLOUT[props.kind] ?? CALLOUT.info;
  return (
    <div className={cn('my-3 rounded-card px-3 py-2.5', style.className)}>
      <p className="mb-1 flex items-center gap-1.5 font-semibold text-xs">
        <Icon name={style.icon} size={14} />
        {props.title}
      </p>
      <Prose
        className="text-[13px] text-current [&_p]:my-1"
        text={props.text}
      />
      <Cites passages={props.passages} />
    </div>
  );
}

export function Steps({ props }: { props: { items: unknown[] } }) {
  return (
    <ol className="my-3 flex flex-col">
      {elements<StepProps>(props.items).map((step, index) => (
        <li
          className="relative pb-3.5 pl-8 last:pb-0 [&:not(:last-child)]:before:absolute [&:not(:last-child)]:before:top-6 [&:not(:last-child)]:before:bottom-0.5 [&:not(:last-child)]:before:left-[9px] [&:not(:last-child)]:before:border-divider [&:not(:last-child)]:before:border-l"
          key={index}
        >
          <span className="absolute top-0 left-0 grid size-5 place-items-center rounded-full border border-line bg-surface text-[10px] text-fg-muted">
            {index + 1}
          </span>
          <p className="font-semibold text-xs">{step.props.title}</p>
          <Prose
            className="text-[13px] [&_p]:my-0.5"
            muted
            text={step.props.text}
          />
          <Cites passages={step.props.passages} />
        </li>
      ))}
    </ol>
  );
}

export function Reveal({ props }: { props: RevealProps }) {
  return (
    <details className="my-2 rounded-card border border-line px-3 py-2">
      <summary className="cursor-pointer font-semibold text-xs">
        {props.title}
      </summary>
      <div className="mt-1.5">
        <Prose className="text-[13px]" muted text={props.text} />
        <Cites passages={props.passages} />
      </div>
    </details>
  );
}
