import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';

/** The dashed box that uploads on a press and takes dropped files (the Add
 * file dialog's Upload, Make a quiz's fields): tinted while files are dragged
 * `over` it (useFileDrop). `tall` stands alone in an empty tab. */
export function UploadDropZone({
  className,
  hint,
  label,
  over,
  tall,
  ...props
}: React.ComponentProps<'button'> & {
  hint: string;
  label: string;
  over: boolean;
  tall?: boolean;
}) {
  return (
    <button
      className={cn(
        'rounded-card border-2 border-line border-dashed transition-colors hover:bg-surface-hover-bg disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent',
        tall
          ? 'flex flex-col items-center gap-1.5 px-6 py-4 sm:gap-2 sm:py-8'
          : 'flex min-h-21.5 shrink-0 items-center justify-center gap-3.5 px-5 py-4 text-left',
        over && 'border-solid-accent-1 bg-tint-accent-1/60',
        className
      )}
      type="button"
      {...props}
    >
      <Icon
        className={cn(
          tall ? 'non-scaling-svg size-6 sm:size-7' : 'size-6.5 shrink-0'
        )}
        name="upload"
      />
      <span
        className={cn(
          'flex min-w-0 flex-col',
          tall ? 'items-center gap-1.5 sm:gap-2' : 'gap-0.5'
        )}
      >
        <span className="t-body font-semibold">{label}</span>
        <span className="t-meta text-fg-muted">{hint}</span>
      </span>
    </button>
  );
}
