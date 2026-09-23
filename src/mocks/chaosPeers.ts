import { CursorEditor, withCursors, withYjs, YjsEditor } from '@slate-yjs/core';
import {
  createSlateEditor,
  type NodeEntry,
  type Path,
  TextApi,
  type TNode,
} from 'platejs';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { qk } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import type { WorkspaceMember } from '@/api/types';
import { MaterialKit } from '@/features/notes/plugins';
import { checkpointRoom, join, type Room, rooms } from './collaboration';
import * as db from './db';
import { mockWorkspaceMembers } from './handlers';

/** In-page port of `collaboration/scripts/chaos-peers.ts`: synthetic
 * collaborators that join whatever mock rooms the app has open, move cursors,
 * type, leave and come back. They ride the mock room fan-out, so no sidecar is
 * involved. Started and stopped by the `collab-chaos` user scenario. */

const PEERS_PER_ROOM = 3;
const EDIT_MS = { max: 2800, min: 700 };
const CURSOR_MS = { max: 1400, min: 400 };
const SESSION_MS = { max: 20_000, min: 6000 };
const IDLE_MS = { max: 8000, min: 2000 };
const SWEEP_MS = 1000;

const PEER_NAMES = [
  'Avery',
  'Blake',
  'Casey',
  'Drew',
  'Eden',
  'Finley',
  'Gray',
  'Harper',
  'Indigo',
  'Jules',
];
const SNIPPETS = [' hmm', ' …', ' ok', ' +1', ' draft', ' note', '?', '!'];

function pick(range: { max: number; min: number }) {
  return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
}

function sample<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function cursorColor(seed: string) {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `hsl(${hash % 360} 72% 48%)`;
}

type PeerEditor = ReturnType<typeof createSlateEditor> &
  YjsEditor &
  CursorEditor<{ color: string; name: string }>;

/** Text leaves outside void blocks, the only places a person could type. */
function textEntries(editor: PeerEditor): NodeEntry[] {
  return [
    ...editor.api.nodes({
      at: [],
      match: (node: TNode, path: Path) =>
        TextApi.isText(node) && !editor.api.void({ at: path }),
    }),
  ];
}

function randomEdit(editor: PeerEditor, name: string) {
  const entries = textEntries(editor);
  if (entries.length === 0 || Math.random() < 0.25) {
    editor.tf.insertNodes(
      {
        children: [{ text: `${name}${sample(SNIPPETS)}` }],
        id: `p_${Math.random().toString(36).slice(2, 10)}`,
        type: 'p',
      },
      { at: [editor.children.length] }
    );
  } else {
    const [node, path] = sample(entries);
    const text = TextApi.isText(node) ? node.text : '';
    editor.tf.insertText(sample(SNIPPETS), {
      at: { offset: Math.floor(Math.random() * (text.length + 1)), path },
    });
  }
  YjsEditor.flushLocalChanges(editor);
}

function moveCursor(editor: PeerEditor) {
  const entries = textEntries(editor);
  if (entries.length === 0) {
    CursorEditor.sendCursorPosition(editor, null);
    return;
  }
  const [node, path] = sample(entries);
  const length = TextApi.isText(node) ? node.text.length : 0;
  const point = { offset: Math.floor(Math.random() * (length + 1)), path };
  CursorEditor.sendCursorPosition(editor, { anchor: point, focus: point });
}

function randomSourceEdit(text: Y.Text, name: string) {
  const snippet =
    Math.random() < 0.2 ? `\n${name}${sample(SNIPPETS)}` : sample(SNIPPETS);
  text.insert(Math.floor(Math.random() * (text.length + 1)), snippet);
}

/** One synthetic collaborator bound to one room. */
class ChaosPeer {
  readonly name: string;
  readonly participant: {
    awareness?: Awareness;
    document: Y.Doc;
    origin: object;
  };
  readonly slot: number;
  readonly room: Room;
  private leaveRoom: (() => void) | null = null;
  private editor: PeerEditor | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(room: Room, slot: number) {
    this.room = room;
    this.slot = slot;
    this.name = `${PEER_NAMES[slot % PEER_NAMES.length]} ${slot + 1}`;
    const document = new Y.Doc();
    this.participant = {
      awareness:
        room.target.kind === 'material' ? new Awareness(document) : undefined,
      document,
      origin: this,
    };
    this.schedule(() => this.join(), slot * 250);
  }

  private schedule(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(timer);
  }

  private join() {
    if (this.stopped || this.leaveRoom) return;
    if (rooms.get(this.room.name) !== this.room || !isOpen(this.room)) {
      this.stop();
      return;
    }
    const { document, awareness } = this.participant;
    this.leaveRoom = join(this.room, this.participant);
    if (awareness) {
      const data = { color: cursorColor(this.name), name: this.name };
      // The app's plugin set, so normalization keeps inline and void nodes.
      // Cursor positions are sent by hand: autoSend would re-send the
      // headless editor's null selection after every change.
      // Plate's editor type is not structurally a Slate BaseEditor, so the
      // slate-yjs wrappers take the same cast as Collaboration.test.ts.
      const editor = withCursors(
        withYjs(
          createSlateEditor({ plugins: MaterialKit }) as never,
          document.get('content', Y.XmlText),
          { autoConnect: false }
        ),
        awareness,
        { autoSend: false, data }
      ) as unknown as PeerEditor;
      YjsEditor.connect(editor);
      CursorEditor.sendCursorData(editor, data);
      this.editor = editor;
      const cursors = () => {
        if (!this.editor) return;
        moveCursor(this.editor);
        this.schedule(cursors, pick(CURSOR_MS));
      };
      this.schedule(cursors, pick(CURSOR_MS));
    }
    const edits = () => {
      if (!this.leaveRoom) return;
      try {
        if (this.editor) randomEdit(this.editor, this.name);
        else randomSourceEdit(document.getText('source'), this.name);
        checkpointRoom(this.room);
      } catch (error) {
        console.warn(`[chaos ${this.name}] edit failed:`, error);
      }
      this.schedule(edits, pick(EDIT_MS));
    };
    this.schedule(edits, pick(EDIT_MS));
    this.schedule(() => this.leave(), pick(SESSION_MS));
  }

  private leave() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.editor) {
      CursorEditor.sendCursorPosition(this.editor, null);
      YjsEditor.disconnect(this.editor);
      this.editor = null;
    }
    this.leaveRoom?.();
    this.leaveRoom = null;
    if (!this.stopped) this.schedule(() => this.join(), pick(IDLE_MS));
  }

  stop() {
    this.stopped = true;
    this.leave();
    this.participant.document.destroy();
  }
}

const peersByRoom = new Map<string, ChaosPeer[]>();
const peerParticipants = new WeakSet<object>();
let sweep: ReturnType<typeof setInterval> | null = null;
const members: WorkspaceMember[] = [];

function workspaceOf(room: Room): string | undefined {
  return room.target.kind === 'material'
    ? db.materials.find((material) => material.id === room.target.id)
        ?.workspaceId
    : db.files.find((file) => file.id === room.target.id)?.workspaceId;
}

/** Peers appear as editors of the workspace so the share dialog agrees with
 * the cursors on screen. */
function ensureMembers(room: Room, peers: ChaosPeer[]) {
  const workspaceId = workspaceOf(room);
  if (!workspaceId) return;
  for (const peer of peers) {
    const userId = `chaos_${peer.slot}`;
    if (
      members.some(
        (member) =>
          member.userId === userId && member.workspaceId === workspaceId
      )
    )
      continue;
    const member: WorkspaceMember = {
      createdAt: new Date().toISOString(),
      name: peer.name,
      role: 'editor',
      userId,
      workspaceId,
    };
    members.push(member);
    mockWorkspaceMembers.push(member);
  }
  void queryClient.invalidateQueries({
    queryKey: qk.workspaceMembers(workspaceId),
  });
}

/** A room is "open" while a participant other than our peers is in it. */
function isOpen(room: Room) {
  for (const participant of room.participants) {
    if (!peerParticipants.has(participant)) return true;
  }
  return false;
}

function tick() {
  for (const [name, peers] of peersByRoom) {
    const room = rooms.get(name);
    if (room === peers[0].room && isOpen(room)) continue;
    for (const peer of peers) peer.stop();
    peersByRoom.delete(name);
  }
  for (const [name, room] of rooms) {
    const peers = peersByRoom.get(name);
    if (isOpen(room) && !peers) {
      const pool = Array.from(
        { length: PEERS_PER_ROOM },
        (_, slot) => new ChaosPeer(room, slot)
      );
      for (const peer of pool) peerParticipants.add(peer.participant);
      peersByRoom.set(name, pool);
      ensureMembers(room, pool);
    }
  }
}

export function setChaosPeers(enabled: boolean) {
  if (enabled && !sweep) {
    sweep = setInterval(tick, SWEEP_MS);
    tick();
  } else if (!enabled && sweep) {
    clearInterval(sweep);
    sweep = null;
    for (const peers of peersByRoom.values())
      for (const peer of peers) peer.stop();
    peersByRoom.clear();
    const workspaceIds = new Set<string>();
    for (const member of members.splice(0)) {
      const index = mockWorkspaceMembers.indexOf(member);
      if (index !== -1) mockWorkspaceMembers.splice(index, 1);
      workspaceIds.add(member.workspaceId);
    }
    for (const workspaceId of workspaceIds) {
      void queryClient.invalidateQueries({
        queryKey: qk.workspaceMembers(workspaceId),
      });
    }
  }
}
