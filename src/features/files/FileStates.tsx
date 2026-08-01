import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';

export function FileLoading() {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3">
      <Spinner className="size-6.5" />
      <p>Loading preview...</p>
    </div>
  );
}

export function FileError() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <span className="flex size-12 items-center justify-center rounded-card-lg bg-tint-error text-tint-error-fg">
        <Icon className="size-6.5" name="warning" />
      </span>
      <div className="flex flex-col items-center justify-center gap-1.5 text-center">
        <p className="t-card-title mt-1 font-bold">Something went wrong</p>
        <p>We can't load the file. The file maybe missing or deleted.</p>
      </div>
    </div>
  );
}

export function FileEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <span className="flex size-12 items-center justify-center rounded-card-lg bg-tint-error text-tint-error-fg">
        <Icon className="size-6.5" name="warning" />
      </span>
      <div className="flex flex-col items-center justify-center gap-1.5 text-center">
        <p className="t-card-title mt-1 font-bold">Something went wrong</p>
        <p>The file is empty or corrupted. Please reupload and try again.</p>
      </div>
    </div>
  );
}
