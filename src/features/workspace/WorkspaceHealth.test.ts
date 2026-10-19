import { describe, expect, it, vi } from 'vitest';
import { AccountState, StorageUsageLevel } from '@/api/types';
import { m } from '@/i18n';
import { refusalHandler, storageStatus } from './WorkspaceHealth';

const account = (state: AccountState, storageUsage: StorageUsageLevel) => ({
  state,
  storageUsage,
});

describe('workspace storage status', () => {
  it("ranks the viewer's own frozen, full or grace, then near", () => {
    expect(
      storageStatus(
        account(AccountState.over_quota_frozen, StorageUsageLevel.ok)
      )
    ).toMatchObject({
      kind: 'frozen-self',
      title: m.account_banner_frozen_title(),
    });
    expect(
      storageStatus(
        account(AccountState.over_quota_grace, StorageUsageLevel.ok)
      )
    ).toMatchObject({
      kind: 'full',
      title: m.workspace_storage_owner_self_title(),
    });
    expect(
      storageStatus(account(AccountState.active, StorageUsageLevel.near_limit))
        ?.kind
    ).toBe('near');
    expect(
      storageStatus(account(AccountState.active, StorageUsageLevel.ok))
    ).toBeNull();
  });
});

describe('workspace refusals', () => {
  const frozen = storageStatus(
    account(AccountState.over_quota_frozen, StorageUsageLevel.full)
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
      account(AccountState.active, StorageUsageLevel.near_limit)
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
