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
  type RibbonControls,
} from '@betteroffice/docx-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DOCUMENT_COLORS } from '@/components/ui/ColorPicker';
import type {
  OfficeAnalysis,
  OfficeCitation,
  OfficeLocale,
  OfficeNotice,
  OfficeParagraphPoint,
  OfficeZoom,
} from '@/features/files/officeProtocol';
import { CITATION_FILL, quoteProbe, uniqueCitation } from './citations';
import { docxIcons } from './docxIcons';
import { docxStrings, editorMenus } from './docxMenus';
import { BODY_PARAGRAPH, topParagraph } from './docxPlace';
import { DOCX_RIBBON } from './docxRibbon';
import { fontSliceErrors } from './fontSliceErrors';
import { OfficeRibbon, type OfficeRibbonHost } from './OfficeRibbon';
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
  citation,
  collaboration,
  colorMode,
  compact,
  initialZoom,
  locale,
  onAnalysis,
  onExporter,
  onMenus,
  onRenderer,
  onFlusher,
  onError,
  onFontError,
  onNotice,
  onPendingChange,
  onPositioner,
  onSave,
  onThumbnailer,
  onZoomChange,
  prepareImage,
  readOnly,
  ribbon,
}: {
  bytes: Uint8Array;
  /** A chat citation's passage: marked and centred as in View. */
  citation: OfficeCitation | null;
  collaboration: OfficeCollaboration;
  colorMode: 'light' | 'dark';
  /**
   * Below md: a pinch zooms the document; comments open only when asked; the
   * ribbon is one row, with no zoom (as the PDF toolbar), font picker or size box.
   */
  compact: boolean;
  /** 1 = 100%, or 'fit' to the pane: where the file was last shown. */
  initialZoom?: OfficeZoom;
  locale: OfficeLocale;
  /** Once the first pages are painted. */
  onAnalysis: (analysis: OfficeAnalysis) => void;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
  onMenus: OfficeMenuReporter;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onError: (error: Error) => void;
  /** A font slice a server failed while editing, by its face: for Sentry. */
  onFontError: (family: string, error: Error) => void;
  onNotice: (notice: OfficeNotice) => void;
  onPendingChange: (pending: boolean) => void;
  onPositioner: (positioner: OfficePositioner | null) => void;
  onSave: () => void;
  onThumbnailer: (thumbnailer: OfficeThumbnailer | null) => void;
  onZoomChange: (zoom: OfficeZoom) => void;
  /** Shrinks an inserted image to the payer's plan cap. */
  prepareImage: (file: File) => Promise<File>;
  /** Recovery: selection and copy only. */
  readOnly: boolean;
  ribbon: OfficeRibbonHost;
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
  // View's rule (citations.ts) over the paragraphs the engine's search finds
  // with the quote's longest piece; marked once the pages are presented, and
  // only while its paragraph still holds the quote (Q809 A, Q811 A).
  useEffect(() => {
    editorRef.current?.showCitation(
      citation && {
        color: CITATION_FILL,
        match: (paragraphs) => uniqueCitation(paragraphs, citation.quote),
        probe: quoteProbe(citation.quote),
      }
    );
  }, [citation]);
  // A font slice failing while editing is a notice, not an error (Q752 B);
  // back online, the editor asks for the failed slices again.
  const fontSlices = useMemo(
    () => fontSliceErrors({ onError, onFontError, onNotice }),
    [onError, onFontError, onNotice]
  );
  useEffect(() => {
    const online = () =>
      fontSlices.online(() => editorRef.current?.retryFontSlices());
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [fontSlices]);
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
        const { selection, top, zoom } = position;
        // The zoom first, so the place below is found on pages at their size;
        // a fitted zoom is only the editor's own at open (the ref sets levels).
        const editor = editorRef.current;
        if (typeof zoom === 'number' && editor && editor.getZoom() !== zoom) {
          editor.setZoom(zoom);
          await frames(2);
        }
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
        model && {
          focus: () => editorRef.current?.focus(),
          menus: editorMenus(model.menus, locale),
          run: model.run,
        }
      );
    },
    [locale, onMenus, onZoomChange]
  );
  const renderRibbon = useCallback(
    (controls: RibbonControls) => (
      <OfficeRibbon
        contexts={RIBBON_CONTEXTS}
        controls={controls}
        layout={DOCX_RIBBON}
        onBannerAction={ribbon.onBannerAction}
        onLeave={ribbon.onLeave}
        store={ribbon.store}
      />
    ),
    [ribbon]
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
        onError={fontSlices.report}
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
        ribbon={renderRibbon}
        showFileOpen={false}
        showFontPicker={!compact}
        showFontSizePicker={!compact}
        showHelpMenu={false}
        showRuler={ruler}
        showZoomControl={!compact}
        singleRowToolbar
      />
    </div>
  );
}

/** Office's contextual tabs, on while the toolbar has their controls. */
const RIBBON_CONTEXTS = { picture: 'imageWrap', table: 'tableMore' };

const SCROLL_BOX = '.docx-editor__scroll-container';

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const next = (left: number) =>
      left ? requestAnimationFrame(() => next(left - 1)) : resolve();
    next(count);
  });
