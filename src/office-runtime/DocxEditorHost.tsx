import {
  type CollaborationPeer,
  type CollaborationPresence,
  resolvePresenceColor,
} from '@betteroffice/docx/collaboration';
import { configureDefaultFonts } from '@betteroffice/docx/layout';
import { setGoogleFontsEnabled } from '@betteroffice/docx/utils';
import {
  DOCX_PAGES_PRESENTED_EVENT,
  DocxEditor,
  type DocxEditorRef,
  type DocxMenuModel,
  type DocxPagesPresentedDetail,
} from '@betteroffice/docx-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DOCUMENT_COLORS } from '@/components/ui/ColorPicker';
import type {
  OfficeAnalysis,
  OfficeLocale,
  OfficeParagraphPoint,
  OfficeZoom,
} from '@/features/files/officeProtocol';
import { docxIcons } from './docxIcons';
import { docxStrings, editorMenus } from './docxMenus';
import type {
  OfficeCollaboration,
  OfficeExporter,
  OfficeFlusher,
} from './officeCollaboration';
import { officeFonts, onOfficeFontFailure } from './officeFonts';
import { type CursorChannel, mappedPeers } from './officePresence';
import {
  canvasPage,
  type OfficeMenuReporter,
  type OfficePositioner,
  type OfficeRenderer,
  type OfficeThumbnailer,
} from './runtimeMenus';
import { pageThumbnail } from './thumbnail';
import { readViewToggle, writeViewToggle } from './viewToggles';

// Before any editor mounts: the engine measures with the bundled faces.
configureDefaultFonts({ fonts: officeFonts });
// Fonts come only from Capy's own assets: no fonts.googleapis.com lookup.
setGoogleFontsEnabled(false);

/** The DOCX editor's presence over the frame's cursor channel: co-editors
 * under the names Capy gives them, in the editor's clock (performance.now). */
function docxPresence(channel: CursorChannel): CollaborationPresence {
  const peers = mappedPeers(channel, (peer): CollaborationPeer | null => {
    if (!('story' in peer.cursor)) return null;
    const shift = performance.now() - Date.now();
    return {
      clientId: peer.clientId,
      clock: 0,
      cursor: {
        anchor: Uint8Array.from(peer.cursor.anchor),
        head: Uint8Array.from(peer.cursor.head),
        story: peer.cursor.story,
      },
      cursorMovedAt: peer.movedAt + shift,
      inferredCursor: null,
      lastSeenAt: peer.seenAt + shift,
      user: {
        color: resolvePresenceColor(peer.clientId, undefined),
        name: peer.name,
      },
    };
  });
  return {
    onPeers: (listener) => channel.subscribe(() => listener(peers())),
    get peers() {
      return peers();
    },
    setCursor: (cursor, broadcast) =>
      channel.send(
        cursor && {
          anchor: [...cursor.anchor],
          head: [...cursor.head],
          story: cursor.story,
        },
        broadcast
      ),
  };
}

export function DocxEditorHost({
  bytes,
  collaboration,
  colorMode,
  compact,
  initialZoom,
  locale,
  narrow,
  onAnalysis,
  onExporter,
  onMenus,
  onRenderer,
  onFlusher,
  onError,
  onPendingChange,
  onPositioner,
  onSave,
  onThumbnailer,
  onZoomChange,
  prepareImage,
  readOnly,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  colorMode: 'light' | 'dark';
  /** Below md: a pinch zooms the document; comments open only when asked. */
  compact: boolean;
  /** 1 = 100%, or 'fit' to the pane: where the file was last shown. */
  initialZoom?: OfficeZoom;
  locale: OfficeLocale;
  /** Below lg: no zoom (as the PDF toolbar), font picker or size box. */
  narrow: boolean;
  /** Once the first pages are painted. */
  onAnalysis: (analysis: OfficeAnalysis) => void;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
  onMenus: OfficeMenuReporter;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onError: (error: Error) => void;
  onPendingChange: (pending: boolean) => void;
  onPositioner: (positioner: OfficePositioner | null) => void;
  onSave: () => void;
  onThumbnailer: (thumbnailer: OfficeThumbnailer | null) => void;
  onZoomChange: (zoom: OfficeZoom) => void;
  /** Shrinks an inserted image to the payer's plan cap. */
  prepareImage: (file: File) => Promise<File>;
  /** Recovery: selection and copy only. */
  readOnly: boolean;
}) {
  const editorRef = useRef<DocxEditorRef>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorCollaboration = useMemo(
    () => ({
      ...collaboration,
      presence: docxPresence(collaboration.cursors),
    }),
    [collaboration]
  );
  // View › Show ruler, one choice per person for every DOCX file.
  const [ruler, setRuler] = useState(() => readViewToggle('docxRuler'));
  const setRulerShown = useCallback((shown: boolean) => {
    setRuler(shown);
    writeViewToggle('docxRuler', shown);
  }, []);
  useEffect(() => onOfficeFontFailure(onError), [onError]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const painted = (event: Event) =>
      onAnalysis({
        format: 'docx',
        pageCount: (event as CustomEvent<DocxPagesPresentedDetail>).detail
          .pageCount,
      });
    host.addEventListener(DOCX_PAGES_PRESENTED_EVENT, painted, { once: true });
    return () => host.removeEventListener(DOCX_PAGES_PRESENTED_EVENT, painted);
  }, [onAnalysis]);
  useEffect(() => {
    onExporter(async () => {
      const bytes = await editorRef.current?.save();
      if (!bytes) throw new Error('Document export failed');
      return new Uint8Array(bytes);
    });
    onFlusher(async () => {
      if (!editorRef.current) throw new Error('Editor is still loading');
      await editorRef.current.flushPendingInput();
    });
    return () => {
      onExporter(null);
      onFlusher(null);
    };
  }, [onExporter, onFlusher]);
  // Capy prints the pages: the sandboxed frame has no print dialog.
  useEffect(() => {
    onRenderer(async (kind) => {
      const editor = editorRef.current;
      if (kind !== 'print' || !editor) throw new Error('Nothing to render');
      // One page drawn and encoded at a time, as pptxRender does.
      return editor.renderPages((page) =>
        canvasPage(page.canvas, page.width, page.height)
      );
    });
    return () => onRenderer(null);
  }, [onRenderer]);
  // A room swap (Epo 2026-10-22): the reader's place by the body paragraph
  // at the top, and the selection, by paragraph id, which the next epoch
  // keeps.
  useEffect(() => {
    onPositioner({
      read: () => {
        const paged = editorRef.current?.getEditorRef();
        const area = document.querySelector<HTMLElement>(SCROLL_BOX);
        if (!(paged && area)) return null;
        const point = (position: number): OfficeParagraphPoint | null => {
          const loc = paged.displayPositionToYrsLoc(position);
          return (
            loc && { offset: loc.offset, paraId: loc.paraId, story: loc.story }
          );
        };
        const range = paged.getSelectionRange();
        const anchor = range && point(range.from);
        const head = range && point(range.to);
        return {
          format: 'docx',
          scrollTop: Math.round(area.scrollTop),
          selection: anchor && head ? { anchor, head } : null,
          top: topParagraph(area),
        };
      },
      show: async (position) => {
        const paged = editorRef.current?.getEditorRef();
        const area = document.querySelector<HTMLElement>(SCROLL_BOX);
        if (!(paged && area) || position.format !== 'docx') return;
        const { selection, top } = position;
        const anchor =
          selection && paged.yrsLocToDisplayPosition(selection.anchor);
        const head = selection && paged.yrsLocToDisplayPosition(selection.head);
        if (typeof anchor === 'number' && typeof head === 'number') {
          paged.setSelection(anchor, head);
          // A moved caret scrolls itself into view; the reader's place wins.
          await frames(2);
        }
        area.scrollTop = position.scrollTop;
        if (!top) return;
        // The pages now in view lay out their paragraphs; the top one goes
        // back to its height (content above it may have changed).
        await frames(1);
        const line = top.line === null ? '' : `[data-from-line="${top.line}"]`;
        const fragment = area.querySelector(
          `${BODY_PARAGRAPH}[data-para-id="${CSS.escape(top.paraId)}"]${line}`
        );
        if (fragment)
          area.scrollTop +=
            fragment.getBoundingClientRect().top -
            area.getBoundingClientRect().top -
            top.offset;
      },
    });
    return () => onPositioner(null);
  }, [onPositioner]);
  // Page 1 for the list cards; Capy asks after edits settle.
  useEffect(() => {
    onThumbnailer(async () => {
      const editor = editorRef.current;
      if (!editor) throw new Error('Editor is still loading');
      return pageThumbnail(editor.renderPages);
    });
    return () => onThumbnailer(null);
  }, [onThumbnailer]);
  const reportMenus = useCallback(
    (model: DocxMenuModel | null) => {
      if (model) onZoomChange(model.zoom);
      onMenus(
        model && { menus: editorMenus(model.menus, locale), run: model.run }
      );
    },
    [locale, onMenus, onZoomChange]
  );
  return (
    <div className="office-editor-host" ref={hostRef}>
      <DocxEditor
        // Below md the comments column has no room beside the page: it opens
        // only from View › Show comments or a new comment.
        autoOpenComments={!compact}
        className="office-editor-host"
        collaboration={editorCollaboration}
        colorMode={colorMode}
        // The note toolbar's palette, as PPTX and the notes pick colours.
        colorPalette={DOCUMENT_COLORS}
        documentBuffer={bytes}
        // The final section's settings are outside the shared state Capy
        // saves: the rulers' margins do not drag and a header or footer has no
        // Remove until they save (Epo 2026-10-20).
        finalSectionEditable={false}
        i18n={docxStrings(locale)}
        icons={docxIcons}
        initialZoom={initialZoom}
        onError={onError}
        onMenus={reportMenus}
        onPendingChange={onPendingChange}
        // File > Save and Ctrl/Cmd+S request the checkpoint; nothing serializes.
        onSaveRequest={() => {
          onSave();
        }}
        onShowRulerChange={setRulerShown}
        pinchZoom={compact}
        prepareImage={prepareImage}
        readOnly={readOnly}
        ref={editorRef}
        showFileOpen={false}
        showFontPicker={!narrow}
        showFontSizePicker={!narrow}
        showHelpMenu={false}
        showRuler={ruler}
        showZoomControl={!narrow}
        singleRowToolbar
      />
    </div>
  );
}

const SCROLL_BOX = '.docx-editor__scroll-container';
/** Body paragraphs in the page mirrors (headers and footers repeat theirs on
 * every page), split ones by fragment. */
const BODY_PARAGRAPH = '.layout-page-content [data-para-id]';

/** The first body paragraph fragment showing at the box's top, and how far
 * below the top edge it starts; mirrors run in document order. */
function topParagraph(area: HTMLElement) {
  const edge = area.getBoundingClientRect().top;
  for (const fragment of area.querySelectorAll<HTMLElement>(BODY_PARAGRAPH)) {
    const rect = fragment.getBoundingClientRect();
    const paraId = fragment.dataset.paraId;
    if (rect.height > 0 && rect.bottom > edge && paraId)
      return {
        line:
          fragment.dataset.fromLine === undefined
            ? null
            : Number(fragment.dataset.fromLine),
        offset: rect.top - edge,
        paraId,
      };
  }
  return null;
}

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const next = (left: number) =>
      left ? requestAnimationFrame(() => next(left - 1)) : resolve();
    next(count);
  });
