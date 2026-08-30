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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { m } from '@/i18n';
import { loadPptxFonts } from './pptxFonts';
import { PptxImageCache } from './pptxImageCache';

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
  const imagesRef = useRef(new PptxImageCache());
  const paintGenerationRef = useRef(0);
  const [slideIndex, setSlideIndex] = useState(0);
  const [slideCount, setSlideCount] = useState(0);
  const [frame, setFrame] = useState<SlideDisplayList | null>(null);
  const [stageSize, setStageSize] = useState({ height: 0, width: 0 });
  const accessibleItems = useMemo(
    () => (frame ? slideA11yItems(frame) : []),
    [frame]
  );

  useEffect(() => {
    let disposed = false;
    let handle: PresentationViewerHandle | null = null;
    setSlideCount(0);
    setSlideIndex(0);
    setFrame(null);
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
      (value: unknown) => {
        if (!disposed) onError(toError(value));
      }
    );
    return () => {
      disposed = true;
      paintGenerationRef.current += 1;
      handleRef.current = null;
      handle?.dispose();
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
    const generation = ++paintGenerationRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !frame || stageSize.height === 0 || stageSize.width === 0)
      return;
    const scale = Math.min(
      (stageSize.width - 40) / frame.width,
      (stageSize.height - 40) / frame.height,
      1
    );
    const dpr = window.devicePixelRatio || 1;
    const renderCanvas = document.createElement('canvas');
    sizeCanvasForSlide(renderCanvas, frame, dpr, scale);
    const context = renderCanvas.getContext('2d');
    if (!context) return;
    void paintSlide(context, frame, dpr, scale, { resolveImage }).then(
      () => {
        if (generation !== paintGenerationRef.current) return;
        const visibleCanvas = canvasRef.current;
        if (!visibleCanvas) return;
        sizeCanvasForSlide(visibleCanvas, frame, dpr, scale);
        const visibleContext = visibleCanvas.getContext('2d');
        if (visibleContext) visibleContext.drawImage(renderCanvas, 0, 0);
      },
      (value: unknown) => {
        if (generation === paintGenerationRef.current) onError(toError(value));
      }
    );
    return () => {
      paintGenerationRef.current += 1;
    };
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
          <>
            <div aria-hidden="true" className="pptx-canvas-layer">
              <canvas ref={canvasRef} />
            </div>
            <div
              aria-label={m.files_office_slide_content({
                current: slideIndex + 1,
                total: slideCount,
              })}
              className="office-a11y-only"
              role="region"
            >
              {accessibleItems.length > 0 ? (
                accessibleItems.map((item, index) => {
                  const key = `${item.kind}:${index}:${item.text}`;
                  if (item.kind === 'chart') {
                    return (
                      <div
                        aria-label={m.files_office_slide_chart({
                          label: item.text,
                        })}
                        key={key}
                        role="img"
                      />
                    );
                  }
                  return (
                    <p key={key}>
                      {item.kind === 'placeholder'
                        ? m.files_office_slide_placeholder({
                            label: item.text,
                          })
                        : item.text}
                    </p>
                  );
                })
              ) : (
                <p>{m.files_office_slide_no_accessible_content()}</p>
              )}
            </div>
          </>
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
          <span aria-atomic="true" aria-live="polite" role="status">
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

type SlideA11yItem = {
  kind: 'chart' | 'placeholder' | 'text';
  text: string;
};

function slideA11yItems(frame: SlideDisplayList): SlideA11yItem[] {
  const items: SlideA11yItem[] = [];
  const add = (kind: SlideA11yItem['kind'], text: string) => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    items.push({ kind, text: normalized });
  };

  for (const primitive of frame.primitives) {
    switch (primitive.kind) {
      case 'textBox':
        for (const paragraph of primitive.paragraphs) {
          add('text', paragraph.runs.map((run) => run.text).join(''));
        }
        break;
      case 'placeholder':
        add('placeholder', primitive.label ?? primitive.name);
        break;
      case 'chart':
        add('chart', primitive.label || primitive.name);
        break;
      default:
        break;
    }
  }

  return items;
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
