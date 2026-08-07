import { Icon } from '@/components/ui/Icon';

export function WarningBanner({ message }: { message?: string }) {
  return (
    <div
      className="flex w-full items-start gap-2.5 rounded-card border border-solid-error/30 bg-tint-error p-4 text-[0.95rem] text-tint-error-fg"
      role="alert"
    >
      <Icon className="mt-0.5 size-4.5 shrink-0" name="warning" />
      <p>{message}</p>
    </div>
  );
}
