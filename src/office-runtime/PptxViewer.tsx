import {
  analyzeOpenPresentation,
  initWasm,
  openPresentation,
  type PresentationAnalysis,
  type PresentationViewerHandle,
  paintSlide,
  type SlideDisplayList,
  sizeCanvasForSlide,
} from '@betteroffice/pptx/viewer';
import { useCallback, useEffect, useRef, useState } from 'react';
import { m } from '@/i18n';
import { loadPptxFonts } from './pptxFonts';

export function PptxViewer({
  bytes,
  onAnalysis,
  onError,
}: {
  bytes: Uint8Array;
  onAnalysis: (analysis: PresentationAnalysis) => void;
  onError: (error: Error) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PresentationViewerHandle | null>(null);
  const imagesRef = useRef(
    new Map<string, Promise<CanvasImageSource | null>>()
  );
  const [slideIndex, setSlideIndex] = useState(0);
  const [slideCount, setSlideCount] = useState(0);
  const [frame, setFrame] = useState<SlideDisplayList | null>(null);
  const [stageSize, setStageSize] = useState({ height: 0, width: 0 });

  useEffect(() => {
    let disposed = false;
    let handle: PresentationViewerHandle | null = null;
    void Promise.all([initWasm(), loadPptxFonts()]).then(
      ([, fonts]) => {
        if (disposed) return;
        try {
          handle = openPresentation(bytes, { fonts });
          handleRef.current = handle;
          const analysis = analyzeOpenPresentation(handle);
          setSlideCount(analysis.slideCount);
          setSlideIndex(0);
          setFrame(analysis.slideCount > 0 ? handle.layoutSlide(0) : null);
          onAnalysis(analysis);
        } catch (value) {
          onError(toError(value));
        }
      },
      (value: unknown) => onError(toError(value))
    );
    return () => {
      disposed = true;
      handleRef.current = null;
      handle?.dispose();
      for (const image of imagesRef.current.values()) {
        void image.then((source) => {
          if (source instanceof ImageBitmap) source.close();
        });
      }
      imagesRef.current.clear();
    };
  }, [bytes, onAnalysis, onError]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () =>
      setStageSize({ height: stage.clientHeight, width: stage.clientWidth });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const resolveImage = useCallback((assetId: string) => {
    const cached = imagesRef.current.get(assetId);
    if (cached) return cached;
    const bytes = handleRef.current?.mediaBytes(assetId);
    const pending = bytes
      ? createImageBitmap(new Blob([bytes.slice()]))
      : Promise.resolve(null);
    imagesRef.current.set(assetId, pending);
    return pending;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame || stageSize.height === 0 || stageSize.width === 0)
      return;
    const scale = Math.min(
      (stageSize.width - 40) / frame.width,
      (stageSize.height - 40) / frame.height,
      1
    );
    const context = canvas.getContext('2d');
    if (!context) return;
    const dpr = window.devicePixelRatio || 1;
    sizeCanvasForSlide(canvas, frame, dpr, scale);
    void paintSlide(context, frame, dpr, scale, { resolveImage }).catch(
      (value: unknown) => onError(toError(value))
    );
  }, [frame, onError, resolveImage, stageSize]);

  const selectSlide = (next: number) => {
    const handle = handleRef.current;
    if (!handle || next < 0 || next >= slideCount) return;
    try {
      setSlideIndex(next);
      setFrame(handle.layoutSlide(next));
    } catch (value) {
      onError(toError(value));
    }
  };

  return (
    <div className="pptx-runtime">
      <div className="pptx-stage" ref={stageRef}>
        {frame ? (
          <canvas ref={canvasRef} />
        ) : (
          <p>{m.files_office_no_slides()}</p>
        )}
      </div>
      {slideCount > 0 && (
        <div className="pptx-controls">
          <button
            disabled={slideIndex === 0}
            onClick={() => selectSlide(slideIndex - 1)}
            type="button"
          >
            {m.files_office_previous_slide()}
          </button>
          <span>
            {m.files_office_slide_position({
              current: slideIndex + 1,
              total: slideCount,
            })}
          </span>
          <button
            disabled={slideIndex === slideCount - 1}
            onClick={() => selectSlide(slideIndex + 1)}
            type="button"
          >
            {m.files_office_next_slide()}
          </button>
        </div>
      )}
    </div>
  );
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
