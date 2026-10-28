import { STYLES, type Style, THEMES, type Theme } from '@/theme/theme';
import {
  isOfficeHeaderActions,
  isOfficeMenus,
  type OfficeHeaderAction,
  type OfficeMenu,
} from './officeMenus';

export const OFFICE_PROTOCOL_VERSION = 13 as const;

/** Capy's UI locales; the runtime draws its chrome and menus in the same one. */
export type OfficeLocale = 'en' | 'zh';

/**
 * One page or image from `render`: PNG bytes and its CSS size in px (a
 * `thumbnail`'s WebP bytes and its size in pixels).
 */
export interface OfficeRenderedPage {
  bytes: ArrayBuffer;
  height: number;
  width: number;
}

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';
export type OfficeCitation = { quote: string; page?: number };

export type OfficeMode = 'view' | 'edit';

/**
 * A file's zoom (1 = 100%; PPTX may also fit the slide to the window). The
 * host keeps it while the file stays open, for the next frame to open at.
 */
export type OfficeZoom = number | 'fit';

export interface OfficeCell {
  col: number;
  row: number;
}

/** A point in a DOCX story by Word paragraph id (`w14:paraId`), which a new
 * epoch keeps where Yrs positions change. */
export interface OfficeParagraphPoint {
  offset: number;
  paraId: string;
  story: string;
}

/**
 * Where a reader is in an editor, by content, so a room swap's next view
 * opens there (Epo 2026-10-22): DOCX the scroll offset, the first body
 * paragraph showing at the top (its fragment by first line) and how far
 * below the top edge it starts, and the selection; XLSX the sheet (by id)
 * and selected cells; PPTX the slide (1-based).
 */
export type OfficePosition =
  | {
      format: 'docx';
      scrollTop: number;
      top: { line: number | null; offset: number; paraId: string } | null;
      selection: {
        anchor: OfficeParagraphPoint;
        head: OfficeParagraphPoint;
      } | null;
    }
  | { format: 'xlsx'; sheet: string; anchor: OfficeCell; head: OfficeCell }
  | { format: 'pptx'; slide: number };

/**
 * An editor's cursor as it goes between Capy and the frame (Epo 2026-10-20):
 * a DOCX selection as the editor's encoded positions in a story, an XLSX cell
 * range on a sheet, a PPTX slide and shape. The room's awareness carries the
 * same, except DOCX positions as base64 (`officeCursors.ts`, Epo 2026-10-28).
 */
export type OfficeCursor =
  | { story: string; anchor: number[]; head: number[] }
  | { sheet: string; anchor: OfficeCell; head: OfficeCell }
  | { slideId: string; shapeId?: string };

/** A co-editor's cursor for the frame to draw, under the verified name the
 * room's presence gives its client id (never a name from its awareness). */
export interface OfficePeer {
  clientId: number;
  cursor: OfficeCursor;
  name: string;
}

/** Bounds on what a cursor and the peers carry, as the fork's providers'. */
export const MAX_CURSOR_TEXT = 1024;
export const MAX_CURSOR_BYTES = 1024;
export const MAX_PEERS = 256;

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
      /** The session's Yjs client id (Q213), which the editor writes
       * under. */
      collaboration?: {
        clientId: number;
        epoch: number;
        initialUpdate: ArrayBuffer;
        /** A DOCX session's id for the editor's resident layout worker
         * (Q219). */
        workerClientId?: number;
      };
      /**
       * Edit mode only: the plan image cap of the account paying for the
       * file; an inserted image over it is shrunk first.
       */
      imageMaxBytes?: number;
      /**
       * Edit mode only: what the room's state could still grow by when the
       * session was read; an inserted image past what is left is refused.
       */
      growthBudgetBytes?: number;
      /** View mode only: saved Yrs state to export over `bytes` before opening. */
      checkpoint?: ArrayBuffer;
      /**
       * With a checkpoint: it is the change over seed(`bytes`) whose SHA-256
       * this is; without, the checkpoint is a complete state.
       */
      checkpointSeedSHA256?: string;
      citation?: OfficeCitation | null;
      /** The zoom the file was last shown at; the format's default without. */
      zoom?: OfficeZoom;
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
  /**
   * Focus left the runtime for another part of Capy while the page kept it
   * (not an app or tab switch): an open cell edit ends, as a click elsewhere
   * in the sheet would end it.
   */
  | { version: typeof OFFICE_PROTOCOL_VERSION; type: 'focus-left' }
  /** The room's other editors' cursors, sent whenever they change. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'peers';
      peers: OfficePeer[];
    }
  /**
   * The tab holds back its collaboration messages (Epo 2026-10-18): frames
   * wait for the update allowance, an update's pieces (over 2 MiB,
   * `splitUpdate`) wait for the room's acknowledgement, or the user is in a
   * timeout. A DOCX or PPTX editor pauses meanwhile (`set-capabilities`
   * with canEdit false); the XLSX editor stays editable there and takes this
   * flag instead, refusing edits with a busy cursor.
   */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'sending';
      pending: boolean;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'set-capabilities';
      /** False pauses an editor: its engine turns read-only, so the document
       * can still be selected and copied. */
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
      /** The viewport is below md: a DOCX opens fitted to its pane and a pinch zooms it. */
      compact: boolean;
      /** The frame sits on a panel frosted over the page frame: its chrome
       * and the area around the document let the frost show through. */
      frosted: boolean;
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
  /**
   * Pages to print, one image to save as PNG, or an editor's list-card
   * capture (no page when there is nothing to capture); answered by
   * `rendered`. A runtime without captures drops `thumbnail`.
   */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'render';
      id: string;
      kind: 'print' | 'png' | 'thumbnail';
    }
  /** Where the editor's reader is, for a room swap; answered by `position`.
   * A runtime without it drops it, and the swap keeps the default view. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'position-request';
      id: string;
    }
  /** Open at a position the replaced view reported (a room swap); answered
   * by `position` once the editor is there. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'set-position';
      id: string;
      position: OfficePosition;
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

/**
 * Refusals the runtime reports for the host to show, not errors: typing into
 * a PPTX equation, an inserted image over the payer's plan cap or of a type
 * the browser cannot decode (nothing is inserted), an XLSX edit past the
 * engine's 64 MiB update cap or a copy (or cut) past the copied-area or text
 * ceiling (nothing changes), or an XLSX clipboard write the browser refused.
 */
export const OFFICE_NOTICES = [
  'equation-text',
  'image-budget',
  'image-too-large',
  'image-type',
  'edit-too-large',
  'copy-too-large',
  'copy-failed',
] as const;
export type OfficeNotice = (typeof OFFICE_NOTICES)[number];

export type OfficeRuntimeMessage =
  | { version: typeof OFFICE_PROTOCOL_VERSION; type: 'initialized' }
  /**
   * Keyboard, pointer, touch or wheel input in the frame, at most once a
   * minute (`reportInput`): Capy's idle close counts it as its page's own,
   * since the frame's events never reach it.
   */
  | { version: typeof OFFICE_PROTOCOL_VERSION; type: 'activity' }
  /** The editor's own cursor moved (null: it has none), for the room. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'cursor';
      cursor: OfficeCursor | null;
      revision: number;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'update';
      epoch: number;
      bytes: ArrayBuffer;
      revision: number;
      /** The edit may change the list-card capture (XLSX: made on the first sheet). */
      capture: boolean;
    }
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'collaboration-ready';
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
       * Sent once the first pages, grid or slide are painted, by every viewer
       * and editor.
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
  /** The user tried something the file refuses; the document is unaffected. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'notice';
      notice: OfficeNotice;
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
    }
  /** The viewer's or editor's zoom changed (also sent once it opens). */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'zoom';
      zoom: OfficeZoom;
      revision: number;
    }
  /**
   * The height of the frame's bottom chrome (XLSX sheet tabs, a narrow PPTX
   * slide strip, the speaker notes box), sent when it changes: Capy's floating
   * tools button sits above it.
   */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'bottom-inset';
      inset: number;
      revision: number;
    }
  /** A PPTX show started or ended: the frame gets the whole page meanwhile. */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'presenting';
      presenting: boolean;
      revision: number;
    }
  /**
   * A click in the show asks for the presenter window, which Capy opens from
   * that click's activation (it reaches the frame's ancestors) as from a
   * `popup` item.
   */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'open-presenter';
      /** The `popup: 'presenter'` command to run. */
      id: string;
      revision: number;
    }
  /** The answer to `position-request` and `set-position`: where the reader
   * is (null: no editor to ask). */
  | {
      version: typeof OFFICE_PROTOCOL_VERSION;
      type: 'position';
      id: string;
      position: OfficePosition | null;
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
  if (candidate.type === 'focus-left') return true;
  if (candidate.type === 'peers')
    return (
      Array.isArray(candidate.peers) &&
      candidate.peers.length <= MAX_PEERS &&
      candidate.peers.every(isOfficePeer)
    );
  if (candidate.type === 'sending')
    return typeof candidate.pending === 'boolean';
  if (candidate.type === 'set-appearance')
    return (
      STYLES.some((style) => style.value === candidate.style) &&
      THEMES.some((theme) => theme.value === candidate.theme) &&
      typeof candidate.narrow === 'boolean' &&
      typeof candidate.compact === 'boolean' &&
      typeof candidate.frosted === 'boolean' &&
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
      (candidate.kind === 'print' ||
        candidate.kind === 'png' ||
        candidate.kind === 'thumbnail')
    );
  if (candidate.type === 'position-request')
    return typeof candidate.id === 'string';
  if (candidate.type === 'set-position')
    return (
      typeof candidate.id === 'string' && isOfficePosition(candidate.position)
    );
  return (
    candidate.version === OFFICE_PROTOCOL_VERSION &&
    ((candidate.type === 'load' &&
      (candidate.citation === undefined ||
        isOfficeCitation(candidate.citation)) &&
      (candidate.zoom === undefined || isOfficeZoom(candidate.zoom)) &&
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
        (isCollaboration(
          candidate.collaboration,
          candidate.format === 'docx'
        ) &&
          isCount(candidate.imageMaxBytes) &&
          candidate.imageMaxBytes > 0 &&
          isCount(candidate.growthBudgetBytes)))) ||
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
  if (
    raw.version === OFFICE_PROTOCOL_VERSION &&
    (raw.type === 'initialized' || raw.type === 'activity')
  )
    return true;
  if (raw.version === OFFICE_PROTOCOL_VERSION && isCount(raw.revision)) {
    if (raw.type === 'checkpoint') return true;
    if (raw.type === 'cursor')
      return raw.cursor === null || isOfficeCursor(raw.cursor);
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
    if (raw.type === 'notice')
      return (OFFICE_NOTICES as readonly unknown[]).includes(raw.notice);
    if (raw.type === 'zoom') return isOfficeZoom(raw.zoom);
    if (raw.type === 'presenting') return typeof raw.presenting === 'boolean';
    if (raw.type === 'bottom-inset') return isFiniteNumber(raw.inset);
    if (raw.type === 'open-presenter') return typeof raw.id === 'string';
    if (raw.type === 'position')
      return (
        typeof raw.id === 'string' &&
        (raw.position === null || isOfficePosition(raw.position))
      );
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
        (raw.type !== 'flushed' || typeof raw.id === 'string') &&
        (raw.type !== 'update' || typeof raw.capture === 'boolean')
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

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_CURSOR_TEXT;

const isBytes = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length <= MAX_CURSOR_BYTES &&
  value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);

const isCell = (value: unknown): value is OfficeCell =>
  !!value &&
  typeof value === 'object' &&
  isCount((value as OfficeCell).row) &&
  isCount((value as OfficeCell).col);

/** A cursor in one of the three formats' shapes, within the bounds; read
 * from awareness, which any peer writes, and from the frame. */
export function isOfficeCursor(value: unknown): value is OfficeCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Record<string, unknown>;
  if ('story' in cursor)
    return (
      isText(cursor.story) && isBytes(cursor.anchor) && isBytes(cursor.head)
    );
  if ('sheet' in cursor)
    return isText(cursor.sheet) && isCell(cursor.anchor) && isCell(cursor.head);
  return (
    isText(cursor.slideId) &&
    (cursor.shapeId === undefined || isText(cursor.shapeId))
  );
}

const isParagraphPoint = (value: unknown): value is OfficeParagraphPoint =>
  !!value &&
  typeof value === 'object' &&
  isText((value as OfficeParagraphPoint).story) &&
  isText((value as OfficeParagraphPoint).paraId) &&
  isCount((value as OfficeParagraphPoint).offset);

/** A position in one of the three formats' shapes, within the cursor bounds:
 * a replaced frame's answer goes on to the next frame. */
export function isOfficePosition(value: unknown): value is OfficePosition {
  if (!value || typeof value !== 'object') return false;
  const position = value as Record<string, unknown>;
  if (position.format === 'docx') {
    const selection = position.selection as Record<string, unknown> | null;
    const top = position.top as Record<string, unknown> | null;
    return (
      isCount(position.scrollTop) &&
      (top === null ||
        (!!top &&
          typeof top === 'object' &&
          isText(top.paraId) &&
          // Above the top edge when the paragraph began before it.
          typeof top.offset === 'number' &&
          Number.isFinite(top.offset) &&
          (top.line === null || isCount(top.line)))) &&
      (selection === null ||
        (!!selection &&
          typeof selection === 'object' &&
          isParagraphPoint(selection.anchor) &&
          isParagraphPoint(selection.head)))
    );
  }
  if (position.format === 'xlsx')
    return (
      isText(position.sheet) && isCell(position.anchor) && isCell(position.head)
    );
  return position.format === 'pptx' && isCount(position.slide);
}

function isOfficePeer(value: unknown): value is OfficePeer {
  if (!value || typeof value !== 'object') return false;
  const peer = value as Record<string, unknown>;
  return (
    isCount(peer.clientId) && isText(peer.name) && isOfficeCursor(peer.cursor)
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** An edit load's collaboration; a DOCX one names its layout worker's id
 * (Q219), with no random fallback (Q226 L4). */
function isCollaboration(value: unknown, worker: boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isCount(candidate.clientId) &&
    candidate.clientId > 0 &&
    (worker
      ? isCount(candidate.workerClientId) && candidate.workerClientId > 0
      : candidate.workerClientId === undefined) &&
    isCount(candidate.epoch) &&
    candidate.initialUpdate instanceof ArrayBuffer
  );
}

// 25–400%, the widest any editor takes: a level outside it never reaches the
// next frame.
function isOfficeZoom(value: unknown): value is OfficeZoom {
  return (
    value === 'fit' ||
    (typeof value === 'number' && value >= 0.25 && value <= 4)
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
