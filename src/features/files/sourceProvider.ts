import { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { USE_MSW } from '@/api/auth';

/** The slice of HocuspocusProvider that source editing drives. Under MSW an
 * in-page provider registered by the mocks stands in for the sidecar. */
export interface SourceProvider {
  destroy(): void;
  disconnect(): void;
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

/** Under MSW the mock is the only allowed provider: a real socket would
 * point at `mock://collaboration` and fail for an unrelated reason. */
export function createSourceProvider(
  config: SourceProviderConfig
): SourceProvider {
  if (!USE_MSW) return new HocuspocusProvider(config);
  if (!mockFactory) throw new Error('Mock source provider is not registered');
  return mockFactory(config);
}
