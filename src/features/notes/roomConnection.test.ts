import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import {
  RECONNECT_GRACE_MS,
  refusalDropsDrafts,
  roomReconnector,
  roomRefusal,
  sendCheckpointRequest,
  socketOpen,
} from './roomConnection';

describe('roomRefusal', () => {
  it('reads the reason, then the failed token request, else retries', () => {
    expect(roomRefusal('collaboration-read-only')).toBe('readOnly');
    expect(roomRefusal('collaboration-not-found')).toBe('notFound');
    expect(roomRefusal('collaboration-forbidden')).toBe('forbidden');
    expect(roomRefusal('collaboration-outdated')).toBe('outdated');
    // A client id the room holds no more never joins again (Epo
    // 2026-10-24); a clash on a fresh offer is retried.
    expect(roomRefusal('collaboration-client-id-unheld')).toBe('rejected');
    expect(roomRefusal('collaboration-client-id')).toBe('retry');
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

  it('rejoins on the shared socket that stays open', () => {
    const provider = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      socketStatus: 'connected',
    };
    const reconnector = roomReconnector({
      onStuck: vi.fn(),
      provider: () => provider,
    });
    expect(socketOpen(provider)).toBe(true);
    reconnector.refused();
    vi.advanceTimersByTime(500);
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

  // Epo 2026-10-20: the room joined and its answer waits on the open
  // budget, so it is reachable however long that takes.
  it('never reports a slowed open as stuck', () => {
    const { onStuck, reconnector } = setup();
    reconnector.disconnected();
    reconnector.slowed();
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

  // Epo 2026-10-23: a join has 30 s from its start, a note's token request
  // included, which came before the editor.
  it('counts a join from its start, not from the call', () => {
    const { onStuck, reconnector } = setup();
    reconnector.started(Date.now() - 20_000);
    vi.advanceTimersByTime(RECONNECT_GRACE_MS - 20_000 - 1);
    expect(onStuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('ends a join at its sync', () => {
    const { onStuck, reconnector } = setup();
    reconnector.started(Date.now() - 20_000);
    reconnector.connected();
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('reports a join that started over 30 s ago at once, unless offline', () => {
    const { onStuck, reconnector } = setup();
    vi.stubGlobal('navigator', { onLine: false });
    reconnector.started(Date.now() - RECONNECT_GRACE_MS - 5000);
    vi.advanceTimersByTime(0);
    expect(onStuck).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: true });
    vi.advanceTimersByTime(RECONNECT_GRACE_MS);
    expect(onStuck).toHaveBeenCalledTimes(1);
    const late = setup();
    late.reconnector.started(Date.now() - RECONNECT_GRACE_MS - 5000);
    vi.advanceTimersByTime(0);
    expect(late.onStuck).toHaveBeenCalledTimes(1);
  });
});
