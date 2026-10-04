import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import {
  RECONNECT_GRACE_MS,
  refusalDropsDrafts,
  roomReconnector,
  roomRefusal,
  sendCheckpointRequest,
} from './roomConnection';

describe('roomRefusal', () => {
  it('reads the reason, then the failed token request, else retries', () => {
    expect(roomRefusal('collaboration-read-only')).toBe('readOnly');
    expect(roomRefusal('collaboration-not-found')).toBe('notFound');
    expect(roomRefusal('collaboration-forbidden')).toBe('forbidden');
    expect(
      roomRefusal('Failed to get token', new ApiError(404, 'Not Found'))
    ).toBe('notFound');
    expect(
      roomRefusal('Failed to get token', new ApiError(403, 'Forbidden'))
    ).toBe('forbidden');
    expect(roomRefusal('permission-denied')).toBe('retry');
  });
});

describe('refusalDropsDrafts', () => {
  it('drops stored edits for a gone document, never for an account lock', () => {
    const forbidden = new ApiError(403, 'Forbidden');
    const suspended = new ApiError(403, 'Forbidden', undefined, {
      code: 'account_suspended',
    });
    expect(refusalDropsDrafts('notFound')).toBe(true);
    expect(refusalDropsDrafts('forbidden', forbidden)).toBe(true);
    expect(refusalDropsDrafts('forbidden', suspended)).toBe(false);
    // The collaboration service's reason alone reads the same for a lock.
    expect(refusalDropsDrafts('forbidden')).toBe(false);
    expect(refusalDropsDrafts('retry', forbidden)).toBe(false);
  });
});

describe('sendCheckpointRequest', () => {
  it('waits for the sync, not only the authentication', () => {
    const send = vi.fn();
    // Authenticated, not yet synced: the old gate sent here, ahead of the
    // step 2 carrying the client's edits.
    expect(sendCheckpointRequest({ send, synced: false }, { id: 'a' })).toBe(
      false
    );
    expect(send).not.toHaveBeenCalled();
    expect(
      sendCheckpointRequest({ send, synced: true }, { flush: true, id: 'a' })
    ).toBe(true);
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({
      flush: true,
      id: 'a',
      type: 'checkpoint-request',
    });
  });
});

describe('roomReconnector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { onLine: true });
    // No jitter: factor 1.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setup() {
    const provider = { connect: vi.fn(), disconnect: vi.fn() };
    const onStuck = vi.fn();
    const reconnector = roomReconnector({ onStuck, provider: () => provider });
    return { onStuck, provider, reconnector };
  }

  it('reconnects a room the server closed on an open socket, once', () => {
    const { provider, reconnector } = setup();
    reconnector.closed(true);
    reconnector.closed(true);
    expect(provider.disconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(provider.connect).toHaveBeenCalledTimes(1);
  });

  it('connects only once the old socket has closed', () => {
    const socket = { status: 'connected' };
    const provider = {
      configuration: { websocketProvider: socket },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const reconnector = roomReconnector({
      onStuck: vi.fn(),
      provider: () => provider,
    });
    reconnector.refused();
    vi.advanceTimersByTime(1000);
    expect(provider.connect).not.toHaveBeenCalled();
    socket.status = 'disconnected';
    vi.advanceTimersByTime(250);
    expect(provider.connect).toHaveBeenCalledTimes(1);
  });

  it('leaves a dropped socket to the provider', () => {
    const { provider, reconnector } = setup();
    reconnector.closed(false);
    vi.advanceTimersByTime(5000);
    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(provider.connect).not.toHaveBeenCalled();
  });

  it('backs off between refusals and resets once synced', () => {
    const { provider, reconnector } = setup();
    reconnector.refused();
    vi.advanceTimersByTime(500);
    reconnector.refused();
    vi.advanceTimersByTime(999);
    expect(provider.connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(provider.connect).toHaveBeenCalledTimes(2);
    reconnector.connected();
    reconnector.refused();
    vi.advanceTimersByTime(500);
    expect(provider.connect).toHaveBeenCalledTimes(3);
  });

  it('reports a connection still lost after the grace period, not before', () => {
    const { onStuck, reconnector } = setup();
    reconnector.disconnected();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1);
    expect(onStuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting while the browser is offline', () => {
    const { onStuck, reconnector } = setup();
    vi.stubGlobal('navigator', { onLine: false });
    reconnector.disconnected();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 3);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('forgets a loss that recovered in time', () => {
    const { onStuck, reconnector } = setup();
    reconnector.disconnected();
    reconnector.connected();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(onStuck).not.toHaveBeenCalled();
  });
});
