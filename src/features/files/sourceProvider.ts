import { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';

/** The slice of HocuspocusProvider that source editing drives. Under MSW an
 * in-page provider registered by the mocks stands in for the sidecar. */
export interface SourceProvider {
  destroy(): void;
  disconnect(): void;
  /** Updates sent that the server has not yet acknowledged as applied. */
  hasUnsyncedChanges: boolean;
  isAuthenticated: boolean;
  sendStateless(payload: string): void;
}

export interface SourceProviderConfig {
  document: Y.Doc;
  name: string;
  onAuthenticationFailed?: (event: { reason: string }) => void;
  onDisconnect?: () => void;
  onStateless?: (event: { payload: string }) => void;
  onSynced?: (event: { state: boolean }) => void;
  onUnsyncedChanges?: (event: { number: number }) => void;
  token: () => Promise<string>;
  url: string;
}

let mockFactory: ((config: SourceProviderConfig) => SourceProvider) | null =
  null;

export function registerMockSourceProvider(
  factory: (config: SourceProviderConfig) => SourceProvider
) {
  mockFactory = factory;
}

/** The collaboration service's refusal while the room is locked for a
 * publication (collaboration/src/sourceHandoff.ts). */
export const SOURCE_PUBLISHING_REASON = 'source-publishing';
const PUBLISHING_RETRY_MS = 3000;

/** Under MSW the mock is the only allowed provider: a real socket would
 * point at `mock://collaboration` and fail for an unrelated reason. */
export function createSourceProvider(
  config: SourceProviderConfig
): SourceProvider {
  if (USE_MSW) {
    if (!mockFactory) throw new Error('Mock source provider is not registered');
    return mockFactory(config);
  }
  // A publication locks the room until the new epoch exists. The first
  // refusal reconnects after a short delay without reaching the session;
  // a refusal before authenticating again does.
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retried = false;
  const provider: HocuspocusProvider = new HocuspocusProvider({
    ...config,
    onAuthenticated: () => {
      retried = false;
    },
    onAuthenticationFailed: (event) => {
      if (event.reason !== SOURCE_PUBLISHING_REASON || retried) {
        config.onAuthenticationFailed?.(event);
        return;
      }
      retried = true;
      provider.disconnect();
      retry = setTimeout(() => void provider.connect(), PUBLISHING_RETRY_MS);
    },
    onDestroy: () => clearTimeout(retry),
  });
  return provider;
}
