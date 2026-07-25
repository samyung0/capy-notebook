import { type PointerEvent, useEffect, useRef, useState } from 'react';
import { clampImageZoom, IMAGE_MIN_ZOOM } from './fileUtils';

/** Clamp pan so the scaled image can't be dragged past the viewport edges. */
function clampPanOffset(
  x: number,
  y: number,
  stage: HTMLElement,
  img: HTMLImageElement,
  zoom: number
) {
  const cw = stage.clientWidth;
  const ch = stage.clientHeight;
  const fw = img.offsetWidth;
  const fh = img.offsetHeight;
  if (!cw || !ch || !fw || !fh) return { x: 0, y: 0 };

  const maxX = Math.max(0, (fw * zoom - cw) / 2);
  const maxY = Math.max(0, (fh * zoom - ch) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

type Point = { x: number; y: number };

type Gesture =
  | {
      kind: 'pan';
      pointerId: number;
      startPoint: Point;
      startOffset: Point;
    }
  | {
      kind: 'pinch';
      pointerIds: [number, number];
      startDistance: number;
      startMidpoint: Point;
      startOffset: Point;
      startZoom: number;
    };

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

const WHEEL_ZOOM_FACTOR = 1.1;

/** Fit-to-screen image with zoom + drag-to-pan. `zoom` is relative to fit (1 = contain). */
export function ImageViewer({
  url,
  alt,
  zoom,
  onZoomChange,
}: {
  url: string;
  alt: string;
  zoom: number;
  onZoomChange?: (next: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  const [displayZoom, setDisplayZoom] = useState(() => clampImageZoom(zoom));
  const zoomRef = useRef(displayZoom);
  const pointersRef = useRef(new Map<number, Point>());
  const gestureRef = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const canPan = displayZoom > IMAGE_MIN_ZOOM;

  function clampToBounds(x: number, y: number, nextZoom = zoomRef.current) {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img) return { x: 0, y: 0 };
    return clampPanOffset(x, y, stage, img, nextZoom);
  }

  function updateOffset(x: number, y: number, nextZoom = zoomRef.current) {
    const next = clampToBounds(x, y, nextZoom);
    offsetRef.current = next;
    setOffset(next);
  }

  function updateZoom(next: number) {
    const clamped = clampImageZoom(next);
    zoomRef.current = clamped;
    setDisplayZoom(clamped);
    onZoomChange?.(clamped);
    return clamped;
  }

  /** Zoom around a screen point so that point stays under the cursor/fingers. */
  function zoomAroundPoint(
    point: Point,
    nextZoomRaw: number,
    startZoom = zoomRef.current,
    startOffset = offsetRef.current
  ) {
    const stageRect = stageRef.current?.getBoundingClientRect();
    if (!stageRect) return;
    const nextZoom = updateZoom(nextZoomRaw);
    const scaleRatio = nextZoom / Math.max(startZoom, 0.0001);
    const center = {
      x: stageRect.left + stageRect.width / 2,
      y: stageRect.top + stageRect.height / 2,
    };
    updateOffset(
      point.x - center.x - scaleRatio * (point.x - center.x - startOffset.x),
      point.y - center.y - scaleRatio * (point.y - center.y - startOffset.y),
      nextZoom
    );
  }
  const zoomAroundPointRef = useRef(zoomAroundPoint);
  zoomAroundPointRef.current = zoomAroundPoint;

  function beginPan(pointerId: number, point: Point) {
    gestureRef.current = {
      kind: 'pan',
      pointerId,
      startOffset: offsetRef.current,
      startPoint: point,
    };
    setDragging(true);
  }

  function beginPinch() {
    const entries = [...pointersRef.current.entries()];
    if (entries.length < 2) return;
    const [[firstId, first], [secondId, second]] = entries;
    gestureRef.current = {
      kind: 'pinch',
      pointerIds: [firstId, secondId],
      startDistance: Math.max(1, distance(first, second)),
      startMidpoint: midpoint(first, second),
      startOffset: offsetRef.current,
      startZoom: zoomRef.current,
    };
    setDragging(true);
  }

  useEffect(() => {
    offsetRef.current = { x: 0, y: 0 };
    setOffset({ x: 0, y: 0 });
    pointersRef.current.clear();
    gestureRef.current = null;
    setDragging(false);
  }, [url]);

  useEffect(() => {
    const nextZoom = clampImageZoom(zoom);
    zoomRef.current = nextZoom;
    setDisplayZoom(nextZoom);
    updateOffset(offsetRef.current.x, offsetRef.current.y, nextZoom);
  }, [zoom]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      updateOffset(offsetRef.current.x, offsetRef.current.y);
    });
    observer.observe(stage);
    if (imgRef.current) observer.observe(imgRef.current);
    return () => observer.disconnect();
  }, [url]);

  // Non-passive so we can prevent the page from scrolling while zooming.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      zoomAroundPointRef.current(
        { x: e.clientX, y: e.clientY },
        zoomRef.current * factor
      );
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [url]);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = { x: e.clientX, y: e.clientY };
    pointersRef.current.set(e.pointerId, point);

    if (pointersRef.current.size >= 2) {
      beginPinch();
    } else if (zoomRef.current > IMAGE_MIN_ZOOM) {
      beginPan(e.pointerId, point);
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(e.pointerId)) return;
    e.preventDefault();
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size >= 2) {
      const gesture = gestureRef.current;
      if (gesture?.kind !== 'pinch') {
        beginPinch();
        return;
      }

      const first = pointersRef.current.get(gesture.pointerIds[0]);
      const second = pointersRef.current.get(gesture.pointerIds[1]);
      if (!first || !second) {
        beginPinch();
        return;
      }

      const currentMidpoint = midpoint(first, second);
      const nextZoomRaw =
        gesture.startZoom * (distance(first, second) / gesture.startDistance);

      // Keep the image point beneath the initial pinch midpoint under the
      // fingers while also applying the midpoint's movement as a pan.
      const stageRect = stageRef.current?.getBoundingClientRect();
      if (!stageRect) return;
      const nextZoom = updateZoom(nextZoomRaw);
      const scaleRatio = nextZoom / gesture.startZoom;
      const center = {
        x: stageRect.left + stageRect.width / 2,
        y: stageRect.top + stageRect.height / 2,
      };
      updateOffset(
        currentMidpoint.x -
          center.x -
          scaleRatio *
            (gesture.startMidpoint.x - center.x - gesture.startOffset.x),
        currentMidpoint.y -
          center.y -
          scaleRatio *
            (gesture.startMidpoint.y - center.y - gesture.startOffset.y),
        nextZoom
      );
      return;
    }

    const gesture = gestureRef.current;
    if (gesture?.kind !== 'pan' || gesture.pointerId !== e.pointerId) {
      if (zoomRef.current > IMAGE_MIN_ZOOM) {
        beginPan(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      return;
    }
    updateOffset(
      gesture.startOffset.x + e.clientX - gesture.startPoint.x,
      gesture.startOffset.y + e.clientY - gesture.startPoint.y
    );
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.delete(e.pointerId);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    const remaining = [...pointersRef.current.entries()];
    if (remaining.length >= 2) {
      beginPinch();
    } else if (remaining.length === 1 && zoomRef.current > IMAGE_MIN_ZOOM) {
      beginPan(remaining[0][0], remaining[0][1]);
    } else {
      gestureRef.current = null;
      setDragging(false);
    }
  }

  return (
    <div
      className={`absolute inset-0 overflow-hidden p-3 ${
        canPan
          ? dragging
            ? 'cursor-grabbing'
            : 'cursor-grab'
          : 'cursor-default'
      }`}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      ref={viewportRef}
      style={{ overscrollBehavior: 'contain', touchAction: 'none' }}
    >
      <div
        className="flex h-full w-full items-center justify-center"
        ref={stageRef}
      >
        <img
          alt={alt}
          className="max-h-full max-w-full select-none rounded-md object-contain transition-all duration-150 ease-out will-change-transform [-webkit-user-drag:none]"
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          onLoad={() => updateOffset(offsetRef.current.x, offsetRef.current.y)}
          ref={imgRef}
          src={url}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${displayZoom})`,
            transformOrigin: 'center center',
          }}
        />
      </div>
    </div>
  );
}
