import { Spinner } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/Icon";

export function FileLoading({
  message = "Loading preview...",
}: {
  message?: string;
}) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3">
      <Spinner className="size-6.5" />
      <p>{message}</p>
    </div>
  );
}

export function FileError({
  title = "Something went wrong",
  message = "We can't load the file. The file maybe missing or deleted.",
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <span className="flex size-14 items-center justify-center rounded-card bg-tint-error text-tint-error-fg">
        <Icon className="size-6.5" name="warning" />
      </span>
      <div className="flex flex-col items-center justify-center gap-1.5 text-center">
        <p className="t-card-title mt-1 font-bold">{title}</p>
        <p>{message}</p>
      </div>
    </div>
  );
}

export function FileEmpty({
  title = "Something went wrong",
  message = "The file is empty or corrupted. Please reupload and try again.",
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <span className="flex size-14 items-center justify-center rounded-card bg-tint-error text-tint-error-fg">
        <Icon className="size-6.5" name="warning" />
      </span>
      <div className="flex flex-col items-center justify-center gap-1.5 text-center">
        <p className="t-card-title mt-1 font-bold">{title}</p>
        <p>{message}</p>
      </div>
    </div>
  );
}
