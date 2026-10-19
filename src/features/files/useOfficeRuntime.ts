import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { authHeaders } from '@/api/auth';
import type { SourceFile } from '@/api/types';
import { OfficeInsetContext } from '@/components/ui/floatingBarContext';
import { userToast } from '@/components/ui/userToast';
import { getLocale, m } from '@/i18n';
import { errorCopy, unexpectedErrorId } from '@/lib/errors';
import { imageLimit } from '@/lib/fitImage';
import { officeMark } from '@/lib/officeMarks';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { useTheme } from '@/theme/theme';
import { useFileMode } from './FileModeControl';
import { fileExt } from './fileUtils';
import {
  fitOfficeMenus,
  type OfficeHeaderAction,
  type OfficeMenu,
  officeCommandNeeds,
  officeHostCommand,
} from './officeMenus';
import {
  isOfficeRuntimeMessage,
  isOutdatedOfficeRuntime,
  OFFICE_PROTOCOL_VERSION,
  type OfficeAnalysis,
  type OfficeCitation,
  type OfficeFormat,
  type OfficeHostMessage,
  type OfficeMode,
  type OfficeNotice,
  type OfficeRenderedPage,
  type OfficeZoom,
} from './officeProtocol';
import {
  getOfficeRuntimeConfig,
  openPresenterWindow,
  runtimeFrameUrl,
} from './officeRuntimeConfig';
import { printPages } from './printPages';
import { holdSource, takeSourceOpen } from './sourceOpen';
import { savedSourceUpdate } from './sourceState';
import {
  canEncodeWebp,
  createThumbnailCapture,
  NOT_DRAWN_YET,
  openedOn,
  type ThumbnailCapture,
  uploadThumbnail,
} from './thumbnailCapture';
import {
  SOURCE_IFRAME_ORIGIN,
  sessionReported,
  useSourceSession,
} from './useSourceSession';

interface OfficeRuntimeOptions {
  canEdit: boolean;
  citation?: OfficeCitation;
  file: SourceFile;
  format: OfficeFormat;
  initialMode?: OfficeMode;
  revision: number;
}

export function officeRuntimeKey(
  file: Pick<SourceFile, 'id'>,
  revision: number
): string {
  void revision;
  return file.id;
}

/**
 * What a runtime replica that reported `replicaState` still lacks of `doc`.
 * The engines refuse a single incoming update above 64 MiB, so a large room is
 * never sent back whole.
 */
export function replicaCatchUp(doc: Y.Doc, replicaState: Uint8Array) {
  return Y.encodeStateAsUpdate(
    doc,
    Y.encodeStateVectorFromUpdate(replicaState)
  );
}

export function isCurrentOfficeRuntimeMessage(
  messageRevision: number,
  currentRevision: number
): boolean {
  return messageRevision === currentRevision;
}

export function useOfficeRuntime({
  canEdit,
  citation,
  file,
  format,
  initialMode = 'view',
  revision,
}: OfficeRuntimeOptions) {
  const citationRef = useRef(citation);
  citationRef.current = citation;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const config = useRef(getOfficeRuntimeConfig()).current;
  const { style, theme } = useTheme();
  const reportInset = useContext(OfficeInsetContext);
  const narrow = !useMediaQuery('(min-width: 1024px)');
  const compact = !useMediaQuery('(min-width: 768px)');
  const [mode, setMode] = useFileMode(canEdit, initialMode);
  const [joined, setJoined] = useState(mode === 'edit');
  const [frameGeneration, setFrameGeneration] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameBoot, setFrameBoot] = useState(0);
  const [viewBytes, setViewBytes] = useState<{
    bytes: ArrayBuffer;
    checkpoint?: ArrayBuffer;
    checkpointSeedSHA256?: string;
  } | null>(null);
  const [analysis, setAnalysis] = useState<OfficeAnalysis | null>(null);
  const [error, setError] = useState<string | null>(config.error);
  // A failed view read's trace id, which the error panel shows.
  const [errorId, setErrorId] = useState<string | null>(null);
  const [outdated, setOutdated] = useState(false);
  // The runtime's menu bar and header actions; each frame sends its own.
  const [menus, setMenus] = useState<{
    menus: OfficeMenu[];
    actions: OfficeHeaderAction[];
  } | null>(null);
  const menusRef = useRef(menus);
  menusRef.current = menus;
  // A PPTX show is on: the frame covers the page.
  const [presenting, setPresenting] = useState(false);
  const [replicaReady, setReplicaReady] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // The room turned read-only (a storage or frozen refusal): the session
  // discarded its unsaved edits, and the frame reloads the saved view.
  const source = useSourceSession(file.id, joined, () => {
    setJoined(false);
    initializedFrame.current = -1;
    setFrameLoaded(false);
    setFrameGeneration((value) => value + 1);
    setPresenting(false);
    setViewBytes(null);
    setAnalysis(null);
    setMode('view');
  });
  // The maintenance pause refused editing before the room opened: show the
  // saved view instead. The frame was never loaded for editing, so view mode
  // loads into the same frame.
  const pausedAtOpen = source.paused && !source.doc;
  useEffect(() => {
    if (mode !== 'edit' || !pausedAtOpen) return;
    setJoined(false);
    setMode('view');
  }, [mode, pausedAtOpen, setMode]);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const revisionRef = useRef(revision);
  // The zoom the file was last shown at, kept (not stored) while it stays
  // open: the next frame, for View or Edit or after a reload, opens at it.
  const zoomRef = useRef<OfficeZoom | undefined>(undefined);
  const [notices] = useState(() =>
    officeNotices((title) => userToast({ title }))
  );
  const publishedRevision = useRef(revision);
  const initializedFrame = useRef(-1);
  // The source document the frame was loaded with: a frame still showing an
  // earlier one (an in-place restart swaps it on the next render) is never
  // made editable.
  const frameDoc = useRef<Y.Doc | null>(null);
  const sourceDocument = useRef<Y.Doc | undefined>(undefined);
  const frameRequests = useRef(
    new Map<
      string,
      { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }
    >()
  );
  // An edit frame's list-card capture, fed its local edits.
  const captureRef = useRef<ThumbnailCapture | null>(null);
  const renderRequests = useRef(
    new Map<
      string,
      {
        resolve: (rendered: Rendered) => void;
        reject: (error: Error) => void;
      }
    >()
  );
  const post = useCallback(
    (message: OfficeHostMessage, transfer: Transferable[] = []) =>
      iframeRef.current?.contentWindow?.postMessage(
        message,
        config.origin,
        transfer
      ),
    [config.origin]
  );
  // Focus moving from an editing runtime to another part of Capy (chat,
  // sidebar, header) ends an open cell edit there. Capy's own window gets
  // `focus` when focus comes back to its document from the frame; an app or
  // browser-tab switch and the return from one leave focus in the frame and
  // send nothing, so the edit stays open for the next key (Excel and Sheets).
  const frameLoadedRef = useRef(frameLoaded);
  frameLoadedRef.current = frameLoaded;
  useEffect(() => {
    const returned = (event: FocusEvent) => {
      if (
        event.target !== window ||
        modeRef.current !== 'edit' ||
        !frameLoadedRef.current
      )
        return;
      post({ type: 'focus-left', version: OFFICE_PROTOCOL_VERSION });
    };
    window.addEventListener('focus', returned);
    return () => window.removeEventListener('focus', returned);
  }, [post]);

  // Before the load below, and again whenever the runtime document boots: the
  // runtime paints in Capy's theme from the start.
  useEffect(() => {
    if (frameLoaded)
      post({
        compact,
        locale: getLocale() === 'zh' ? 'zh' : 'en',
        narrow,
        style,
        theme,
        type: 'set-appearance',
        version: OFFICE_PROTOCOL_VERSION,
      });
  }, [compact, frameBoot, frameLoaded, narrow, post, style, theme]);
  useEffect(() => {
    if (frameLoaded)
      post({
        citation: mode === 'view' ? (citation ?? null) : null,
        type: 'set-citation',
        version: OFFICE_PROTOCOL_VERSION,
      });
  }, [citation, mode, frameLoaded, post]);
  const request = useCallback(
    (kind: 'flush' | 'export') =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timeout = setTimeout(() => {
          frameRequests.current.delete(id);
          reject(new Error(m.source_edit_save_failed()));
        }, 30_000);
        frameRequests.current.set(id, {
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
          resolve: (bytes) => {
            clearTimeout(timeout);
            resolve(bytes);
          },
        });
        if (kind === 'flush') {
          const epoch = sourceRef.current.session?.epoch;
          if (epoch === undefined) {
            frameRequests.current.delete(id);
            reject(new Error(m.source_edit_session_changed()));
            return;
          }
          post({ epoch, id, type: 'flush', version: OFFICE_PROTOCOL_VERSION });
        } else post({ id, type: 'export', version: OFFICE_PROTOCOL_VERSION });
      }),
    [post]
  );
  const checkpoint = useCallback(async () => {
    await sourceRef.current.save();
  }, [request]);

  // A save that went through supersedes an earlier editing error.
  useEffect(() => {
    if (mode === 'edit' && source.status === 'saved') setError(null);
  }, [mode, source.status]);

  useEffect(() => {
    source.flushHandler.current =
      mode === 'edit'
        ? async (pause = false) => {
            if (pause)
              post({
                canEdit: false,
                type: 'set-capabilities',
                version: OFFICE_PROTOCOL_VERSION,
              });
            await request('flush');
          }
        : async () => {};
    return () => {
      source.flushHandler.current = null;
    };
  }, [mode, request, source.flushHandler, post]);

  useEffect(() => {
    const doc = source.doc;
    if (!doc) return;
    if (sourceDocument.current && sourceDocument.current !== doc) {
      setFrameLoaded(false);
      setFrameGeneration((value) => value + 1);
      setPresenting(false);
      setAnalysis(null);
      setError(null);
    }
    sourceDocument.current = doc;
  }, [source.doc]);

  useEffect(() => {
    const changed = publishedRevision.current !== revision;
    publishedRevision.current = revision;
    if (!changed || mode !== 'view') return;
    revisionRef.current = revision;
    setFrameLoaded(false);
    setFrameGeneration((value) => value + 1);
    setPresenting(false);
    setViewBytes(null);
    setAnalysis(null);
    setError(config.error);
    setErrorId(null);
  }, [revision, mode, config.error]);

  const retryView = () => {
    if (mode !== 'view') return;
    initializedFrame.current = -1;
    setFrameLoaded(false);
    setFrameGeneration((value) => value + 1);
    setPresenting(false);
    setViewBytes(null);
    setAnalysis(null);
    setError(config.error);
    setErrorId(null);
  };

  // The route started this file's open (sourceOpen.ts) unless a view shows it.
  useEffect(() => holdSource(file.id), [file.id]);

  // View mode reads the published base plus the saved checkpoint, so a viewer
  // sees what was last saved rather than what was last published. The
  // checkpoint rides along only when it is ahead of the indexed one; the
  // runtime exports it over the base before opening the viewer.
  useEffect(() => {
    if (mode !== 'view' || viewBytes || config.error) return;
    const controller = new AbortController();
    void takeSourceOpen(file.id, 'view', controller.signal)
      .then(async ({ base, session }) => {
        const bytes = (await base).buffer;
        const saved =
          session.checkpoint === session.indexedCheckpoint
            ? null
            : savedSourceUpdate(session);
        const checkpoint = saved ? saved.slice().buffer : undefined;
        // A stored change applies over seed(base), named by its hash.
        const checkpointSeedSHA256 = saved
          ? (session.stateSeedSHA256 ?? undefined)
          : undefined;
        if (!controller.signal.aborted)
          setViewBytes({ bytes, checkpoint, checkpointSeedSHA256 });
      })
      .catch((value: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorCopy(value, m.error_file_body()));
        setErrorId(unexpectedErrorId(value));
      });
    return () => controller.abort();
  }, [file.id, revision, mode, config.error, viewBytes, frameGeneration]);

  useEffect(() => {
    if (!frameLoaded || initializedFrame.current === frameGeneration) return;
    if (
      mode === 'edit' &&
      (!source.doc ||
        !source.session ||
        !source.bytes ||
        (!source.synced && source.status !== 'recovery' && !source.outdated))
    )
      return;
    if (mode === 'view' && !viewBytes) return;
    const bytes =
      mode === 'edit'
        ? source.bytes!.slice().buffer
        : viewBytes!.bytes.slice(0);
    const checkpoint =
      mode === 'view' ? viewBytes!.checkpoint?.slice(0) : undefined;
    const collaboration =
      mode === 'edit'
        ? {
            epoch: source.session!.epoch,
            initialUpdate: Y.encodeStateAsUpdate(source.doc!).slice().buffer,
          }
        : undefined;
    const imageMaxBytes =
      mode === 'edit' ? source.session!.imageMaxBytes : undefined;
    initializedFrame.current = frameGeneration;
    // An Office edit session always names the payer's image cap; without one
    // the editor cannot open, so it fails here instead of hanging.
    if (mode === 'edit' && !(imageMaxBytes && imageMaxBytes > 0)) {
      setError(m.error_file_body());
      return;
    }
    frameDoc.current = mode === 'edit' ? source.doc! : null;
    officeMark('load-posted', {
      bytes: bytes.byteLength,
      checkpointBytes: checkpoint?.byteLength ?? 0,
      initialUpdateBytes: collaboration?.initialUpdate.byteLength ?? 0,
      mode,
    });
    post(
      {
        bytes,
        canEdit,
        checkpoint,
        checkpointSeedSHA256:
          mode === 'view' ? viewBytes!.checkpointSeedSHA256 : undefined,
        citation: mode === 'view' ? citationRef.current : null,
        collaboration,
        fileName: file.name,
        format,
        imageMaxBytes,
        mode,
        revision: revisionRef.current,
        type: 'load',
        version: OFFICE_PROTOCOL_VERSION,
        zoom: zoomRef.current,
      },
      [bytes, collaboration?.initialUpdate, checkpoint].filter(
        (item): item is ArrayBuffer => !!item
      )
    );
  }, [
    frameLoaded,
    frameGeneration,
    frameBoot,
    mode,
    source.doc,
    source.session,
    source.bytes,
    source.synced,
    source.status,
    viewBytes,
    canEdit,
    file.name,
    format,
    post,
  ]);

  // The load carries the raw canEdit; this narrows it to the session's pauses.
  const editable =
    canEdit &&
    !source.handoff &&
    !source.replaced &&
    !source.offlineLimit &&
    !source.outdated &&
    source.status !== 'recovery' &&
    // `connecting` pauses only before the first sync: the document exists
    // only from then (each session start clears it), and the first save
    // receipt is not waited for.
    (mode !== 'edit' || (!!source.doc && !source.discarding));
  // A capture uploads only what the room has (saved) while the user may edit.
  const captureAllowed = useRef<() => boolean>(() => false);
  captureAllowed.current = () => editable && source.status === 'saved';
  // After the load above, and again whenever the runtime document boots. A
  // paused editor shows its content read-only, for selecting and copying.
  useEffect(() => {
    if (frameLoaded)
      post({
        canEdit:
          editable && (mode !== 'edit' || frameDoc.current === source.doc),
        type: 'set-capabilities',
        version: OFFICE_PROTOCOL_VERSION,
      });
  }, [editable, frameBoot, frameLoaded, mode, post, source.doc]);

  useEffect(() => {
    const doc = source.doc;
    if (!doc || mode !== 'edit' || !source.session) return;
    const epoch = source.session.epoch;
    const send = (update: Uint8Array, origin: unknown) => {
      if (origin === SOURCE_IFRAME_ORIGIN) return;
      // Not this editor's own edit: a capture drawn before it is stale.
      captureRef.current?.remote();
      const bytes = update.slice().buffer;
      post({ bytes, epoch, type: 'update', version: OFFICE_PROTOCOL_VERSION }, [
        bytes,
      ]);
    };
    doc.on('update', send);
    return () => doc.off('update', send);
  }, [source.doc, source.session, mode, post]);

  /**
   * A `popup: 'presenter'` command: opens the presenter window from the
   * click Capy got (in its header, or in the frame, whose activation reaches
   * Capy), after telling the runtime the token to expect; '' when blocked.
   */
  const openPresenter = useCallback(
    (id: string) => {
      const send = (value: string) =>
        post({
          id,
          type: 'menu-command',
          value,
          version: OFFICE_PROTOCOL_VERSION,
        });
      const token = crypto.randomUUID();
      send(token);
      if (!openPresenterWindow(config.origin, token)) send('');
    },
    [config.origin, post]
  );

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== config.origin ||
        event.source !== iframeRef.current?.contentWindow
      )
        return;
      if (isOutdatedOfficeRuntime(event.data)) {
        setOutdated(true);
        return;
      }
      if (!isOfficeRuntimeMessage(event.data)) return;
      const message = event.data,
        active = sourceRef.current;
      if (message.type === 'initialized') {
        officeMark('runtime-initialized');
        notices.frame();
        setReplicaReady(false);
        setMenus(null);
        setPresenting(false);
        initializedFrame.current = -1;
        setFrameLoaded(true);
        setFrameBoot((value) => value + 1);
        return;
      }
      if (!isCurrentOfficeRuntimeMessage(message.revision, revisionRef.current))
        return;
      if (message.type === 'dirty') {
        active.pendingInput(message.dirty);
        return;
      }
      if (message.type === 'presenting') {
        setPresenting(message.presenting);
        return;
      }
      if (message.type === 'bottom-inset') {
        // No taller than the frame: a hostile document cannot push the tools
        // button off the page.
        const frame = iframeRef.current;
        if (frame) reportInset?.(Math.min(message.inset, frame.clientHeight));
        return;
      }
      if (message.type === 'zoom') {
        zoomRef.current = message.zoom;
        return;
      }
      if (message.type === 'open-presenter') {
        openRequestedPresenter(menusRef.current, message.id, openPresenter);
        return;
      }
      if (message.type === 'menus') {
        setMenus({
          actions: message.actions,
          menus: fitOfficeMenus(message.menus),
        });
        return;
      }
      if (message.type === 'rendered') {
        renderRequests.current.get(message.id)?.resolve(message);
        renderRequests.current.delete(message.id);
        return;
      }
      if (message.type === 'render-failed') {
        // The pages could not be drawn; the document is unaffected.
        renderRequests.current
          .get(message.id)
          ?.reject(new Error('render-failed'));
        renderRequests.current.delete(message.id);
        return;
      }
      if (message.type === 'ready') {
        officeMark('ready');
        setAnalysis(message.analysis);
        // Edit frames report ready too (for their timings); their errors stay.
        if (modeRef.current === 'view') {
          setError(null);
          setErrorId(null);
        }
        return;
      }
      if (message.type === 'notice') {
        // Notices come from an edit frame, which loads only with the payer's
        // image cap; without one (no edit session) there is nothing to word.
        const imageMaxBytes = active.session?.imageMaxBytes;
        if (imageMaxBytes) notices.show(message.notice, imageMaxBytes);
        return;
      }
      if (message.type === 'error') {
        // The runtime's own text is English engine detail; the host owns copy.
        setError(m.error_file_body());
        for (const waiters of [frameRequests, renderRequests]) {
          for (const waiter of waiters.current.values())
            waiter.reject(new Error(message.message));
          waiters.current.clear();
        }
        return;
      }
      if (message.type === 'collaboration-ready') {
        officeMark('collaboration-ready');
        setReplicaReady(true);
        // A newly opened DOCX editor takes the focus (it waits for its frame
        // to get it) unless Capy's focus is somewhere it keeps (the chat box,
        // an open dialog or menu).
        if (format === 'docx' && !keepsFocus(document.activeElement))
          iframeRef.current?.focus({ preventScroll: true });
      }
      if (
        message.type === 'update' ||
        message.type === 'collaboration-ready' ||
        message.type === 'flushed'
      ) {
        if (
          !active.doc ||
          message.epoch !== active.session?.epoch ||
          active.status === 'recovery'
        )
          return;
        const replicaUpdate = new Uint8Array(message.bytes);
        Y.applyUpdate(active.doc, replicaUpdate, SOURCE_IFRAME_ORIGIN);
        if (message.type === 'update' && message.capture)
          captureRef.current?.edited();
        if (message.type === 'collaboration-ready') {
          const bytes = replicaCatchUp(active.doc, replicaUpdate).slice()
            .buffer;
          post(
            {
              bytes,
              epoch: message.epoch,
              type: 'update',
              version: OFFICE_PROTOCOL_VERSION,
            },
            [bytes]
          );
        }
        if (message.type === 'flushed') {
          frameRequests.current.get(message.id)?.resolve(message.bytes);
          frameRequests.current.delete(message.id);
        }
        return;
      }
      if (message.type === 'exported') {
        frameRequests.current.get(message.id)?.resolve(message.bytes);
        frameRequests.current.delete(message.id);
        return;
      }
      if (message.type === 'checkpoint' || message.type === 'save')
        void checkpoint().catch((value: unknown) => {
          if (!sessionReported(value))
            setError(errorCopy(value, m.source_edit_save_failed()));
        });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [config.origin, post, checkpoint, openPresenter, reportInset]);

  const downloadDraft = useCallback(async () => {
    saveBlob(new Blob([await request('export')]), file.name);
  }, [file.name, request]);

  const render = useCallback(
    (kind: 'print' | 'png' | 'thumbnail') =>
      new Promise<Rendered>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timeout = setTimeout(() => {
          renderRequests.current.delete(id);
          reject(new Error(m.error_generic_body()));
        }, 60_000);
        renderRequests.current.set(id, {
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
          resolve: (rendered) => {
            clearTimeout(timeout);
            resolve(rendered);
          },
        });
        post({ id, kind, type: 'render', version: OFFICE_PROTOCOL_VERSION });
      }),
    [post]
  );

  // Once the editor holds the document, a card older than it (Go's
  // `thumbnailStale`) is captured, once per session read.
  const held = replicaReady ? source.session : null;
  const heldRef = useRef(held);
  heldRef.current = held;
  const staleSeen = useRef(new WeakSet<object>());
  useEffect(() => {
    if (held && captureRef.current)
      openedOn(captureRef.current, held, staleSeen.current);
  }, [held]);

  // Browsers that cannot encode WebP (Safari) capture nothing.
  useEffect(() => {
    if (mode !== 'edit') return;
    let cancelled = false;
    void canEncodeWebp().then((supported) => {
      if (!supported || cancelled) return;
      const capture = createThumbnailCapture({
        allowed: () => captureAllowed.current(),
        draw: async () => {
          const [rendered, headers] = await Promise.all([
            render('thumbnail'),
            authHeaders(),
          ]);
          const bytes = rendered.pages[0]?.bytes;
          if (bytes) return { bytes, headers };
          // A DOCX always has a page: none means its edit's layout had not
          // landed, which must not end the cycle as an XLSX's other sheet does.
          return format === 'docx' ? NOT_DRAWN_YET : null;
        },
        upload: (drawn, keepalive) =>
          uploadThumbnail(file.id, drawn, keepalive),
      });
      captureRef.current = capture;
      if (heldRef.current)
        openedOn(capture, heldRef.current, staleSeen.current);
    });
    const leave = () => captureRef.current?.leave();
    const hidden = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
      // Leaving the file in the app (View, another file, another page)
      // uploads what was drawn, as the page hiding does.
      leave();
      captureRef.current?.dispose();
      captureRef.current = null;
    };
  }, [file.id, format, mode, render]);

  /** A menu item or header action: Capy's own commands run here. */
  const runMenuCommand = useCallback(
    (id: string, value?: string) => {
      const needs = officeCommandNeeds(menusRef.current, id);
      if (needs.popup === 'presenter') return openPresenter(id);
      if (needs.fullscreen) {
        // Chromium lets the frame go full screen from this click; elsewhere
        // (or without the click's activation) the show starts windowed.
        const message: OfficeHostMessage = {
          id,
          type: 'menu-command',
          value,
          version: OFFICE_PROTOCOL_VERSION,
        };
        const target = iframeRef.current?.contentWindow;
        try {
          target?.postMessage(message, {
            delegate: 'fullscreen',
            targetOrigin: config.origin,
          } as WindowPostMessageOptions);
        } catch {
          post(message);
        }
        return;
      }
      const command = officeHostCommand(id);
      const run = async () => {
        if (command === 'save') {
          // Disabled in the paused menus; a stale click does nothing.
          if (editable) await checkpoint();
        } else if (command === 'download') await downloadDraft();
        else if (command === 'print') {
          const { pages, truncated } = await render('print');
          await printPages(pages);
          if (truncated)
            userToast({
              title: m.files_office_print_truncated({
                count: String(pages.length),
              }),
            });
        } else if (command === 'png') {
          const [image] = (await render('png')).pages;
          if (image)
            saveBlob(
              new Blob([image.bytes], { type: 'image/png' }),
              `${file.name.slice(0, -(fileExt(file.name).length + 1)) || file.name}.png`
            );
        } else
          post({
            id,
            type: 'menu-command',
            value,
            version: OFFICE_PROTOCOL_VERSION,
          });
      };
      void run().catch((value: unknown) => {
        // A failed print leaves the document as it was: a toast, no banner.
        if (command === 'print' || command === 'png')
          userToast({
            title:
              command === 'print'
                ? m.files_office_print_failed()
                : m.files_office_png_failed(),
            variant: 'error',
          });
        // A failed save the session already shows (its banner or strip).
        else if (!sessionReported(value))
          setError(errorCopy(value, m.error_generic_body()));
      });
    },
    [
      checkpoint,
      config.origin,
      downloadDraft,
      editable,
      file.name,
      openPresenter,
      post,
      render,
    ]
  );

  /** A `pick` item's file, from Capy's picker. */
  const sendMenuFile = useCallback(
    (id: string, file: File) => {
      void file.arrayBuffer().then((bytes) =>
        post(
          {
            bytes,
            id,
            mimeType: file.type,
            name: file.name,
            type: 'menu-file',
            version: OFFICE_PROTOCOL_VERSION,
          },
          [bytes]
        )
      );
    },
    [post]
  );

  const setRuntimeMode = useCallback(
    async (next: OfficeMode) => {
      if (next === mode) return true;
      if (next === 'edit' && !canEdit) return false;
      if (next === 'view') {
        setLeaving(true);
        try {
          await checkpoint();
          const bytes = await request('export');
          setViewBytes({ bytes });
        } catch (value) {
          if (!sessionReported(value))
            setError(errorCopy(value, m.source_edit_save_failed()));
          setLeaving(false);
          return false;
        }
        setLeaving(false);
      } else setJoined(true);
      initializedFrame.current = -1;
      setFrameLoaded(false);
      setFrameGeneration((value) => value + 1);
      setPresenting(false);
      // The new frame reports its own: an edit frame's ready also sets one.
      setAnalysis(null);
      setMode(next);
      return true;
    },
    [canEdit, mode, checkpoint, request, setMode]
  );

  useEffect(() => () => reportInset?.(0), [reportInset]);

  // Each frame's URL names the format and the mode it opened in, fixed for
  // its lifetime: a changed src reloads the frame, and the pause's drop to
  // View keeps the frame opened for Edit.
  const frameUrl = useRef({ generation: -1, url: '' });
  if (frameUrl.current.generation !== frameGeneration)
    frameUrl.current = {
      generation: frameGeneration,
      url: runtimeFrameUrl(config.url, format, mode),
    };

  useEffect(
    () => () => {
      for (const waiters of [frameRequests, renderRequests]) {
        for (const waiter of waiters.current.values())
          waiter.reject(new Error(m.source_edit_save_failed()));
        waiters.current.clear();
      }
    },
    []
  );

  return {
    analysis,
    banner: source.banner,
    dirty: source.dirty,
    discardDraft: source.discardDraft,
    discarding: source.discarding,
    downloadDraft,
    error: error ?? source.error,
    errorId: error ? errorId : null,
    handoff: source.handoff,
    iframeAllow: config.allow,
    iframeKey: `${file.id}:${frameGeneration}`,
    iframeRef,
    iframeSandbox: config.sandbox,
    iframeUrl: frameUrl.current.url,
    menus,
    mode,
    paused: source.paused,
    pausedAtOpen,
    presenting,
    readOnly: source.readOnly,
    ready: mode === 'view' ? !!analysis : replicaReady,
    replaced: source.replaced,
    retryView,
    runMenuCommand,
    saving: leaving || source.status === 'saving',
    sendMenuFile,
    setFrameLoaded,
    setRuntimeMode,
    status: source.status,
    unavailable: outdated ? ('outdated' as const) : source.unavailable,
  };
}

interface Rendered {
  pages: OfficeRenderedPage[];
  truncated: boolean;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Each notice's toast: a new notice needs its entry here. */
const OFFICE_NOTICE_TOASTS: Record<
  OfficeNotice,
  { once: boolean; title: (imageMaxBytes: number) => string }
> = {
  // Each copy or cut is its own keystroke: every time.
  'copy-failed': { once: false, title: () => m.files_office_copy_failed() },
  'copy-too-large': {
    once: false,
    title: () => m.files_office_copy_too_large(),
  },
  'cut-peer-change': {
    once: false,
    title: () => m.files_office_cut_peer_change(),
  },
  // Each refused clear or copy is its own keystroke: every time.
  'edit-too-large': {
    once: false,
    title: () => m.files_office_edit_too_large(),
  },
  // A refused keystroke repeats on every key: once per frame.
  'equation-text': { once: true, title: () => m.files_office_equation_text() },
  // Each refused image is its own pick: every time.
  'image-too-large': {
    once: false,
    title: (imageMaxBytes) =>
      m.image_too_large({ limit: imageLimit(imageMaxBytes) }),
  },
  'image-type': { once: false, title: () => m.image_unreadable() },
};

/**
 * The notices a frame shows, each as its entry says: a `once` notice once per
 * frame (a new frame starts over), the others every time. `imageMaxBytes` is
 * the edit session's image cap, which the size notice names.
 */
export function officeNotices(toast: (title: string) => void) {
  const shown = new Set<OfficeNotice>();
  return {
    frame: () => shown.clear(),
    show: (notice: OfficeNotice, imageMaxBytes: number) => {
      const { once, title } = OFFICE_NOTICE_TOASTS[notice];
      if (once && shown.has(notice)) return;
      shown.add(notice);
      toast(title(imageMaxBytes));
    },
  };
}

/**
 * The frame's `open-presenter`: opens the presenter window only for a command
 * Capy itself opens it for (`popup: 'presenter'` in the frame's menus), so the
 * sandboxed runtime cannot have Capy open a window for anything else.
 */
export function openRequestedPresenter(
  menus: Parameters<typeof officeCommandNeeds>[0],
  id: string,
  open: (id: string) => void
) {
  if (officeCommandNeeds(menus, id).popup === 'presenter') open(id);
}

/**
 * Capy focus a newly opened DOCX leaves alone: anything in an open dialog,
 * alert dialog or menu, or a field taking typing, also behind a shadow root
 * (MathLive's math-field).
 */
export function keepsFocus(element: Element | null): boolean {
  if (!element) return false;
  if (element.closest('[role=dialog],[role=alertdialog],[role=menu]'))
    return true;
  let focused = element;
  while (focused.shadowRoot?.activeElement)
    focused = focused.shadowRoot.activeElement;
  return (
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName) ||
    (focused as HTMLElement).isContentEditable === true
  );
}
