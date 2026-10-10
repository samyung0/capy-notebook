import { Dialog as DialogPrimitive } from 'radix-ui';
import { type ReactNode, useRef, useState } from 'react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { m } from '@/i18n';
import { useMaterialRender } from './MaterialRenderContext';
import { Mermaid } from './Mermaid';
import type { MermaidTheme } from './mermaidThemes';

const MAX_SCALE = 8;
/** Pointer travel past which a press is a pan, not a click on the backdrop. */
const CLICK_SLOP = 4;
const ZOOM_BUTTON_CLASS =
  'rounded-button p-2 text-white/75 hover:bg-white/10 hover:text-white disabled:opacity-35 disabled:hover:bg-transparent';

/**
 * Full-screen look at an image or diagram on a deep backdrop: name on top,
 * caption below. Wheel, pinch, double-click and the header buttons zoom up to
 * 8×; dragging pans. A click on empty space or Escape closes it.
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
  const [scale, setScale] = useState(1);
  const press = useRef<{ x: number; y: number } | null>(null);
  const closeOnBackdropClick = (event: React.MouseEvent) => {
    const start = press.current;
    press.current = null;
    if (
      !start ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) >
        CLICK_SLOP ||
      // Everything but the media and the controls counts as backdrop.
      (event.target as Element).closest('button, h2, [data-preview-media]')
    )
      return;
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="motion-fade fixed inset-0 z-50 bg-black/88 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="motion-fade fixed inset-0 z-50 flex flex-col text-white outline-none"
          onClick={closeOnBackdropClick}
          // Capture: the zoom surface handles the press for panning.
          onPointerDownCapture={(event) => {
            press.current = { x: event.clientX, y: event.clientY };
          }}
        >
          <TransformWrapper
            doubleClick={{ mode: 'toggle', step: 1 }}
            keyboard={{ disabled: false }}
            maxScale={MAX_SCALE}
            minScale={1}
            onTransform={(_, state) => setScale(state.scale)}
            // Multiplied by deltaY (~100 per mouse notch): ~30% a notch.
            wheel={{ step: 0.003 }}
          >
            {({ resetTransform, zoomIn, zoomOut }) => (
              <>
                <header className="flex shrink-0 items-center gap-1 px-5 py-2">
                  <DialogPrimitive.Title className="min-w-0 flex-1 truncate pr-3 font-medium text-sm">
                    {title}
                  </DialogPrimitive.Title>
                  <button
                    aria-label={m.material_zoom_out()}
                    className={ZOOM_BUTTON_CLASS}
                    disabled={scale <= 1}
                    onClick={() => zoomOut()}
                    type="button"
                  >
                    <EditorIcon className="size-5" name="zoomOut" />
                  </button>
                  <button
                    aria-label={m.media_zoom_reset()}
                    className="min-w-14 rounded-button px-2 py-1.5 text-white/75 text-xs hover:bg-white/10 hover:text-white"
                    onClick={() => resetTransform()}
                    type="button"
                  >
                    {Math.round(scale * 100)}%
                  </button>
                  <button
                    aria-label={m.material_zoom_in()}
                    className={ZOOM_BUTTON_CLASS}
                    disabled={scale >= MAX_SCALE}
                    onClick={() => zoomIn()}
                    type="button"
                  >
                    <EditorIcon className="size-5" name="zoomIn" />
                  </button>
                  <DialogPrimitive.Close
                    aria-label={m.action_close()}
                    className="ml-2 rounded-button p-2 text-white/75 hover:bg-white/10 hover:text-white"
                  >
                    <EditorIcon className="size-5" name="x" />
                  </DialogPrimitive.Close>
                </header>
                <TransformComponent
                  contentClass="size-full! flex items-center justify-center px-4 sm:px-12"
                  wrapperClass="min-h-0 w-full! flex-1 h-auto! cursor-grab active:cursor-grabbing"
                >
                  <div className="contents" data-preview-media>
                    {children}
                  </div>
                </TransformComponent>
              </>
            )}
          </TransformWrapper>
          <footer className="min-h-12 shrink-0 px-5 py-3 text-center text-sm text-white/80">
            {caption}
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** A diagram block's preview, titled with its material when it stands alone
 * or `title` names it (a mindmap or diagram material's own page). */
export function MermaidPreview({
  caption,
  code,
  onOpenChange,
  open,
  theme,
  title,
}: {
  caption?: string;
  code: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  theme?: MermaidTheme;
  title?: string;
}) {
  const material = useMaterialRender();
  const named = title ?? (material?.isStandalone ? material.title : undefined);
  return (
    <MediaPreview
      caption={caption}
      onOpenChange={onOpenChange}
      open={open}
      title={named?.trim() ? named : m.editor_mermaid()}
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
