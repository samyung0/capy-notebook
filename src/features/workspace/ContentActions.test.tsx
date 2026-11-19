import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { act, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import type { ConfirmDialog } from '@/components/ui/Dialog';
import type { MenuItem } from '@/components/ui/Menu';
import { getLocale, m } from '@/i18n';
import { ContentActions, trashErrorMessage } from './ContentActions';
import type { ContentActionTarget } from './contentActionTarget';

// The menu records the items it was given.
const menus = vi.hoisted(() => [] as MenuItem[][]);
vi.mock('@/components/ui/Menu', () => ({
  Menu: ({ items }: { items: MenuItem[] }) => {
    menus.push(items);
    return null;
  },
}));
// The questions asked: each open confirm dialog's props. No dialog draws.
const questions = vi.hoisted(
  () => [] as ComponentProps<typeof ConfirmDialog>[]
);
vi.mock('@/components/ui/Dialog', async (original) => ({
  ...(await original<typeof import('@/components/ui/Dialog')>()),
  ConfirmDialog: (props: ComponentProps<typeof ConfirmDialog>) => {
    if (props.open) questions.push(props);
    return null;
  },
  SimpleDialog: () => null,
}));

function deleteItem(content: ContentActionTarget, confirmInMenu = false) {
  menus.length = 0;
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ContentActions
        confirmInMenu={confirmInMenu}
        content={content}
        display="menu"
        topics={[]}
        workspaceId="ws_1"
      />
    </QueryClientProvider>
  );
  return menus[0]?.find((item) => item.label === m.action_delete());
}

const file = (kind: string, status: ContentActionTarget['status']) =>
  ({
    createdAt: '2026-10-24T00:00:00Z',
    id: 'f_1',
    kind,
    name: 'lecture.mp3',
    status,
    topicId: null,
    type: 'file',
  }) satisfies ContentActionTarget;

describe('trashing a file', () => {
  it('holds Delete back while a recording is transcribing', () => {
    expect(deleteItem(file('audio', 'processing'))).toMatchObject({
      description: m.trash_audio_transcribing_hint(),
      disabled: true,
    });
    for (const target of [file('audio', 'ready'), file('pdf', 'processing')]) {
      expect(deleteItem(target)?.disabled).toBeUndefined();
    }
  });

  it('asks again in the menu instead of a dialog', () => {
    expect(deleteItem(file('pdf', 'ready'), true)?.confirmLabel).toBe(
      m.action_confirm_delete()
    );
  });

  it("shows the server's transcribing refusal as its own copy", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ errors: [{ message: 'audio_transcribing' }] }),
            { status: 409 }
          )
      )
    );
    const refusal = await api.del('/files/f_1').catch((error) => error);
    vi.unstubAllGlobals();
    expect(trashErrorMessage(refusal)).toBe(m.trash_audio_transcribing());
    expect(trashErrorMessage(new Error('offline'))).not.toBe(
      m.trash_audio_transcribing()
    );
  });
});

describe('moving a file', () => {
  function labels(props: { canMoveTo?: boolean }) {
    menus.length = 0;
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ContentActions
          canClone
          content={file('pdf', 'ready')}
          display="menu"
          topics={[]}
          workspaceId="ws_1"
          {...props}
        />
      </QueryClientProvider>
    );
    return menus[0]?.map((item) => item.label);
  }

  it('offers Move to… in place of the topic move, before Clone to… and Download', () => {
    expect(labels({ canMoveTo: true })).toEqual([
      m.action_rename(),
      m.action_move_to(),
      m.content_shared_with_members(),
      m.action_clone_to(),
      m.action_download(),
      m.content_properties(),
      m.action_delete(),
    ]);
    expect(labels({})).toContain(m.content_move_file());
  });
});

describe('sharing an item with members', () => {
  const visible = file('pdf', 'ready');
  const hidden = { ...visible, hidden: true };
  const tree = (content: ContentActionTarget, readOnly = false) => (
    <QueryClientProvider client={new QueryClient()}>
      <ContentActions
        content={content}
        display="menu"
        readOnly={readOnly}
        topics={[]}
        workspaceId="ws_1"
      />
    </QueryClientProvider>
  );
  const switchRow = () =>
    menus
      .at(-1)
      ?.find((item) => item.label === m.content_shared_with_members());

  it('shows owners and editors the state as a switch, viewers no row', () => {
    for (const [content, checked] of [
      [visible, true],
      [hidden, false],
    ] as const) {
      menus.length = 0;
      renderToStaticMarkup(tree(content));
      expect(switchRow()).toMatchObject({
        checked,
        icon: 'members',
        switch: true,
      });
    }
    menus.length = 0;
    renderToStaticMarkup(tree(visible, true));
    expect(switchRow()).toBeUndefined();
  });

  it('hides at once when switched off; asks, then shares, when switched on', async () => {
    // The locale resolves before a window exists (see ItemsList.test.tsx),
    // then linkedom's document goes in before react-dom/client loads.
    getLocale();
    const { document, window } = parseHTML(
      '<!doctype html><html><body><div id="root"></div></body></html>'
    );
    Object.assign(globalThis, {
      document,
      IS_REACT_ACT_ENVIRONMENT: true,
      window,
    });
    const { createRoot } = await import('react-dom/client');
    const fetched = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetched);
    const sent = (hiddenFlag: boolean) =>
      expect(fetched).toHaveBeenCalledWith(
        expect.stringContaining('/files/f_1/hidden'),
        expect.objectContaining({
          body: JSON.stringify({ hidden: hiddenFlag }),
          method: 'PUT',
        })
      );
    const root = createRoot(document.getElementById('root') as never);

    // Off: no question, and the menu stays open on the switch.
    await act(async () => root.render(tree(visible)));
    expect(switchRow()?.closeOnSelect).toBe(false);
    await act(async () => switchRow()?.onClick?.());
    expect(questions).toHaveLength(0);
    sent(true);

    // On: the menu closes for the question, and only its answer sends.
    fetched.mockClear();
    await act(async () => root.render(tree(hidden)));
    expect(switchRow()?.closeOnSelect).toBe(true);
    await act(async () => switchRow()?.onClick?.());
    expect(fetched).not.toHaveBeenCalled();
    expect(questions.at(-1)).toMatchObject({
      confirmLabel: m.content_share_with_members(),
      title: m.content_share_with_members_title(),
    });
    await act(async () => questions.at(-1)?.onConfirm());
    sent(false);

    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
});
