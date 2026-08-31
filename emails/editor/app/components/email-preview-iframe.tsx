import { MailOpenIcon } from 'lucide-react';
import type { HTMLProps } from 'react';
import { toast } from 'sonner';
import { cn } from '~/lib/classname';
import { Button } from './ui/button';

type EmailPreviewIFrameProps = {
  innerHTML: string;
  showOpenInNewTab?: boolean;
  wrapperClassName?: string;
} & HTMLProps<HTMLIFrameElement>;

export function EmailPreviewIFrame({
  innerHTML,
  showOpenInNewTab = true,
  wrapperClassName,
  ...iframeProps
}: EmailPreviewIFrameProps) {
  function handleOpen() {
    if (!innerHTML.trim()) {
      toast.error('There is no email to preview.');
      return;
    }

    const newWindow = window.open('about:blank', '_blank');
    const newDocument = newWindow?.document;
    if (!newDocument) {
      toast.error('The browser blocked the preview tab.');
      return;
    }
    newDocument.open();
    newDocument.write(innerHTML);
    newDocument.close();
  }

  return (
    <div className={cn('relative', wrapperClassName)}>
      <iframe
        {...iframeProps}
        sandbox=""
        srcDoc={innerHTML}
        title="Email preview"
      />
      {showOpenInNewTab && (
        <Button
          className="absolute right-0 bottom-0 h-8 cursor-pointer gap-1.5 rounded-none rounded-tl-md border-gray-200 border-t border-l font-normal text-sm hover:bg-gray-50"
          onClick={handleOpen}
          type="button"
          variant="secondary"
        >
          <MailOpenIcon className="h-3.5 w-3.5 shrink-0" />
          <span>Open in new tab</span>
        </Button>
      )}
    </div>
  );
}
