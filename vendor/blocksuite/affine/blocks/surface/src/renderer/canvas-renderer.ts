import {
  type Color,
  ColorScheme,
  ConnectorElementModel,
} from '@blocksuite/affine-model';
import { FeatureFlagService } from '@blocksuite/affine-shared/services';
import { requestConnectedFrame } from '@blocksuite/affine-shared/utils';
import { DisposableGroup } from '@blocksuite/global/disposable';
import { IS_IOS } from '@blocksuite/global/env';
import {
  Bound,
  getBoundWithRotation,
  type IBound,
  intersects,
} from '@blocksuite/global/gfx';
import type { BlockStdScope } from '@blocksuite/std';
import type {
  GfxCompatibleInterface,
  GfxController,
  GfxLocalElementModel,
  GridManager,
  LayerManager,
  SurfaceBlockModel,
  Viewport,
} from '@blocksuite/std/gfx';
import {
  getEffectiveDpr,
  getPostGestureRecoveryDelay,
  GfxControllerIdentifier,
  viewportRuntimeConfig,
} from '@blocksuite/std/gfx';
import { effect } from '@preact/signals-core';
import last from 'lodash-es/last';
import { Subject } from 'rxjs';

import type { SurfaceElementModel } from '../element-model/base.js';
import { ElementRendererIdentifier } from '../extensions/element-renderer.js';
import { RoughCanvas } from '../utils/rough/canvas.js';
import type { ElementRenderer } from './elements/index.js';
import type { Overlay } from './overlay.js';
import { resolveSurfacePlaceholderColor } from './placeholder-style.js';

type EnvProvider = {
  generateColorProperty: (color: Color, fallback?: Color) => string;
  getColorScheme: () => ColorScheme;
  getColorValue: (color: Color, fallback?: Color, real?: boolean) => string;
  getPropertyValue: (property: string) => string;
  selectedElements?: () => string[];
};

type RendererOptions = {
  std: BlockStdScope;
  viewport: Viewport;
  layerManager: LayerManager;
  provider?: Partial<EnvProvider>;
  enableStackingCanvas?: boolean;
  onStackingCanvasCreated?: (canvas: HTMLCanvasElement) => void;
  gridManager: GridManager;
  surfaceModel: SurfaceBlockModel;
};

export type CanvasRenderPassMetrics = {
  overlayCount: number;
  placeholderElementCount: number;
  renderByBoundCallCount: number;
  renderedElementCount: number;
  visibleElementCount: number;
};

export type CanvasMemorySnapshot = {
  bytes: number;
  datasetLayerId: string | null;
  height: number;
  kind: 'main' | 'stacking';
  width: number;
  zIndex: string;
};

export type CanvasRendererDebugMetrics = {
  canvasLayerCount: number;
  canvasMemoryBytes: number;
  canvasMemorySnapshots: CanvasMemorySnapshot[];
  canvasMemoryMegabytes: number;
  canvasPixelCount: number;
  coalescedRefreshCount: number;
  dirtyLayerRenderCount: number;
  fallbackElementCount: number;
  lastRenderDurationMs: number;
  lastRenderMetrics: CanvasRenderPassMetrics;
  maxRenderDurationMs: number;
  pooledStackingCanvasCount: number;
  refreshCount: number;
  renderCount: number;
  stackingCanvasCount: number;
  totalLayerCount: number;
  totalRenderDurationMs: number;
  visibleStackingCanvasCount: number;
};

type MutableCanvasRendererDebugMetrics = Omit<
  CanvasRendererDebugMetrics,
  | 'canvasLayerCount'
  | 'canvasMemoryBytes'
  | 'canvasMemoryMegabytes'
  | 'canvasPixelCount'
  | 'canvasMemorySnapshots'
  | 'pooledStackingCanvasCount'
  | 'stackingCanvasCount'
  | 'totalLayerCount'
  | 'visibleStackingCanvasCount'
>;

type RenderPassStats = CanvasRenderPassMetrics;

type StackingCanvasState = {
  bound: Bound | null;
  layerId: string | null;
};

type RefreshTarget =
  | { type: 'all' }
  | { type: 'main' }
  | { type: 'element'; element: SurfaceElementModel | GfxLocalElementModel }
  | {
      type: 'elements';
      elements: Array<SurfaceElementModel | GfxLocalElementModel>;
    };

const STACKING_CANVAS_PADDING = 32;
const IOS_LOW_ZOOM_SURVIVAL_THRESHOLD = 0.5;

// Capy (local change 76): a change to one element draws again only the part
// of its canvas the element covered and covers now, not every element there.
/** What part of a canvas waits to be drawn again: a region in model units, or
 * all of it. */
type DirtyRegion = Bound | 'whole';

/** Past an element's bound, in model units, what its drawing may still reach:
 * antialiasing and glyph overhang, plus its stroke (a connector's arrowhead
 * reaches 7.5 times its stroke width past its end) and its shadow. */
const DIRTY_PADDING = 24;
const DIRTY_STROKE_REACH = 8;

/** A whole redraw once region passes pause, so every region's edge (a stroke
 * crossing it, drawn clipped, can come out a few levels off there) is as a
 * whole pass draws it. Longer than the gap between two typed keys, so typing
 * never pays it per key: the redraw every key paid before, now once a pause. */
const SETTLE_MS = 1000;

const unite = (a: DirtyRegion, b: DirtyRegion): DirtyRegion =>
  a === 'whole' || b === 'whole' ? 'whole' : a.unite(b);

const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.abs(value) : 0;

/** What a model draws past its bound, as far as its reach goes. */
type Drawing = {
  externalBound?: Bound | null;
  lineWidth?: unknown;
  shadow?: { blur?: unknown; offsetX?: unknown; offsetY?: unknown } | null;
  strokeWidth?: unknown;
};

/** Where a model's drawing can reach from its turned bound: what it draws
 * outside it (a group's title), its stroke and its shadow. */
function extentOf(model: object, turned: Bound) {
  const { externalBound, lineWidth, shadow, strokeWidth } = model as Drawing;
  const bound = externalBound ? turned.unite(externalBound) : turned;
  const shadowReach = shadow
    ? finite(shadow.blur) +
      Math.max(finite(shadow.offsetX), finite(shadow.offsetY))
    : 0;
  return bound.expand(
    DIRTY_PADDING +
      DIRTY_STROKE_REACH * finite(strokeWidth ?? lineWidth) +
      shadowReach
  );
}

/** extentOf any element the renderer draws (a local one too, as a connector
 * label's hit area), from its turned bound, which reads the element's parsed
 * `xywh` (`elementBound` parses it again on every call), and a connector's
 * label. */
function reachOf(element: SurfaceElementModel | GfxLocalElementModel) {
  const turned = Bound.from(getBoundWithRotation(element));
  const label =
    element instanceof ConnectorElementModel && element.hasLabel()
      ? element.shownLabelXYWH
      : undefined;
  return extentOf(
    element,
    label ? turned.unite(Bound.fromXYWH(label)) : turned
  );
}

export function shouldSyncCanvasBudgetOnViewportUpdate(
  previousZoom: number,
  nextZoom: number,
  rawDpr = window.devicePixelRatio
) {
  if (rawDpr <= 1) {
    return false;
  }

  return (
    getEffectiveDpr(previousZoom, rawDpr) !== getEffectiveDpr(nextZoom, rawDpr)
  );
}

export function shouldUseLowZoomSurvivalMode(
  isIOS: boolean,
  zoom: number,
  gestureActive: boolean
) {
  return isIOS && gestureActive && zoom <= IOS_LOW_ZOOM_SURVIVAL_THRESHOLD;
}

export function getStackingCanvasBypassState(params: {
  isIOS: boolean;
  zoom: number;
  gestureActive: boolean;
  recoveryActive: boolean;
  viewportWidth: number;
  viewportHeight: number;
}) {
  const {
    isIOS,
    zoom,
    gestureActive,
    recoveryActive,
    viewportWidth,
    viewportHeight,
  } = params;

  return (
    isIOS &&
    zoom <= IOS_LOW_ZOOM_SURVIVAL_THRESHOLD &&
    (gestureActive || recoveryActive) &&
    viewportWidth > viewportHeight
  );
}

export function shouldBypassStackingCanvasesDuringLowZoomGesture(params: {
  isIOS: boolean;
  zoom: number;
  gestureActive: boolean;
  recoveryActive: boolean;
  viewportWidth: number;
  viewportHeight: number;
}) {
  return getStackingCanvasBypassState(params);
}

export function getStackingCanvasAttachmentDiff(params: {
  canvases: HTMLCanvasElement[];
  wasAttached: boolean;
  shouldAttach: boolean;
}) {
  const { canvases, wasAttached, shouldAttach } = params;

  if (wasAttached === shouldAttach) {
    return {
      added: [],
      removed: [],
    };
  }

  return shouldAttach
    ? {
        added: canvases,
        removed: [],
      }
    : {
        added: [],
        removed: canvases,
      };
}

export function getMainCanvasFallbackBounds(params: {
  viewportBounds: Bound;
  overscanViewportBounds: Bound;
}) {
  const { overscanViewportBounds } = params;

  return {
    cullBound: overscanViewportBounds,
    renderBound: overscanViewportBounds,
  };
}

export function getCanvasViewportLayout(params: {
  bound: Bound;
  viewportBounds: Bound;
  zoom: number;
  viewScale: number;
  dpr: number;
}) {
  const { bound, viewportBounds, zoom, viewScale, dpr } = params;
  const width = bound.w * zoom;
  const height = bound.h * zoom;
  const left = (bound.x - viewportBounds.x) * zoom;
  const top = (bound.y - viewportBounds.y) * zoom;

  return {
    actualHeight: Math.max(0, Math.ceil(height * dpr)),
    actualWidth: Math.max(0, Math.ceil(width * dpr)),
    height,
    transform: `translate(${left}px, ${top}px) scale(${1 / viewScale})`,
    width,
  };
}

function applyCanvasViewportLayout(
  canvas: HTMLCanvasElement,
  layout: ReturnType<typeof getCanvasViewportLayout>
) {
  const width = `${layout.width}px`;
  const height = `${layout.height}px`;

  if (canvas.style.left !== '0px') {
    canvas.style.left = '0px';
  }
  if (canvas.style.top !== '0px') {
    canvas.style.top = '0px';
  }
  if (canvas.style.width !== width) {
    canvas.style.width = width;
  }
  if (canvas.style.height !== height) {
    canvas.style.height = height;
  }
  if (canvas.style.transform !== layout.transform) {
    canvas.style.transform = layout.transform;
  }
  if (canvas.style.transformOrigin !== 'top left') {
    canvas.style.transformOrigin = 'top left';
  }
  if (canvas.width !== layout.actualWidth) {
    canvas.width = layout.actualWidth;
  }
  if (canvas.height !== layout.actualHeight) {
    canvas.height = layout.actualHeight;
  }
}

export function shouldRenderCanvasPlaceholders(params: {
  isIOS: boolean;
  zoom: number;
  isPanning: boolean;
  isZooming: boolean;
  skipRefreshDuringGesture: boolean;
  turboEnabled: boolean;
}) {
  const {
    isIOS,
    zoom,
    isPanning,
    isZooming,
    skipRefreshDuringGesture,
    turboEnabled,
  } = params;

  if (shouldUseLowZoomSurvivalMode(isIOS, zoom, isZooming)) {
    return true;
  }

  return !skipRefreshDuringGesture && turboEnabled && isZooming && !isPanning;
}

export class CanvasRenderer {
  private _container!: HTMLElement;

  private readonly _disposables = new DisposableGroup();

  private readonly _gfx: GfxController;

  private readonly _turboEnabled: () => boolean;

  private readonly _overlays = new Set<Overlay>();

  private _refreshRafId: number | null = null;

  private _stackingCanvas: HTMLCanvasElement[] = [];

  private readonly _stackingCanvasPool: HTMLCanvasElement[] = [];

  private readonly _stackingCanvasState = new WeakMap<
    HTMLCanvasElement,
    StackingCanvasState
  >();

  // Capy (local change 76): each dirty stacking canvas's region, and the main
  // canvas's while it is dirty.
  private readonly _dirtyStackingCanvasIndexes = new Map<number, DirtyRegion>();

  private _mainCanvasDirty = true;

  private _mainDirtyRegion: DirtyRegion = 'whole';

  /** Where each element's drawing reached when it was last drawn. */
  private readonly _drawnExtents = new WeakMap<
    SurfaceElementModel | GfxLocalElementModel,
    Bound
  >();

  /** Each canvas's origin, scale and size when it was last drawn (and, for
   * the main canvas, the layers it drew): a region is drawn only over pixels
   * drawn there. */
  private readonly _drawnPlacements = new WeakMap<HTMLCanvasElement, string>();

  /** The whole redraw waiting on a pause in region passes. */
  private _settleTimer: ReturnType<typeof setTimeout> | null = null;

  private _needsFullRender = true;

  private _lastCanvasBudgetZoom = 1;

  private _lastLowZoomSurvivalMode = false;

  private _lastBypassStackingCanvases = false;

  private _stackingCanvasesAttached = true;

  private _stackingCanvasRecoveryUntil = 0;

  private _stackingCanvasRecoveryTimerId: ReturnType<typeof setTimeout> | null =
    null;

  private _debugMetrics: MutableCanvasRendererDebugMetrics = {
    refreshCount: 0,
    coalescedRefreshCount: 0,
    renderCount: 0,
    totalRenderDurationMs: 0,
    lastRenderDurationMs: 0,
    maxRenderDurationMs: 0,
    lastRenderMetrics: {
      renderByBoundCallCount: 0,
      visibleElementCount: 0,
      renderedElementCount: 0,
      placeholderElementCount: 0,
      overlayCount: 0,
    },
    dirtyLayerRenderCount: 0,
    fallbackElementCount: 0,
  };

  canvas: HTMLCanvasElement;

  ctx: CanvasRenderingContext2D;

  std: BlockStdScope;

  grid: GridManager;

  layerManager: LayerManager;

  provider: Partial<EnvProvider>;

  stackingCanvasUpdated = new Subject<{
    canvases: HTMLCanvasElement[];
    added: HTMLCanvasElement[];
    removed: HTMLCanvasElement[];
  }>();

  usePlaceholder = false;

  viewport: Viewport;

  get stackingCanvas() {
    return this._stackingCanvas;
  }

  get stackingCanvasesAttached() {
    return this._stackingCanvasesAttached;
  }

  constructor(options: RendererOptions) {
    const canvas = document.createElement('canvas');

    this.canvas = canvas;
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.std = options.std;
    this.viewport = options.viewport;
    this._lastCanvasBudgetZoom = this.viewport.zoom;
    this.layerManager = options.layerManager;
    this.grid = options.gridManager;
    this.provider = options.provider ?? {};
    this._gfx = this.std.get(GfxControllerIdentifier);

    this._turboEnabled = () => {
      const featureFlagService = options.std.get(FeatureFlagService);
      return featureFlagService.getFlag('enable_turbo_renderer');
    };

    this._initViewport();

    options.enableStackingCanvas = options.enableStackingCanvas ?? false;
    if (options.enableStackingCanvas) {
      this._initStackingCanvas(options.onStackingCanvasCreated);
    }

    this._watchSurface(options.surfaceModel);
  }

  /**
   * Specifying the actual size gives better results and more consistent behavior across browsers.
   *
   * Make sure the main canvas and the offscreen canvas or layer canvas are the same size.
   *
   * It is not recommended to set width and height to 100%.
   */
  private _canvasSizeUpdater(
    bound = this.viewport.overscanViewportBounds,
    dpr = getEffectiveDpr(this.viewport.zoom)
  ) {
    const layout = getCanvasViewportLayout({
      bound,
      viewportBounds: this.viewport.viewportBounds,
      zoom: this.viewport.zoom,
      viewScale: this.viewport.viewScale,
      dpr,
    });

    return {
      filter(canvas: HTMLCanvasElement) {
        return (
          canvas.width !== layout.actualWidth ||
          canvas.height !== layout.actualHeight ||
          canvas.style.transform !== layout.transform
        );
      },
      update(canvas: HTMLCanvasElement) {
        applyCanvasViewportLayout(canvas, layout);
      },
    };
  }

  private _applyStackingCanvasLayout(
    canvas: HTMLCanvasElement,
    bound: Bound | null,
    dpr = getEffectiveDpr(this.viewport.zoom)
  ) {
    const state =
      this._stackingCanvasState.get(canvas) ??
      ({
        bound: null,
        layerId: canvas.dataset.layerId ?? null,
      } satisfies StackingCanvasState);

    if (!bound || bound.w <= 0 || bound.h <= 0) {
      canvas.style.display = 'none';
      canvas.style.left = '0px';
      canvas.style.top = '0px';
      canvas.style.width = '0px';
      canvas.style.height = '0px';
      canvas.style.transform = '';
      canvas.width = 0;
      canvas.height = 0;
      // Capy (local change 76): cleared, so its next pass draws it whole.
      this._drawnPlacements.delete(canvas);
      state.bound = null;
      state.layerId = canvas.dataset.layerId ?? null;
      this._stackingCanvasState.set(canvas, state);
      return;
    }

    const layout = getCanvasViewportLayout({
      bound,
      viewportBounds: this.viewport.viewportBounds,
      zoom: this.viewport.zoom,
      viewScale: this.viewport.viewScale,
      dpr,
    });

    if (canvas.style.display !== 'block') {
      canvas.style.display = 'block';
    }
    applyCanvasViewportLayout(canvas, layout);

    state.bound = bound;
    state.layerId = canvas.dataset.layerId ?? null;
    this._stackingCanvasState.set(canvas, state);
  }

  private _clampBoundToViewport(bound: Bound, viewportBounds: Bound) {
    const minX = Math.max(bound.x, viewportBounds.x);
    const minY = Math.max(bound.y, viewportBounds.y);
    const maxX = Math.min(bound.maxX, viewportBounds.maxX);
    const maxY = Math.min(bound.maxY, viewportBounds.maxY);

    if (maxX <= minX || maxY <= minY) {
      return null;
    }

    return new Bound(minX, minY, maxX - minX, maxY - minY);
  }

  private _createCanvasForLayer(
    onCreated?: (canvas: HTMLCanvasElement) => void
  ) {
    const reused = this._stackingCanvasPool.pop();

    if (reused) {
      return reused;
    }

    const created = document.createElement('canvas');
    onCreated?.(created);
    return created;
  }

  private _findLayerIndexByElement(
    element: SurfaceElementModel | GfxLocalElementModel
  ) {
    const canvasLayers = this.layerManager.getCanvasLayers();
    const index = canvasLayers.findIndex(layer =>
      layer.elements.some(layerElement => layerElement.id === element.id)
    );

    return index === -1 ? null : index;
  }

  private _getLayerRenderBound(
    elements: SurfaceElementModel[],
    viewportBounds: Bound
  ) {
    let layerBound: Bound | null = null;

    for (const element of elements) {
      const display = (element.display ?? true) && !element.hidden;

      if (!display) {
        continue;
      }

      const elementBound = Bound.from(getBoundWithRotation(element));

      if (!intersects(elementBound, viewportBounds)) {
        continue;
      }

      layerBound = layerBound ? layerBound.unite(elementBound) : elementBound;
    }

    if (!layerBound) {
      return null;
    }

    return this._clampBoundToViewport(
      layerBound.expand(STACKING_CANVAS_PADDING),
      viewportBounds
    );
  }

  private _getResolvedStackingCanvasBound(
    canvas: HTMLCanvasElement,
    bound: Bound | null
  ) {
    if (!bound || !this._gfx.tool.dragging$.peek()) {
      return bound;
    }

    const previousBound = this._stackingCanvasState.get(canvas)?.bound;

    return previousBound ? previousBound.unite(bound) : bound;
  }

  private _invalidate(target: RefreshTarget = { type: 'all' }) {
    if (target.type === 'all') {
      this._needsFullRender = true;
      this._mainCanvasDirty = true;
      this._dirtyStackingCanvasIndexes.clear();
      return;
    }

    if (this._needsFullRender) {
      return;
    }

    if (target.type === 'main') {
      this._markMainDirty('whole');
      return;
    }

    const elements =
      target.type === 'element' ? [target.element] : target.elements;

    for (const element of elements) {
      const region = this._regionOf(element);
      const layerIndex = this._findLayerIndexByElement(element);

      if (layerIndex === null || layerIndex >= this._stackingCanvas.length) {
        this._markMainDirty(region);
        continue;
      }

      const dirty = this._dirtyStackingCanvasIndexes.get(layerIndex);
      this._dirtyStackingCanvasIndexes.set(
        layerIndex,
        dirty ? unite(dirty, region) : region
      );
    }
  }

  // Capy (local change 76)
  private _markMainDirty(region: DirtyRegion) {
    this._mainDirtyRegion = this._mainCanvasDirty
      ? unite(this._mainDirtyRegion, region)
      : region;
    this._mainCanvasDirty = true;
  }

  /** What a change to `element` can repaint: where it was last drawn and where
   * it and the groups holding it (a mind map's lines, a group's title) reach
   * now. */
  private _regionOf(element: SurfaceElementModel | GfxLocalElementModel) {
    const now = reachOf(element);
    let region = this._drawnExtents.get(element)?.unite(now) ?? now;
    for (const group of element.groups)
      region = region.unite(
        extentOf(group, Bound.from(getBoundWithRotation(group)))
      );
    return region;
  }

  private _resetPooledCanvas(canvas: HTMLCanvasElement) {
    canvas.dataset.layerId = '';
    this._applyStackingCanvasLayout(canvas, null);
  }

  private _syncStackingCanvasAttachment(shouldAttach: boolean) {
    const payloadDiff = getStackingCanvasAttachmentDiff({
      canvases: this._stackingCanvas,
      wasAttached: this._stackingCanvasesAttached,
      shouldAttach,
    });

    this._stackingCanvasesAttached = shouldAttach;

    if (!payloadDiff.added.length && !payloadDiff.removed.length) {
      return;
    }

    this.stackingCanvasUpdated.next({
      canvases: this._stackingCanvas,
      ...payloadDiff,
    });
  }

  private _isStackingCanvasRecoveryActive() {
    return this._stackingCanvasRecoveryUntil > performance.now();
  }

  private _clearStackingCanvasRecoveryTimer() {
    if (this._stackingCanvasRecoveryTimerId !== null) {
      clearTimeout(this._stackingCanvasRecoveryTimerId);
      this._stackingCanvasRecoveryTimerId = null;
    }
  }

  private _scheduleStackingCanvasRecoveryWindow(
    delayMs = viewportRuntimeConfig.POST_GESTURE_REFRESH_DELAY
  ) {
    this._clearStackingCanvasRecoveryTimer();
    this._stackingCanvasRecoveryUntil = performance.now() + delayMs;
    this._stackingCanvasRecoveryTimerId = setTimeout(() => {
      this._stackingCanvasRecoveryTimerId = null;
      this._stackingCanvasRecoveryUntil = 0;
      if (this._container) {
        this._updatePlaceholderMode();
      }
    }, delayMs);
  }

  private _syncCanvasBudgetForViewportZoom() {
    const nextZoom = this.viewport.zoom;

    if (
      !shouldSyncCanvasBudgetOnViewportUpdate(
        this._lastCanvasBudgetZoom,
        nextZoom
      )
    ) {
      this._lastCanvasBudgetZoom = nextZoom;
      return;
    }

    this._lastCanvasBudgetZoom = nextZoom;
    this._resetSize();
    this._render();
  }

  private _updatePlaceholderMode() {
    const gestureActive =
      this.viewport.panning$.value || this.viewport.zooming$.value;
    const recoveryActive = this._isStackingCanvasRecoveryActive();
    const lowZoomSurvivalMode = shouldUseLowZoomSurvivalMode(
      IS_IOS,
      this.viewport.zoom,
      gestureActive
    );
    const shouldBypassStackingCanvases =
      shouldBypassStackingCanvasesDuringLowZoomGesture({
        isIOS: IS_IOS,
        zoom: this.viewport.zoom,
        gestureActive,
        recoveryActive,
        viewportWidth: this.viewport.width,
        viewportHeight: this.viewport.height,
      });
    const shouldRenderPlaceholders = shouldRenderCanvasPlaceholders({
      isIOS: IS_IOS,
      zoom: this.viewport.zoom,
      isPanning: this.viewport.panning$.value,
      isZooming: this.viewport.zooming$.value,
      skipRefreshDuringGesture: this.viewport.SKIP_REFRESH_DURING_GESTURE,
      turboEnabled: this._turboEnabled(),
    });

    const bypassModeChanged =
      this._lastBypassStackingCanvases !== shouldBypassStackingCanvases;

    this._syncStackingCanvasAttachment(!shouldBypassStackingCanvases);

    if (this.usePlaceholder === shouldRenderPlaceholders) {
      this._lastLowZoomSurvivalMode = lowZoomSurvivalMode;
      this._lastBypassStackingCanvases = shouldBypassStackingCanvases;
      if (bypassModeChanged) {
        this.refresh({ type: 'all' });
      }
      return;
    }

    this.usePlaceholder = shouldRenderPlaceholders;
    const survivalModeChanged =
      this._lastLowZoomSurvivalMode !== lowZoomSurvivalMode;
    this._lastLowZoomSurvivalMode = lowZoomSurvivalMode;
    this._lastBypassStackingCanvases = shouldBypassStackingCanvases;

    if (
      survivalModeChanged ||
      bypassModeChanged ||
      !this.viewport.SKIP_REFRESH_DURING_GESTURE ||
      !gestureActive
    ) {
      this.refresh({ type: 'all' });
    }
  }

  private _initStackingCanvas(onCreated?: (canvas: HTMLCanvasElement) => void) {
    const layer = this.layerManager;
    const updateStackingCanvas = () => {
      /**
       * we already have a main canvas, so the last layer should be skipped
       */
      const canvasLayers = layer.getCanvasLayers().slice(0, -1);
      const canvases = [];
      const currentCanvases = this._stackingCanvas;
      const lastLayer = last(this.layerManager.layers);
      const maximumZIndex = lastLayer
        ? lastLayer.zIndex + lastLayer.elements.length + 1
        : 1;

      this.canvas.style.zIndex = maximumZIndex.toString();
      for (let i = 0; i < canvasLayers.length; ++i) {
        const layer = canvasLayers[i];
        const created = i < currentCanvases.length;
        const canvas = created
          ? currentCanvases[i]
          : this._createCanvasForLayer(onCreated);

        canvas.dataset.layerId = `[${layer.indexes[0]}--${layer.indexes[1]}]`;
        canvas.style.zIndex = layer.zIndex.toString();
        canvases.push(canvas);
      }

      this._stackingCanvas = canvases;

      if (currentCanvases.length !== canvases.length) {
        const diff = canvases.length - currentCanvases.length;
        const payload: {
          canvases: HTMLCanvasElement[];
          removed: HTMLCanvasElement[];
          added: HTMLCanvasElement[];
        } = {
          canvases,
          removed: [],
          added: [],
        };

        if (diff > 0) {
          if (this._stackingCanvasesAttached) {
            payload.added = canvases.slice(-diff);
          }
        } else {
          payload.removed = currentCanvases.slice(diff);
          payload.removed.forEach(canvas => {
            this._resetPooledCanvas(canvas);
            this._stackingCanvasPool.push(canvas);
          });
        }

        if (payload.added.length || payload.removed.length) {
          this.stackingCanvasUpdated.next(payload);
        }
      }

      this.refresh({ type: 'all' });
    };

    this._disposables.add(
      this.layerManager.slots.layerUpdated.subscribe(() => {
        updateStackingCanvas();
      })
    );

    updateStackingCanvas();
  }

  private _initViewport() {
    let sizeUpdatedRafId: number | null = null;

    this._disposables.add({
      dispose: () => this._clearStackingCanvasRecoveryTimer(),
    });

    this._disposables.add(
      this.viewport.zoomUpdated.subscribe(() => {
        this._syncCanvasBudgetForViewportZoom();
      })
    );

    this._disposables.add(
      this.viewport.viewportUpdated.subscribe(() => {
        this._updatePlaceholderMode();
        if (
          this.viewport.SKIP_REFRESH_DURING_GESTURE &&
          (this.viewport.panning$.value || this.viewport.zooming$.value)
        ) {
          return;
        }
        this.refresh({ type: 'all' });
      })
    );

    this._disposables.add(
      this.viewport.sizeUpdated.subscribe(() => {
        if (
          IS_IOS &&
          this.viewport.zoom <= IOS_LOW_ZOOM_SURVIVAL_THRESHOLD &&
          this.viewport.width > this.viewport.height
        ) {
          this._scheduleStackingCanvasRecoveryWindow();
          if (this._container) {
            this._updatePlaceholderMode();
          }
        }

        if (sizeUpdatedRafId) return;
        sizeUpdatedRafId = requestConnectedFrame(() => {
          sizeUpdatedRafId = null;
          this._resetSize();
          // When SKIP_REFRESH_DURING_GESTURE is active, schedule the render
          // after a short delay to let the layout settle on orientation change,
          // avoiding a white-flash from resizing + rendering in the same frame.
          if (this.viewport.SKIP_REFRESH_DURING_GESTURE) {
            setTimeout(() => this._render(), 16);
          } else {
            this._render();
          }
        }, this._container);
      })
    );

    this._disposables.add(
      this.viewport.zooming$.subscribe(() => {
        this._updatePlaceholderMode();
      })
    );

    // When SKIP_REFRESH_DURING_GESTURE is enabled, defer heavy canvas work
    // while the gesture is still in-flight, but start the first recovery frame
    // immediately once both gesture signals have fully settled.
    if (this.viewport.SKIP_REFRESH_DURING_GESTURE) {
      let pendingCanvasTimerId: ReturnType<typeof setTimeout> | null = null;

      const cancelPendingCanvasRefresh = () => {
        if (pendingCanvasTimerId !== null) {
          clearTimeout(pendingCanvasTimerId);
          pendingCanvasTimerId = null;
        }
      };

      const scheduleCanvasRefresh = () => {
        cancelPendingCanvasRefresh();
        const delayMs = getPostGestureRecoveryDelay({
          isPanning: this.viewport.panning$.value,
          isZooming: this.viewport.zooming$.value,
          fallbackDelayMs: viewportRuntimeConfig.POST_GESTURE_REFRESH_DELAY,
        });
        pendingCanvasTimerId = setTimeout(() => {
          pendingCanvasTimerId = null;
          // If a gesture is still in-flight when the timer fires, reschedule
          // instead of dropping. Dropping here left connectors blank until a
          // tap forced a synchronous refresh.
          if (this.viewport.panning$.value || this.viewport.zooming$.value) {
            scheduleCanvasRefresh();
            return;
          }
          this.refresh({ type: 'all' });
        }, delayMs);
      };

      this._disposables.add(
        this.viewport.panning$.subscribe(panning => {
          this._updatePlaceholderMode();
          if (panning) {
            cancelPendingCanvasRefresh();
          } else {
            scheduleCanvasRefresh();
          }
        })
      );
      this._disposables.add(
        this.viewport.zooming$.subscribe(zooming => {
          this._updatePlaceholderMode();
          if (zooming) {
            cancelPendingCanvasRefresh();
          } else {
            scheduleCanvasRefresh();
          }
        })
      );
      this._disposables.add({ dispose: cancelPendingCanvasRefresh });
    }

    let wasDragging = false;
    this._disposables.add(
      effect(() => {
        const isDragging = this._gfx.tool.dragging$.value;

        if (wasDragging && !isDragging) {
          if (this.viewport.panning$.value || this.viewport.zooming$.value) {
            // Deferred refresh will handle it after gesture ends
          } else {
            this.refresh({ type: 'all' });
          }
        }

        wasDragging = isDragging;
      })
    );

    this.usePlaceholder = false;
  }

  private _createRenderPassStats(): RenderPassStats {
    return {
      renderByBoundCallCount: 0,
      visibleElementCount: 0,
      renderedElementCount: 0,
      placeholderElementCount: 0,
      overlayCount: 0,
    };
  }

  private _getCanvasMemorySnapshots(): CanvasMemorySnapshot[] {
    return [this.canvas, ...this._stackingCanvas].map((canvas, index) => {
      return {
        kind: index === 0 ? 'main' : 'stacking',
        width: canvas.width,
        height: canvas.height,
        bytes: canvas.width * canvas.height * 4,
        zIndex: canvas.style.zIndex,
        datasetLayerId: canvas.dataset.layerId ?? null,
      };
    });
  }

  private _render() {
    const renderStart = performance.now();
    const { overscanViewportBounds, viewportBounds, zoom } = this.viewport;
    const {
      cullBound: mainCanvasCullBound,
      renderBound: mainCanvasRenderBound,
    } = getMainCanvasFallbackBounds({
      viewportBounds,
      overscanViewportBounds,
    });
    const { ctx } = this;
    const dpr = getEffectiveDpr(zoom);
    const scale = zoom * dpr;
    const matrix = new DOMMatrix().scaleSelf(scale);
    const renderStats = this._createRenderPassStats();
    const fullRender = this._needsFullRender;
    const bypassStackingCanvases = getStackingCanvasBypassState({
      isIOS: IS_IOS,
      zoom: this.viewport.zoom,
      gestureActive:
        this.viewport.panning$.value || this.viewport.zooming$.value,
      recoveryActive: this._isStackingCanvasRecoveryActive(),
      viewportWidth: this.viewport.width,
      viewportHeight: this.viewport.height,
    });
    const stackingIndexesToRender = bypassStackingCanvases
      ? []
      : fullRender
        ? this._stackingCanvas.map((_, idx) => idx)
        : [...this._dirtyStackingCanvasIndexes.keys()];
    /**
     * if a layer does not have a corresponding canvas
     * its element will be add to this array and drawing on the
     * main canvas
     */
    let fallbackElement: SurfaceElementModel[] = [];
    const allCanvasLayers = this.layerManager.getCanvasLayers();
    const stackingViewportBound = Bound.from(overscanViewportBounds);

    this._canvasSizeUpdater(mainCanvasRenderBound, dpr).update(this.canvas);
    // Capy (local change 76): whether this frame draws a region anywhere.
    let regionDrawn = false;

    if (bypassStackingCanvases) {
      this._stackingCanvas.forEach(canvas => {
        this._applyStackingCanvasLayout(canvas, null, dpr);
      });
    }

    for (const idx of stackingIndexesToRender) {
      const layer = allCanvasLayers[idx];
      const canvas = this._stackingCanvas[idx];

      if (!layer || !canvas) {
        continue;
      }

      const layerRenderBound = this._getLayerRenderBound(
        layer.elements,
        stackingViewportBound
      );
      const resolvedLayerRenderBound = this._getResolvedStackingCanvasBound(
        canvas,
        layerRenderBound
      );
      this._applyStackingCanvasLayout(canvas, resolvedLayerRenderBound);

      if (
        !resolvedLayerRenderBound ||
        canvas.width === 0 ||
        canvas.height === 0
      ) {
        continue;
      }

      const layerCtx = canvas.getContext('2d') as CanvasRenderingContext2D;
      const layerRc = new RoughCanvas(layerCtx.canvas);
      // Capy (local change 76): at the origin, scale and size it was last
      // drawn at, only the region its changed elements reach is drawn again.
      const kept = this._keepsPlacement(
        canvas,
        `${resolvedLayerRenderBound.x},${resolvedLayerRenderBound.y},${scale}`
      );
      const region = fullRender
        ? 'whole'
        : (this._dirtyStackingCanvasIndexes.get(idx) ?? 'whole');
      if (region !== 'whole' && kept) {
        this._renderRegion(
          layerCtx,
          matrix,
          layerRc,
          resolvedLayerRenderBound,
          region,
          layer.elements,
          false,
          renderStats,
          resolvedLayerRenderBound
        );
        regionDrawn = true;
        continue;
      }

      layerCtx.clearRect(0, 0, canvas.width, canvas.height);
      layerCtx.save();
      layerCtx.setTransform(matrix);

      this._renderByBound(
        layerCtx,
        matrix,
        layerRc,
        resolvedLayerRenderBound,
        layer.elements,
        false,
        renderStats
      );
    }

    if (fullRender || this._mainCanvasDirty) {
      // Capy (local change 76): which layers fall back here, for the placement.
      const fallbackLayers: number[] = [];
      allCanvasLayers.forEach((layer, idx) => {
        if (
          bypassStackingCanvases ||
          !this._stackingCanvas[idx] ||
          this._stackingCanvas[idx].width === 0 ||
          this._stackingCanvas[idx].height === 0
        ) {
          fallbackElement = fallbackElement.concat(layer.elements);
          fallbackLayers.push(idx);
        }
      });

      // Capy (local change 76): a region only over what was drawn at this
      // origin and scale, with these layers.
      const kept = this._keepsPlacement(
        this.canvas,
        `${mainCanvasRenderBound.x},${mainCanvasRenderBound.y},${scale},${fallbackLayers.join(' ')}`
      );
      const region = fullRender || !kept ? 'whole' : this._mainDirtyRegion;
      if (region !== 'whole') regionDrawn = true;
      if (region === 'whole') {
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();
        ctx.setTransform(matrix);

        this._renderByBound(
          ctx,
          matrix,
          new RoughCanvas(ctx.canvas),
          mainCanvasRenderBound,
          fallbackElement,
          true,
          renderStats,
          mainCanvasCullBound
        );
      } else {
        this._renderRegion(
          ctx,
          matrix,
          new RoughCanvas(ctx.canvas),
          mainCanvasRenderBound,
          region,
          fallbackElement,
          true,
          renderStats,
          mainCanvasCullBound
        );
      }
    }

    const canvasMemorySnapshots = this._getCanvasMemorySnapshots();
    const canvasMemoryBytes = canvasMemorySnapshots.reduce(
      (sum, snapshot) => sum + snapshot.bytes,
      0
    );
    const layerTypes = this.layerManager.layers.map(layer => layer.type);
    const renderDurationMs = performance.now() - renderStart;

    this._debugMetrics.renderCount += 1;
    this._debugMetrics.totalRenderDurationMs += renderDurationMs;
    this._debugMetrics.lastRenderDurationMs = renderDurationMs;
    this._debugMetrics.maxRenderDurationMs = Math.max(
      this._debugMetrics.maxRenderDurationMs,
      renderDurationMs
    );
    this._debugMetrics.lastRenderMetrics = renderStats;
    this._debugMetrics.fallbackElementCount = fallbackElement.length;
    this._debugMetrics.dirtyLayerRenderCount = stackingIndexesToRender.length;

    this._lastDebugSnapshot = {
      canvasMemorySnapshots,
      canvasMemoryBytes,
      canvasPixelCount: canvasMemorySnapshots.reduce(
        (sum, snapshot) => sum + snapshot.width * snapshot.height,
        0
      ),
      stackingCanvasCount: this._stackingCanvas.length,
      canvasLayerCount: layerTypes.filter(type => type === 'canvas').length,
      totalLayerCount: layerTypes.length,
      pooledStackingCanvasCount: this._stackingCanvasPool.length,
      visibleStackingCanvasCount: this._stackingCanvas.filter(
        canvas => canvas.width > 0 && canvas.height > 0
      ).length,
    };

    this._needsFullRender = false;
    this._mainCanvasDirty = false;
    this._dirtyStackingCanvasIndexes.clear();
    // Capy (local change 76): a whole pass settles every region; a region
    // pass waits for the next pause.
    if (fullRender) this._cancelSettle();
    else if (regionDrawn) this._scheduleSettle();
  }

  // Capy (local change 76)
  /** Whether `canvas` still holds what was drawn at `placement` and at its
   * size now, so a region can be drawn over it; records them for the next
   * pass. */
  private _keepsPlacement(canvas: HTMLCanvasElement, placement: string) {
    const now = `${placement},${canvas.width},${canvas.height}`;
    const kept = this._drawnPlacements.get(canvas) === now;
    this._drawnPlacements.set(canvas, now);
    return kept;
  }

  // Capy (local change 76): a plain timer, then a frame (`refresh`):
  // `requestIdleCallback` is not in Safari's stable releases.
  private _scheduleSettle() {
    this._cancelSettle();
    this._settleTimer = setTimeout(() => {
      this._settleTimer = null;
      this.refresh({ type: 'all' });
    }, SETTLE_MS);
  }

  private _cancelSettle() {
    if (this._settleTimer === null) return;
    clearTimeout(this._settleTimer);
    this._settleTimer = null;
  }

  private _lastDebugSnapshot: Pick<
    CanvasRendererDebugMetrics,
    | 'canvasMemoryBytes'
    | 'canvasMemorySnapshots'
    | 'canvasPixelCount'
    | 'canvasLayerCount'
    | 'pooledStackingCanvasCount'
    | 'stackingCanvasCount'
    | 'totalLayerCount'
    | 'visibleStackingCanvasCount'
  > = {
    canvasMemoryBytes: 0,
    canvasMemorySnapshots: [],
    canvasPixelCount: 0,
    canvasLayerCount: 0,
    pooledStackingCanvasCount: 0,
    stackingCanvasCount: 0,
    totalLayerCount: 0,
    visibleStackingCanvasCount: 0,
  };

  private _renderByBound(
    ctx: CanvasRenderingContext2D | null,
    matrix: DOMMatrix,
    rc: RoughCanvas,
    bound: IBound,
    surfaceElements?: SurfaceElementModel[],
    overLay: boolean = false,
    renderStats?: RenderPassStats,
    cullBound: IBound = bound,
    // Capy (local change 76): a region drawn again takes every element a
    // whole pass draws (its bound in the canvas's cull) whose drawing reaches
    // the region's cleared pixels.
    cleared?: IBound
  ) {
    if (!ctx) return;

    renderStats && (renderStats.renderByBoundCallCount += 1);

    const elements =
      surfaceElements ??
      (this.grid.search(cullBound, {
        filter: ['canvas', 'local'],
      }) as SurfaceElementModel[]);

    for (const element of elements) {
      const display = (element.display ?? true) && !element.hidden;
      if (
        display &&
        intersects(getBoundWithRotation(element), cullBound) &&
        (!cleared || intersects(reachOf(element), cleared))
      ) {
        renderStats && (renderStats.visibleElementCount += 1);
        if (
          this.usePlaceholder &&
          !(element as GfxCompatibleInterface).forceFullRender
        ) {
          renderStats && (renderStats.placeholderElementCount += 1);
          ctx.save();
          ctx.fillStyle = resolveSurfacePlaceholderColor(this.getColorScheme());
          const drawX = element.x - bound.x;
          const drawY = element.y - bound.y;
          ctx.fillRect(drawX, drawY, element.w, element.h);
          ctx.restore();
        } else {
          renderStats && (renderStats.renderedElementCount += 1);
          ctx.save();
          const renderFn = this.std.getOptional<ElementRenderer>(
            ElementRendererIdentifier(element.type)
          );

          // Capy (local change 76): restored, or a region's clip stays on.
          if (!renderFn) {
            ctx.restore();
            continue;
          }

          ctx.globalAlpha = element.opacity ?? 1;
          const dx = element.x - bound.x;
          const dy = element.y - bound.y;
          renderFn(element, ctx, matrix.translate(dx, dy), this, rc, bound);
          ctx.restore();
        }
        // Capy (local change 76): after its renderer, which places a group's
        // title.
        this._drawnExtents.set(element, reachOf(element));
      }
    }

    if (overLay) {
      renderStats && (renderStats.overlayCount += this._overlays.size);
      for (const overlay of this._overlays) {
        ctx.save();
        ctx.translate(-bound.x, -bound.y);
        overlay.render(ctx, rc);
        ctx.restore();
      }
    }

    ctx.restore();
  }

  /**
   * Capy (local change 76): clears `region` of a canvas whose top left is
   * `bound`'s, in whole device pixels so its edges join what stays, and draws
   * there, clipped, in order, every element a whole pass draws (in
   * `cullBound`) that reaches it, and the overlays.
   */
  private _renderRegion(
    ctx: CanvasRenderingContext2D,
    matrix: DOMMatrix,
    rc: RoughCanvas,
    bound: Bound,
    region: Bound,
    surfaceElements: SurfaceElementModel[],
    overLay: boolean,
    renderStats: RenderPassStats,
    cullBound: IBound
  ) {
    const scale = matrix.a;
    const { height, width } = ctx.canvas;
    const left = Math.max(0, Math.floor((region.x - bound.x) * scale));
    const top = Math.max(0, Math.floor((region.y - bound.y) * scale));
    const right = Math.min(width, Math.ceil((region.maxX - bound.x) * scale));
    const bottom = Math.min(height, Math.ceil((region.maxY - bound.y) * scale));
    if (right <= left || bottom <= top) return;
    // The pixels cleared, in model units.
    const cleared = new Bound(
      bound.x + left / scale,
      bound.y + top / scale,
      (right - left) / scale,
      (bottom - top) / scale
    );

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(left, top, right - left, bottom - top);
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    ctx.setTransform(matrix);

    this._renderByBound(
      ctx,
      matrix,
      rc,
      bound,
      surfaceElements,
      overLay,
      renderStats,
      cullBound,
      cleared
    );
  }

  private _resetSize() {
    const sizeUpdater = this._canvasSizeUpdater(
      this.viewport.overscanViewportBounds
    );

    sizeUpdater.update(this.canvas);
    this._lastCanvasBudgetZoom = this.viewport.zoom;
    this._invalidate({ type: 'all' });
  }

  private _watchSurface(surfaceModel: SurfaceBlockModel) {
    this._disposables.add(
      surfaceModel.elementAdded.subscribe(() => this.refresh({ type: 'all' }))
    );
    this._disposables.add(
      surfaceModel.elementRemoved.subscribe(() => this.refresh({ type: 'all' }))
    );
    this._disposables.add(
      surfaceModel.localElementAdded.subscribe(() =>
        this.refresh({ type: 'all' })
      )
    );
    this._disposables.add(
      surfaceModel.localElementDeleted.subscribe(() =>
        this.refresh({ type: 'all' })
      )
    );
    this._disposables.add(
      surfaceModel.localElementUpdated.subscribe(({ model }) => {
        this.refresh({ type: 'element', element: model });
      })
    );

    this._disposables.add(
      surfaceModel.elementUpdated.subscribe(payload => {
        // ignore externalXYWH update cause it's updated by the renderer
        if (payload.props['externalXYWH']) return;
        const element = surfaceModel.getElementById(payload.id);
        this.refresh(element ? { type: 'element', element } : { type: 'all' });
      })
    );
  }

  addOverlay(overlay: Overlay) {
    overlay.setRenderer(this);
    this._overlays.add(overlay);
    this.refresh({ type: 'main' });
  }

  /**
   * Used to attach main canvas, main canvas will always exist
   * @param container
   */
  attach(container: HTMLElement) {
    this._container = container;
    container.append(this.canvas);

    this._updatePlaceholderMode();
    this._resetSize();
    this.refresh({ type: 'all' });
  }

  dispose(): void {
    // Capy (local change 76)
    this._cancelSettle();
    this._overlays.forEach(overlay => overlay.dispose());
    this._overlays.clear();
    this._disposables.dispose();
  }

  generateColorProperty(color: Color, fallback?: Color) {
    return (
      this.provider.generateColorProperty?.(color, fallback) ?? 'transparent'
    );
  }

  getCanvasByBound(
    bound: IBound = this.viewport.viewportBounds,
    surfaceElements?: SurfaceElementModel[],
    canvas?: HTMLCanvasElement,
    clearBeforeDrawing?: boolean,
    withZoom?: boolean,
    // Capy (local change 19): a big board's image can't always take the device's scale.
    scale?: number
  ): HTMLCanvasElement {
    canvas = canvas || document.createElement('canvas');

    const dpr = scale ?? (window.devicePixelRatio || 1);
    const actualWidth = Math.ceil(bound.w * dpr);
    const actualHeight = Math.ceil(bound.h * dpr);

    if (canvas.width !== actualWidth) canvas.width = actualWidth;
    if (canvas.height !== actualHeight) canvas.height = actualHeight;

    canvas.style.width = `${bound.w}px`;
    canvas.style.height = `${bound.h}px`;

    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const matrix = new DOMMatrix().scaleSelf(
      withZoom ? dpr * this.viewport.zoom : dpr
    );
    const rc = new RoughCanvas(canvas);

    if (clearBeforeDrawing) ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(matrix);

    this._renderByBound(ctx, matrix, rc, bound, surfaceElements);

    return canvas;
  }

  getColorScheme() {
    return this.provider.getColorScheme?.() ?? ColorScheme.Light;
  }

  getColorValue(color: Color, fallback?: Color, real?: boolean) {
    return (
      this.provider.getColorValue?.(color, fallback, real) ?? 'transparent'
    );
  }

  getPropertyValue(property: string) {
    return this.provider.getPropertyValue?.(property) ?? '';
  }

  getDebugMetrics(): CanvasRendererDebugMetrics {
    return {
      ...this._debugMetrics,
      ...this._lastDebugSnapshot,
      canvasMemoryMegabytes:
        this._lastDebugSnapshot.canvasMemoryBytes / 1024 / 1024,
    };
  }

  resetDebugMetrics() {
    this._debugMetrics = {
      refreshCount: 0,
      coalescedRefreshCount: 0,
      renderCount: 0,
      totalRenderDurationMs: 0,
      lastRenderDurationMs: 0,
      maxRenderDurationMs: 0,
      lastRenderMetrics: this._createRenderPassStats(),
      dirtyLayerRenderCount: 0,
      fallbackElementCount: 0,
    };
    this._lastDebugSnapshot = {
      canvasMemoryBytes: 0,
      canvasMemorySnapshots: [],
      canvasPixelCount: 0,
      canvasLayerCount: 0,
      pooledStackingCanvasCount: 0,
      stackingCanvasCount: 0,
      totalLayerCount: 0,
      visibleStackingCanvasCount: 0,
    };
  }

  refresh(target: RefreshTarget = { type: 'all' }) {
    this._debugMetrics.refreshCount += 1;
    this._invalidate(target);
    if (this._refreshRafId !== null) {
      this._debugMetrics.coalescedRefreshCount += 1;
      return;
    }

    this._refreshRafId = requestConnectedFrame(() => {
      this._refreshRafId = null;
      this._render();
    }, this._container);
  }

  removeOverlay(overlay: Overlay) {
    if (!this._overlays.has(overlay)) {
      return;
    }

    overlay.setRenderer(null);
    this._overlays.delete(overlay);
    this.refresh({ type: 'main' });
  }
}
