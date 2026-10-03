import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { m } from '@/i18n';
import { useMaterialRender } from './MaterialRenderContext';
import { Mermaid } from './Mermaid';
import type { MermaidTheme } from './mermaidThemes';

/**
 * Full-screen look at an image or diagram on a deep backdrop: name on top,
 * caption below. Clicking the backdrop or pressing Escape closes it.
 */
export function MediaPreview({
  caption,
  children,
  onOpenChange,
  open,
  title,
}: {
  caption?: string;
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="motion-fade fixed inset-0 z-50 bg-black/88 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="motion-fade fixed inset-0 z-50 flex flex-col text-white outline-none"
        >
          <header className="flex shrink-0 items-center gap-3 px-5 py-3">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate font-medium text-sm">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label={m.action_close()}
              className="rounded-button p-2 text-white/75 hover:bg-white/10 hover:text-white"
            >
              <EditorIcon className="size-5" name="x" />
            </DialogPrimitive.Close>
          </header>
          {/* Empty space around the media closes, like the backdrop. */}
          <div
            className="flex min-h-0 flex-1 items-center justify-center px-4 sm:px-12"
            onClick={(event) => {
              if (event.target === event.currentTarget) onOpenChange(false);
            }}
          >
            {children}
          </div>
          <footer className="min-h-12 shrink-0 px-5 py-3 text-center text-sm text-white/80">
            {caption}
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** A diagram block's preview, titled with its material when it stands alone. */
export function MermaidPreview({
  caption,
  code,
  onOpenChange,
  open,
  theme,
}: {
  caption?: string;
  code: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  theme?: MermaidTheme;
}) {
  const material = useMaterialRender();
  return (
    <MediaPreview
      caption={caption}
      onOpenChange={onOpenChange}
      open={open}
      title={
        material?.isStandalone && material.title.trim()
          ? material.title
          : m.editor_mermaid()
      }
    >
      {/* Height drives the size; the width follows from the SVG's viewBox. */}
      <Mermaid
        className="max-h-full max-w-full [&>svg]:h-[calc(100dvh-10rem)] [&>svg]:max-h-none [&>svg]:w-auto [&>svg]:max-w-full"
        code={code}
        fill
        theme={theme}
      />
    </MediaPreview>
  );
}
