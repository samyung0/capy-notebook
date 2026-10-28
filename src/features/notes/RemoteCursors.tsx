import {
  CursorEditor,
  type CursorEditor as CursorEditorType,
  relativePositionToSlatePoint,
  YjsEditor,
} from '@slate-yjs/core';
import {
  type Path,
  PathApi,
  type Point,
  type SlateEditor,
  type TElement,
} from 'platejs';
import {
  createPlatePlugin,
  PlateLeaf,
  type PlateLeafProps,
  useEditorRef,
} from 'platejs/react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { Icon } from '@/components/ui/Icon';
import {
  type PresenceConnection,
  type PresenceStore,
  presenceClients,
} from '@/features/collaboration/presence';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useNoteEditorPrefs } from './noteEditorPrefs';
import {
  type BlockRun,
  blockIndex,
  decodePosition,
  type NotePointer,
  readNotePresence,
} from './notePresence';
import { editorAwareness } from './uploadPresence';

const REMOTE_CURSOR_KEY = 'capy_remote_cursor';

/** The co-editor palette's size (`--peer-0` to `--peer-7` in tailwind.css,
 * the cursors design's eight colours, a shade per theme). */
export const PEER_COLORS = 8;

export const remoteCursorDecorationPlugin = createPlatePlugin({
  key: REMOTE_CURSOR_KEY,
  node: { isLeaf: true },
  render: {
    node: (props: PlateLeafProps) => {
      const color = props.leaf.remoteCursorColor as number;
      const name =
        typeof props.leaf.remoteCursorName === 'string'
          ? props.leaf.remoteCursorName
          : m.editor_collaborator();
      // A caret is a collapsed decoration, an empty leaf with no width: the
      // stylesheet draws its bar (::before), so it adds no DOM to the text.
      // The stylesheet also tints a selection. The colour is the palette's,
      // never one a peer sends (Epo 2026-10-28).
      const caret = props.leaf.remoteCursorCaret === true;
      return (
        <PlateLeaf
          {...props}
          attributes={{
            ...props.attributes,
            [caret ? 'data-remote-caret' : 'data-remote-cursor']: name,
          }}
          style={
            {
              ...props.style,
              '--remote-cursor': `var(--peer-${color})`,
              pointerEvents: 'none',
            } as CSSProperties
          }
        />
      );
    },
  },
});

type CollaborativeEditor = YjsEditor & SlateEditor & CursorEditorType;

/** A peer's selection as its presence holds it (`s` and `f`, Yjs relative
 * positions in base64), which follow the text and are resolved only when
 * drawn. It is labelled with the verified name the room's presence gives its
 * client id, never a name its awareness claims (Epo 2026-10-20), and coloured
 * by its person's number there, the same in every co-editor's tab (Epo
 * 2026-10-28). */
type RemotePeer = {
  anchor: string;
  /** The palette's index. */
  color: number;
  focus: string;
  name: string | undefined;
};

type RemoteCursorDecoration = {
  anchor: Point;
  focus: Point;
  [REMOTE_CURSOR_KEY]: true;
  remoteCursorCaret?: true;
  remoteCursorColor: number;
  remoteCursorName: string | undefined;
};

const NO_PEERS: RemotePeer[] = [];
const NO_REMOTE_CURSORS: RemoteCursorDecoration[] = [];

/** The carets of the clients the room's presence lists (one it does not
 * list yet is not drawn), from states the note's field list admits. */
export function readRemotePeers(
  editor: SlateEditor,
  clients: ReadonlyMap<number, PresenceConnection>
): RemotePeer[] {
  if (!(CursorEditor.isCursorEditor(editor) && YjsEditor.connected(editor)))
    return NO_PEERS;
  const { awareness } = editor as CollaborativeEditor;
  const peers: RemotePeer[] = [];
  for (const [client, state] of awareness.getStates()) {
    const connection = clients.get(client);
    if (client === awareness.clientID || !connection) continue;
    const presence = readNotePresence(state);
    if (!presence?.s) continue;
    peers.push({
      anchor: presence.s,
      color: connection.person % PEER_COLORS,
      focus: presence.f ?? presence.s,
      name: connection.name ?? undefined,
    });
  }
  return peers;
}

function samePeers(left: RemotePeer[], right: RemotePeer[]) {
  return (
    left.length === right.length &&
    left.every((peer, index) => {
      const other = right[index];
      return (
        !!other &&
        peer.anchor === other.anchor &&
        peer.focus === other.focus &&
        peer.color === other.color &&
        peer.name === other.name
      );
    })
  );
}

export function useRemotePeers(editor: SlateEditor, presence: PresenceStore) {
  // Every state change here re-renders the whole editable, and the render
  // also restores the DOM caret from Slate's selection, which can undo native
  // caret movement the editor has not synced yet. So only a peer whose
  // selection or label actually changed may reach React (a pointer or block
  // selection never does); where its caret sits in the current document is
  // worked out in `decorate`. With the show-others switch off none is drawn.
  const shown = useNoteEditorPrefs((state) => state.showOthers);
  const [peers, setPeers] = useState<RemotePeer[]>(NO_PEERS);
  useEffect(() => {
    if (!(shown && CursorEditor.isCursorEditor(editor))) {
      setPeers(NO_PEERS);
      return;
    }
    let clients = presenceClients(presence.getState().connections);
    const update = () => {
      const next = readRemotePeers(editor, clients);
      setPeers((previous) => (samePeers(previous, next) ? previous : next));
    };
    update();
    CursorEditor.on(editor, 'change', update);
    const unsubscribe = presence.subscribe(({ connections }) => {
      clients = presenceClients(connections);
      update();
    });
    return () => {
      CursorEditor.off(editor, 'change', update);
      unsubscribe();
    };
  }, [editor, presence, shown]);

  return peers;
}

/** slate-react renders no decorations inside a void, so a caret in an inline
 * void (an inline equation) is drawn in the text right after it. */
function outOfInlineVoid(editor: SlateEditor, point: Point): Point {
  const entry = editor.api.parent<TElement>(point.path);
  if (!entry) return point;
  const [parent, parentPath] = entry;
  return editor.api.isInline(parent) && editor.api.isVoid(parent)
    ? { offset: 0, path: PathApi.next(parentPath) }
    : point;
}

function resolvePeer(
  editor: CollaborativeEditor,
  peer: RemotePeer
): RemoteCursorDecoration[] {
  const label = {
    [REMOTE_CURSOR_KEY]: true as const,
    remoteCursorColor: peer.color,
    remoteCursorName: peer.name,
  };
  const relativeFocus = decodePosition(peer.focus);
  const focus =
    relativeFocus &&
    relativePositionToSlatePoint(editor.sharedRoot, editor, relativeFocus);
  if (!focus) return [];
  const caretAt = outOfInlineVoid(editor, focus);
  const caret = {
    ...label,
    anchor: caretAt,
    focus: caretAt,
    remoteCursorCaret: true as const,
  };
  if (peer.anchor === peer.focus) return [caret];
  const relativeAnchor = decodePosition(peer.anchor);
  const anchor =
    relativeAnchor &&
    relativePositionToSlatePoint(editor.sharedRoot, editor, relativeAnchor);
  return anchor ? [{ ...label, anchor, focus }, caret] : [caret];
}

const resolved = new WeakMap<
  object,
  { peers: RemotePeer[]; ranges: RemoteCursorDecoration[]; version: unknown }
>();

/**
 * The peers' decorations for a `decorate` entry: each peer's selection as a
 * tinted range (when not collapsed) and its caret at the focus. They are
 * returned for the root entry only, since slate-react hands the root's
 * decorations down to every node they cover; returning them for a block or
 * text as well drew each caret once per level. Peer positions are relative,
 * so they are resolved once per document version (local and remote edits
 * move them) or peer change, like comment anchors.
 */
export function remoteCursorRangesForEntry(
  editor: SlateEditor,
  [, path]: [unknown, Path],
  peers: RemotePeer[]
): RemoteCursorDecoration[] {
  if (path.length > 0 || peers.length === 0) return NO_REMOTE_CURSORS;
  const cached = resolved.get(editor);
  if (cached?.version === editor.children && cached.peers === peers) {
    return cached.ranges;
  }
  const collaborative = editor as CollaborativeEditor;
  const ranges = collaborative.sharedRoot
    ? peers.flatMap((peer) => {
        try {
          return resolvePeer(collaborative, peer);
        } catch {
          // A position the document no longer holds draws no caret.
          return [];
        }
      })
    : NO_REMOTE_CURSORS;
  // A local edit is in Slate before it is flushed to Yjs (on change), and
  // positions resolved in between map Yjs offsets onto the edited text: such
  // a result is drawn but not kept for this version.
  if (YjsEditor.localChanges(collaborative).length === 0) {
    resolved.set(editor, { peers, ranges, version: editor.children });
  }
  return ranges;
}

/** A peer's pointer and block selection, from a state the note's field list
 * admits, for a client the room's presence lists. */
type PeerMarks = {
  b?: BlockRun[];
  color: number;
  name: string;
  p?: NotePointer | null;
};

/** What the overlay draws, in its own coordinates. */
type Mark =
  | {
      color: number;
      flip: boolean;
      key: string;
      kind: 'pointer';
      left: number;
      name: string;
      top: number;
    }
  | {
      color: number;
      height: number;
      key: string;
      kind: 'run';
      left: number;
      name: string;
      top: number;
      width: number;
    };

const NO_MARKS: Mark[] = [];
/** The pointer's tip sits 3.2 units into Cursor02Icon's 24-unit box. */
const POINTER_SIZE = 18;
const POINTER_TIP = (3.2 / 24) * POINTER_SIZE;
/** A name pill is at most 128 px wide (`max-w-32`, then truncated) and starts
 * 14 px from the tip, so a pointer this close to the overlay's right edge puts
 * it on its left, as a caret's flag flips (cursors design SPEC.md). */
const FLIP_WITHIN = 14 + 128;
/** The outline stands this far outside its blocks. */
const RUN_OUTSET = 4;

/** `client`'s pointer and block runs, from a state the note's field list
 * admits, when the room's presence lists it; none when it shows neither. */
export function readPeerMarks(
  awareness: Awareness,
  clients: ReadonlyMap<number, PresenceConnection>,
  client: number
): PeerMarks | undefined {
  const connection = clients.get(client);
  if (client === awareness.clientID || !connection) return;
  const presence = readNotePresence(awareness.getStates().get(client));
  if (!(presence?.p || presence?.b)) return;
  return {
    b: presence.b,
    color: connection.person % PEER_COLORS,
    name: connection.name ?? m.editor_collaborator(),
    p: presence.p,
  };
}

/**
 * Where a peer's pointer and block runs go, relative to the overlay's box
 * `origin`: a pointer at its x and y (0–1000) of its block's box, a run from
 * its first block's top to its last block's bottom. A block the note does not
 * render draws nothing.
 */
export function placeMarks(
  origin: DOMRect,
  find: (id: string) => Element | undefined,
  client: number,
  { b, color, name, p }: PeerMarks
): Mark[] {
  const marks: Mark[] = [];
  const block = p && find(p[0])?.getBoundingClientRect();
  if (p && block) {
    const left = block.left - origin.left + (p[1] / 1000) * block.width;
    marks.push({
      color,
      flip: left > origin.width - FLIP_WITHIN,
      key: `${client}:p`,
      kind: 'pointer',
      left,
      name,
      top: block.top - origin.top + (p[2] / 1000) * block.height,
    });
  }
  b?.forEach(([firstId, lastId], run) => {
    const first = find(firstId)?.getBoundingClientRect();
    const last = find(lastId)?.getBoundingClientRect();
    if (!(first && last)) return;
    const left = Math.min(first.left, last.left) - origin.left;
    const top = Math.min(first.top, last.top) - origin.top;
    marks.push({
      color,
      height: Math.max(first.bottom, last.bottom) - origin.top - top,
      key: `${client}:b${run}`,
      kind: 'run',
      left,
      name,
      top,
      width: Math.max(first.right, last.right) - origin.left - left,
    });
  });
  return marks;
}

const sameMarks = (left: Mark[], right: Mark[]) =>
  left.length === right.length &&
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Co-editors' pointers and block selections (Epo 2026-10-28, presence mocks
 * P1 and B3): a pointer is Cursor02Icon in the peer's colour with its name in
 * a pill beside it; a block selection is an outline around each run, its
 * corners the theme's (half its button radius), with the name at its top
 * right. An overlay in the editor's container, so it scrolls with the note;
 * it lays out at most once per frame and never re-renders the editor: a peer
 * again when its pointer or runs change (not on a caret move), every peer
 * when the room's presence, the note's size or the document changes. Nothing
 * with the show-others switch off.
 */
export function RemotePresenceMarks({ presence }: { presence: PresenceStore }) {
  const editor = useEditorRef();
  const shown = useNoteEditorPrefs((state) => state.showOthers);
  const overlay = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<Mark[]>(NO_MARKS);
  useEffect(() => {
    const awareness = editorAwareness(editor);
    const root = editor.api.toDOMNode(editor);
    const box = overlay.current;
    if (!(shown && awareness && root && box)) {
      setMarks(NO_MARKS);
      return;
    }
    let clients = presenceClients(presence.getState().connections);
    const blocks = blockIndex(root);
    // Each peer's marks and the presence they were placed from: a peer whose
    // pointer, runs, name and colour are unchanged (a caret move) keeps them.
    const placed = new Map<number, { from: string; marks: Mark[] }>();
    const changed = new Set<number>();
    let every = true;
    let frame = 0;
    const layout = () => {
      frame = 0;
      blocks.next();
      const peers = every
        ? new Set([...placed.keys(), ...awareness.getStates().keys()])
        : changed;
      let origin: DOMRect | undefined;
      let moved = false;
      for (const client of peers) {
        const peer = readPeerMarks(awareness, clients, client);
        if (!peer) {
          moved = placed.delete(client) || moved;
          continue;
        }
        const from = JSON.stringify(peer);
        if (!every && placed.get(client)?.from === from) continue;
        origin ??= box.getBoundingClientRect();
        placed.set(client, {
          from,
          marks: placeMarks(origin, blocks.find, client, peer),
        });
        moved = true;
      }
      every = false;
      changed.clear();
      if (!moved) return;
      const next = [...placed.values()].flatMap((peer) => peer.marks);
      setMarks((previous) => (sameMarks(previous, next) ? previous : next));
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(layout);
    };
    // Every mark moves with the note's layout and the room's names.
    const relayout = () => {
      every = true;
      schedule();
    };
    // This tab's own pointer moves change nothing here.
    const update = ({
      added,
      removed,
      updated,
    }: Record<'added' | 'removed' | 'updated', number[]>) => {
      for (const client of [...added, ...updated, ...removed])
        if (client !== awareness.clientID) changed.add(client);
      if (changed.size > 0) schedule();
    };
    relayout();
    awareness.on('change', update);
    // An edit can move blocks without resizing the note (a dragged block).
    awareness.doc.on('update', relayout);
    const unsubscribe = presence.subscribe(({ connections }) => {
      clients = presenceClients(connections);
      relayout();
    });
    const resized = new ResizeObserver(relayout);
    resized.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      awareness.off('change', update);
      awareness.doc.off('update', relayout);
      unsubscribe();
      resized.disconnect();
    };
  }, [editor, presence, shown]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      ref={overlay}
    >
      {marks.map((mark) =>
        mark.kind === 'pointer' ? (
          <span
            className="absolute text-(--peer)"
            data-remote-pointer={mark.name}
            key={mark.key}
            style={
              {
                '--peer': `var(--peer-${mark.color})`,
                left: mark.left - POINTER_TIP,
                top: mark.top - POINTER_TIP,
              } as CSSProperties
            }
          >
            <Icon
              className="drop-shadow-[0_1px_1px_rgb(0_0_0/0.3)]"
              fill="currentColor"
              name="pointer"
              size={POINTER_SIZE}
            />
            <span
              className={cn(
                'absolute top-3.5 max-w-32 truncate rounded-[6px] bg-(--peer) px-[7px] font-bold text-(--peer-fg) text-[12.5px] leading-[21px]',
                mark.flip ? 'right-3.5' : 'left-3.5'
              )}
            >
              {mark.name}
            </span>
          </span>
        ) : (
          <span
            className="absolute rounded-[calc(var(--radius-button)/2)] border-(--peer) border-2"
            data-remote-run={mark.name}
            key={mark.key}
            style={
              {
                '--peer': `var(--peer-${mark.color})`,
                height: mark.height + RUN_OUTSET * 2,
                left: mark.left - RUN_OUTSET,
                top: mark.top - RUN_OUTSET,
                width: mark.width + RUN_OUTSET * 2,
              } as CSSProperties
            }
          >
            <span className="absolute -top-[11px] right-1.5 max-w-32 truncate rounded-[6px] bg-(--peer) px-[7px] font-bold text-(--peer-fg) text-[12.5px] leading-[21px]">
              {mark.name}
            </span>
          </span>
        )
      )}
    </div>
  );
}
