import {
  analyzeOpenPresentation,
  type CanvasImageResolver,
  initWasm,
  openPresentation,
  type PresentationAnalysis,
  type PresentationViewerHandle,
  paintSlide,
  type SlideDisplayList,
  sizeCanvasForSlide,
} from '@betteroffice/pptx/viewer';
import {
  IconSetContext,
  LocaleProvider,
  PresentationOverlay,
} from '@betteroffice/pptx-react/presentation';
import {
  ArrowLeft04Icon,
  ArrowRight04Icon,
  Note01Icon,
} from '@hugeicons/core-free-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HugeIcon } from '@/components/ui/HugeIcon';
import type {
  OfficeCitation,
  OfficeLocale,
  OfficeZoom,
} from '@/features/files/officeProtocol';
import { m } from '@/i18n';
import { CITATION_FILL, slideCitationItems, uniqueCitation } from './citations';
import { runtimeNotesWindow } from './notesWindow';
import { loadPptxFonts } from './pptxFonts';
import { pptxIcons } from './pptxIcons';
import { PptxImageCache } from './pptxImageCache';
import { pptxStrings, pptxT, presentAction, viewerMenus } from './pptxMenus';
import { renderSlides } from './pptxRender';
import type { OfficeMenuReporter, OfficeRenderer } from './runtimeMenus';
import {
  readNotesSize,
  readViewToggle,
  writeNotesSize,
  writeViewToggle,
} from './viewToggles';
import './pptx-runtime.css';

export function PptxViewer({
  bytes,
  citation,
  initialZoom = 'fit',
  locale,
  onAnalysis,
  onError,
  onMenus,
  onAskPresenter,
  onPresentingChange,
  onRenderer,
  onZoomChange,
}: {
  bytes: Uint8Array;
  citation: OfficeCitation | null;
  /** The level the file was last shown at; fit to the window without. */
  initialZoom?: OfficeZoom;
  locale: OfficeLocale;
  onAnalysis: (analysis: PresentationAnalysis) => void;
  onError: (error: Error) => void;
  onMenus: OfficeMenuReporter;
  /** Asks Capy for Presenter view's notes window, from a click in the show. */
  onAskPresenter: () => void;
  onPresentingChange: (presenting: boolean) => void;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onZoomChange: (zoom: OfficeZoom) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PresentationViewerHandle | null>(null);
  const imagesRef = useRef(new PptxImageCache());
  const paintGenerationRef = useRef(0);
  // The open deck's analysis, reported once the first slide is painted.
  const pendingAnalysisRef = useRef<PresentationAnalysis | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  // Every slide, laid out at open as the editor's strip does; null while opening.
  // ponytail: eager layout of the whole deck; lay thumbnails out on scroll if large decks open slowly.
  const [slides, setSlides] = useState<
    { frame: SlideDisplayList; notes: string }[] | null
  >(null);
  const [stageSize, setStageSize] = useState({ height: 0, width: 0 });
  // View › Zoom, as the editor's; the host carries it to the next frame.
  const [zoom, setZoom] = useState(initialZoom);
  useEffect(() => onZoomChange(zoom), [onZoomChange, zoom]);
  // The slide a show starts from; null while not presenting.
  const [presenting, setPresenting] = useState<number | null>(null);
  const [presenter] = useState(() => runtimeNotesWindow(onAskPresenter));
  useEffect(() => () => presenter.dispose(), [presenter]);
  // The same remembered choice as edit mode; hidden by default.
  const [speakerNotes, setSpeakerNotes] = useState(() =>
    readViewToggle('speakerNotes')
  );
  const toggleSpeakerNotes = useCallback(() => {
    setSpeakerNotes(!speakerNotes);
    writeViewToggle('speakerNotes', !speakerNotes);
  }, [speakerNotes]);
  const slideCount = slides?.length ?? 0;
  const slideIndexRef = useRef(slideIndex);
  slideIndexRef.current = slideIndex;

  // View mode offers what works here: Download, Print, Present, the zoom and
  // the notes.
  useEffect(() => {
    if (!slides) return;
    const hasSlides = slides.length > 0;
    onMenus({
      actions: hasSlides ? [presentAction(locale)] : [],
      menus: viewerMenus(locale, hasSlides, speakerNotes, String(zoom)),
      run: (id, value) => {
        if (!hasSlides) return;
        const [command, level] = id.split(':');
        if (command === 'view.zoom' && level)
          setZoom(level === 'fit' ? 'fit' : Number(level));
        if (id === 'view.present') setPresenting(slideIndexRef.current);
        if (id === 'view.present:start') setPresenting(0);
        if (id === 'view.presenterView') {
          presenter.expect(value ?? '');
          setPresenting((current) => current ?? slideIndexRef.current);
        }
        if (id === 'view.speakerNotes') toggleSpeakerNotes();
      },
    });
  }, [
    locale,
    onMenus,
    presenter,
    slides,
    speakerNotes,
    toggleSpeakerNotes,
    zoom,
  ]);
  const isPresenting = presenting !== null;
  useEffect(() => {
    if (!isPresenting) return;
    onPresentingChange(true);
    return () => onPresentingChange(false);
  }, [isPresenting, onPresentingChange]);
  useEffect(() => () => onMenus(null), [onMenus]);

  // Capy prints the slides and saves the PNG: the sandboxed frame can do neither.
  useEffect(() => {
    if (!slides) return;
    onRenderer(async (kind) => {
      const handle = handleRef.current;
      if (!handle) throw new Error('The presentation is not open');
      return renderSlides(
        handle,
        kind === 'png'
          ? [slideIndexRef.current]
          : slides.map((_, index) => index)
      );
    });
    return () => onRenderer(null);
  }, [onRenderer, slides]);
  const frame = slides?.[slideIndex]?.frame ?? null;
  const accessibleItems = useMemo(
    () => (frame ? slideA11yItems(frame) : []),
    [frame]
  );

  useEffect(() => {
    let disposed = false;
    let handle: PresentationViewerHandle | null = null;
    setSlides(null);
    setSlideIndex(0);
    pendingAnalysisRef.current = null;
    void Promise.all([initWasm(), loadPptxFonts()]).then(
      ([, fonts]) => {
        if (disposed) return;
        try {
          handle = openPresentation(bytes, { fonts });
          handleRef.current = handle;
          const analysis = analyzeOpenPresentation(handle);
          const open = handle;
          const laidOut = open.snapshot().slides.map((slide, index) => ({
            frame: open.layoutSlide(index),
            notes: slide.notes ?? '',
          }));
          setSlides(laidOut);
          // A deck without slides has nothing to paint.
          if (laidOut.length === 0) onAnalysis(analysis);
          else pendingAnalysisRef.current = analysis;
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

  const [highlight, setHighlight] = useState<{
    slide: number;
    rects: ReturnType<typeof slideCitationItems>[number]['rects'];
  } | null>(null);
  useEffect(() => {
    setHighlight(null);
    if (!citation || !slides?.length) return;
    try {
      const items = slides.flatMap((slide, index) =>
        slideCitationItems(slide.frame).map((item) => ({
          ...item,
          slide: index,
        }))
      );
      const match = uniqueCitation(items, citation.quote);
      if (!match?.rects.length) return;
      setHighlight(match);
      setSlideIndex(match.slide);
    } catch {
      /* Best-effort navigation must not fail the viewer. */
    }
  }, [citation, slides]);

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
    // The editor's scale: its fit zoom (pptx-react fitScale) or the level.
    const scale =
      zoom === 'fit'
        ? Math.min(
            (stageSize.width - 40) / frame.width,
            (stageSize.height - 40) / frame.height,
            1
          )
        : zoom;
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
        if (highlight?.slide === slideIndex) {
          context.save();
          context.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
          context.fillStyle = CITATION_FILL;
          for (const rect of highlight.rects)
            context.fillRect(rect.x, rect.y, rect.w, rect.h);
          context.restore();
        }
        sizeCanvasForSlide(visibleCanvas, frame, dpr, scale);
        const visibleContext = visibleCanvas.getContext('2d');
        if (visibleContext) visibleContext.drawImage(renderCanvas, 0, 0);
        const analysis = pendingAnalysisRef.current;
        pendingAnalysisRef.current = null;
        if (analysis) onAnalysis(analysis);
      },
      (value: unknown) => {
        if (generation === paintGenerationRef.current) onError(toError(value));
      }
    );
    return () => {
      paintGenerationRef.current += 1;
    };
  }, [
    frame,
    onAnalysis,
    onError,
    resolveImage,
    stageSize,
    highlight,
    slideIndex,
    zoom,
  ]);

  const selectSlide = (next: number) => {
    if (next >= 0 && next < slideCount) setSlideIndex(next);
  };

  return (
    <div className="pptx-viewer">
      <div className="pptx-viewer-workspace">
        {slides && slideCount > 0 && (
          <aside
            aria-label={m.files_office_slide_count({ count: slideCount })}
            className="pptx-viewer-strip"
          >
            <div className="pptx-viewer-slides">
              {slides.map((slide, index) => (
                <button
                  aria-current={index === slideIndex ? 'page' : undefined}
                  className="pptx-viewer-slide"
                  key={index}
                  onClick={() => selectSlide(index)}
                  type="button"
                >
                  <span className="pptx-viewer-slide-number">{index + 1}</span>
                  <span
                    aria-hidden="true"
                    className="pptx-viewer-slide-preview"
                    style={{
                      aspectRatio: `${slide.frame.width} / ${slide.frame.height}`,
                    }}
                  >
                    <SlideThumbnail
                      frame={slide.frame}
                      resolveImage={resolveImage}
                    />
                  </span>
                </button>
              ))}
            </div>
            <div className="pptx-viewer-pager">
              <button
                aria-label={m.files_office_previous_slide()}
                disabled={slideIndex === 0}
                onClick={() => selectSlide(slideIndex - 1)}
                title={m.files_office_previous_slide()}
                type="button"
              >
                <HugeIcon icon={ArrowLeft04Icon} size={16} />
              </button>
              <span aria-atomic="true" aria-live="polite" role="status">
                {m.files_office_slide_position({
                  current: slideIndex + 1,
                  total: slideCount,
                })}
              </span>
              <button
                aria-label={m.files_office_next_slide()}
                data-testid="pptx-next-slide"
                disabled={slideIndex === slideCount - 1}
                onClick={() => selectSlide(slideIndex + 1)}
                title={m.files_office_next_slide()}
                type="button"
              >
                <HugeIcon icon={ArrowRight04Icon} size={16} />
              </button>
            </div>
          </aside>
        )}
        <div className="pptx-viewer-stage">
          <div className="pptx-viewer-scroll" ref={stageRef}>
            {frame ? (
              <>
                <div aria-hidden="true" className="pptx-viewer-canvas">
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
              slides && <p>{m.files_office_no_slides()}</p>
            )}
          </div>
          {slides && slideCount > 0 && (
            // As the editor's Notes button (pptx-react's pptx-notes-toggle).
            <button
              aria-label={pptxT(locale)('notes.toggle')}
              aria-pressed={speakerNotes}
              className="pptx-viewer-notes-toggle"
              data-testid="pptx-notes-toggle"
              onClick={toggleSpeakerNotes}
              title={pptxT(locale)('notes.toggle')}
              type="button"
            >
              <HugeIcon icon={Note01Icon} size={16} />
              <span>{pptxT(locale)('notes.toggle')}</span>
            </button>
          )}
        </div>
      </div>
      {slides && slideCount > 0 && speakerNotes && (
        <div className="pptx-viewer-notes">
          <span className="pptx-viewer-notes-label" id="pptx-viewer-notes">
            {m.files_office_speaker_notes()}
          </span>
          <div
            aria-labelledby="pptx-viewer-notes"
            className="pptx-viewer-notes-text"
            role="note"
          >
            {slides[slideIndex]?.notes}
          </div>
        </div>
      )}
      {presenting !== null && handleRef.current && slideCount > 0 && (
        <LocaleProvider i18n={pptxStrings(locale)}>
          <IconSetContext.Provider value={pptxIcons}>
            <PresentationOverlay
              defaultNotesSize={readNotesSize()}
              handle={handleRef.current}
              notesFor={(index) => slides?.[index]?.notes ?? ''}
              notesWindow={presenter.notes}
              onError={(value) => onError(toError(value))}
              onExit={(index) => {
                setPresenting(null);
                setSlideIndex(index);
              }}
              onNotesSizeChange={(size) => writeNotesSize(size)}
              resolveImage={resolveImage}
              slideCount={slideCount}
              startIndex={presenting}
            />
          </IconSetContext.Provider>
        </LocaleProvider>
      )}
    </div>
  );
}

/** pptx-react's SlideThumbnail, painted at the strip's 126px width. */
function SlideThumbnail({
  frame,
  resolveImage,
}: {
  frame: SlideDisplayList;
  resolveImage: CanvasImageResolver;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const scale = 126 / frame.width;
    const dpr = window.devicePixelRatio || 1;
    sizeCanvasForSlide(canvas, frame, dpr, scale);
    // Fills its frame, which is narrower in the narrow layout.
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    void paintSlide(context, frame, dpr, scale, { resolveImage }).catch(
      () => undefined
    );
  }, [frame, resolveImage]);
  return <canvas ref={canvasRef} />;
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
