import { EyeIcon, Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { RenderedPreview } from '~/lib/email-template-types';
import { EmailPreviewIFrame } from './email-preview-iframe';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';

interface PreviewEmailDialogProps {
  disabled?: boolean;
  renderPreview: () => Promise<RenderedPreview>;
}

export function PreviewEmailDialog({
  disabled,
  renderPreview,
}: PreviewEmailDialogProps) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<RenderedPreview | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function openPreview() {
    setIsPending(true);
    try {
      setResult(await renderPreview());
      setOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Preview failed');
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        className="flex min-h-[28px] cursor-pointer items-center justify-center rounded-md bg-black px-2 py-1 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50 max-lg:w-7"
        disabled={disabled || isPending}
        onClick={(event) => {
          event.preventDefault();
          void openPreview();
        }}
      >
        {isPending ? (
          <Loader2Icon className="inline-block size-4 shrink-0 animate-spin lg:mr-1" />
        ) : (
          <EyeIcon className="inline-block size-4 shrink-0 lg:mr-1" />
        )}
        <span className="hidden lg:inline-block">Preview email</span>
      </DialogTrigger>

      {result && (
        <DialogContent className="z-[99999] flex max-w-[620px] flex-col border-none bg-transparent p-0 shadow-none max-[680px]:h-full max-[680px]:border-0 max-[680px]:p-2">
          <DialogHeader className="sr-only">
            <DialogTitle>Email preview</DialogTitle>
            <DialogDescription>
              Exact HTML preview with sample variable values.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-4 rounded-xl border border-gray-200 bg-white p-3 shadow-xs">
            <div className="flex size-8 items-center justify-center rounded-full border border-gray-200 bg-black font-semibold text-sm text-white">
              E
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="font-medium">Capy Notebook</h3>
              <h4 className="truncate text-sm">{result.subject}</h4>
              <p className="truncate text-gray-500 text-sm">{result.preview}</p>
            </div>
          </div>
          <div className="flex min-h-[75vh] w-full grow overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xs">
            <EmailPreviewIFrame
              className="h-full w-full grow"
              innerHTML={result.html}
              wrapperClassName="w-full"
            />
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
