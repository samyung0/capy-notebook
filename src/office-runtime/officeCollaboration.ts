import type { CursorChannel } from './officePresence';

/** An editor's replica; the XLSX one answers from its workbook worker. */
export interface OfficeReplica {
  applyUpdate(update: Uint8Array): unknown;
  encodeStateAsUpdate(
    remoteStateVector?: Uint8Array
  ): Uint8Array | Promise<Uint8Array>;
  onUpdate(
    listener: (update: Uint8Array, origin: 'local' | 'remote') => void
  ): () => void;
}
export interface OfficeCollaboration {
  clientId: number;
  /** The co-editors' cursors and this editor's (Epo 2026-10-20). */
  cursors: CursorChannel;
  initialUpdate: Uint8Array;
  onReplica: (replica: OfficeReplica | null) => void;
}
export type OfficeExporter = () => Promise<Uint8Array>;

export type OfficeFlusher = () => void | Promise<void>;
