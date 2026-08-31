import { ClipboardCheckIcon, ClipboardIcon, Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '~/lib/classname';
import type { RenderedPreview } from '~/lib/email-template-types';

interface CopyEmailHtmlProps {
  disabled?: boolean;
  renderPreview: () => Promise<RenderedPreview>;
}

export function CopyEmailHtml({ disabled, renderPreview }: CopyEmailHtmlProps) {
  const [isCopied, setIsCopied] = useState(false);
  const [isPending, setIsPending] = useState(false);

  async function copyHtml() {
    setIsPending(true);
    try {
      const result = await renderPreview();
      await navigator.clipboard.writeText(result.html);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Copy failed');
    } finally {
      setIsPending(false);
    }
  }

  return (
    <button
      className={cn(
        'flex min-h-[28px] cursor-pointer items-center justify-center rounded-md px-2 py-1 text-sm disabled:cursor-not-allowed max-lg:w-7',
        isCopied
          ? 'bg-green-200 text-green-700'
          : 'bg-black text-white disabled:opacity-50'
      )}
      disabled={disabled || isCopied || isPending}
      onClick={() => void copyHtml()}
      type="button"
    >
      {isPending ? (
        <Loader2Icon className="inline-block size-4 shrink-0 animate-spin lg:mr-1" />
      ) : isCopied ? (
        <ClipboardCheckIcon className="inline-block size-4 shrink-0 lg:mr-1" />
      ) : (
        <ClipboardIcon className="inline-block size-4 shrink-0 lg:mr-1" />
      )}
      <span className="hidden lg:inline-block">
        {isCopied ? 'Copied' : 'Copy HTML'}
      </span>
    </button>
  );
}
