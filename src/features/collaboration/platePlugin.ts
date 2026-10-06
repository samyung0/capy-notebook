import {
  type ProviderConstructorProps,
  registerProviderType,
  type UnifiedProvider,
} from '@platejs/yjs';
import { RoomProvider, type RoomProviderConfig } from './roomProvider';

export type CapyProviderOptions = Omit<
  RoomProviderConfig,
  'awareness' | 'document'
>;

/**
 * The note editor's room provider for Plate's YjsPlugin (`type: 'capy'`):
 * Plate's own document and awareness over the tab's collaboration socket.
 * `provider` is the RoomProvider, for stateless messages and reconnects.
 */
export class CapyProviderWrapper implements UnifiedProvider {
  readonly provider: RoomProvider;
  readonly type = 'capy';
  private synced = false;

  constructor({
    awareness,
    doc,
    onConnect,
    onDisconnect,
    onSyncChange,
    options,
  }: ProviderConstructorProps<CapyProviderOptions>) {
    if (!doc) throw new Error('The capy provider needs the editor document');
    this.provider = new RoomProvider({
      ...options,
      awareness,
      document: doc,
      onConnect: () => {
        onConnect?.();
        options.onConnect?.();
      },
      onDisconnect: () => {
        if (this.synced) {
          this.synced = false;
          onSyncChange?.(false);
        }
        onDisconnect?.();
        options.onDisconnect?.();
      },
      onSynced: (event) => {
        if (event.state && !this.synced) {
          this.synced = true;
          onSyncChange?.(true);
        } else if (!event.state && this.synced) {
          this.synced = false;
          onSyncChange?.(false);
        }
        options.onSynced?.(event);
      },
    });
  }

  get awareness() {
    return this.provider.awareness;
  }

  get document() {
    return this.provider.document;
  }

  get isConnected() {
    return this.provider.isConnected;
  }

  get isSynced() {
    return this.synced;
  }

  connect() {
    this.provider.connect();
  }

  disconnect() {
    this.provider.disconnect();
  }

  destroy() {
    this.provider.destroy();
  }
}

registerProviderType('capy', CapyProviderWrapper);
