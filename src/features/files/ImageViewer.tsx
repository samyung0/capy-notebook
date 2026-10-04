import { useEffect, useRef, useState } from 'react';
import {
  type ReactZoomPanPinchRef,
  TransformComponent,
  TransformWrapper,
} from 'react-zoom-pan-pinch';
import { FileError } from './FileStates';
import { clampImageZoom, IMAGE_MAX_ZOOM, IMAGE_MIN_ZOOM } from './fileUtils';

/**
 * Fit-to-screen image with wheel, pinch and double-click zoom and drag-to-pan.
 * `zoom` is relative to fit (1 = contain); the header's buttons set it, and
 * gestures report back through `onZoomChange`.
 */
export function ImageViewer({
  url,
  alt,
  zoom,
  onZoomChange,
  onRetry,
}: {
  url: string;
  alt: string;
  zoom: number;
  onZoomChange?: (next: number) => void;
  onRetry: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const transform = useRef<ReactZoomPanPinchRef>(null);

  // A header button changed `zoom`: zoom around the middle of the view. A
  // gesture's own report lands within the rounding and changes nothing.
  useEffect(() => {
    const current = transform.current;
    const wrapper = current?.instance.wrapperComponent;
    if (!current || !wrapper) return;
    const target = clampImageZoom(zoom);
    if (Math.abs(current.instance.state.scale - target) < 0.01) return;
    const rect = wrapper.getBoundingClientRect();
    void current.zoomToPoint(
      target,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      150
    );
  }, [zoom]);

  if (failed) return <FileError onRetry={onRetry} />;

  return (
    <TransformWrapper
      doubleClick={{ mode: 'toggle', step: 1 }}
      maxScale={IMAGE_MAX_ZOOM}
      minScale={IMAGE_MIN_ZOOM}
      onTransform={(ref, state) => {
        // Skip a zoom animation's in-between frames: reporting them made a
        // quick second click step from a half-way zoom, not the target.
        if (!ref.instance.isAnimating)
          onZoomChange?.(clampImageZoom(state.scale));
      }}
      ref={transform}
      // Multiplied by deltaY (~100 per mouse notch): ~30% a notch.
      wheel={{ step: 0.003 }}
    >
      <TransformComponent
        contentClass="size-full! flex items-center justify-center"
        wrapperClass="absolute! inset-3 size-auto! cursor-grab overscroll-contain active:cursor-grabbing"
      >
        <img
          alt={alt}
          className="max-h-full max-w-full select-none rounded-md object-contain [-webkit-user-drag:none]"
          draggable={false}
          onError={() => setFailed(true)}
          src={url}
        />
      </TransformComponent>
    </TransformWrapper>
  );
}
