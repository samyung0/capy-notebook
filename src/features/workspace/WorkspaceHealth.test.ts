import { describe, expect, it, vi } from 'vitest';
import { AccountState, StorageUsageLevel } from '@/api/types';
import { m } from '@/i18n';
import { refusalHandler, storageStatus } from './WorkspaceHealth';

const owner = (
  storageOwnerState: AccountState,
  storageOwnerUsage: StorageUsageLevel,
  isOwner = false
) => ({ isOwner, storageOwnerState, storageOwnerUsage });

describe('workspace storage status', () => {
  it('ranks own frozen, owner frozen, full or grace, then near', () => {
    const near = owner(AccountState.active, StorageUsageLevel.near_limit);
    const frozenOwner = owner(
      AccountState.over_quota_frozen,
      StorageUsageLevel.full
    );
    expect(storageStatus(near, AccountState.over_quota_frozen)?.kind).toBe(
      'frozen-self'
    );
    expect(storageStatus(frozenOwner, AccountState.active)?.kind).toBe(
      'frozen-owner'
    );
    expect(
      storageStatus(
        owner(AccountState.over_quota_grace, StorageUsageLevel.full),
        AccountState.active
      )?.kind
    ).toBe('full');
    expect(storageStatus(near, AccountState.active)?.kind).toBe('near');
    expect(
      storageStatus(
        owner(AccountState.active, StorageUsageLevel.ok),
        AccountState.active
      )
    ).toBeNull();
  });

  it('counts grace as full and speaks to members without naming the owner', () => {
    const grace = storageStatus(
      owner(AccountState.over_quota_grace, StorageUsageLevel.ok),
      AccountState.active
    );
    expect(grace).toMatchObject({
      kind: 'full',
      payer: false,
      title: m.workspace_storage_owner_full_title(),
    });
    expect(
      storageStatus(
        owner(AccountState.active, StorageUsageLevel.near_limit),
        AccountState.active
      )?.title
    ).toBe(m.workspace_storage_owner_near_title());
    expect(
      storageStatus(
        owner(AccountState.over_quota_frozen, StorageUsageLevel.full),
        AccountState.active
      )?.title
    ).toBe(m.workspace_storage_owner_frozen_title());
  });

  it('speaks to the owner about their own storage', () => {
    expect(
      storageStatus(
        owner(AccountState.active, StorageUsageLevel.full, true),
        AccountState.active
      )
    ).toMatchObject({
      payer: true,
      title: m.workspace_storage_owner_self_title(),
    });
    expect(
      storageStatus(
        owner(AccountState.over_quota_frozen, StorageUsageLevel.full, true),
        undefined
      )
    ).toMatchObject({
      kind: 'frozen-self',
      title: m.account_banner_frozen_title(),
    });
  });
});

describe('workspace refusals', () => {
  const frozen = storageStatus(
    owner(AccountState.over_quota_frozen, StorageUsageLevel.full),
    AccountState.active
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve));

  it('share one refresh and one status toast while the refresh runs', async () => {
    let finish!: (status: typeof frozen) => void;
    const refresh = vi.fn(
      () =>
        new Promise<typeof frozen>((resolve) => {
          finish = resolve;
        })
    );
    const showStatus = vi.fn();
    const showError = vi.fn();
    const refuse = refusalHandler(refresh, showStatus, showError);
    for (let i = 0; i < 5; i++) refuse(new Error(`refusal ${i}`));
    finish(frozen);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(showStatus).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
    // A later refusal refreshes again.
    refuse(new Error('later'));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('fall back to the error toast when the refresh fails or shows no refusing status', async () => {
    const showStatus = vi.fn();
    const showError = vi.fn();
    const failed = new Error('failed refresh');
    refusalHandler(
      () => Promise.reject(failed),
      showStatus,
      showError
    )('offline refusal');
    const near = storageStatus(
      owner(AccountState.active, StorageUsageLevel.near_limit),
      AccountState.active
    );
    for (const status of [null, near])
      refusalHandler(
        () => Promise.resolve(status),
        showStatus,
        showError
      )('cleared refusal');
    await settle();
    expect(showStatus).not.toHaveBeenCalled();
    expect(showError.mock.calls).toEqual([
      ['offline refusal'],
      ['cleared refusal'],
      ['cleared refusal'],
    ]);
  });
});
