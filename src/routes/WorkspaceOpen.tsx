import { useQuery } from '@tanstack/react-query';
import {
  useNavigate,
  useParams,
  useRouter,
  useSearch,
} from '@tanstack/react-router';
import {
  lazy,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
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
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/Popover';
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
import type { MakeQuizChoice } from '@/features/makeQuiz/MakeQuizDialog';
import { CenterContent } from '@/features/materials/CenterContent';
import type { OneColumnChrome } from '@/features/materials/CenterContentHeader';
import {
  isWorkspacePanel,
  type NoteCitationTarget,
  type OpenItem,
  openItemFromSearch,
  searchFromOpenItem,
  type WorkspaceOpenSearch,
  type WorkspacePanel,
} from '@/features/materials/openItem';
import { SharingNotice } from '@/features/study/assignments/SharingNotice';
import { StudyPanel } from '@/features/study/practice/StudyPanel';
import { type StudyPage, studyView } from '@/features/study/practice/studyView';
import { VoiceFooterButton } from '@/features/voice/VoiceCard';
import {
  AddSourceDialog,
  type AddSourceMode,
  resumedConnect,
} from '@/features/workspace/AddSourceDialog';
import {
  canManageWorkspaceSettings,
  isWorkspaceReadOnly,
} from '@/features/workspace/access';
import { ChatPanel, type ChatRequest } from '@/features/workspace/ChatPanel';
import { CloneWorkspaceDialog } from '@/features/workspace/CloneWorkspaceDialog';
import { ArchivedChatsDialog } from '@/features/workspace/chat/ArchivedChatsDialog';
import { ConversationList } from '@/features/workspace/chat/ConversationList';
import { FilesPanel } from '@/features/workspace/FilesPanel';
import type { TabAction } from '@/features/workspace/PanelTabRow';
import type { SettingsView } from '@/features/workspace/settingsTabs';
import { WorkspaceDashboard } from '@/features/workspace/WorkspaceDashboard';
import { WorkspaceHealth } from '@/features/workspace/WorkspaceHealth';
import {
  SectionTitle,
  WorkspaceRail,
  type WorkspaceSection,
} from '@/features/workspace/WorkspaceRail';
import { WorkspaceSettingsDialog } from '@/features/workspace/WorkspaceSettingsDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import {
  isBoolean,
  PREF_KEYS,
  readPref,
  removePref,
  writePref,
} from '@/lib/localPrefs';
import { waitsForConnection } from '@/lib/online';
import { useMediaQuery } from '@/lib/useMediaQuery';

const SummaryPage = lazy(() =>
  import('@/features/study/practice/SummaryPage').then((mod) => ({
    default: mod.SummaryPage,
  }))
);
const MakeQuizDialog = lazy(() =>
  import('@/features/makeQuiz/MakeQuizDialog').then((mod) => ({
    default: mod.MakeQuizDialog,
  }))
);
const PagePicker = lazy(() =>
  import('@/features/makeQuiz/PagePicker').then((mod) => ({
    default: mod.PagePicker,
  }))
);
const ExtractionProgress = lazy(() =>
  import('@/features/makeQuiz/ExtractionProgress').then((mod) => ({
    default: mod.ExtractionProgress,
  }))
);
/** A search value's ids: the paper's or the answer files'. */
const splitIds = (ids: string | undefined) =>
  ids ? ids.split(',').filter(Boolean) : [];

const AssignmentsPage = lazy(() =>
  import('@/features/study/assignments/AssignmentsPage').then((mod) => ({
    default: mod.AssignmentsPage,
  }))
);
const PracticePage = lazy(() =>
  import('@/features/study/practice/PracticePage').then((mod) => ({
    default: mod.PracticePage,
  }))
);

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

type PanelCenter = {
  makePage: boolean;
  openKey: string | null;
  studyPage: boolean;
};

/** The rail's section after the centre moves: Agent stays, a Study page shows
 * Study, an open item or a Make a quiz page Files, and leaving Study for the
 * landing (Back) shows the Dashboard. */
function sectionForCenter(
  was: WorkspaceSection,
  { makePage, openKey, studyPage }: PanelCenter
): WorkspaceSection {
  if (was === 'agent') return was;
  if (studyPage) return 'study';
  if (makePage || openKey) return 'files';
  return was === 'study' ? 'dashboard' : was;
}

export default function WorkspaceOpenPage() {
  const params = useParams({ strict: false }) as { workspaceId: string };
  return (
    <>
      {/* Its panels are each workspace's own. */}
      <WorkspaceOpen key={params.workspaceId} />
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

  // Breakpoints: one column below 1260px; from there the rail with one panel
  // beside it, whichever section shows.
  const lg = useMediaQuery('(min-width: 1260px)');
  const oneColumnLayout = !lg;
  const searchedOpenItem = openItemFromSearch(search);
  const studyPage = !searchedOpenItem && !!search.study;
  // Make a quiz's pages (X1 and the run) keep the rail and take the panel's
  // place (Epo 2026-11-02).
  const makePage =
    !readOnly && !searchedOpenItem && !search.study && !!search.make;
  // Agent shows its chat rather than the history (Epo 2026-11-04, option A). A
  // chat on screen comes back on the next visit, with the thread the chat panel
  // keeps.
  const [chatShown, setChatShown] = useState(() =>
    readPref(PREF_KEYS.chatShown(workspaceId), false, isBoolean)
  );
  const openKey = searchedOpenItem
    ? `${searchedOpenItem.kind}:${searchedOpenItem.id}`
    : null;
  const center: PanelCenter = { makePage, openKey, studyPage };
  // The panel opens as the URL says, else as this workspace last had it. These
  // two states draw it; the effect below keeps the URL and the memory on them.
  const [firstPanel] = useState(() =>
    lg
      ? (search.panel ??
        readPref<WorkspacePanel | null>(
          PREF_KEYS.panel(workspaceId),
          null,
          (value): value is WorkspacePanel => isWorkspacePanel(value)
        ))
      : null
  );
  const [section, setSection] = useState<WorkspaceSection>(() => {
    const first =
      firstPanel && firstPanel !== 'none' ? firstPanel : 'dashboard';
    // Study's panel lists Study's pages: the sync below opens Practice.
    if (first === 'study' && !studyPage && !openKey && !makePage) return first;
    return sectionForCenter(first, center);
  });
  const [panelOpen, setPanelOpen] = useState(
    () => firstPanel !== 'none' || (!openKey && !studyPage)
  );
  // The centre moves on while Agent keeps its chat: a citation opens its file
  // beside the chat, and so does anything else opened there.
  const centerKey = `${openKey}|${studyPage}|${makePage}`;
  const [seenCenter, setSeenCenter] = useState(centerKey);
  if (centerKey !== seenCenter) {
    setSeenCenter(centerKey);
    setSection((was) => sectionForCenter(was, center));
  }
  const leftOpen = section !== 'dashboard' && panelOpen && !makePage;
  const leftShown = lg && leftOpen;
  const chatOnScreen = leftShown && section === 'agent' && chatShown;
  useEffect(() => {
    if (!lg) return;
    const key = PREF_KEYS.chatShown(workspaceId);
    if (chatOnScreen) writePref(key, true);
    else removePref(key);
  }, [chatOnScreen, lg, workspaceId]);
  // The tour's panels aren't the learner's to remember.
  const beforeTour = useRef<{
    chatShown: boolean;
    panelOpen: boolean;
    section: WorkspaceSection;
  } | null>(null);
  const panelNow: WorkspacePanel | null = lg
    ? section === 'dashboard' || !panelOpen
      ? 'none'
      : section
    : null;
  const panelPressed = useRef(false);
  const seenUrlPanel = useRef(search.panel);
  useEffect(() => {
    if (!panelNow) return;
    const urlPanel = search.panel;
    const moved = urlPanel && urlPanel !== seenUrlPanel.current;
    seenUrlPanel.current = urlPanel;
    // Back, forward or a link moved the URL: the panel follows.
    if (moved && urlPanel !== panelNow) {
      if (urlPanel !== 'none') {
        setSection(urlPanel);
        setPanelOpen(true);
      } else if (openKey || studyPage) setPanelOpen(false);
      else {
        setSection('dashboard');
        setPanelOpen(true);
      }
      return;
    }
    if (!beforeTour.current) writePref(PREF_KEYS.panel(workspaceId), panelNow);
    if (urlPanel === panelNow) return;
    // A press adds a step for back; anything else only labels the entry, such
    // as a navigation that left the panel out.
    const pressed = panelPressed.current && !!urlPanel;
    panelPressed.current = false;
    navigate({
      replace: !pressed,
      search: (previous) => ({ ...previous, panel: panelNow }),
      to: '.',
    });
  }, [navigate, openKey, panelNow, search.panel, studyPage, workspaceId]);
  const openPracticeFirst = useEffectEvent(() => {
    if (lg && section === 'study' && !studyPage && !openKey && !makePage)
      navigate({
        replace: true,
        search: (previous) => ({ ...previous, study: 'practice' as const }),
        to: '.',
      });
  });
  useEffect(() => openPracticeFirst(), []);
  const panelGroupRef = useGroupRef();
  const [panelGroup, setPanelGroup] = useState<HTMLDivElement | null>(null);
  usePanelLayout({
    // One column has no side panel to place.
    group: lg ? panelGroup : null,
    groupRef: panelGroupRef,
    open: leftShown,
  });
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Agent's list drives the chat, which reports back the thread it shows.
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
  /** Every way into a chat: Agent's panel, showing that chat. */
  function openChat(id: string | null, prompt?: string) {
    panelPressed.current = true;
    setSection('agent');
    setPanelOpen(true);
    setChatShown(true);
    requestChat(id, prompt);
  }

  // One column: Files drops from the top, under the header it was opened from.
  const [filesOpen, setFilesOpen] = useState(false);
  // The Files dropdown hangs from the header, which lives in CenterContent.
  const filesAnchor = useRef<HTMLElement | null>(null);
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

  function setOpenItem(item: OpenItem | null) {
    setCitationTarget(null);
    setFilesOpen(false);
    navigate({
      replace: true,
      search: searchFromOpenItem(item),
      to: '.',
    });
  }

  /** The chat page below the panels: `agent` in the URL. Opening adds a history
   * entry for the back gesture to leave, and the page's back arrow takes that
   * same step. */
  const chatPagePushed = useRef(false);
  function setChatPageOpen(open: boolean) {
    const latest = router.latestLocation.search as WorkspaceOpenSearch;
    if (open === (latest.panel === 'agent')) return;
    if (open) {
      chatPagePushed.current = true;
      navigate({
        search: (previous) => ({ ...previous, panel: 'agent' as const }),
        to: '.',
      });
    } else if (chatPagePushed.current) {
      chatPagePushed.current = false;
      router.history.back();
    } else {
      navigate({
        replace: true,
        search: (previous) => ({ ...previous, panel: undefined }),
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

  /** A Study page takes the centre pane; Back returns here. */
  function openStudy(page: StudyPage) {
    if (page === 'members') return;
    setCitationTarget(null);
    setFilesOpen(false);
    navigate({ search: { study: page }, to: '.' });
  }
  const openPractice = () => openStudy('practice');

  /** The landing: the workspace's Dashboard. */
  function openDashboard() {
    setCitationTarget(null);
    setFilesOpen(false);
    setSection((was) => (was === 'agent' ? was : 'dashboard'));
    navigate({ search: {}, to: '.' });
  }

  /** A rail section: the Dashboard has no panel and opens its page; Study
   * opens Practice, its only page so far. Pressing the shown section closes
   * or reopens its panel. */
  function selectSection(next: WorkspaceSection) {
    panelPressed.current = true;
    if (next === 'dashboard') {
      setSection('dashboard');
      if (searchedOpenItem || search.study || search.make) openDashboard();
      return;
    }
    // A Make a quiz page has no panel: picking a section leaves it for that
    // section's panel.
    if (makePage) {
      if (next === 'study') openPractice();
      else openDashboard();
      setSection(next);
      setPanelOpen(true);
      return;
    }
    if (next === section) {
      setPanelOpen(!panelOpen);
      return;
    }
    setSection(next);
    setPanelOpen(true);
    if (next === 'study' && !search.study) openPractice();
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
        replace: true,
        resetScroll: false,
        search: { material: citation.materialId },
        to: '.',
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
    };
    // A repeated citation leaves the URL as it is, so it doesn't navigate:
    // the route's loader would refetch the open file and re-render the
    // workspace as the scroll starts (Q493).
    if (
      router.buildLocation({ search, to: '.' }).href ===
      router.latestLocation.href
    )
      return;
    // The router's scroll reset would abort the viewer's smooth scroll to
    // the cited box.
    navigate({ replace: true, resetScroll: false, search, to: '.' });
  }

  const [topicForm, setTopicForm] = useState<
    { mode: 'add' } | { mode: 'rename'; id: string; name: string } | null
  >(null);
  const [resumeProvider] = useState(() => resumedConnect(workspaceId));
  const [makeQuiz, setMakeQuiz] = useState<MakeQuizChoice | null>(null);
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
    if (add && !readOnly) setAddSource('upload');
    if (chat) openChat(null);
    navigate({
      replace: true,
      search: (previous) => ({ ...previous, add: undefined, chat: undefined }),
      to: '.',
    });
  }, [add, chat, loaded, navigate, readOnly]);
  // The tour (features/guide/Tour.tsx) opens panels through these while this
  // page is open; when it stops, the panel goes back as it was before it, with
  // the section fitting what the tour left in the centre.
  const tourPanels = useRef<TourPanels | null>(null);
  useEffect(() => {
    const show = (next: WorkspaceSection) => {
      beforeTour.current ??= { chatShown, panelOpen, section };
      setSection(next);
      setPanelOpen(true);
    };
    tourPanels.current = {
      restore: () => {
        const before = beforeTour.current;
        if (!before) return;
        beforeTour.current = null;
        setChatShown(before.chatShown);
        setPanelOpen(before.panelOpen);
        setSection(
          before.section === 'dashboard'
            ? studyPage
              ? 'study'
              : openKey
                ? 'files'
                : 'dashboard'
            : before.section
        );
      },
      showChats: () => {
        show('agent');
        setChatShown(false);
      },
      showFiles: () => show('files'),
    };
  });
  useEffect(() => registerTourPanels(tourPanels), []);

  if (wsLoading) {
    return (
      <LoadingLarge
        backLabel={m.workspace_back_to()}
        backTo="/workspaces"
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
    return (
      <WorkspaceError backLabel={m.workspace_back_to()} backTo="/workspaces" />
    );

  // Everyone has settings: phones open on the tab list, wider screens on the
  // first tab (General for owner and editor members, else their own Study).
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

  // One column has no panels: the header title opens Files, and ⋮ carries
  // the workspace actions their tab rows held.
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
  // One column has no rail: its menus carry the Dashboard and Study.
  const settingsItem: MenuItem = {
    icon: 'settings',
    label: m.workspace_settings(),
    onClick: openSettings,
  };
  const settingsItems: MenuItem[] = [
    {
      icon: 'dashboard',
      label: m.workspace_section_dashboard(),
      onClick: openDashboard,
    },
    {
      icon: 'book',
      label: m.workspace_tab_study(),
      onClick: openPractice,
    },
    // Phones have no Study panel: the pages this person has sit beside Study.
    ...(studyView(ws).pages.includes('summary')
      ? [
          {
            icon: 'profile' as const,
            label: m.study_panel_summary(),
            onClick: () => openStudy('summary'),
          },
        ]
      : []),
    ...(studyView(ws).pages.includes('assignments')
      ? [
          {
            icon: 'clipboard' as const,
            label: m.study_panel_assignments(),
            onClick: () => openStudy('assignments'),
          },
        ]
      : []),
    settingsItem,
  ];
  function openFiles() {
    filesAnchor.current =
      viewerBox.current?.querySelector<HTMLElement>(
        '[data-testid=content-header],[data-slot=center-header]'
      ) ?? null;
    setFilesOpen(true);
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
            onClick: () => setSettingsTab('sharing'),
          },
        ]
      : []),
    {
      icon: 'settings',
      label: m.workspace_settings(),
      onClick: openSettings,
    },
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
        filesOpen,
        onOpenFiles: openFiles,
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
  // The Files dropdown's tree: the workspace as a plain row the size of a file
  // row (no switcher; Back leaves the workspace), Add file, Workspace settings
  // and Study pinned under it; Add topic stays in the header's ⋮.
  const filesDropdown = (
    <FilesPanel
      className="h-auto flex-1"
      footer={
        <div className="flex shrink-0 flex-col gap-1 border-divider border-t px-2.5 pt-1.5 pb-2">
          {[
            ...addItems.slice(0, 1),
            ...settingsItems,
            ...(readOnly && canClone
              ? [
                  {
                    icon: 'clone' as const,
                    label: m.action_clone_workspace(),
                    onClick: () => setCloneOpen(true),
                  },
                ]
              : []),
          ].map((action) => (
            <button
              className="flex h-7.5 items-center gap-1.75 rounded-button px-2 text-left hover:bg-surface-hover-bg"
              key={action.label}
              onClick={() => {
                setFilesOpen(false);
                action.onClick?.();
              }}
              type="button"
            >
              {action.icon && <Icon name={action.icon} size={15} />}
              <span className="translate-y-px">{action.label}</span>
            </button>
          ))}
        </div>
      }
      header={
        <div className="mt-1.5 flex items-center gap-1.5 px-2 py-1.5">
          <img
            alt=""
            className="size-3.75 shrink-0 rounded-[4px]"
            src={iconUrl(ws.iconId)}
          />
          <span className="min-w-0 translate-y-px truncate font-semibold">
            {ws.name}
          </span>
        </div>
      }
      onNavigate={() => {
        setCitationTarget(null);
        setFilesOpen(false);
      }}
      onOpenItem={setOpenItem}
      onRenameTopic={(ch) =>
        setTopicForm({ id: ch.id, mode: 'rename', name: ch.name })
      }
      openItem={openItem}
      readOnly={readOnly}
      renderTabRow={() => null}
      rowMenus={false}
      uploadTopic={addSource ? openTopicId : undefined}
      workspaceId={workspaceId}
    />
  );
  // Study's pages fill the centre without a file header from lg (boards P1,
  // P2); one column keeps its header for the Files dropdown and ⋮.
  // A link to a page this person doesn't have opens Practice.
  const studyShown: StudyPage =
    search.study === 'assignments' ||
    (search.study === 'summary' && studyView(ws).pages.includes('summary'))
      ? search.study
      : 'practice';
  const studyContent =
    studyPage &&
    (studyShown === 'summary' ? (
      <Suspense fallback={null}>
        <SummaryPage workspaceId={workspaceId} />
      </Suspense>
    ) : studyShown === 'assignments' ? (
      <Suspense fallback={null}>
        <AssignmentsPage
          search={{
            assignment: search.assignment,
            attempt: search.attempt,
            member: search.member,
            newFromQuiz: search.newFromQuiz,
            own: search.own,
            question: search.question,
            tab: search.tab,
          }}
          workspaceId={workspaceId}
        />
      </Suspense>
    ) : (
      <Suspense fallback={null}>
        <PracticePage
          search={{
            group: search.group,
            review: search.review,
            reviewMode: search.reviewMode,
            topicId: search.topicId,
          }}
          workspaceId={workspaceId}
        />
      </Suspense>
    ));
  const makeSearch = {
    answers: search.answers,
    paper: search.paper,
  };
  const makeQuizContent =
    makePage &&
    (search.make === 'pages' ? (
      <Suspense fallback={null}>
        <PagePicker
          answers={splitIds(search.answers)}
          onBack={() => {
            setMakeQuiz({
              answers: splitIds(search.answers),
              paper: splitIds(search.paper),
            });
            openDashboard();
          }}
          onCancel={openDashboard}
          onStarted={(run) =>
            void navigate({
              replace: true,
              search: { ...makeSearch, make: 'run', run },
              to: '.',
            })
          }
          paper={splitIds(search.paper)}
          workspaceId={workspaceId}
        />
      </Suspense>
    ) : (
      search.run && (
        <Suspense fallback={null}>
          <ExtractionProgress
            onBackToPages={
              search.paper
                ? () =>
                    void navigate({
                      replace: true,
                      search: { ...makeSearch, make: 'pages' },
                      to: '.',
                    })
                : undefined
            }
            onDone={(quizId) => {
              void navigate({
                replace: true,
                search: { material: quizId },
                to: '.',
              });
            }}
            onLeave={openDashboard}
            runId={search.run}
          />
        </Suspense>
      )
    ));
  // The landing is the workspace's Dashboard (boards H1, H2).
  const pageContent =
    studyContent ||
    makeQuizContent ||
    (!openItem && (
      <WorkspaceDashboard
        onMakeQuiz={() => setMakeQuiz({ answers: [], paper: [] })}
        onUpload={() => setAddSource('upload')}
        workspace={ws}
      />
    ));
  // The page's one h1: the Dashboard, Study's pages, a quiz and a flashcards set
  // head themselves with theirs.
  const openMaterialType =
    openItem?.kind === 'material'
      ? materials?.find((mt) => mt.id === openItem.id)?.type
      : undefined;
  const headsItself =
    !!pageContent ||
    openMaterialType === 'quiz' ||
    openMaterialType === 'flashcards';
  const viewer = (
    <Panel className="w-full" frost="center" sectionClassName="h-full gap-0">
      {!headsItself && <h1 className="sr-only">{ws.name}</h1>}
      <WorkspaceHealth workspace={ws} />
      <AppErrorBoundary resetKeys={[openItem?.kind, openItem?.id]}>
        {lg && pageContent ? (
          pageContent
        ) : (
          <CenterContent
            color="purple"
            item={openItem}
            // From lg the rail carries Home and the section panels.
            leading={
              oneColumnLayout ? (
                <ToolbarButton
                  label={m.workspace_back_to()}
                  onClick={() => navigate({ to: '/workspaces' })}
                >
                  <Icon name="navigationBack" />
                </ToolbarButton>
              ) : null
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

  // The one panel beside the rail (boards T3, P1, P2): Files' tree with its add
  // menu, Agent's chats or a chat, or Study's pages. The Dashboard has none. The
  // chat stays mounted through all of them, closed too, so it keeps its thread,
  // draft and stream.
  const sectionPanel = (
    <Panel className="w-full" frost="left" sectionClassName="h-full gap-0">
      <div className="flex h-full min-h-0 flex-col" data-workspace-left-panel>
        {leftOpen && section === 'files' && (
          <FilesPanel
            onAddSource={readOnly ? undefined : setAddSource}
            onAddTopic={
              readOnly ? undefined : () => setTopicForm({ mode: 'add' })
            }
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
        )}
        {leftOpen && section === 'agent' && !chatShown && (
          <>
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
              title={m.workspace_section_agent()}
            />
            <ConversationList
              activeId={activeChat}
              onNew={() => openChat(null)}
              onOpen={openChat}
              onRemoved={(id) => id === activeChat && requestChat(null)}
              workspaceId={workspaceId}
            />
          </>
        )}
        {leftOpen && section === 'study' && (
          <StudyPanel
            active={studyPage ? studyShown : null}
            onOpen={openStudy}
            workspace={ws}
          />
        )}
        <div className="min-h-0 flex-1" hidden={!chatOnScreen}>
          <AppErrorBoundary resetKeys={[workspaceId]}>
            <ChatPanel
              canReprocess={ws.isOwner}
              color="purple"
              hidden={!chatOnScreen}
              onActiveChange={setActiveChat}
              onOpenCitation={openCitation}
              onOpenResource={openChatResource}
              openResource={openItem}
              renderTabRow={(actions, title) => (
                <SectionTitle
                  actions={tabButtons(actions)}
                  onBack={() => setChatShown(false)}
                  title={title}
                />
              )}
              request={chatRequest}
              workspaceId={workspaceId}
            />
          </AppErrorBoundary>
        </div>
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
        {lg && (
          <WorkspaceRail
            accountItems={accountItems}
            active={section}
            onSelect={selectSection}
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
              setPanelOpen(false);
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
              {oneColumnLayout && (
                <AppErrorBoundary resetKeys={[workspaceId]}>
                  <ChatPanel
                    canReprocess={ws.isOwner}
                    color="purple"
                    dock={{
                      // The chat page's ⋮: back leads to the rest (Epo 2026-11-05).
                      menuItems: [settingsItem],
                      office: officeOpen,
                      onPageOpen: setChatPageOpen,
                      pageOpen: search.panel === 'agent',
                    }}
                    // The page picker's footer takes the dock's corner on
                    // phones; hidden, the chat keeps its draft and stream.
                    hidden={makePage}
                    onOpenCitation={openCitation}
                    onOpenResource={openChatResource}
                    openResource={openItem}
                    workspaceId={workspaceId}
                  />
                </AppErrorBoundary>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
        {oneColumnLayout && (
          <Popover modal onOpenChange={setFilesOpen} open={filesOpen}>
            <PopoverAnchor
              virtualRef={{
                current: {
                  getBoundingClientRect: () =>
                    filesAnchor.current?.getBoundingClientRect() ??
                    new DOMRect(),
                },
              }}
            />
            {/* A plain dropdown under the header, its workspace row in line
                with the header title; full width on phones, a 400px column from sm. */}
            <PopoverContent
              align="start"
              alignOffset={16}
              aria-label={m.workspace_tab_files()}
              className="max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0 sm:w-100"
              collisionPadding={8}
              sideOffset={4}
            >
              {filesDropdown}
            </PopoverContent>
          </Popover>
        )}
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
      {makeQuiz && (
        <Suspense fallback={null}>
          <MakeQuizDialog
            initial={makeQuiz}
            onClose={() => setMakeQuiz(null)}
            onContinue={(choice) => {
              setMakeQuiz(null);
              void navigate({
                search: {
                  answers: choice.answers.join(',') || undefined,
                  make: 'pages',
                  paper: choice.paper.join(','),
                },
                to: '.',
              });
            }}
            workspaceId={workspaceId}
            workspaceName={ws.name}
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
