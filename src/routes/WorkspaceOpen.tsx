import { useQuery } from '@tanstack/react-query';
import {
  Navigate,
  Outlet,
  useChildMatches,
  useNavigate,
  useParams,
  useRouter,
  useSearch,
} from '@tanstack/react-router';
import {
  type ComponentProps,
  lazy,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type GroupImperativeHandle,
  useGroupRef,
} from 'react-resizable-panels';
import { isApiError } from '@/api/client';
import { addTopicBodyNameMax } from '@/api/gen/validators';
import {
  useAddTopic,
  useFile,
  useFiles,
  useMaterials,
  useTopics,
  useUpdateTopic,
  useVisitWorkspace,
  useWorkspace,
  workspaceQuery,
} from '@/api/hooks';
import type { Citation, Region, ResourceRef } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { LoadingLarge } from '@/components/app/LoadingLarge';
import { Panel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import {
  FloatingBarContext,
  OfficeInsetContext,
} from '@/components/ui/floatingBarContext';
import { Icon } from '@/components/ui/Icon';
import type { MenuItem } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/Resizable';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { followMoves } from '@/features/files/fileMoved';
import { officeFormatOf } from '@/features/files/fileUtils';
import {
  registerTourPanels,
  type TourPanels,
} from '@/features/guide/tourStore';
import type {
  MakeQuizChoice,
  MakeQuizDialog,
} from '@/features/makeQuiz/MakeQuizDialog';
import { addQuizRun, useQuizDialogKey } from '@/features/makeQuiz/quizRuns';
import { CenterContent } from '@/features/materials/CenterContent';
import type { OneColumnChrome } from '@/features/materials/CenterContentHeader';
import {
  type NoteCitationTarget,
  type OpenItem,
  openItemFromSearch,
  searchFromOpenItem,
  type WorkspaceOpenSearch,
} from '@/features/materials/openItem';
import { SharingNotice } from '@/features/study/assignments/SharingNotice';
import { type StudyPage, studyView } from '@/features/study/practice/studyView';
import {
  assignmentsLink,
  membersLink,
  studyLink,
  studyTabPage,
} from '@/features/study/studyRoutes';
import { VoiceFooterButton } from '@/features/voice/VoiceCard';
import {
  AddSourceDialog,
  type AddSourceMode,
} from '@/features/workspace/AddSourceDialog';
import {
  canManageWorkspaceSettings,
  hasWorkspaceSettings,
  isWorkspaceReadOnly,
} from '@/features/workspace/access';
import { ChatPanel, type ChatRequest } from '@/features/workspace/ChatPanel';
import { CloneWorkspaceDialog } from '@/features/workspace/CloneWorkspaceDialog';
import { ArchivedChatsDialog } from '@/features/workspace/chat/ArchivedChatsDialog';
import { preloadProseWhenIdle } from '@/features/workspace/chat/blocks/text';
import { ConversationList } from '@/features/workspace/chat/ConversationList';
import { resumedConnect } from '@/features/workspace/connectResume';
import { FilesHome } from '@/features/workspace/FilesHome';
import { FilesPanel } from '@/features/workspace/FilesPanel';
import type { TabAction } from '@/features/workspace/PanelTabRow';
import type { SettingsView } from '@/features/workspace/settingsTabs';
import { WorkspaceDashboard } from '@/features/workspace/WorkspaceDashboard';
import { WorkspaceHealth } from '@/features/workspace/WorkspaceHealth';
import {
  PAGE_SECTION,
  SECTION_PAGE,
  SectionTitle,
  WorkspaceRail,
  type WorkspaceSection,
  workspaceSections,
} from '@/features/workspace/WorkspaceRail';
import { WorkspaceSettingsDialog } from '@/features/workspace/WorkspaceSettingsDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { waitsForConnection } from '@/lib/online';
import { useMediaQuery } from '@/lib/useMediaQuery';

const WorkspaceCanvas = lazy(() => import('@/routes/WorkspaceCanvas'));
const AddPracticeDialog = lazy(() =>
  import('@/features/study/practice/AddPractice').then((mod) => ({
    default: mod.AddPracticeDialog,
  }))
);
/** A search value's ids: the paper's or the answer files'. */
const splitIds = (ids: string | undefined) =>
  ids ? ids.split(',').filter(Boolean) : [];
const choiceSearch = ({ answers, paper }: MakeQuizChoice) => ({
  answers: answers.join(',') || undefined,
  paper: paper.join(',') || undefined,
});

// The section panel beside the rail: one default for every section (Epo
// 2026-11-04). It can be dragged as wide as half the group, as the right panel
// could, which from lg keeps the viewer above its least width.
const LEFT_SIZE = 340;
const LEFT_MIN = 220;
const LEFT_MAX = '50%';
const VIEWER_MIN = 400;

/** Places the left panel whenever it opens or closes, as the library starts it
 * at nothing. It comes back at the width it closed at; closed, it collapses but
 * stays mounted, so Agent's chat keeps its thread, draft and stream. Dragging it
 * under its least width closes it on release. */
function usePanelLayout({
  group,
  groupRef,
  open,
}: {
  group: HTMLDivElement | null;
  groupRef: RefObject<GroupImperativeHandle | null>;
  open: boolean;
}) {
  const kept = useRef(LEFT_SIZE);
  useEffect(() => {
    if (!group) return;
    const observer = new ResizeObserver(([entry]) => {
      const handle = groupRef.current;
      const width = entry.contentRect.width;
      if (!(handle && width > 0)) return;
      const current = handle.getLayout();
      // The library reads a layout's sizes by position, in the order its
      // panels registered (not the DOM's): the current layout's keys give
      // that order. None yet: the group has no size, wait for one.
      const order = Object.keys(current);
      if (order.length === 0) return;
      // Only the callback that lands after the group registered its panels;
      // a window resize keeps the panels' shares.
      observer.disconnect();
      const shown = ((current.left ?? 0) * width) / 100;
      if (shown > 0) kept.current = shown;
      const left = open ? (kept.current / width) * 100 : 0;
      const sizes: Record<string, number> = { left, viewer: 100 - left };
      handle.setLayout(Object.fromEntries(order.map((id) => [id, sizes[id]])));
    });
    observer.observe(group);
    return () => observer.disconnect();
  }, [group, groupRef, open]);
}

/** A panel's own actions as its title row's buttons. */
const tabButtons = (actions: TabAction[]) =>
  actions.map((action) => (
    <ToolbarButton
      disabled={action.disabled}
      key={action.label}
      label={action.label}
      onClick={action.onClick}
    >
      <Icon name={action.icon} />
    </ToolbarButton>
  ));

/** A read this user may not make (gone or forbidden). */
function missing(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 403);
}

/** The open file follows its workspace (Q455, Q462, Q467). A Move's room
 * message is acted on at once (`followMoves`): into the target workspace
 * when this user can read it, else the file closes here. Without it (an old
 * bookmark, a PDF, a tab that was closed), a fresh settled file read naming
 * another workspace opens the file there once that workspace reads, a
 * standalone file at `/files`; an unreadable file shows the usual panel. A
 * file read is fresh once this page saw it within its staleness window, and
 * stays so however long the workspace read takes (L4); a row restored from
 * storage, a read in flight or one seen fresh on another page never moves
 * the page. Opened PDFs never refetch their
 * file, so they follow on their next open. Every follow replaces history and
 * opens the file as a normal open does: its mode from this device, out of full
 * screen. */
function useFollowOpenFile(workspaceId: string, fileId: string | null) {
  const navigate = useNavigate();
  const {
    data: file,
    dataUpdatedAt,
    error,
    isFetching,
    isStale,
  } = useFile(fileId, { errorBoundary: false });
  const settled = !!fileId && !isFetching;
  // The read last seen fresh on this page (L4).
  const fresh = useRef({ at: 0, workspaceId: '' });
  if (settled && !isStale) fresh.current = { at: dataUpdatedAt, workspaceId };
  const elsewhere =
    settled &&
    fresh.current.at === dataUpdatedAt &&
    fresh.current.workspaceId === workspaceId &&
    !error &&
    file?.id === fileId &&
    file.workspaceId !== workspaceId
      ? file.workspaceId
      : undefined;
  const { data: target, error: targetError } = useQuery({
    ...workspaceQuery(elsewhere ?? ''),
    enabled: !!elsewhere,
    meta: { errorBoundary: false },
  });
  const follow = useCallback(
    (to: string | null) => {
      if (!fileId) return;
      if (to === null)
        navigate({
          replace: true,
          search: (previous) => ({
            ...previous,
            file: undefined,
            fullscreen: undefined,
            mode: undefined,
            page: undefined,
          }),
          to: '.',
        });
      else if (to === '')
        navigate({ params: { fileId }, replace: true, to: '/files/$fileId' });
      else
        navigate({
          params: { workspaceId: to },
          replace: true,
          search: { file: fileId },
          to: '/workspaces/$workspaceId',
        });
    },
    [fileId, navigate]
  );
  useEffect(
    () =>
      followMoves((moved, to) => {
        if (moved === fileId) follow(to);
      }),
    [fileId, follow]
  );
  useEffect(() => {
    if (elsewhere === '') follow('');
    else if (elsewhere && target) follow(elsewhere);
    else if (elsewhere && missing(targetError)) follow(null);
  }, [elsewhere, follow, target, targetError]);
}

/** The follow re-renders whenever the open file's row fetches, as it does on
 * any navigation once the row is 5 s stale (the route's loader prefetches
 * it), a citation click included. Beside the page it re-renders alone, not
 * the whole workspace in the middle of the citation's scroll. */
function FollowOpenFile() {
  const params = useParams({ strict: false });
  const workspaceId = (params as { workspaceId: string }).workspaceId;
  const search = useSearch({ strict: false }) as WorkspaceOpenSearch;
  useFollowOpenFile(workspaceId, search.file ?? null);
  return null;
}

export default function WorkspaceOpenPage() {
  return (
    <>
      <WorkspaceOpen />
      {/* After the page, so the follow's normal open (Q462) runs after the
          file view's effects and its URL wins. */}
      <FollowOpenFile />
    </>
  );
}

function WorkspaceOpen() {
  const params = useParams({ strict: false });
  const workspaceId = (params as { workspaceId: string }).workspaceId;
  const navigate = useNavigate();
  const router = useRouter();
  const search = useSearch({ strict: false }) as WorkspaceOpenSearch;

  // Other failures without data go to the error boundary.
  const {
    data: ws,
    fetchStatus: wsFetchStatus,
    isLoading: wsLoading,
  } = useWorkspace(workspaceId, {
    errorBoundary: 'unlessMissing',
  });
  // Each open is a visit: recent workspaces sort by it, and a link or public
  // workspace a visitor opened lists with their own.
  const visit = useVisitWorkspace();
  const loaded = !!ws;
  const visitor = !ws?.role;
  useEffect(() => {
    if (loaded) visit({ id: workspaceId, visitor });
  }, [loaded, visit, visitor, workspaceId]);
  // The chat's Markdown once the page is idle, so saved chats read formatted
  // offline too (Q681).
  useEffect(() => {
    if (loaded) return preloadProseWhenIdle();
  }, [loaded]);
  const { data: topics } = useTopics(workspaceId);
  const { data: files } = useFiles(workspaceId);
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  const readOnly = isWorkspaceReadOnly(ws?.capabilities);
  const canClone = !!ws?.canClone;
  const { mutateAsync: addTopic } = useAddTopic(workspaceId);
  const { mutateAsync: updateTopic } = useUpdateTopic(workspaceId);
  const [cloneOpen, setCloneOpen] = useState(false);

  // Breakpoints: one column below 1260px, with the rail from 768px so iPads keep it
  // (Epo 2026-11-06); from 1260px the Files and Chat pages have their side
  // panel beside the rail.
  const lg = useMediaQuery('(min-width: 1260px)');
  const railShown = useMediaQuery('(min-width: 768px)');
  const oneColumnLayout = !lg;
  const searchedOpenItem = openItemFromSearch(search);
  // The page a child route draws in the centre (Assignments, Members, Study's
  // tabs); an open file or material is the Files page instead.
  const routePage = useChildMatches({
    select: (matches): StudyPage | null => {
      const match = matches[0];
      if (match?.routeId === '/auth-shell/workspaces/$workspaceId/study/$tab')
        return studyTabPage(match.params.tab);
      if (match?.routeId === '/auth-shell/workspaces/$workspaceId/assignments')
        return 'assignments';
      if (match?.routeId === '/auth-shell/workspaces/$workspaceId/members')
        return 'members';
      return null;
    },
  });
  const studyPage = searchedOpenItem ? null : routePage;
  // Make a quiz's dialog: opened from a page (Add practice) it keeps that page
  // behind it; from a link it opens over the Dashboard, on its pages or run
  // (Epo 2026-11-05).
  const quizDialogKey = useQuizDialogKey((state) => state.key);
  const making = !readOnly && !searchedOpenItem && !!search.make;
  // The workspace's own URL: the Dashboard, the Files and Chat pages, an open
  // item, the canvas.
  const home = {
    params: { workspaceId },
    to: '/workspaces/$workspaceId',
  } as const;
  const openKey = searchedOpenItem
    ? `${searchedOpenItem.kind}:${searchedOpenItem.id}`
    : null;
  const view = search.view;
  // A chat is open (Epo 2026-11-14): with nothing open the Chat page, else
  // over the Files page its window (from lg) or sheet, `files-chat` when no
  // file is open. Wider than a phone the chat list is the Chat page too.
  const chatOver = view === 'chat' || view === 'files-chat';
  const chatOpen = chatOver || (lg && view === 'chats');
  // The page the URL shows. Files and Chat are pages, each with its side
  // panel from lg; the other sections have none.
  const page: WorkspaceSection =
    view === 'canvas' && !openKey && !studyPage
      ? 'canvas'
      : studyPage
        ? PAGE_SECTION[studyPage]
        : openKey || view === 'files' || view === 'files-chat'
          ? 'files'
          : view === 'chat' || view === 'chats'
            ? 'agent'
            : 'dashboard';
  // Pressing the shown Files or Agent again folds its side panel away.
  const [sideOpen, setSideOpen] = useState(true);
  const [seenWorkspace, setSeenWorkspace] = useState(workspaceId);
  if (workspaceId !== seenWorkspace) {
    setSeenWorkspace(workspaceId);
    setSideOpen(true);
  }
  const leftOpen = (page === 'files' || page === 'agent') && sideOpen;
  const leftShown = lg && leftOpen;
  const panelGroupRef = useGroupRef();
  const [panelGroup, setPanelGroup] = useState<HTMLDivElement | null>(null);
  usePanelLayout({
    // One column has no side panel to place.
    group: lg ? panelGroup : null,
    groupRef: panelGroupRef,
    open: leftShown,
  });
  const [archivedOpen, setArchivedOpen] = useState(false);
  // The chat list drives the chat, which reports back the thread it shows.
  const [chatRequest, setChatRequest] = useState<ChatRequest>();
  const [activeChat, setActiveChat] = useState<string | null>(null);
  /** The chat opens that thread, or with a null id a new chat. */
  function requestChat(id: string | null, prompt?: string) {
    setChatRequest((previous) => ({
      id,
      prompt,
      seq: (previous?.seq ?? 0) + 1,
    }));
  }
  /** Whether this page's own press opened the chat, so closing it steps back
   * (the back gesture's step) rather than adding one. */
  const chatPagePushed = useRef(false);
  useEffect(() => {
    if (!chatOver) chatPagePushed.current = false;
  }, [view]);
  /** Every way into a chat: the Chat page, showing that chat. */
  function openChat(id: string | null, prompt?: string) {
    requestChat(id, prompt);
    const latest = router.latestLocation.search as WorkspaceOpenSearch;
    if (latest.view === 'chat' && !openItemFromSearch(latest)) return;
    chatPagePushed.current = true;
    navigate({ ...home, search: { view: 'chat' } });
  }

  const [citationTarget, setCitationTarget] = useState<{
    fileId: string;
    regions: Region[];
    citation?: NoteCitationTarget;
  } | null>(null);
  // The chat dock sits 8px above the Office frame's bottom chrome, which the
  // runtime reports; written to the box's style so the workspace does not
  // re-render while a resize moves it.
  const viewerBox = useRef<HTMLDivElement>(null);
  const setOfficeInset = useCallback((inset: number) => {
    viewerBox.current?.style.setProperty('--office-inset', `${inset}px`);
  }, []);
  const openItem =
    searchedOpenItem && citationTarget?.fileId === searchedOpenItem.id
      ? {
          ...searchedOpenItem,
          citation: citationTarget.citation,
          regions: citationTarget.regions,
        }
      : searchedOpenItem;

  // From lg a chat stays open over what it opens (citations, files it made).
  const keepChat = lg && chatOver ? { view: 'chat' as const } : {};
  function setOpenItem(item: OpenItem | null) {
    setCitationTarget(null);
    navigate({ ...home, replace: true, search: searchFromOpenItem(item) });
  }

  /** The chat over the viewer: `view=chat` in the URL. Opening adds a history
   * entry for the back gesture to leave, and the chat's back arrow takes that
   * same step; closed without one, a phone's Chat page shows its list. */
  function setChatPageOpen(open: boolean) {
    const latest = router.latestLocation.search as WorkspaceOpenSearch;
    const over = latest.view === 'chat' || latest.view === 'files-chat';
    if (open === over) return;
    const item = openItemFromSearch(latest);
    if (open) {
      chatPagePushed.current = true;
      navigate({
        search: (previous) => ({
          ...previous,
          // Over the Files page with nothing open the page stays Files.
          view:
            item || latest.view !== 'files'
              ? ('chat' as const)
              : ('files-chat' as const),
        }),
        to: '.',
      });
    } else if (chatPagePushed.current) {
      chatPagePushed.current = false;
      router.history.back();
    } else {
      navigate({
        replace: true,
        search: (previous) => ({
          ...previous,
          view: item
            ? undefined
            : latest.view === 'files-chat'
              ? ('files' as const)
              : ('chats' as const),
        }),
        to: '.',
      });
    }
  }

  /** Workspace settings at `tab`, kept in the URL so a link can open it.
   * Opening, switching tabs and closing replace the entry, so the dialog
   * adds no history. */
  function setSettingsTab(tab: SettingsView | undefined) {
    // The live URL, not this render's: a dialog closing because the app is
    // leaving (Back, Clone, Delete) finds no settings there and stays put.
    const latest = router.latestLocation.search as WorkspaceOpenSearch;
    if (tab === latest.settings) return;
    navigate({
      replace: true,
      search: (previous) => ({
        ...previous,
        settings: tab,
        settingsQuery: tab ? previous.settingsQuery : undefined,
      }),
      to: '.',
    });
  }

  /** Its search once settled, in the URL beside the tab; a search settling
   * after the dialog closed stays out. */
  function setSettingsQuery(query: string) {
    const latest = router.latestLocation.search as WorkspaceOpenSearch;
    if (!latest.settings || query === (latest.settingsQuery ?? '')) return;
    navigate({
      replace: true,
      search: (previous) => ({
        ...previous,
        settingsQuery: query || undefined,
      }),
      to: '.',
    });
  }

  /** To do, Practice, Members or Study takes the centre pane; Back returns here. */
  function openStudy(page: StudyPage) {
    setCitationTarget(null);
    if (page === 'assignments') navigate(assignmentsLink(workspaceId));
    else if (page === 'members') navigate(membersLink(workspaceId));
    else navigate(studyLink(workspaceId, page));
  }

  /** The landing: the workspace's Dashboard. */
  function openDashboard() {
    setCitationTarget(null);
    navigate({ ...home, search: {} });
  }

  /** A rail section opens its page; pressing the shown Files or Agent again
   * folds its side panel away or back. */
  function selectSection(next: WorkspaceSection) {
    if (lg && next === page && (next === 'files' || next === 'agent')) {
      setSideOpen(!sideOpen);
      return;
    }
    setSideOpen(true);
    setCitationTarget(null);
    if (next in SECTION_PAGE)
      openStudy(SECTION_PAGE[next as keyof typeof SECTION_PAGE]);
    else if (next === 'dashboard') openDashboard();
    else
      navigate({
        ...home,
        search: {
          view:
            next === 'canvas'
              ? 'canvas'
              : next === 'files'
                ? 'files'
                : lg
                  ? 'chat'
                  : 'chats',
        },
      });
  }

  function openCitation(citation: Citation) {
    if (citation.materialId) {
      // A note has no boxes: its View finds the cited blocks, else the
      // quoted text (Q593, Q594). A new object per click, so a repeat
      // flashes again.
      setCitationTarget({
        citation: {
          blockIds: citation.blockIds ?? undefined,
          quote: citation.snippet,
        },
        fileId: citation.materialId,
        regions: [],
      });
      navigate({
        ...home,
        replace: true,
        resetScroll: false,
        search: { material: citation.materialId, ...keepChat },
      });
      return;
    }
    // A copy per click: PdfView scrolls and flashes once per regions array.
    const regions = [...(citation.regions ?? [])];
    const regionPage = regions.find((region) => region.page > 0)?.page;
    setCitationTarget({
      citation: citation.snippet
        ? { page: citation.pageStart ?? regionPage, quote: citation.snippet }
        : undefined,
      fileId: citation.fileId,
      regions,
    });
    const search = {
      ...searchFromOpenItem({
        id: citation.fileId,
        kind: 'file',
        page: regionPage ?? citation.pageStart ?? undefined,
      }),
      mode: 'view' as const,
      ...keepChat,
    };
    // A repeated citation leaves the URL as it is, so it doesn't navigate:
    // the route's loader would refetch the open file and re-render the
    // workspace as the scroll starts (Q493).
    if (
      router.buildLocation({ ...home, search }).href ===
      router.latestLocation.href
    )
      return;
    // The router's scroll reset would abort the viewer's smooth scroll to
    // the cited box.
    navigate({ ...home, replace: true, resetScroll: false, search });
  }

  const [topicForm, setTopicForm] = useState<
    { mode: 'add' } | { mode: 'rename'; id: string; name: string } | null
  >(null);
  const [resumeProvider] = useState(() => resumedConnect(workspaceId));
  const [addSource, setAddSource] = useState<AddSourceMode | null>(
    resumeProvider ? 'import' : null
  );
  // Get started links act once the workspace has loaded, then leave the URL.
  const { add, chat } = search;
  // Once per link: the panel setters change every render and the URL only
  // drops the params after the navigation lands.
  const linkTaken = useRef(false);
  useEffect(() => {
    if (!(add || chat)) {
      linkTaken.current = false;
      return;
    }
    if (!loaded || linkTaken.current) return;
    linkTaken.current = true;
    if (add && !readOnly) setAddSource(add);
    if (chat) openChat(null);
    navigate({
      replace: true,
      search: (previous) => ({ ...previous, add: undefined, chat: undefined }),
      to: '.',
    });
  }, [add, chat, loaded, navigate, readOnly]);
  // The tour (features/guide/Tour.tsx) opens Files and the chats through these
  // while this page is open; when it stops, the page goes back as it was.
  const tourPanels = useRef<TourPanels | null>(null);
  const beforeTour = useRef<string | null>(null);
  useEffect(() => {
    const show = (to: WorkspaceOpenSearch) => {
      beforeTour.current ??= router.latestLocation.href;
      setSideOpen(true);
      navigate({ ...home, replace: true, search: to });
    };
    tourPanels.current = {
      restore: () => {
        const before = beforeTour.current;
        if (!before) return;
        beforeTour.current = null;
        navigate({ href: before, replace: true });
      },
      showChats: () => show({ view: lg ? 'chat' : 'chats' }),
      showFiles: () => show({ view: 'files' }),
    };
  });
  useEffect(() => registerTourPanels(tourPanels), []);

  if (wsLoading) {
    return (
      <LoadingLarge
        backLabel={m.workspace_back_to()}
        backTo="/"
        title={m.workspace_loading()}
      />
    );
  }

  // Offline before the first load: the fetch resumes on reconnect.
  if (waitsForConnection(wsFetchStatus, ws))
    return (
      <Panel
        frost="center"
        sectionClassName="items-center justify-center h-full"
      >
        <QueryPausedState />
      </Panel>
    );

  if (!ws)
    return <WorkspaceError backLabel={m.workspace_back_to()} backTo="/" />;

  // Members and anyone who may clone have settings: phones open on the tab
  // list, wider screens on the first tab (General for owner and editor members).
  const openSettings = () => setSettingsTab('menu');
  // Below lg an open Office file keeps its bottom chrome (sheet tabs, slide
  // pager) clear: the chat dock stays a button above it.
  const openFile =
    openItem?.kind === 'file'
      ? files?.find((file) => file.id === openItem.id)
      : undefined;
  const officeOpen = !!openFile && !!officeFormatOf(openFile);
  // Added files start in the open item's topic, else Other files, and Files
  // highlights that row while the dialog is open (Epo 2026-11-03, board T4).
  const openTopicId =
    (openItem?.kind === 'file'
      ? openFile?.topicId
      : openItem?.kind === 'material'
        ? materials?.find((mt) => mt.id === openItem.id)?.topicId
        : null) ?? null;

  // One column has no side panels: the header's ⋮ carries the workspace
  // actions their title rows hold.
  const addItems: MenuItem[] = readOnly
    ? []
    : [
        {
          icon: 'plusCircle',
          label: m.action_add_file(),
          onClick: () => setAddSource('upload'),
        },
        {
          icon: 'topic',
          label: m.action_add_topic(),
          onClick: () => setTopicForm({ mode: 'add' }),
        },
      ];
  // Phones have no rail: their menu carries its pages.
  const settingsEntry: MenuItem[] = hasWorkspaceSettings(ws)
    ? [
        {
          icon: 'settings',
          label: m.workspace_settings(),
          onClick: openSettings,
        },
      ]
    : [];
  const settingsItems: MenuItem[] = [
    {
      icon: 'dashboard',
      label: m.workspace_section_dashboard(),
      onClick: openDashboard,
    },
    ...(ws
      ? workspaceSections(ws).flatMap((entry) =>
          entry.value in SECTION_PAGE
            ? [
                {
                  icon: entry.icon,
                  label: entry.label,
                  onClick: () =>
                    openStudy(
                      SECTION_PAGE[entry.value as keyof typeof SECTION_PAGE]
                    ),
                },
              ]
            : []
        )
      : []),
    ...settingsEntry,
  ];
  /** Where the workspace is shared and people are invited: Members. */
  function openInvite() {
    setCitationTarget(null);
    navigate(membersLink(workspaceId));
  }
  // The rail avatar's workspace part: Invite (sharing is managed by owners
  // and editors), Workspace settings, and Clone for readers who may.
  const accountItems: MenuItem[] = [
    ...(canManageWorkspaceSettings(ws)
      ? [
          {
            accent: true,
            icon: 'userAdd' as const,
            label: m.workspace_invite_member(),
            onClick: openInvite,
          },
        ]
      : []),
    ...settingsEntry,
    ...(readOnly && canClone
      ? [
          {
            icon: 'clone' as const,
            label: m.action_clone_workspace(),
            onClick: () => setCloneOpen(true),
          },
        ]
      : []),
  ];
  const oneColumn: OneColumnChrome | undefined = oneColumnLayout
    ? {
        addItems,
        settingsItems,
        workspaceIconId: ws.iconId,
        workspaceName: ws.name,
      }
    : undefined;

  const openChatResource = (ref: ResourceRef) =>
    setOpenItem(
      ref.kind === 'material'
        ? { id: ref.id, kind: 'material' }
        : { id: ref.id, kind: 'file' }
    );
  // Files' tree with its add menu: the Files page's side panel from lg, the
  // page itself below.
  const filesTree = (
    <FilesPanel
      onAddSource={readOnly ? undefined : setAddSource}
      onAddTopic={readOnly ? undefined : () => setTopicForm({ mode: 'add' })}
      onNavigate={() => setCitationTarget(null)}
      onOpenItem={setOpenItem}
      onRenameTopic={(ch) =>
        setTopicForm({ id: ch.id, mode: 'rename', name: ch.name })
      }
      openItem={openItem}
      readOnly={readOnly}
      renderTabRow={(actions) => (
        <SectionTitle
          actions={tabButtons(actions)}
          title={m.workspace_tab_files()}
        />
      )}
      searchable
      uploadTopic={addSource ? openTopicId : undefined}
      workspaceId={workspaceId}
    />
  );
  // The chats: the Chat page's side panel from lg, a phone's Chat page.
  const chatList = (
    <div className="flex h-full min-h-0 flex-col">
      <SectionTitle
        actions={
          <>
            <VoiceFooterButton
              onSend={(prompt) => openChat(null, prompt)}
              workspaceId={workspaceId}
            />
            <ToolbarButton
              label={m.chat_archived_title()}
              onClick={() => setArchivedOpen(true)}
            >
              <Icon name="archive" />
            </ToolbarButton>
          </>
        }
        title={m.chat_chats()}
      />
      <ConversationList
        activeId={activeChat}
        onNew={() => openChat(null)}
        onOpen={openChat}
        onRemoved={(id) => id === activeChat && requestChat(null)}
        workspaceId={workspaceId}
      />
    </div>
  );
  // These pages fill the centre without a file header from lg (boards P1,
  // P2); one column keeps its header for the Files dropdown and ⋮. A link to
  // a page this person doesn't have goes to Practice.
  const studyContent =
    studyPage &&
    (studyView(ws).pages.includes(studyPage) ? (
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    ) : (
      <Navigate {...studyLink(workspaceId, 'practice')} replace />
    ));
  const makeChoice = { answers: search.answers, paper: search.paper };
  /** Make a quiz from a file's dialog, which Add practice wraps in its tabs:
   * every step is an address under `make`. */
  const makeQuizProps = (
    step: NonNullable<typeof search.make>
  ): ComponentProps<typeof MakeQuizDialog> => ({
    file: search.quizFile,
    initial: {
      answers: splitIds(search.answers),
      paper: splitIds(search.paper),
    },
    // Back to the page behind it, the Dashboard when none. A move to another
    // path (Add practice opening its new quiz, Back off Practice) already
    // closed it: the dialog reports that close too, and navigating again
    // would drop where the move went.
    onClose: () => {
      if (!('make' in router.latestLocation.search)) return;
      void navigate({ search: {}, to: '.' });
    },
    onConfirmed: (run, choice) => {
      addQuizRun({ ...choice, id: run.id, workspaceId });
      openDashboard();
    },
    onDone: (quizId) =>
      void navigate({ ...home, replace: true, search: { material: quizId } }),
    onFile: (file) =>
      void navigate({
        // A phone's Back returns to the list; wider, the list stays beside it.
        replace: !window.matchMedia('(max-width: 639.98px)').matches,
        search: { ...makeChoice, make: 'pages', quizFile: file },
        to: '.',
      }),
    onRunBack: () =>
      void navigate({
        replace: true,
        search: { ...makeChoice, make: 'pages' },
        to: '.',
      }),
    onShowFiles: (choice) =>
      void navigate({
        search: {
          ...choiceSearch(choice),
          make: 'files',
        },
        to: '.',
      }),
    onShowPages: (choice) =>
      void navigate({
        search: {
          ...choiceSearch(choice),
          make: 'pages',
        },
        to: '.',
      }),
    onStarted: (run, choice) =>
      void navigate({
        search: {
          ...choiceSearch(choice),
          make: 'run',
          run,
        },
        to: '.',
      }),
    runId: search.run,
    step,
    workspaceId,
    workspaceName: ws.name,
  });
  // The landing is the workspace's Dashboard (boards H1, H2). The Files page
  // with nothing open shows the recent files from lg, its tree below; a
  // phone's Chat page is its list (the chat covers the centre from lg).
  const pageContent =
    studyContent ||
    (page === 'dashboard' && (
      <WorkspaceDashboard
        onMakeQuiz={() => void navigate({ search: { make: 'files' }, to: '.' })}
        onUpload={() => setAddSource('upload')}
        workspace={ws}
      />
    )) ||
    (page === 'files' &&
      !openItem &&
      (lg ? (
        <FilesHome
          onUpload={() => setAddSource('upload')}
          workspaceId={workspaceId}
        />
      ) : (
        filesTree
      ))) ||
    (page === 'agent' && (lg ? <div /> : chatList));
  // The page's one h1: the Dashboard, Study's pages, a quiz and a flashcards set
  // head themselves with theirs.
  const openMaterialType =
    openItem?.kind === 'material'
      ? materials?.find((mt) => mt.id === openItem.id)?.type
      : undefined;
  const headsItself =
    !!studyContent ||
    page === 'dashboard' ||
    openMaterialType === 'quiz' ||
    openMaterialType === 'flashcards';
  const viewer = (
    <Panel className="w-full" frost="center" sectionClassName="h-full gap-0">
      {!headsItself && <h1 className="sr-only">{ws.name}</h1>}
      <WorkspaceHealth workspace={ws} />
      <AppErrorBoundary resetKeys={[openItem?.kind, openItem?.id]}>
        {page === 'canvas' ? (
          <div className="relative h-full" data-workspace-canvas>
            <Suspense fallback={null}>
              <WorkspaceCanvas
                besideBack={!railShown}
                onOpenMaterial={(id) => setOpenItem({ id, kind: 'material' })}
                openMaterialId={
                  openItem?.kind === 'material' ? openItem.id : null
                }
                workspaceId={workspaceId}
                workspaceName={ws.name}
              />
            </Suspense>
            {/* Phones have no rail to leave by. Back floats on the board's top left,
                level with its ☰ menu and in its colours (AFFiNE's, set on <html> by
                the board), so the board and its gestures reach the top; an open card
                has its own corners. */}
            {!railShown && (
              <ToolbarButton
                className="absolute top-2 left-2 z-10 size-8 rounded-(--radius-toolbar) border border-(--affine-border-color) bg-(--affine-background-overlay-panel-color) text-(--affine-icon-color) hover:bg-[linear-gradient(var(--affine-hover-color),var(--affine-hover-color))] hover:text-(--affine-icon-color) [[data-workspace-canvas]:has(.capy-board[data-editor-open])_&]:hidden"
                label={m.workspace_section_dashboard()}
                onClick={openDashboard}
              >
                <Icon name="navigationBack" />
              </ToolbarButton>
            )}
          </div>
        ) : (lg || (railShown && page !== 'files')) && pageContent ? (
          // Beside the rail a page has no header but the Files page's, which
          // holds Add file and Add topic; the rail has the rest (Epo
          // 2026-11-17). Phones keep theirs for its ⋮ and Back.
          pageContent
        ) : (
          <CenterContent
            color="purple"
            item={openItem}
            // From 768px the rail carries Home and Files. A phone's file leads
            // back to the tree; its list pages leave the workspace.
            leading={
              railShown ? null : openItem ? (
                // The arrow alone (Epo 2026-11-16), named for screen readers.
                <ToolbarButton
                  label={m.workspace_tab_files()}
                  onClick={() =>
                    void navigate({ ...home, search: { view: 'files' } })
                  }
                >
                  <Icon name="navigationBack" />
                </ToolbarButton>
              ) : (
                <ToolbarButton
                  label={m.workspace_back_to()}
                  onClick={() => navigate({ to: '/' })}
                >
                  <Icon name="navigationBack" />
                </ToolbarButton>
              )
            }
            onDeleted={() => setOpenItem(null)}
            oneColumn={oneColumn}
            onModeChange={(mode) => {
              void navigate({
                // The viewer has already completed its save/export checks.
                ignoreBlocker: true,
                replace: true,
                search: (previous) => ({ ...previous, mode }),
                to: '.',
              });
            }}
            page={pageContent || undefined}
            readOnly={readOnly}
            requestedMode={search.mode ?? null}
            topics={topics ?? []}
            workspaceId={workspaceId}
          />
        )}
      </AppErrorBoundary>
    </Panel>
  );

  // The side panel beside the rail from lg (boards T3, P1, P2): the Files
  // page's tree or the Chat page's chats. The other pages have none.
  const sectionPanel = (
    <Panel className="w-full" frost="left" sectionClassName="h-full gap-0">
      <div className="flex h-full min-h-0 flex-col" data-workspace-left-panel>
        {leftOpen && (page === 'files' ? filesTree : chatList)}
      </div>
    </Panel>
  );
  // The viewer keeps one parent chain at every width: moving an Office iframe
  // to another parent reloads its runtime and refetches the document.
  // The gaps between panels are padding inside them and the separators stay
  // mounted (disabled while their panel is closed): panels size as shares of
  // their summed width, so a gap or separator that came and went with a
  // panel shifted the other one, and a new separator re-registered the group,
  // which could restore a layout with the reopened panel at zero.
  // overflow-visible WITH important is so that shadow doesnt get clipped
  return (
    <>
      <div className="flex h-full min-h-0 gap-2">
        {railShown && (
          <WorkspaceRail
            accountItems={accountItems}
            active={page}
            onSelect={selectSection}
            onSettings={hasWorkspaceSettings(ws) ? openSettings : undefined}
            workspace={ws}
          />
        )}
        <ResizablePanelGroup
          className={cn(
            'group/panels overflow-visible! flex min-h-0 min-w-0 flex-1',
            // Collapsed, the left panel leaves no gap or handle behind.
            'data-left-collapsed:[&>#left]:hidden!',
            !leftOpen && '[&>#left]:hidden!'
          )}
          elementRef={setPanelGroup}
          groupRef={panelGroupRef}
          // A drag can collapse the panel before the pointer lets go. Marked on
          // the group without a render, its gap and handle go in the same
          // frame; it closes only on release, so dragging back reopens it.
          onLayoutChange={(layout) => {
            panelGroup?.toggleAttribute('data-left-collapsed', !layout.left);
          }}
          onLayoutChanged={(layout, { isUserInteraction }) => {
            if (isUserInteraction && leftOpen && layout.left === 0)
              setSideOpen(false);
          }}
          orientation="horizontal"
        >
          {lg && (
            <>
              <ResizablePanel
                className="overflow-visible! pr-1"
                collapsible
                // Constant: a changing defaultSize re-registers the group.
                defaultSize="0%"
                id="left"
                maxSize={LEFT_MAX}
                minSize={`${LEFT_MIN}px`}
              >
                {sectionPanel}
              </ResizablePanel>
              <ResizableHandle
                className="group-data-left-collapsed/panels:[&>div]:hidden"
                disabled={!leftOpen}
                withHandle={leftOpen}
              />
            </>
          )}
          <ResizablePanel
            className={cn(
              'overflow-visible!',
              leftShown && 'pl-1 group-data-left-collapsed/panels:pl-0'
            )}
            id="viewer"
            minSize={oneColumnLayout ? undefined : `${VIEWER_MIN}px`}
          >
            <div
              className="relative h-full"
              data-viewer=""
              ref={viewerBox}
              style={{ '--office-inset': '0px' } as React.CSSProperties}
            >
              <FloatingBarContext.Provider
                value={oneColumnLayout && !officeOpen}
              >
                <OfficeInsetContext.Provider value={setOfficeInset}>
                  {viewer}
                </OfficeInsetContext.Provider>
              </FloatingBarContext.Provider>
              {/* The workspace's one chat at every width (Epo 2026-11-14): the
                  button on the Files page, which opens it as a window over the
                  file from lg (a sheet below), and the Chat page. Hidden, it
                  keeps its thread, draft and stream. */}
              <AppErrorBoundary resetKeys={[workspaceId]}>
                <ChatPanel
                  canReprocess={ws.isOwner}
                  color="purple"
                  dock={{
                    backLabel:
                      !lg && page === 'agent' ? m.chat_chats() : undefined,
                    layout: lg
                      ? page === 'agent'
                        ? 'page'
                        : 'window'
                      : 'overlay',
                    // The chat page's ⋮: back leads to the rest (Epo 2026-11-05).
                    menuItems: settingsEntry,
                    off: page !== 'files',
                    office: officeOpen,
                    onExpand: () =>
                      void navigate({ ...home, search: { view: 'chat' } }),
                    onPageOpen: setChatPageOpen,
                    pageOpen: chatOpen,
                  }}
                  // The dialog and the canvas take the screen; hidden, the chat
                  // keeps its draft and stream.
                  hidden={making || page === 'canvas'}
                  onActiveChange={setActiveChat}
                  onOpenCitation={openCitation}
                  onOpenResource={openChatResource}
                  openResource={openItem}
                  request={chatRequest}
                  workspaceId={workspaceId}
                />
              </AppErrorBoundary>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <ArchivedChatsDialog
        onClose={() => setArchivedOpen(false)}
        open={archivedOpen}
        workspaceId={workspaceId}
      />
      <WorkspaceSettingsDialog
        onClose={() => setSettingsTab(undefined)}
        onQueryChange={setSettingsQuery}
        onTabChange={setSettingsTab}
        open={!!search.settings}
        query={search.settingsQuery}
        tab={search.settings}
        workspace={ws}
      />
      <SharingNotice workspace={ws} />
      {canClone && (
        <CloneWorkspaceDialog
          open={cloneOpen}
          setOpen={setCloneOpen}
          workspace={ws}
        />
      )}
      {topicForm && (
        <NameFormDialog
          defaultName={topicForm.mode === 'rename' ? topicForm.name : ''}
          key={
            topicForm.mode === 'rename' ? `rename-${topicForm.id}` : 'add-topic'
          }
          maxLength={addTopicBodyNameMax}
          onClose={() => setTopicForm(null)}
          onSubmit={async (name) => {
            if (topicForm.mode === 'rename') {
              await updateTopic({ id: topicForm.id, name });
            } else {
              await addTopic(name);
            }
          }}
          open
          submitLabel={
            topicForm.mode === 'add' ? m.action_create() : m.action_save()
          }
          title={topicForm.mode === 'add' ? m.topic_new() : m.topic_rename()}
        />
      )}
      {making && search.make && (
        <Suspense fallback={null}>
          {/* Add quiz from Study's Add practice and the Dashboard's Make a quiz
              (Epo 2026-11-14). */}
          <AddPracticeDialog
            key={quizDialogKey}
            make={makeQuizProps(search.make)}
            onOpenQuiz={(quizId) =>
              void navigate({ ...home, search: { material: quizId } })
            }
          />
        </Suspense>
      )}
      {addSource && (
        <AddSourceDialog
          defaultTopicId={openTopicId}
          initialMode={addSource}
          onClose={() => setAddSource(null)}
          onOpenItem={setOpenItem}
          open
          resumeProvider={resumeProvider}
          workspaceId={workspaceId}
        />
      )}
    </>
  );
}
