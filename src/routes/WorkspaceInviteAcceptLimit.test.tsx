import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists (see ItemsList.test.tsx), then
// linkedom's document goes in before react-dom/client loads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const limit = new ApiError(403, 'Forbidden', undefined, {
  code: 'workspace_limit_exceeded',
});
const spies = vi.hoisted(() => ({
  clear: vi.fn(),
  preview: { role: 'editor', workspaceKind: 'personal' },
  toast: vi.fn(),
}));
vi.mock('@/api/hooks', async () => {
  const { useState } = await import('react');
  return {
    useAcceptWorkspaceInvite: () => {
      const [error, setError] = useState<unknown>(null);
      return {
        error,
        isPending: false,
        isSuccess: false,
        mutate: (
          _token: string,
          options: { onError: (error: unknown) => void }
        ) => {
          setError(limit);
          options.onError(limit);
        },
      };
    },
    useWorkspaceInvitePreview: () => ({ data: spies.preview, error: null }),
  };
});
vi.mock('@/api/queryClient', () => ({ showErrorToast: spies.toast }));
vi.mock('@/lib/urlTokenStash', () => ({ clearStashedToken: spies.clear }));
vi.mock('@/lib/useStashedToken', () => ({ useStashedToken: () => 'tok_1' }));
vi.mock('@/components/app/AuthProvider', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/app/layout', () => ({
  Panel: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ token: '-' }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: WorkspaceInviteAccept } = await import(
  './WorkspaceInviteAccept'
);

const acceptButton = () =>
  [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === m.invite_accept()
  );

// At the workspace cap the page toasts once and keeps the invite, on screen
// and in the stash, for Back or a refresh after upgrading (Epo 2026-10-28).
it('keeps the invite open and stashed when the workspace cap refuses it', async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(<WorkspaceInviteAccept />));
  await act(async () => {
    acceptButton()?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  expect(spies.toast).toHaveBeenCalledOnce();
  expect(spies.toast).toHaveBeenCalledWith(limit);
  expect(spies.clear).not.toHaveBeenCalled();
  expect(acceptButton()).toBeDefined();
  act(() => root.unmount());
});

// A class's member agrees to what they share before Accept (Epo 2026-11-19).
it('asks a class member to agree to sharing their practice before Accept', async () => {
  spies.preview = { role: 'viewer', workspaceKind: 'class' };
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(<WorkspaceInviteAccept />));
  expect(document.body.textContent).toContain(m.invite_sharing_consent());
  expect(document.body.textContent).toContain(m.invite_sharing_progress());
  expect(acceptButton()).toBeDefined();
  act(() => root.unmount());
});
