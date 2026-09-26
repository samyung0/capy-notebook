import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  createSourceProvider,
  SOURCE_PUBLISHING_REASON,
} from './sourceProvider';

type Handlers = {
  onAuthenticated(): void;
  onAuthenticationFailed(event: { reason: string }): void;
};
const { providers } = vi.hoisted(() => ({
  providers: [] as {
    config: Handlers;
    connect: () => void;
    disconnect: () => void;
  }[],
}));
vi.mock('@/api/auth', () => ({ USE_MSW: false }));
vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    readonly config: Handlers;
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();
    constructor(config: Handlers) {
      this.config = config;
      providers.push(this);
    }
  },
}));

afterEach(() => {
  providers.length = 0;
  vi.useRealTimers();
});

function open() {
  const onAuthenticationFailed = vi.fn();
  createSourceProvider({
    document: new Y.Doc(),
    name: 'source:f:epoch:1',
    onAuthenticationFailed,
    token: async () => 'token',
    url: 'wss://collaboration.test',
  });
  return { onAuthenticationFailed, provider: providers[0] };
}

it('reconnects once, silently, when a publication refuses the room, and reports a second refusal', () => {
  vi.useFakeTimers();
  const { onAuthenticationFailed, provider } = open();
  const locked = { reason: SOURCE_PUBLISHING_REASON };
  provider.config.onAuthenticationFailed(locked);
  expect(onAuthenticationFailed).not.toHaveBeenCalled();
  expect(provider.disconnect).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(3000);
  expect(provider.connect).toHaveBeenCalledOnce();
  provider.config.onAuthenticationFailed(locked);
  expect(onAuthenticationFailed).toHaveBeenCalledWith(locked);
  // Once authenticated, a later publication gets its own silent retry.
  provider.config.onAuthenticated();
  provider.config.onAuthenticationFailed(locked);
  expect(onAuthenticationFailed).toHaveBeenCalledOnce();
});

it('reports other authentication failures at once', () => {
  const { onAuthenticationFailed, provider } = open();
  provider.config.onAuthenticationFailed({ reason: 'permission-denied' });
  expect(onAuthenticationFailed).toHaveBeenCalledWith({
    reason: 'permission-denied',
  });
  expect(provider.disconnect).not.toHaveBeenCalled();
});
