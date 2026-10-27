import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import type { MenuItem } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { ContentActions, trashErrorMessage } from './ContentActions';
import type { ContentActionTarget } from './contentActionTarget';

// No DOM here: the menu records the items it was given.
const menus = vi.hoisted(() => [] as MenuItem[][]);
vi.mock('@/components/ui/Menu', () => ({
  Menu: ({ items }: { items: MenuItem[] }) => {
    menus.push(items);
    return null;
  },
}));

function deleteItem(content: ContentActionTarget, confirmInMenu = false) {
  menus.length = 0;
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ContentActions
        chapters={[]}
        confirmInMenu={confirmInMenu}
        content={content}
        display="menu"
        workspaceId="ws_1"
      />
    </QueryClientProvider>
  );
  return menus[0]?.find((item) => item.label === m.action_delete());
}

const file = (kind: string, status: ContentActionTarget['status']) =>
  ({
    chapterId: null,
    createdAt: '2026-10-24T00:00:00Z',
    id: 'f_1',
    kind,
    name: 'lecture.mp3',
    status,
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
          chapters={[]}
          content={file('pdf', 'ready')}
          display="menu"
          workspaceId="ws_1"
          {...props}
        />
      </QueryClientProvider>
    );
    return menus[0]?.map((item) => item.label);
  }

  it('offers Move to… in place of the chapter move, before Clone to…', () => {
    expect(labels({ canMoveTo: true })).toEqual([
      m.action_rename(),
      m.action_move_to(),
      m.action_clone_to(),
      m.content_properties(),
      m.action_delete(),
    ]);
    expect(labels({})).toContain(m.content_move_file());
  });
});
