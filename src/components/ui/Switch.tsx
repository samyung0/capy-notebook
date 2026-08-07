import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '@/lib/cn';

function Switch({
  className,
  size = 'default',
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: 'sm' | 'default';
}) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer group/switch relative inline-flex shrink-0 items-center rounded-full border-2 border-transparent outline-none transition-all after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-line focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-solid-error aria-invalid:ring-2 aria-invalid:ring-solid-error data-[size=default]:h-6 data-[size=sm]:h-4.5 data-[size=default]:w-10 data-[size=sm]:w-7.5 data-disabled:cursor-not-allowed data-checked:bg-action data-unchecked:bg-line-strong data-disabled:opacity-50',
        className
      )}
      data-size={size}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="pointer-events-none block rounded-full bg-surface ring-0 transition-transform group-data-[size=default]/switch:size-4.5 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-0px)] group-data-[size=sm]/switch:data-unchecked:translate-x-0"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
