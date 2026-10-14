import { Icon } from '@/components/ui/Icon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** A question's first issue, and how many more there are (Epo 2026-10-15). */
export function IssueSummary({
  className,
  messages,
}: {
  className?: string;
  messages: string[];
}) {
  if (messages.length === 0) return null;
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 rounded-lg bg-tint-warning px-3 py-2 text-sm text-tint-warning-fg',
        className
      )}
      role="status"
    >
      <Icon className="mt-0.5 size-4 shrink-0" name="alert" />
      <span className="min-w-0">
        {messages[0]}
        {messages.length > 1 &&
          ` ${m.question_issue_more({ count: messages.length - 1 })}`}
      </span>
    </p>
  );
}

/** A title's warning icon: its tooltip lists the title's issues. */
export function IssueIcon({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={m.question_issue_warning({ issues: messages.join(' ') })}
        className="inline-grid size-6 shrink-0 place-items-center rounded-button text-tint-warning-fg outline-none focus-visible:ring-2 focus-visible:ring-action"
        render={<span role="img" />}
        tabIndex={0}
      >
        <Icon className="size-4" name="alert" />
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-1" side="top">
        {messages.map((message) => (
          <span key={message}>{message}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
