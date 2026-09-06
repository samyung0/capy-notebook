export interface OfficeReplica {
  applyUpdate(update: Uint8Array): unknown;
  encodeStateAsUpdate(remoteStateVector?: Uint8Array): Uint8Array;
  onUpdate(
    listener: (update: Uint8Array, origin: 'local' | 'remote') => void
  ): () => void;
}
export interface OfficeCollaboration {
  clientId: number;
  initialUpdate: Uint8Array;
  onReplica: (replica: OfficeReplica | null) => void;
}
export type OfficeExporter = () => Promise<Uint8Array>;

export type OfficeFlusher = () => void | Promise<void>;
