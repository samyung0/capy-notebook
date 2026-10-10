import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';
import { cropPhoto, fitView, minZoomFor, type PhotoView } from './photoCrop';

/** Gap between the crop circle and the stage's shorter side. */
const INSET = 20;
const MAX_ZOOM = 3;
const START: PhotoView = { rotation: 0, x: 0, y: 0, zoom: 1 };

/** Positions a picked photo inside a circle: drag to move, wheel, pinch or
 * the slider to zoom, rotate in quarter turns. Apply hands back the 512 px
 * square crop; the form's Save or Confirm stores it. */
export function PhotoEditorDialog({
  source,
  onApply,
  onClose,
}: {
  source: File | null;
  onApply: (file: File) => void;
  onClose: () => void;
}) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [view, setView] = useState(START);
  const [stage, setStage] = useState({ height: 0, width: 0 });
  const [applying, setApplying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);

  useEffect(() => {
    if (!source) return;
    let next: ImageBitmap | undefined;
    let live = true;
    setView(START);
    // Decoding applies the photo's EXIF orientation.
    void createImageBitmap(source).then(
      (decoded) => {
        next = decoded;
        if (live) setBitmap(decoded);
        else decoded.close();
      },
      () => live && onClose()
    );
    return () => {
      live = false;
      next?.close();
      setBitmap(null);
    };
  }, [source, onClose]);

  // The dialog mounts its content after opening, so observe through a
  // callback ref rather than an effect.
  const observe = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setStage({
        height: entry.contentRect.height,
        width: entry.contentRect.width,
      })
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const diameter = Math.max(0, Math.min(stage.width, stage.height) - INSET * 2);
  const size = bitmap && { height: bitmap.height, width: bitmap.width };
  // Zoom 1 fills the circle; zooming out stops at MIN_COVERAGE of it.
  const minZoom = size ? minZoomFor(size) : 1;
  const update = (next: (view: PhotoView) => PhotoView) =>
    setView((current) =>
      size
        ? fitView(next(current), size, diameter, {
            max: MAX_ZOOM,
            min: minZoom,
          })
        : current
    );
  const zoomTo = (zoom: number) =>
    update((current) => {
      const z = Math.min(MAX_ZOOM, Math.max(minZoom, zoom));
      // Zoom about the circle's centre: the offset grows with the scale.
      const k = z / current.zoom;
      return { ...current, x: current.x * k, y: current.y * k, zoom: z };
    });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap || !diameter) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(stage.width * ratio);
    canvas.height = Math.round(stage.height * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, stage.width, stage.height);
    context.translate(stage.width / 2, stage.height / 2);
    cropPhoto(context, bitmap, view, diameter);
  }, [bitmap, view, stage, diameter]);

  const apply = async () => {
    if (!bitmap || !diameter) return;
    setApplying(true);
    try {
      const canvas = new OffscreenCanvas(512, 512);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.translate(256, 256);
      context.scale(512 / diameter, 512 / diameter);
      cropPhoto(context, bitmap, view, diameter);
      const webp = await canvas.convertToBlob({
        quality: 0.9,
        type: 'image/webp',
      });
      // Safari has no WebP encoder and hands back PNG, which keeps alpha.
      const blob =
        webp.type === 'image/webp'
          ? webp
          : await canvas.convertToBlob({ type: 'image/png' });
      const ext = blob.type === 'image/webp' ? 'webp' : 'png';
      onApply(new File([blob], `avatar.${ext}`, { type: blob.type }));
    } finally {
      setApplying(false);
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const last = pointers.current.get(event.pointerId);
    if (!last) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current)
        zoomTo((pinch.current.zoom * distance) / pinch.current.distance);
      else pinch.current = { distance, zoom: view.zoom };
      return;
    }
    update((current) => ({
      ...current,
      x: current.x + point.x - last.x,
      y: current.y + point.y - last.y,
    }));
  };
  const onPointerEnd = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    pinch.current = null;
  };

  return (
    <SimpleDialog
      footer={
        <>
          <Button
            className="mr-auto"
            disabled={applying}
            onClick={onClose}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
          <Button
            disabled={applying}
            onClick={() => setView(START)}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_reset()}
          </Button>
          <Button
            disabled={!bitmap || applying}
            onClick={() => void apply()}
            size="lg"
            type="button"
            variant="accent"
          >
            {m.action_apply()}
          </Button>
        </>
      }
      onClose={onClose}
      open={!!source}
      title={m.photo_editor_title()}
      width={480}
    >
      <div
        aria-label={m.photo_editor_stage()}
        className="relative h-[min(300px,72vw)] w-full cursor-grab touch-none select-none overflow-hidden outline-offset-2 focus-visible:outline-2 focus-visible:outline-action-accent active:cursor-grabbing"
        onKeyDown={(event) => {
          const step = event.shiftKey ? 40 : 10;
          const moves: Record<string, [number, number]> = {
            ArrowDown: [0, step],
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
          };
          const move = moves[event.key];
          if (move) {
            event.preventDefault();
            update((current) => ({
              ...current,
              x: current.x + move[0],
              y: current.y + move[1],
            }));
          } else if (event.key === '+' || event.key === '=') {
            zoomTo(view.zoom * 1.1);
          } else if (event.key === '-') {
            zoomTo(view.zoom / 1.1);
          }
        }}
        onPointerCancel={onPointerEnd}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onWheel={(event) => zoomTo(view.zoom * Math.exp(-event.deltaY / 500))}
        ref={observe}
        role="application"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus lets arrow keys move the photo and +/- zoom it.
        tabIndex={0}
      >
        <canvas className="absolute inset-0 size-full" ref={canvasRef} />
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_3000px_color-mix(in_srgb,var(--color-surface)_80%,transparent),inset_0_0_0_1px_var(--color-line)]"
          style={{ height: diameter, width: diameter }}
        />
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Icon className="shrink-0 text-fg-muted" name="image" size={16} />
        <input
          aria-label={m.photo_editor_zoom()}
          className="h-6 min-w-0 flex-1 cursor-pointer accent-action-accent"
          max={MAX_ZOOM}
          min={minZoom}
          onChange={(event) => zoomTo(Number(event.target.value))}
          step="any"
          type="range"
          value={view.zoom}
        />
        <Icon className="shrink-0 text-fg-muted" name="image" size={22} />
        <span className="mx-0.5 h-5.5 w-px bg-divider" />
        <IconButton
          className="-mx-1.5"
          icon="rotate"
          label={m.photo_editor_rotate()}
          onClick={() =>
            update((current) => ({
              ...current,
              // A quarter turn clockwise carries the offset with it.
              rotation: (current.rotation + 90) % 360,
              x: -current.y,
              y: current.x,
            }))
          }
          tooltip
          type="button"
          variant="ghost-hover"
        />
      </div>
    </SimpleDialog>
  );
}
