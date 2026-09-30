import { onlineManager } from '@tanstack/react-query';
import * as Y from 'yjs';
import { qk } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import type { MockDialogId } from '@/components/dev/mockDialogOptions';
import { writeSourceDraft } from '@/features/files/sourceDraft';
import { decodeSourceState } from '@/features/files/useSourceSession';
import { m } from '@/i18n';
import { features } from '@/lib/features';
import { router } from '@/router';
import { worker } from './browser';
import { setChaosPeers } from './chaosPeers';
import { chatFixtureOptions } from './chatFixtures';
import {
  announceReadOnly,
  announceSourceEpoch,
  failNextSourceSave,
  rooms,
  savedSourceState,
  sourceRoomName,
} from './collaboration';
import * as db from './db';
import { mockWorkspaceMembers } from './handlers';
import { scenarioDriver } from './scenarioDriver';
import {
  advanceScenarioSource,
  prepareScenarioOffice,
  scenarioCards,
  scenarioMarker,
  scenarioNote,
  scenarioPath,
  scenarioQuiz,
  scenarioSavedMarker,
  scenarioSourceSession,
  scenarioText,
  scenarioWorkspace,
} from './scenarioFixtures';
import {
  getMockScenarioHandlers,
  type MockScenarioId,
  mockScenarioOptions,
} from './scenarios';

export const editorScenarios = [
  { id: 'source-save-failed', label: 'Text source: save failed' },
  { id: 'source-replaced', label: 'Text source: replaced with unsaved edits' },
  {
    id: 'source-draft-recovery',
    label: 'Text source: reopen a recovered draft',
  },
  { id: 'note-permission-lost', label: 'Note: edit access removed' },
  { id: 'office-docx-save', label: 'Word: save failed after editing' },
  { id: 'office-xlsx-save', label: 'Spreadsheet: save failed after editing' },
  { id: 'office-pptx-save', label: 'Slides: save failed after editing' },
  {
    id: 'office-runtime-error',
    label: 'Spreadsheet: export failed after editing',
  },
] as const;
export type JourneyId =
  | Exclude<MockScenarioId, 'none'>
  | (typeof editorScenarios)[number]['id'];
export const journeyOptions = [
  ...mockScenarioOptions.filter((option) => option.id !== 'none'),
  ...editorScenarios,
];

export function journeyGroup(id: string) {
  if (id.startsWith('auth-') || id.startsWith('onboarding-'))
    return 'Authentication';
  if (
    id.startsWith('chat-') ||
    id.startsWith('ai-') ||
    id.startsWith('generation') ||
    id === 'conversations-load'
  )
    return 'Chat and generation';
  if (/^(source-|office-|note-|collab)/.test(id)) return 'Editors and recovery';
  if (/^(file|upload|import|annotations|trash|storage)/.test(id))
    return 'Files and imports';
  if (/^(quiz|attempt|flashcard)/.test(id)) return 'Study';
  if (
    /^(account|profile|billing|checkout|models|credentials|notification|integrations|deletion)/.test(
      id
    )
  )
    return 'Account and settings';
  if (
    /^(workspace|chapter|member|sharing|invite|ownership|material|tags)/.test(
      id
    )
  )
    return 'Workspaces and materials';
  return 'Application';
}

export function journeyUnavailable(id: string): string | undefined {
  const flag = (
    {
      explore: 'explore',
      schedule: 'schedule',
      tasks: 'tasks',
      thinking: 'thinking',
    } as const
  )[id as 'explore'];
  return flag && !features[flag]
    ? `Enable VITE_FEATURE_${flag.toUpperCase()} to use this application page.`
    : undefined;
}

export async function runJourney(
  id: JourneyId,
  signal: AbortSignal,
  openDialog: (dialog: MockDialogId) => void
) {
  const ui = scenarioDriver(signal);
  const go = async (path: string) => {
    signal.throwIfAborted();
    await router.navigate({ to: path });
    await new Promise(requestAnimationFrame);
    signal.throwIfAborted();
    if (id !== 'workspace-timeout')
      await ui.wait(() => queryClient.isFetching() === 0, 'page data loaded');
  };
  const fail = (scenario = id as MockScenarioId) => {
    signal.throwIfAborted();
    worker.use(
      ...getMockScenarioHandlers(
        scenario === 'workspace-flaky' ? 'workspace-500' : scenario
      )
    );
  };
  const dialog = async (name: MockDialogId) => {
    openDialog(name);
    await ui.element('[role="dialog"]');
    await new Promise(requestAnimationFrame);
    await ui.wait(() => queryClient.isFetching() === 0, 'dialog data loaded');
  };
  const editMode = async () => {
    const toggle = await ui.button(m.material_mode(), 'button');
    if (toggle.getAttribute('aria-pressed') !== 'true') ui.activate(toggle);
  };
  const sourceOpen = async (fileId = scenarioText) => {
    await go(`${scenarioPath}?file=${fileId}`);
    await editMode();
    await ui.button(m.action_save());
  };
  const textEdit = async (marker = scenarioMarker) => {
    const input = await ui.element<HTMLTextAreaElement>(
      `textarea[aria-label="${m.source_edit_raw()}"]`
    );
    await ui.wait(() => input.value.length > 0, 'source input binding ready');
    await ui.fill(
      `textarea[aria-label="${m.source_edit_raw()}"]`,
      `${input.value}\n${marker}`
    );
  };
  // The text a source's viewer read returns: its last saved checkpoint.
  const savedText = (fileId: string) => {
    const state = savedSourceState(fileId);
    if (!state) return '';
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decodeSourceState(state));
    const text = doc.getText('source').toString();
    doc.destroy();
    return text;
  };
  const share = async () => {
    if (
      !mockWorkspaceMembers.some((row) => row.workspaceId === scenarioWorkspace)
    )
      mockWorkspaceMembers.push({
        createdAt: new Date().toISOString(),
        name: 'Morgan Lee',
        role: 'editor',
        userId: 'u_mock_collaborator',
        workspaceId: scenarioWorkspace,
      });
    await go(scenarioPath);
    await dialog('workspace-sharing');
  };
  const chat = async () => {
    await go(scenarioPath);
    await ui.click(m.workspace_tab_chat());
    await ui.fill(
      `textarea[aria-label="${m.chat_placeholder()}"]`,
      'Explain the source for this scenario.'
    );
    await ui.click(m.chat_send());
    if (id !== 'chat-openui-slow') await ui.button(m.chat_send());
  };
  const formSave = async () => {
    await ui.click(m.action_save());
  };
  const sourceImport = async (local: boolean) => {
    await go(scenarioPath);
    await dialog(local ? 'source-upload' : 'source-details');
    await ui.click(local ? m.action_upload() : m.action_import());
  };

  if (id === 'source-save-failed' || id === 'source-replaced') {
    await sourceOpen();
    await ui.wait(
      () =>
        [...document.querySelectorAll('[role="status"]')].some(
          (node) => node.textContent === m.editor_status_saved()
        ),
      'initial source checkpoint'
    );
    if (id === 'source-save-failed') failNextSourceSave(scenarioText);
    await textEdit();
    if (id === 'source-replaced')
      announceSourceEpoch(scenarioText, advanceScenarioSource(scenarioText));
    else await ui.click(m.action_save());
    // Unsaved edits send a replaced session to recovery, so both show the error strip.
    await ui.element('[role="alert"]');
    return;
  }
  if (id === 'source-draft-recovery') {
    const session = await scenarioSourceSession(scenarioText);
    if (!session) throw new Error('Missing draft fixture');
    const room = rooms.get(sourceRoomName(scenarioText, session.epoch))!;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.document));
    doc
      .getText('source')
      .insert(doc.getText('source').length, `\n${scenarioMarker}`);
    await writeSourceDraft(
      {
        baseSourceSHA256: session.baseSourceSHA256,
        epoch: session.epoch,
        fileId: `${db.user.id}:${scenarioText}`,
        id: 'mock-scenario-recovered',
        state: Y.encodeStateAsUpdate(doc),
        version: crypto.randomUUID(),
      },
      new TextEncoder().encode('A source for trying application errors.\n')
    );
    doc.destroy();
    advanceScenarioSource(scenarioText);
    await sourceOpen();
    await ui.element('[role="alert"]');
    return;
  }
  const readOnlyStrip = () =>
    ui.wait(
      () => !!document.body.textContent?.includes(m.editor_read_only_strip()),
      'read-only strip'
    );
  if (
    id === 'note-frozen-while-editing' ||
    id === 'note-storage-full-while-editing'
  ) {
    await go(`${scenarioPath}?material=${scenarioNote}&mode=edit`);
    const editable = await ui.element<HTMLElement>('[contenteditable="true"]');
    // A normal typed edit, still inside the checkpoint debounce when the
    // room turns read-only.
    editable.focus();
    getSelection()?.selectAllChildren(editable);
    getSelection()?.collapseToEnd();
    // Slate reads the DOM selection on a throttled selectionchange.
    const since = performance.now();
    await ui.wait(
      () => performance.now() - since > 250,
      'editor selection synced'
    );
    // Typed text as the browser delivers it; Slate applies it to the document.
    editable.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: ` ${scenarioMarker}`,
        inputType: 'insertText',
      })
    );
    await ui.wait(
      () =>
        [...document.querySelectorAll('[role="status"]')].some(
          (node) => node.textContent === m.editor_status_syncing()
        ),
      'note edit waiting for its checkpoint'
    );
    // The account freezes, or its storage fills up: the server's answers
    // change, then the open room turns read-only.
    fail();
    announceReadOnly();
    await readOnlyStrip();
    return 'The open note drops to view mode under the read-only strip and discards the refused edit.';
  }
  if (id === 'source-frozen-while-editing') {
    await sourceOpen();
    await ui.wait(
      () =>
        [...document.querySelectorAll('[role="status"]')].some(
          (node) => node.textContent === m.editor_status_saved()
        ),
      'initial source checkpoint'
    );
    // A saved edit, which is not published: View shows it all the same.
    await textEdit(scenarioSavedMarker);
    await ui.click(m.action_save());
    await ui.wait(
      () => savedText(scenarioText).includes(scenarioSavedMarker),
      'saved source edit'
    );
    await textEdit();
    // The account freezes: the server's answers change, then the open room
    // refuses the pending edit and turns read-only.
    fail();
    announceReadOnly();
    await readOnlyStrip();
    return 'The source drops to view mode under the read-only strip, showing its saved edit and discarding the unsaved text.';
  }
  if (id === 'note-permission-lost') {
    await go(`${scenarioPath}?material=${scenarioNote}&mode=edit`);
    await ui.element('[contenteditable="true"]');
    const note = db.materials.find((row) => row.id === scenarioNote)!;
    note.capabilities = {
      ...note.capabilities,
      canEdit: false,
      canEditContent: false,
    };
    await queryClient.invalidateQueries({
      queryKey: qk.material(scenarioNote),
    });
    await ui.wait(
      () => !document.querySelector('[contenteditable="true"]'),
      'note switched to its static preview'
    );
    return 'The application switches this note to its static preview. Its inner permission error is not reached.';
  }
  if (id.startsWith('office-')) {
    const format =
      id === 'office-runtime-error'
        ? 'xlsx'
        : (id.split('-')[1] as 'docx' | 'xlsx' | 'pptx');
    await prepareScenarioOffice(format, signal);
    const fileId = `mock-scenario-${format}`;
    await sourceOpen(fileId);
    const frame = await ui.element<HTMLIFrameElement>(
      'iframe[src*="office-runtime"]'
    );
    const frameDocument = frame.contentDocument;
    if (!frameDocument)
      throw new Error('Office scenarios require the local same-origin runtime');
    const officeUI = scenarioDriver(signal, frameDocument);
    await ui.wait(
      () =>
        [...document.querySelectorAll('[role="status"]')].some(
          (node) => node.textContent === m.editor_status_saved()
        ),
      'initial Office checkpoint'
    );
    if (id !== 'office-runtime-error') failNextSourceSave(fileId);
    if (format === 'xlsx') {
      await officeUI.fill('[data-testid="xlsx-formula-input"]', scenarioMarker);
      const input = await officeUI.element(
        '[data-testid="xlsx-formula-input"]'
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          code: 'Enter',
          key: 'Enter',
        })
      );
    } else if (format === 'docx') {
      await officeUI.fill(
        '[aria-label="Document input"]:not([readonly])',
        scenarioMarker
      );
    } else {
      await officeUI.element('[data-testid="pptx-slide-canvas"]');
      frame.contentWindow!.dispatchEvent(
        new CustomEvent('capy-scenario-edit-slide', { detail: scenarioMarker })
      );
    }
    await ui.wait(
      () => rooms.get(sourceRoomName(fileId, 1))?.dirty,
      'Office local update'
    );
    if (id === 'office-runtime-error') {
      // The runtime's real export error path, with its current replica retained.
      frame.contentWindow!.dispatchEvent(
        new CustomEvent('capy-scenario-export-failure')
      );
      await ui.click(m.material_mode(), 'button');
    } else await ui.click(m.action_save());
    await ui.element('[role="alert"]');
    return;
  }

  if (id.startsWith('auth-')) {
    fail();
    if (id === 'auth-callback') {
      await go('/sso-callback');
      return;
    }
    const reset = id === 'auth-reset' || id === 'auth-password';
    const signup =
      id === 'auth-signup' || id === 'auth-code' || id === 'auth-send-code';
    await go(reset ? '/forgot-password' : signup ? '/sign-up' : '/sign-in');
    if (id === 'auth-sso') {
      await ui.click('Google');
      return;
    }
    await ui.fill('input[name="email"]', 'scenario@example.test');
    if (!reset)
      await ui.fill('input[name="password"]', 'Scenario-Password-42!');
    await ui.submit();
    if (id === 'auth-code') {
      await ui.fill('input[name="code"]', '123456');
      await ui.submit();
    }
    if (id === 'auth-password') {
      await ui.fill('input[name="code"]', '123456');
      await ui.fill('input[name="password"]', 'Scenario-Password-42!');
      await ui.submit();
    }
    if (id === 'auth-breached')
      return 'The normal sign-in flow requires a new password.';
    if (id === 'auth-busy')
      return 'The sign-in request is pending for 15 seconds.';
    return;
  }

  const readRoutes: Partial<Record<JourneyId, string>> = {
    'account-deleted': '/settings',
    'account-deletion-pending': '/settings',
    'account-frozen-create': '/workspaces',
    'account-frozen-member': scenarioPath,
    'account-frozen-workspace': scenarioPath,
    'account-grace': '/',
    'account-grace-workspace': scenarioPath,
    'account-over-quota': '/',
    'account-storage-full': scenarioPath,
    'account-storage-full-dashboard': '/',
    'account-storage-near': scenarioPath,
    'account-storage-near-dashboard': '/',
    'account-suspended': '/settings',
    'annotations-load': `${scenarioPath}?file=mock-scenario-pdf`,
    'attempt-load': `/quizzes/attempts/${db.attempts[0].id}`,
    'billing-load': '/billing',
    'chapters-load': scenarioPath,
    'collaboration-token': `${scenarioPath}?material=${scenarioNote}&mode=edit`,
    'credentials-load': '/settings?tab=llm',
    'deletion-check': '/settings?tab=danger',
    'deletion-transfer-required': '/settings?tab=danger',
    explore: '/explore',
    'file-detail': `${scenarioPath}?file=${scenarioText}`,
    'file-links': `${scenarioPath}?file=${scenarioText}`,
    'file-list': '/files',
    'file-list-forbidden': '/files',
    'file-list-network': '/files',
    'flashcards-load': `/flashcards/${scenarioCards}`,
    'material-load': `${scenarioPath}?material=${scenarioNote}`,
    'material-unreadable': `${scenarioPath}?material=${scenarioNote}`,
    'materials-load': scenarioPath,
    'models-load': '/settings?tab=llm',
    'notification-count': '/',
    'notification-prefs-load': '/settings?tab=notifications',
    'profile-load': '/settings',
    'quiz-load': `/quizzes/${scenarioQuiz}/attempt`,
    schedule: '/schedule',
    'service-503': '/workspaces',
    tasks: '/tasks',
    thinking: '/thinking',
    'trash-load': '/files?tab=trash',
    'workspace-401': scenarioPath,
    'workspace-404': scenarioPath,
    'workspace-500': scenarioPath,
    'workspace-flaky': scenarioPath,
    'workspace-owner-frozen': scenarioPath,
    'workspace-owner-full': scenarioPath,
    'workspace-owner-grace': scenarioPath,
    'workspace-owner-near': scenarioPath,
    'workspace-timeout': scenarioPath,
  };
  const route = readRoutes[id];
  if (id === 'trash-load') {
    fail();
    await go('/files');
    await ui.click(m.files_tab_trash());
    return;
  }
  if (route) {
    fail();
    await go(route);
    // The deletion preflight loads only once its dialog opens.
    if (id === 'deletion-check' || id === 'deletion-transfer-required')
      await ui.click(m.action_delete());
    if (
      [
        'billing-load',
        'models-load',
        'notification-count',
        'service-503',
      ].includes(id)
    )
      return 'This page currently suppresses the failed read instead of rendering a local error.';
    if (id === 'credentials-load') {
      await ui.wait(
        () =>
          [...document.querySelectorAll('p')].some(
            (node) => node.textContent === m.settings_llm_key_unavailable()
          ),
        'provider keys unavailable'
      );
      return 'The provider key error is displayed beside the input.';
    }
    const accountTitle = (
      {
        'account-deleted': m.account_blocked_deleted_title,
        'account-deletion-pending': m.account_blocked_deletion_pending_title,
        'account-frozen-create': m.account_banner_frozen_title,
        'account-frozen-member': m.account_banner_frozen_title,
        'account-frozen-workspace': m.account_banner_frozen_title,
        'account-grace': m.account_banner_grace_title,
        'account-grace-workspace': m.workspace_storage_owner_self_title,
        'account-over-quota': m.account_banner_frozen_title,
        'account-storage-full': m.workspace_storage_owner_self_title,
        'account-storage-full-dashboard': m.account_banner_full_title,
        'account-storage-near': m.workspace_storage_near_self_title,
        'account-storage-near-dashboard': m.account_banner_near_title,
        'account-suspended': m.account_blocked_suspended_title,
        'workspace-owner-frozen': m.workspace_storage_owner_frozen_title,
        'workspace-owner-full': m.workspace_storage_owner_full_title,
        'workspace-owner-grace': m.workspace_storage_owner_full_title,
        'workspace-owner-near': m.workspace_storage_owner_near_title,
      } as Partial<Record<JourneyId, () => string>>
    )[id];
    if (accountTitle) {
      // The header triangle carries the title as its label; the entry toast
      // may still be leaving from a previous run in this workspace.
      await ui.wait(
        () =>
          document.body.textContent?.includes(accountTitle()) ||
          [...document.querySelectorAll('[data-storage-status]')].some(
            (node) => node.getAttribute('aria-label') === accountTitle()
          ),
        'account status displayed'
      );
      if (id === 'account-frozen-create') {
        await ui.wait(
          () =>
            [...document.querySelectorAll('button')].some(
              (node) =>
                node.textContent === m.action_new_workspace() && node.disabled
            ),
          'create control disabled'
        );
        return 'Create controls are disabled and the page header shows the frozen status triangle.';
      }
      if (id === 'account-frozen-member')
        return "Your own frozen account keeps this healthy owner's workspace read-only; the header shows your status.";
      if (id.startsWith('workspace-owner-'))
        return 'The workspace header and entry toast show the owner status in member wording.';
      return route === scenarioPath
        ? 'The workspace header triangle and entry toast show your storage status.'
        : 'The dashboard banner slot or the blocked-account page shows the account status.';
    }
    if (id === 'workspace-timeout')
      return 'The request remains pending; the application shows its loading state.';
    if (id === 'deletion-transfer-required')
      return 'The account deletion section requires ownership transfers first.';
    return;
  }
  if (id.startsWith('chat-') || (id.startsWith('ai-') && id !== 'ai-context')) {
    fail();
    await chat();
    if (id === 'chat-undo-refused') await ui.click(m.chat_undo_edit());
    if (
      id === 'chat-tool-failed' ||
      id === 'chat-undo-refused' ||
      id === 'chat-pending-sources'
    )
      return 'The application shows this result in the chat message.';
    if (chatFixtureOptions.some((option) => option.id === id))
      return 'The chat response is rendered by the application.';
    return;
  }
  switch (id) {
    case 'source-session':
    case 'source-token':
      fail();
      await sourceOpen();
      return;
    case 'offline':
      await go(scenarioPath);
      await ui.element('main');
      onlineManager.setOnline(false);
      return 'Application offline preview. Actual network loss is covered by browser offline tests.';
    case 'connection-reconnecting':
      await go(scenarioPath);
      queryClient.setQueryData(qk.eventStream, { status: 'disconnected' });
      return 'Application reconnecting preview. MSW does not open the events connection.';
    case 'collab-chaos':
      await go(`${scenarioPath}?material=${scenarioNote}&mode=edit`);
      await ui.element('[contenteditable="true"]');
      setChaosPeers(true);
      return;
    case 'invite-success':
    case 'invite-unavailable':
    case 'invite-retry':
    case 'invite-frozen':
      fail();
      await go('/workspace-invites/mock-scenario');
      await ui.click(m.invite_accept());
      return;
    case 'workspace-stats':
      fail();
      await go(scenarioPath);
      await dialog('workspace-stats');
      return;
    case 'workspace-save':
      await go(scenarioPath);
      await dialog('workspace-settings');
      await ui.fill('input[name="name"]', 'Renamed scenario workspace');
      fail();
      await formSave();
      return;
    case 'workspace-create':
    case 'tags-load':
      await go('/workspaces');
      if (id === 'tags-load') fail();
      await ui.click(m.action_new_workspace());
      if (id === 'tags-load') {
        await ui.fill('input[role="combobox"]', 'scenario');
        return 'Tag suggestions currently suppress their read error.';
      }
      await ui.fill('input[name="name"]', 'Scenario creation');
      fail();
      await ui.submit('[role="dialog"] form');
      return;
    case 'workspace-delete':
    case 'workspace-clone':
      await go(scenarioPath);
      await dialog('workspace-settings');
      await ui.click(
        id === 'workspace-delete'
          ? m.workspace_tab_danger()
          : m.workspace_tab_others()
      );
      fail();
      await ui.click(
        id === 'workspace-delete' ? m.action_delete() : m.action_clone()
      );
      if (id === 'workspace-delete')
        await ui.click(m.trash_delete_forever(), '[role="dialog"] button');
      return;
    case 'members-load':
      fail();
      await share();
      return 'The member list currently suppresses its read error.';
    case 'sharing-save':
      await share();
      fail();
      await ui.click(m.share_visibility(), '[role="combobox"]');
      await ui.click(m.share_link(), '[role="option"]');
      return;
    case 'invite-send':
      await share();
      await ui.fill('input[name="identifier"]', 'morgan@example.com');
      fail();
      await ui.click(m.members_invite());
      return;
    case 'member-save':
    case 'member-remove':
      await share();
      ui.activate(
        await ui.element(
          'section[aria-labelledby="workspace-members-title"] button[aria-haspopup="menu"]'
        )
      );
      fail();
      await ui.click(
        id === 'member-remove' ? m.members_remove() : m.members_manage()
      );
      if (id === 'member-save') {
        await ui.click(m.common_role(), '[role="combobox"]');
        await ui.click(m.members_role_view(), '[role="option"]');
      }
      return;
    case 'ownership-transfer':
      await go(scenarioPath);
      await dialog('ownership-transfer');
      fail();
      await ui.click(m.workspace_transfer_confirm());
      return;
    case 'chapter-save':
      await go(scenarioPath);
      await ui.click(m.action_add_file());
      await ui.click(m.action_add_chapter());
      await ui.fill('[role="dialog"] input', 'Scenario chapter');
      fail();
      await ui.submit('[role="dialog"] form');
      return;
    case 'file-save':
    case 'file-delete':
    case 'material-save':
      await go(
        `${scenarioPath}?${id === 'material-save' ? `material=${scenarioNote}` : `file=${scenarioText}`}`
      );
      await ui.click(
        m.a11y_open_menu(),
        '[data-testid="content-header"] button'
      );
      if (id === 'file-delete') fail();
      await ui.click(
        id === 'file-delete' ? m.action_delete() : m.action_rename()
      );
      if (id === 'file-delete') {
        await ui.click(m.action_confirm(), '[role="dialog"] button');
        return;
      }
      await ui.fill('[role="dialog"] input', 'Renamed scenario item');
      fail();
      await ui.click(m.action_save());
      return;
    case 'trash-restore':
    case 'trash-delete': {
      await go('/files');
      await ui.click(m.files_tab_trash());
      await ui.wait(() => queryClient.isFetching() === 0, 'trash loaded');
      const title = await ui.wait(
        () =>
          [...document.querySelectorAll('p')].find(
            (node) => node.textContent === 'Scenario archived file'
          ),
        'scenario trash item'
      );
      const row =
        title.closest('[data-slot="card"]') ??
        title.parentElement?.parentElement;
      const menu = row?.querySelector<HTMLButtonElement>(
        'button[aria-haspopup="menu"]'
      );
      if (!menu) throw new Error('Scenario trash action is missing');
      ui.activate(menu);
      fail();
      await ui.click(
        id === 'trash-restore' ? m.trash_restore() : m.trash_delete_forever()
      );
      if (id === 'trash-delete')
        await ui.click(m.trash_delete_forever(), '[role="dialog"] button');
      return;
    }
    case 'upload-policy':
    case 'integrations-load':
      fail();
      await go(scenarioPath);
      await dialog('source-chooser');
      if (id === 'integrations-load') await ui.click(m.action_import());
      return 'The source chooser currently suppresses this read error; its controls reflect the missing data.';
    case 'upload-failed':
    case 'upload-file-cap':
    case 'upload-batch-cap':
    case 'ingest-slots':
    case 'storage-quota':
    case 'account-locked':
      fail();
      await sourceImport(true);
      return;
    case 'import-start':
    case 'import-status':
    case 'import-job-failed':
    case 'import-job-pending':
      fail();
      await sourceImport(false);
      return id === 'import-job-pending'
        ? 'The import remains pending in the application.'
        : undefined;
    case 'import-analysis':
      fail();
      await go(scenarioPath);
      await dialog('source-chooser');
      await ui.click(m.action_import());
      await ui.click('Google Drive');
      await ui.wait(
        () =>
          document
            .querySelector('[role="dialog"]')
            ?.textContent?.includes(m.source_analysis_failed()),
        'Office analysis failure'
      );
      return 'Cloud file analysis failed through the real import workflow.';
    case 'import-inspect':
    case 'import-rejected':
      fail();
      await go(scenarioPath);
      await dialog('source-chooser');
      await ui.click(m.action_import());
      await ui.click('Google Drive');
      return;
    case 'profile-save':
    case 'onboarding-photo':
    case 'onboarding-metadata':
      await go('/settings');
      await dialog('onboarding');
      await ui.fill('input[name="name"]', 'Scenario profile');
      if (id === 'onboarding-photo') {
        const input = await ui.wait(
          () =>
            document.querySelector<HTMLInputElement>(
              '[role="dialog"] input[type="file"]'
            ),
          'photo input'
        );
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(
            [
              Uint8Array.from(
                atob(
                  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
                ),
                (c) => c.charCodeAt(0)
              ),
            ],
            'scenario.png',
            { type: 'image/png' }
          )
        );
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      fail();
      await ui.click(m.action_confirm());
      return;
    case 'checkout':
    case 'checkout-free':
    case 'billing-portal':
      if (id === 'billing-portal') fail();
      else fail('checkout-free');
      await go('/billing?tab=subscription');
      await ui.click(
        id === 'billing-portal'
          ? m.subscription_manage()
          : m.billing_upgrade_pro()
      );
      return;
    case 'models-save':
      db.llmCredentials.openai = 'sk-mock-scenario';
      await go('/settings?tab=llm');
      await ui.click(m.settings_llm_chat(), '[role="combobox"]');
      fail();
      (
        await ui.element(
          '[role="option"][data-state="unchecked"]:not([data-disabled])'
        )
      ).click();
      return;
    case 'credentials-save':
      await go('/settings?tab=llm');
      await ui.fill('input[type="password"]', 'scenario-invalid-key');
      fail();
      await ui.click(m.settings_llm_key_save());
      await ui.wait(
        () =>
          [...document.querySelectorAll('p')].some(
            (node) => node.textContent === m.settings_llm_key_invalid()
          ),
        'provider key error'
      );
      return 'The provider key error is displayed beside the input.';
    case 'notification-prefs':
      await go('/settings?tab=notifications');
      fail();
      (await ui.element('[role="switch"]:not(:disabled)')).click();
      return;
    case 'notifications-load':
    case 'notification-save':
      await go('/');
      fail();
      (await ui.element('button[aria-label*="notification" i]')).click();
      if (id === 'notification-save')
        await ui.click(m.notifications_mark_all_read());
      return 'This notification request currently has no local error display.';
    case 'deletion-submit':
      await go('/settings?tab=danger');
      await ui.click(m.action_delete());
      await ui.fill('input[name="confirmEmail"]', db.user.email);
      fail();
      await ui.click(m.settings_deletion_request());
      return;
    case 'search':
      await go('/');
      fail();
      await ui.click(m.search_placeholder());
      await ui.fill('input[placeholder]', 'scenario');
      return 'Search currently suppresses its request error.';
    case 'conversations-load':
      fail();
      await go(scenarioPath);
      await ui.click(m.workspace_tab_chat());
      await ui.click(m.chat_history());
      return 'Chat history currently suppresses its read error.';
    case 'generation-failed':
    case 'ai-context':
      await go(scenarioPath);
      await ui.click(m.nav_create());
      await ui.click(m.generate_kind_diagram());
      fail();
      await ui.click(m.action_generate());
      return id === 'ai-context'
        ? 'The application currently shows its generic validation error for this response.'
        : undefined;
    case 'quiz-save':
      await go(`/quizzes/${scenarioQuiz}/edit`);
      await ui.fill(
        `input[placeholder="${m.quiz_prompt_placeholder()}"]`,
        'Edited scenario question?'
      );
      fail();
      await formSave();
      return;
    case 'quiz-submit':
    case 'quiz-grade':
      await go(`/quizzes/${scenarioQuiz}/attempt`);
      fail();
      if (id === 'quiz-grade') {
        const text = await ui.element<HTMLTextAreaElement>('textarea');
        await ui.fill('textarea', 'A scenario answer about cells.');
        text.blur();
      }
      for (
        let i = 0;
        i <
        db.quizFromMaterial(
          db.materials.find((row) => row.id === scenarioQuiz)!
        ).questions.length -
          1;
        i++
      )
        await ui.click(m.action_next());
      await ui.click(m.action_finish());
      return;
    case 'flashcard-progress':
      await go(`/flashcards/${scenarioCards}`);
      fail();
      await ui.click(m.flashcards_show_answer());
      await ui.click(m.srs_good());
      return 'The application currently suppresses flashcard progress failures.';
    case 'task-save':
      await go('/');
      await dialog('task-edit');
      await ui.fill('input[name="title"]', 'Scenario task edit');
      fail();
      await formSave();
      return 'The task form currently suppresses its save error.';
    case 'annotations-save':
      await go(`${scenarioPath}?file=mock-scenario-pdf`);
      await editMode();
      await ui.click(m.pdf_draw());
      await ui.click(m.pdf_pen());
      {
        const canvas = await ui.element('[data-page="1"] canvas');
        const rect = canvas.getBoundingClientRect();
        fail();
        canvas.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: rect.x + 50,
            clientY: rect.y + 50,
          })
        );
        document.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            clientX: rect.x + 100,
            clientY: rect.y + 70,
          })
        );
        document.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            clientX: rect.x + 100,
            clientY: rect.y + 70,
          })
        );
      }
      return;
  }
  throw new Error(`No journey registered for ${id}`);
}
