import { STYLES, type Style, THEMES, type Theme } from '@/theme/theme';
import {
  isOfficeHeaderActions,
  isOfficeMenus,
  type OfficeHeaderAction,
  type OfficeMenu,
} from './officeMenus';

export const OFFICE_PROTOCOL_VERSION = 7 as const;

/** Capy's UI locales; the runtime draws its chrome and menus in the same one. */
export type OfficeLocale = 'en' | 'zh';

/** One page or image from `render`: PNG bytes and its CSS size in px. */
export interface OfficeRenderedPage {
  bytes: ArrayBuffer;
  height: number;
  width: number;
}

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';
export type OfficeCitation = { quote: string; page?: number };

export type OfficeMode = 'view' | 'edit';

export type OfficeAnalysis =
  | {
      format: 'docx';
      pageCount: number;
    }
  | {
      format: 'xlsx';
      sheetCount: number;
      sheetNames: string[];
      contentWidth: number;
      contentHeight: number;
    }
  | {
      format: 'pptx';
      slideCount: number;
      widthEmu: number;
      heightEmu: number;
      textCharacterCount: number;
    };

export type OfficeHostMessage =
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'set-citation';
      citation: OfficeCitation | null;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'load';
      format: OfficeFormat;
      fileName: string;
      bytes: ArrayBuffer;
      canEdit: boolean;
      mode: OfficeMode;
      revision: number;
      collaboration?: { epoch: number; initialUpdate: ArrayBuffer };
      /** View mode only: saved Yrs state to export over `bytes` before opening. */
      checkpoint?: ArrayBuffer;
      /**
       * With a checkpoint: it is the change over seed(`bytes`) whose SHA-256
       * this is; without, the checkpoint is a complete state.
       */
      checkpointSeedSHA256?: string;
      citation?: OfficeCitation | null;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'update';
      epoch: number;
      bytes: ArrayBuffer;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'flush';
      epoch: number;
      id: string;
    }
  | { version: typeof OFFICE_PROTOCOL_VERSION; type: 'export'; id: string }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'set-capabilities';
      canEdit: boolean;
    }
  /** Capy's appearance, sent when the runtime starts and on every change. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'set-appearance';
      style: Style;
      theme: Theme;
      /** The viewport is below lg, where the PDF toolbar drops zoom too. */
      narrow: boolean;
      locale: OfficeLocale;
    }
  /** A click on a runtime menu item or header action (not a host command). */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'menu-command';
      id: string;
      /** A grid's size, "<rows>x<cols>". */
      value?: string;
    }
  /** The file Capy's picker returned for a `pick` item. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'menu-file';
      id: string;
      name: string;
      mimeType: string;
      bytes: ArrayBuffer;
    }
  /** Pages to print, or one image to save as PNG; answered by `rendered`. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'render';
      id: string;
      kind: 'print' | 'png';
    };

/**
 * `ready` after the first paint: the runtime's own clock (`performance.now()`
 * in its frame), which the host cannot read across origins.
 */
export interface OfficeReadyTimings {
  /** Frame start → the host's `load` arrived: frame boot plus the host's fetch. */
  loadMs: number;
  /** `load` arrived → the first pages painted: parse, fonts, layout, raster. */
  paintMs: number;
}

export type OfficeRuntimeMessage =
  | { version: typeof OFFICE_PROTOCOL_VERSION; type: 'initialized' }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'update' | 'collaboration-ready';
      epoch: number;
      bytes: ArrayBuffer;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'flushed';
      epoch: number;
      id: string;
      bytes: ArrayBuffer;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'checkpoint';
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'exported';
      id: string;
      bytes: ArrayBuffer;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'ready';
      analysis: OfficeAnalysis;
      revision: number;
      /**
       * Sent once the first pages, grid or slide are painted: by every viewer
       * and by the DOCX editor (the XLSX and PPTX editors send no `ready`).
       */
      timings?: OfficeReadyTimings;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'mode';
      mode: OfficeMode;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'dirty';
      dirty: boolean;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'save';
      bytes: ArrayBuffer;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'error';
      message: string;
      revision: number;
    }
  /** The whole menu bar and header actions, re-sent when either changes. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'menus';
      menus: OfficeMenu[];
      actions: OfficeHeaderAction[];
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'rendered';
      id: string;
      pages: OfficeRenderedPage[];
      revision: number;
      /** A sheet longer than the page cap printed only its first pages. */
      truncated: boolean;
    }
  /** The pages could not be drawn; the document itself is fine. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'render-failed';
      id: string;
      revision: number;
    };

type WithoutVersion<T> = T extends unknown ? Omit<T, 'version'> : never;
export type OfficeRuntimePayload = WithoutVersion<OfficeRuntimeMessage>;

export function isOfficeHostMessage(
  value: unknown
): value is OfficeHostMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== OFFICE_PROTOCOL_VERSION) return false;
  if (candidate.type === 'set-citation')
    return isOfficeCitation(candidate.citation);
  if (candidate.type === 'update')
    return isCount(candidate.epoch) && candidate.bytes instanceof ArrayBuffer;
  if (candidate.type === 'flush')
    return isCount(candidate.epoch) && typeof candidate.id === 'string';
  if (candidate.type === 'export') return typeof candidate.id === 'string';
  if (candidate.type === 'set-appearance')
    return (
      STYLES.some((style) => style.value === candidate.style) &&
      THEMES.some((theme) => theme.value === candidate.theme) &&
      typeof candidate.narrow === 'boolean' &&
      (candidate.locale === 'en' || candidate.locale === 'zh')
    );
  if (candidate.type === 'menu-command')
    return (
      typeof candidate.id === 'string' &&
      (candidate.value === undefined || typeof candidate.value === 'string')
    );
  if (candidate.type === 'menu-file')
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.mimeType === 'string' &&
      candidate.bytes instanceof ArrayBuffer
    );
  if (candidate.type === 'render')
    return (
      typeof candidate.id === 'string' &&
      (candidate.kind === 'print' || candidate.kind === 'png')
    );
  return (
    candidate.version === OFFICE_PROTOCOL_VERSION &&
    ((candidate.type === 'load' &&
      (candidate.citation === undefined ||
        isOfficeCitation(candidate.citation)) &&
      ['docx', 'pptx', 'xlsx'].includes(
        String((candidate as { format?: unknown }).format)
      ) &&
      ['edit', 'view'].includes(
        String((candidate as { mode?: unknown }).mode)
      ) &&
      typeof (candidate as { fileName?: unknown }).fileName === 'string' &&
      typeof (candidate as { canEdit?: unknown }).canEdit === 'boolean' &&
      (candidate as { bytes?: unknown }).bytes instanceof ArrayBuffer &&
      typeof (candidate as { revision?: unknown }).revision === 'number' &&
      isRevision((candidate as { revision: number }).revision) &&
      ['undefined', 'string'].includes(
        typeof (candidate as { checkpointSeedSHA256?: unknown })
          .checkpointSeedSHA256
      ) &&
      (candidate.mode === 'view' ||
        isCollaboration(candidate.collaboration))) ||
      (candidate.type === 'set-capabilities' &&
        typeof (candidate as { canEdit?: unknown }).canEdit === 'boolean'))
  );
}

/**
 * The runtime started under another protocol version: a deploy replaced the
 * runtime or the app while this tab stayed open, and neither side reads the
 * other's messages. The host asks for a reload instead of waiting.
 */
export function isOutdatedOfficeRuntime(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return raw.type === 'initialized' && raw.version !== OFFICE_PROTOCOL_VERSION;
}

export function isOfficeRuntimeMessage(
  value: unknown
): value is OfficeRuntimeMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    revision?: unknown;
    type?: unknown;
    version?: unknown;
  };
  const raw = value as Record<string, unknown>;
  if (raw.version === OFFICE_PROTOCOL_VERSION && raw.type === 'initialized')
    return true;
  if (raw.version === OFFICE_PROTOCOL_VERSION && isCount(raw.revision)) {
    if (raw.type === 'checkpoint') return true;
    if (raw.type === 'menus')
      return isOfficeMenus(raw.menus) && isOfficeHeaderActions(raw.actions);
    if (raw.type === 'rendered')
      return (
        typeof raw.id === 'string' &&
        typeof raw.truncated === 'boolean' &&
        Array.isArray(raw.pages) &&
        raw.pages.every(isRenderedPage)
      );
    if (raw.type === 'render-failed') return typeof raw.id === 'string';
    if (raw.type === 'exported')
      return typeof raw.id === 'string' && raw.bytes instanceof ArrayBuffer;
    if (
      raw.type === 'update' ||
      raw.type === 'collaboration-ready' ||
      raw.type === 'flushed'
    )
      return (
        isCount(raw.epoch) &&
        raw.bytes instanceof ArrayBuffer &&
        (raw.type !== 'flushed' || typeof raw.id === 'string')
      );
  }
  return (
    candidate.version === OFFICE_PROTOCOL_VERSION &&
    typeof candidate.revision === 'number' &&
    isRevision(candidate.revision) &&
    ((candidate.type === 'ready' &&
      isOfficeAnalysis((candidate as { analysis?: unknown }).analysis) &&
      isReadyTimings((candidate as { timings?: unknown }).timings)) ||
      (candidate.type === 'mode' &&
        ['edit', 'view'].includes(
          String((candidate as { mode?: unknown }).mode)
        )) ||
      (candidate.type === 'dirty' &&
        typeof (candidate as { dirty?: unknown }).dirty === 'boolean') ||
      (candidate.type === 'save' &&
        (candidate as { bytes?: unknown }).bytes instanceof ArrayBuffer) ||
      (candidate.type === 'error' &&
        typeof (candidate as { message?: unknown }).message === 'string'))
  );
}

function isRenderedPage(value: unknown): value is OfficeRenderedPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Record<string, unknown>;
  return (
    page.bytes instanceof ArrayBuffer &&
    isFiniteNumber(page.width) &&
    isFiniteNumber(page.height)
  );
}

function isReadyTimings(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const timings = value as Record<string, unknown>;
  return isFiniteNumber(timings.loadMs) && isFiniteNumber(timings.paintMs);
}

function isRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isOfficeAnalysis(value: unknown): value is OfficeAnalysis {
  if (!value || typeof value !== 'object') return false;
  const analysis = value as Record<string, unknown>;
  if (analysis.format === 'docx') {
    return isCount(analysis.pageCount);
  }
  if (analysis.format === 'xlsx') {
    return (
      isCount(analysis.sheetCount) &&
      Array.isArray(analysis.sheetNames) &&
      analysis.sheetNames.every((name) => typeof name === 'string') &&
      isFiniteNumber(analysis.contentWidth) &&
      isFiniteNumber(analysis.contentHeight)
    );
  }
  if (analysis.format === 'pptx') {
    return (
      isCount(analysis.slideCount) &&
      isFiniteNumber(analysis.widthEmu) &&
      isFiniteNumber(analysis.heightEmu) &&
      isCount(analysis.textCharacterCount)
    );
  }
  return false;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCollaboration(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isCount(candidate.epoch) && candidate.initialUpdate instanceof ArrayBuffer
  );
}

function isOfficeCitation(value: unknown): value is OfficeCitation | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.quote === 'string' &&
    item.quote.length > 0 &&
    item.quote.length <= 4000 &&
    (item.page === undefined ||
      (typeof item.page === 'number' &&
        Number.isInteger(item.page) &&
        item.page > 0))
  );
}
