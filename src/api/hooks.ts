import type { QueryClient, QueryKey } from '@tanstack/react-query';
import {
  focusManager,
  type InfiniteData,
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import {
  durationBucket,
  failureReason,
  ingestFailReason,
  ingestStageCode,
  ingestTracker,
  sizeBucket,
  track,
  trackItemCloned,
} from '@/lib/analytics';
import { NOTIFICATION_PAGE_SIZE } from '@/lib/const';
import { dropOpen, type OpenKey, takeOpen } from '@/lib/sentOpens';
import {
  forgetUndoPayload,
  keepUndoPayloads,
  sawRoom,
} from '@/lib/undoPayloads';
import { emitSyncedCustomization } from '@/theme/customizationEvents';
import { USE_MSW } from './auth';
import { api, isApiError, qk } from './client';
import {
  type IngestEvent,
  type NotificationStreamEvent,
  readEventStream,
  type StreamEvent,
} from './eventStream';
import { persisted } from './queryPersistence';
import type {
  AccountStatus,
  Attempt,
  AttemptDetail,
  AttemptParams,
  AutoReloadReq,
  AutoReloadResp,
  BillingCheckoutReq,
  BillingInfo,
  CalendarEvent,
  Chapter,
  ChatPrefs,
  CheckQuizQuestionReq,
  CloneFileReq,
  CloneMaterialReq,
  CloneWorkspaceResult,
  ContentOrderItem,
  Conversation,
  CreateBlankFileReq,
  CreateCommentReq,
  CreateDiscussionReq,
  CreateEmbeddedMaterialReq,
  CreateEventReq,
  CreateFlashcardSetReq,
  CreateMaterialReq,
  CreateQuizReq,
  CreateWorkspaceInviteReq,
  CreateWorkspaceReq,
  Customization,
  DeletionPreflight,
  EditableQuiz,
  EditorAssetAccess,
  EditorAssetPage,
  FileLinks,
  FileListParams,
  FilePage,
  Flashcard,
  FlashcardSet,
  GenerateOptions,
  IngestSlots,
  InspectSourceImportsReq,
  InspectSourceImportsResponse,
  IntegrationsStatus,
  InvoiceList,
  ItemAttempts,
  Label,
  LearningProgress,
  Material,
  MaterialCollaborationToken,
  MaterialComment,
  MaterialDiscussion,
  MaterialListItem,
  MaterialListParams,
  MaterialPage,
  MaterialRef,
  MaterialUpdateResult,
  ModelSlot,
  ModelsResponse,
  MoveFilesReq,
  NotificationCount,
  NotificationPage,
  NotificationPrefs,
  OperationReceipt,
  PastReview,
  PastReviewParams,
  PendingWorkspaceInvite,
  PlanStepInput,
  Privacy,
  PublicFlashcardSetPage,
  PublicQuizPage,
  PublicWorkspacePage,
  Quiz,
  RateReviewItemReq,
  RecentPage,
  RequestAccountDeletionReq,
  RetryProcessingReq,
  ReviewOverview,
  ReviewResult,
  ReviewSession,
  ReviewStart,
  SearchResult,
  SetModelPrefsReq,
  SetStudyItemReq,
  SourceFile,
  SourceUploadPolicy,
  SpendingLimitReq,
  StudyPlan,
  StudyPlans,
  StudyPreferences,
  StudySummary,
  Tag,
  Task,
  TopUpReq,
  TrashActionReq,
  TrashItem,
  TrashPage,
  UndoEditReq,
  UndoPayload,
  UpdateChapterReq,
  UpdateCommentReq,
  UpdateConversationReq,
  UpdateEventReq,
  UpdateFileReq,
  UpdateFlashcardSetReq,
  UpdateLabelReq,
  UpdateMaterialReq,
  UpdateMeReq,
  UpdateStandaloneSharingReq,
  UpdateTaskReq,
  UpdateWorkspaceMemberReq,
  UpdateWorkspaceReq,
  UpdateWorkspaceSharingReq,
  URLResp,
  UsageEventPage,
  UsageEventParams,
  UsageReport,
  User,
  VoiceTranscription,
  WireMessage,
  Workspace,
  WorkspaceCollaborator,
  WorkspaceMember,
  WorkspaceRecent,
  WorkspaceStats,
} from './types';
import { uploadWithTicket } from './uploadTurn';

export interface QueryUiOptions {
  errorBoundary?: false | 'unlessMissing';
}

export interface MutationUiOptions {
  errorToast?: false;
}

function queryMeta(options?: QueryUiOptions) {
  return options?.errorBoundary === undefined
    ? undefined
    : { errorBoundary: options.errorBoundary };
}

function mutationMeta(options?: MutationUiOptions) {
  return options?.errorToast === false
    ? ({ errorToast: false } as const)
    : undefined;
}

/** Optimistic writes to one cache share a mutation key, and only the last of
 * them to settle refetches: an earlier write's refetch can return before a
 * later write lands and overwrite its optimistic value. */
function refetchIfLast(
  qc: QueryClient,
  mutationKey: QueryKey,
  refetch: () => Promise<unknown>
) {
  return qc.isMutating({ mutationKey }) === 1 ? refetch() : undefined;
}

/** Shared key for optimistic file, material and chapter ordering writes. */
const contentMutationKey = (wsId: string) =>
  ['workspace', wsId, 'content'] as const;

function refetchContentIfLast(qc: QueryClient, wsId: string) {
  return refetchIfLast(qc, contentMutationKey(wsId), () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.files(wsId) }),
      qc.invalidateQueries({ queryKey: qk.materials(wsId) }),
      qc.invalidateQueries({ queryKey: qk.chapters(wsId) }),
    ])
  );
}

/* ---------------- account / shell ---------------- */
export const meQuery = () =>
  queryOptions({
    ...persisted,
    queryFn: () => api.get<User>('/me'),
    queryKey: qk.me,
    // Plan and account banners follow a plan change made in another tab
    // (Checkout, the portal, Stripe's emails).
    refetchOnWindowFocus: 'always',
  });
export const useMe = (options?: QueryUiOptions) =>
  useQuery({ ...meQuery(), meta: queryMeta(options) });

export const ingestSlotsQuery = () =>
  queryOptions({
    queryFn: () => api.get<IngestSlots>('/me/ingest-slots'),
    queryKey: qk.ingestSlots,
  });
export const useIngestSlots = (options?: QueryUiOptions) =>
  useQuery({ ...ingestSlotsQuery(), meta: queryMeta(options) });

export const modelsQuery = (slot: ModelSlot) =>
  queryOptions({
    ...persisted,
    queryFn: () =>
      api.get<ModelsResponse>(`/models?slot=${encodeURIComponent(slot)}`),
    queryKey: qk.models(slot),
  });
export const useModels = (slot: ModelSlot, options?: QueryUiOptions) =>
  useQuery({ ...modelsQuery(slot), meta: queryMeta(options) });

const modelPrefsKey = ['models'] as const;

/** Saves model choices, shown at once in the models and me caches. Saves go
 * out in order and only the last one to settle refetches, so a slower earlier
 * response never shows an older choice. */
export function useSetModelPrefs() {
  const qc = useQueryClient();
  const queue = useRef(Promise.resolve());
  return useMutation({
    mutationFn: (body: SetModelPrefsReq) => {
      const request = queue.current.then(() =>
        api.patch<void>('/me/models', body)
      );
      queue.current = request.then(
        () => undefined,
        () => undefined
      );
      return request;
    },
    mutationKey: modelPrefsKey,
    onMutate: async ({ chatModel, chatThinking, noteAiEnabled }) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: modelPrefsKey }),
        qc.cancelQueries({ queryKey: qk.me }),
      ]);
      qc.setQueryData<ModelsResponse>(qk.models('chat'), (models) =>
        models
          ? {
              ...models,
              selectedModel: chatModel ?? models.selectedModel,
              selectedThinking: chatThinking ?? models.selectedThinking,
            }
          : models
      );
      qc.setQueryData<User>(qk.me, (me) =>
        me
          ? {
              ...me,
              chatModel: chatModel ?? me.chatModel,
              noteAiEnabled: noteAiEnabled ?? me.noteAiEnabled,
            }
          : me
      );
    },
    onSettled: () =>
      refetchIfLast(qc, modelPrefsKey, () =>
        Promise.all([
          qc.invalidateQueries({ queryKey: qk.me }),
          qc.invalidateQueries({ queryKey: modelPrefsKey }),
        ])
      ),
  });
}

/** True while a chat model change is saving: the Thinking levels it offers
 * belong to the new model, and its stored level arrives with the refetch. */
export const useChatModelSaving = () =>
  useMutationState({
    filters: { mutationKey: modelPrefsKey, status: 'pending' },
    select: (mutation) =>
      (mutation.state.variables as SetModelPrefsReq).chatModel !== undefined,
  }).some(Boolean);

export const deletionPreflightQuery = () =>
  queryOptions({
    queryFn: () => api.get<DeletionPreflight>('/account/deletion'),
    queryKey: qk.deletionPreflight,
  });
export const useDeletionPreflight = (enabled = true) =>
  useQuery({ ...deletionPreflightQuery(), enabled });

export function useRequestAccountDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (request: RequestAccountDeletionReq) =>
      api.post<AccountStatus>('/account/deletion', request),
    onError: () => {
      void qc.invalidateQueries({ queryKey: qk.deletionPreflight });
    },
    onSuccess: (status) => {
      qc.setQueryData<User>(qk.me, (me) => me && { ...me, account: status });
      void qc.invalidateQueries({ queryKey: qk.deletionPreflight });
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export function useTransferWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (recipientId: string) =>
      api.post<Workspace>(`/workspaces/${workspaceId}/transfer`, {
        recipientId,
      }),
    onSuccess: (ws) => {
      qc.setQueryData(qk.workspace(workspaceId), ws);
      void qc.invalidateQueries({ queryKey: qk.workspaceMembers(workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.workspaces() });
      void qc.invalidateQueries({ queryKey: qk.deletionPreflight });
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

export const useSearch = (q: string, options?: QueryUiOptions) =>
  useQuery({
    enabled: q.trim().length > 0,
    meta: queryMeta(options),
    queryFn: () =>
      api.get<SearchResult[]>(`/search?q=${encodeURIComponent(q)}`),
    queryKey: qk.search(q),
  });

type NotificationCache = InfiniteData<NotificationPage, string>;
export type EventStreamState = { status: 'connected' | 'disconnected' };

/** The notifications page's list; the nav's dot rides on the separate unread
 * count. */
export const useNotifications = (options?: QueryUiOptions) =>
  useInfiniteQuery<
    NotificationPage,
    Error,
    NotificationCache,
    typeof qk.notifications,
    string
  >({
    ...persisted,
    getNextPageParam: (page) => page.next || undefined,
    initialPageParam: '',
    meta: queryMeta(options),
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({
        limit: String(NOTIFICATION_PAGE_SIZE),
      });
      if (pageParam) query.set('before', pageParam);
      return api.get<NotificationPage>(`/notifications?${query}`);
    },
    queryKey: qk.notifications,
    refetchOnWindowFocus: true,
  });

export const useUnreadNotificationCount = (options?: QueryUiOptions) =>
  useQuery({
    ...persisted,
    meta: queryMeta(options),
    queryFn: () => api.get<NotificationCount>('/notifications/unread-count'),
    queryKey: qk.notificationUnread,
  });

export function applyNotificationEvent(
  qc: QueryClient,
  event: NotificationStreamEvent
) {
  // A standalone file's ingest progress (no workspace to stream it on).
  if (event.type === 'ingest') {
    applyIngestEvent(qc, null, event);
    return;
  }
  // Stripe or the reload worker changed billing. A pending billing save
  // refetches when it settles, so it is left to that refetch.
  if (event.type === 'billing') {
    if (qc.isMutating({ mutationKey: qk.billing }) === 0)
      void qc.invalidateQueries({ queryKey: qk.billing });
    return;
  }
  // A device synced its look (the sender hears it too and finds its own).
  if (event.type === 'customization') {
    void qc
      .fetchQuery({ ...meQuery(), staleTime: 0 })
      .then((me) => {
        if (me.customization) emitSyncedCustomization(me.customization);
      })
      .catch(() => undefined);
    return;
  }
  // The list joins each row's workspace and member for its icon, which a
  // pushed row lacks, so a new notification refetches instead of inserting.
  if (event.type === 'created') {
    void qc.invalidateQueries({ queryKey: qk.notifications });
    void qc.invalidateQueries({ queryKey: qk.notificationUnread });
    return;
  }
  if (event.type === 'removed') {
    const ids = new Set(event.ids ?? []);
    const current = qc.getQueryData<NotificationCache>(qk.notifications);
    if (current) {
      qc.setQueryData<NotificationCache>(qk.notifications, (cache) => {
        if (!cache) return cache;
        return {
          ...cache,
          pages: cache.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => !ids.has(item.id)),
          })),
        };
      });
    } else {
      void qc.invalidateQueries({ queryKey: qk.notifications });
    }
    void qc.invalidateQueries({ queryKey: qk.notificationUnread });
    return;
  }
  if (event.type === 'read') {
    const ids = new Set(event.ids ?? []);
    const current = qc.getQueryData<NotificationCache>(qk.notifications);
    if (current) {
      qc.setQueryData<NotificationCache>(qk.notifications, (cache) => {
        if (!cache) return cache;
        return {
          ...cache,
          pages: cache.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              ids.has(item.id)
                ? { ...item, readAt: item.readAt ?? new Date().toISOString() }
                : item
            ),
          })),
        };
      });
    } else {
      void qc.invalidateQueries({ queryKey: qk.notifications });
    }
    void qc.invalidateQueries({ queryKey: qk.notificationUnread });
  }
}

/** The one SSE connection a signed-in tab holds: notifications always, plus
 * ingest progress and tree changes for the workspace being viewed. Redis
 * Pub/Sub and Postgres NOTIFY replay nothing, so every connect refetches the
 * lists the stream feeds; while disconnected there is no polling, only the
 * banner and a backoff reconnect. No-op under MSW (the dev mock has no event
 * stream). */
export function useEventStream(wsId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (USE_MSW) return;
    let stopped = false;
    let controller: AbortController | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    const treeTimers: Partial<
      Record<'files' | 'materials', ReturnType<typeof setTimeout>>
    > = {};

    const setStatus = (status: EventStreamState['status']) =>
      qc.setQueryData<EventStreamState>(qk.eventStream, { status });
    const reconcile = () => {
      const keys: QueryKey[] = [
        qk.notifications,
        qk.notificationUnread,
        qk.billing,
        // Standalone files' ingest events ride the notifications.
        qk.ownedFilesRoot,
      ];
      if (wsId) {
        keys.push(qk.files(wsId), qk.materials(wsId), qk.chapters(wsId));
      }
      for (const queryKey of keys) {
        void qc.refetchQueries({ queryKey, type: 'active' });
      }
    };
    // One ingest raises several tree events seconds apart and a bulk write
    // raises one per transaction, so a trailing debounce per kind collapses a
    // burst into one refetch. Chapters ride along: a row that arrives in a
    // chapter this tab has not loaded would otherwise render nowhere. A
    // hidden tab only marks the lists stale; refetch-on-focus reads them when
    // it comes back.
    const refetchTree = (kind: 'files' | 'materials') => {
      const keys: QueryKey[] = [
        kind === 'files' ? qk.files(wsId) : qk.materials(wsId),
        qk.chapters(wsId),
      ];
      for (const queryKey of keys) {
        void qc.invalidateQueries({
          queryKey,
          refetchType: focusManager.isFocused() ? 'active' : 'none',
        });
      }
    };
    const handle = (event: StreamEvent) => {
      switch (event.name) {
        case 'notification':
          applyNotificationEvent(qc, event.data);
          return;
        case 'ingest':
          applyIngestEvent(qc, wsId, event.data);
          return;
        case 'tree': {
          const { kind } = event.data;
          clearTimeout(treeTimers[kind]);
          treeTimers[kind] = setTimeout(() => refetchTree(kind), 300);
        }
      }
    };
    const connect = async () => {
      if (stopped) return;
      controller = new AbortController();
      let clean = false;
      try {
        await readEventStream(wsId, handle, controller.signal, () => {
          // The backoff grew, so this is the way back from a fault (a redeploy,
          // a dropped network): retry the reads that failed meanwhile too.
          if (delay > 1000)
            void qc.refetchQueries({
              predicate: (query) => query.state.status === 'error',
              type: 'active',
            });
          delay = 1000;
          setStatus('connected');
          reconcile();
        });
        clean = true;
      } catch {
        /* reconnect below */
      }
      if (stopped) return;
      // A clean end is the server's bounded stream lifetime or a fanout
      // eviction, not a fault: reconnect without raising the banner.
      if (!clean) setStatus('disconnected');
      retryTimer = setTimeout(connect, clean ? 1000 : delay);
      if (!clean) delay = Math.min(delay * 2, 30_000);
    };
    void connect();

    return () => {
      stopped = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      for (const timer of Object.values(treeTimers)) clearTimeout(timer);
      qc.removeQueries({ queryKey: qk.eventStream });
    };
  }, [wsId, qc]);
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id: string) => api.post<void>(`/notifications/${id}/read`),
    onSuccess: (_data, id) => {
      applyNotificationEvent(qc, { ids: [id], type: 'read' });
    },
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: () => api.post<void>('/notifications/read'),
    onSuccess: () => {
      const ids =
        qc
          .getQueryData<NotificationCache>(qk.notifications)
          ?.pages.flatMap((page) => page.items.map((n) => n.id)) ?? [];
      applyNotificationEvent(qc, { ids, type: 'read' });
    },
  });
}

export const notificationPrefsQuery = () =>
  queryOptions({
    ...persisted,
    queryFn: () => api.get<NotificationPrefs>('/notification-prefs'),
    queryKey: qk.notificationPrefs,
  });
export const useNotificationPrefs = (options?: QueryUiOptions) =>
  useQuery({ ...notificationPrefsQuery(), meta: queryMeta(options) });

export function useSetNotificationPrefs() {
  const qc = useQueryClient();
  const queue = useRef(Promise.resolve());
  return useMutation({
    mutationFn: (prefs: NotificationPrefs) => {
      const request = queue.current.then(() =>
        api.patch<NotificationPrefs>('/notification-prefs', prefs)
      );
      queue.current = request.then(
        () => undefined,
        () => undefined
      );
      return request;
    },
    mutationKey: qk.notificationPrefs,
    // Each save carries the whole set, built from this cache, so a quick
    // second toggle keeps the first.
    onMutate: async (prefs) => {
      await qc.cancelQueries({ queryKey: qk.notificationPrefs });
      qc.setQueryData(qk.notificationPrefs, prefs);
    },
    onSettled: () =>
      refetchIfLast(qc, qk.notificationPrefs, () =>
        qc.invalidateQueries({ queryKey: qk.notificationPrefs })
      ),
  });
}

/** Saves the whole preferences object; changes queue so a fast second
 * change cannot land before the first. */
export function useSetStudyPreferences() {
  const qc = useQueryClient();
  const queue = useRef(Promise.resolve());
  return useMutation({
    mutationFn: (prefs: StudyPreferences) => {
      const request = queue.current.then(() =>
        api.patch<void>('/me/study-preferences', prefs)
      );
      queue.current = request.then(
        () => undefined,
        () => undefined
      );
      return request;
    },
    mutationKey: qk.me,
    onMutate: async (prefs) => {
      await qc.cancelQueries({ queryKey: qk.me });
      qc.setQueryData<User>(qk.me, (me) =>
        me ? { ...me, studyPreferences: prefs } : me
      );
    },
    onSettled: () =>
      refetchIfLast(qc, qk.me, () => qc.invalidateQueries({ queryKey: qk.me })),
  });
}

/** Saves the Settings → Chat choices, shown at once through the me cache. */
export function useSetChatPrefs() {
  const qc = useQueryClient();
  const queue = useRef(Promise.resolve());
  return useMutation({
    mutationFn: (prefs: ChatPrefs) => {
      const request = queue.current.then(() =>
        api.patch<void>('/me/chat', prefs)
      );
      queue.current = request.then(
        () => undefined,
        () => undefined
      );
      return request;
    },
    mutationKey: qk.me,
    onMutate: async ({ sendKey, steps }) => {
      await qc.cancelQueries({ queryKey: qk.me });
      qc.setQueryData<User>(qk.me, (me) =>
        me
          ? {
              ...me,
              chatSendKey: sendKey ?? me.chatSendKey,
              chatSteps: steps ?? me.chatSteps,
            }
          : me
      );
    },
    onSettled: () =>
      refetchIfLast(qc, qk.me, () => qc.invalidateQueries({ queryKey: qk.me })),
  });
}

/** Sync in the Theme drawer: stores this device's look on the account; the
 * server then tells the user's other tabs and devices to adopt it. */
export function useSyncCustomization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (customization: Customization) =>
      api.put<void>('/me/customization', customization),
    onSuccess: (_, customization) =>
      qc.setQueryData<User>(qk.me, (me) =>
        me ? { ...me, customization } : me
      ),
  });
}

export function useUpdateMe(options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (body: UpdateMeReq) => api.patch<User>('/me', body),
    onSuccess: (user) => qc.setQueryData(qk.me, user),
  });
}

export function useSetLocale() {
  const qc = useQueryClient();
  const queue = useRef(Promise.resolve());
  return useMutation({
    mutationFn: (locale: 'en' | 'zh') => {
      const request = queue.current.then(() =>
        api.patch<void>('/me/locale', { locale })
      );
      queue.current = request.then(
        () => undefined,
        () => undefined
      );
      return request;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

export const billingQuery = () =>
  queryOptions({
    queryFn: () => api.get<BillingInfo>('/billing'),
    queryKey: qk.billing,
  });
/** Kept current by the event stream's `billing` events (useEventStream). */
export const useBilling = (options?: QueryUiOptions) =>
  useQuery({ ...billingQuery(), meta: queryMeta(options) });

export const usageQuery = () =>
  queryOptions({
    queryFn: () => api.get<UsageReport>('/usage'),
    queryKey: qk.usage,
  });
export const useUsage = (options?: QueryUiOptions) =>
  useQuery({ ...usageQuery(), meta: queryMeta(options) });

/** Detailed usage: this actor's ledger rows, newest first unless sorted, one
 * page per fetch. Secondary query, so the tab renders its own error state. */
export const useUsageEvents = (params: UsageEventParams = {}) =>
  useInfiniteQuery({
    getNextPageParam: (last: UsageEventPage) => last.next || undefined,
    initialPageParam: '',
    meta: { errorBoundary: false },
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) =>
      api.get<UsageEventPage>(
        `/usage/events${listSearch({ before: pageParam, dir: params.dir, sort: params.sort }, '')}`
      ),
    queryKey: qk.usageEvents(params),
  });

/** Stripe invoices, read live by the gateway. Secondary query. */
export const useInvoices = () =>
  useQuery({
    meta: { errorBoundary: false },
    queryFn: () => api.get<InvoiceList>('/billing/invoices'),
    queryKey: qk.invoices,
  });

export function useBillingCheckout() {
  return useMutation({
    mutationFn: (planTier: BillingCheckoutReq['planTier']) =>
      api.post<URLResp>('/billing/checkout', { planTier }),
  });
}

/** Starts a credit top-up: hosted Checkout in the same tab. */
export function useTopUp() {
  return useMutation({
    meta: { errorToast: false },
    mutationFn: async (amountCents: TopUpReq['amountCents']) => {
      const { url } = await api.post<URLResp>('/billing/top-up', {
        amountCents,
      });
      window.location.href = url;
    },
  });
}

/** Saves the auto-reload card through hosted Checkout in setup mode. */
export function usePaymentMethodCheckout() {
  return useMutation({
    mutationFn: async () => {
      const { url } = await api.post<URLResp>('/billing/payment-method');
      window.location.href = url;
    },
  });
}

/** Shows a credit setting at once; billing saves share qk.billing so only
 * the last to settle refetches, and stream refetches wait for them. */
async function setCreditSettings(
  qc: QueryClient,
  patch: Partial<BillingInfo['creditSettings']>
) {
  await qc.cancelQueries({ queryKey: qk.billing });
  qc.setQueryData<BillingInfo>(qk.billing, (billing) =>
    billing
      ? { ...billing, creditSettings: { ...billing.creditSettings, ...patch } }
      : billing
  );
}

const refetchBillingIfLast = (qc: QueryClient) =>
  refetchIfLast(qc, qk.billing, () =>
    qc.invalidateQueries({ queryKey: qk.billing })
  );

export function useSetAutoReload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AutoReloadReq) =>
      api.put<AutoReloadResp>('/billing/auto-reload', body),
    mutationKey: qk.billing,
    onMutate: (body) =>
      setCreditSettings(qc, {
        autoReload: body.enabled,
        reloadAmountCents: body.amountCents,
        reloadThresholdMicros: body.thresholdCredits * 1_000_000,
      }),
    onSettled: () => refetchBillingIfLast(qc),
  });
}

export function useSetSpendingLimit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (limitCents: SpendingLimitReq['limitCents']) =>
      api.put<void>('/billing/spending-limit', { limitCents }),
    mutationKey: qk.billing,
    onMutate: (limitCents) =>
      setCreditSettings(qc, { spendingLimitCents: limitCents || undefined }),
    onSettled: () => refetchBillingIfLast(qc),
  });
}

export function useBillingPortal() {
  return useMutation({
    mutationFn: async () => {
      const { url } = await api.post<URLResp>('/billing/portal');
      window.location.href = url;
    },
  });
}

/** Opens the portal on the live subscription's cancel screen; cancelling
 * stops Stripe retrying a failed plan invoice. */
export function useBillingPortalCancel() {
  return useMutation({
    mutationFn: async () => {
      const { url } = await api.post<URLResp>(
        '/billing/portal/cancel-subscription'
      );
      window.location.href = url;
    },
  });
}

/** Voids the reloads Stripe is retrying; auto-reload stays on. */
export function useCancelReloadRetry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/billing/auto-reload/cancel-retry'),
    mutationKey: qk.billing,
    onSettled: () => refetchBillingIfLast(qc),
  });
}

export const integrationsQuery = () =>
  queryOptions({
    ...persisted,
    queryFn: () => api.get<IntegrationsStatus>('/integrations'),
    queryKey: qk.integrations,
  });
export const useIntegrations = (options?: QueryUiOptions) =>
  useQuery({ ...integrationsQuery(), meta: queryMeta(options) });

/** Where a destination's source routes live: a workspace's, or the unscoped
 * ones for a standalone file (no workspace). */
export const sourcesPath = (workspaceId: string | null) =>
  workspaceId ? `/workspaces/${workspaceId}/sources` : '/sources';

export function useImportSources(
  workspaceId: string | null,
  options?: MutationUiOptions
) {
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (body: {
      /** The submission and its picked-item count; one notification for all. */
      batchId: string;
      batchTotal: number;
      chapterId?: string | null;
      chapterName?: string | null;
      driveIds?: string[];
      fileIds: string[];
      parseMode?: 'fast' | 'none';
      provider: 'google' | 'microsoft';
      requestId?: string;
      signal?: AbortSignal;
    }) => {
      const { signal, chapterId, chapterName, ...request } = body;
      return api.post<unknown>(
        `${sourcesPath(workspaceId)}/import`,
        // A standalone file has no chapter.
        workspaceId ? { ...request, chapterId, chapterName } : request,
        { signal }
      );
    },
  });
}

export function useInspectSourceImports(
  workspaceId: string | null,
  options?: MutationUiOptions
) {
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (body: InspectSourceImportsReq) =>
      api.post<InspectSourceImportsResponse>(
        `${sourcesPath(workspaceId)}/import-inspect`,
        body
      ),
  });
}

/* ---------------- tags ---------------- */
/** The user's tag catalog for one kind — feeds the reuse-existing autocomplete.
 * Loaded once and filtered client-side (no per-keystroke request). */
export const tagsQuery = (kind = 'workspace') =>
  queryOptions({
    ...persisted,
    queryFn: () => api.get<Tag[]>(`/tags?kind=${encodeURIComponent(kind)}`),
    queryKey: qk.tags(kind),
  });
export const useTags = (kind = 'workspace', options?: QueryUiOptions) =>
  useQuery({ ...tagsQuery(kind), meta: queryMeta(options) });

/* ---------------- workspaces ---------------- */
export interface WorkspaceQuery {
  q?: string;
  sort?: string;
  /** One or more tag values. */
  tag?: string | string[];
}
export const workspacesQuery = (params: WorkspaceQuery = {}) => {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.sort) search.set('sort', params.sort);
  const tags = Array.isArray(params.tag)
    ? params.tag
    : params.tag
      ? [params.tag]
      : [];
  if (tags.length) search.set('tag', tags.join(','));
  const qs = search.toString();
  return queryOptions({
    // A search is not kept: one entry per query typed.
    ...(params.q ? {} : persisted),
    queryFn: () => api.get<Workspace[]>(`/workspaces${qs ? `?${qs}` : ''}`),
    queryKey: qk.workspaces(params),
  });
};
export const useWorkspaces = (
  params: WorkspaceQuery = {},
  options?: QueryUiOptions
) => useQuery({ ...workspacesQuery(params), meta: queryMeta(options) });

export const workspaceQuery = (id: string) =>
  queryOptions({
    ...persisted,
    enabled: !!id,
    queryFn: () => api.get<Workspace>(`/workspaces/${id}`),
    queryKey: qk.workspace(id),
  });
export const useWorkspace = (id: string, options?: QueryUiOptions) =>
  useQuery({ ...workspaceQuery(id), meta: queryMeta(options) });

export const workspaceStatsQuery = (id: string) =>
  queryOptions({
    enabled: !!id,
    queryFn: () => api.get<WorkspaceStats>(`/workspaces/${id}/stats`),
    queryKey: qk.workspaceStats(id),
    // Processing reports nothing live, so the Indexing tab polls while a
    // file or note change is queued or processing.
    refetchInterval: (query) =>
      [
        ...(query.state.data?.fileChanges ?? []),
        ...(query.state.data?.noteChanges ?? []),
      ].some(
        (change) => change.state === 'queued' || change.state === 'processing'
      )
        ? 3000
        : false,
  });
export const useWorkspaceStats = (id: string, options?: QueryUiOptions) =>
  useQuery({ ...workspaceStatsQuery(id), meta: queryMeta(options) });

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkspaceReq) =>
      api.post<Workspace>('/workspaces', body),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['workspaces'] }),
        qc.invalidateQueries({ queryKey: ['tags'] }),
      ]);
    },
  });
}
export function useUpdateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateWorkspaceReq & { id: string }) =>
      api.patch<Workspace>(`/workspaces/${id}`, body),
    onSuccess: async (workspace, v) => {
      qc.setQueryData(qk.workspace(v.id), workspace);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['workspaces'] }),
        qc.invalidateQueries({ queryKey: qk.workspace(v.id) }),
        qc.invalidateQueries({ queryKey: ['tags'] }),
      ]);
    },
  });
}
export function useUpdateWorkspaceSharing() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: ({ id, ...body }: UpdateWorkspaceSharingReq & { id: string }) =>
      api.patch<Workspace>(`/workspaces/${id}/sharing`, body),
    // Await invalidation so mutateAsync (and ShareDialog's savingField) stay
    // pending until active workspace queries finish refetching.
    onSuccess: async (_d, v) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['workspaces'] }),
        qc.invalidateQueries({ queryKey: qk.workspace(v.id) }),
      ]);
    },
  });
}
export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/workspaces/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
}

/** The lists a visit moves: workspaces always (the recent order), and the
 * Member file and material lists and search when a visitor's workspace joins
 * or leaves them (every mutation marks Recent stale, queryClient.ts). */
function invalidateVisitLists(qc: QueryClient, visitor: boolean) {
  void qc.invalidateQueries({ queryKey: ['workspaces'] });
  if (!visitor) return;
  void qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
  void qc.invalidateQueries({ queryKey: qk.ownedMaterialsRoot });
  void qc.invalidateQueries({ queryKey: ['search'] });
}

/** Notes an open of the workspace page, at most once per workspace per
 * `OPEN_WINDOW_MS` from this browser (the server holds the same window). A
 * visitor's open always sends: Forget on another device leaves this browser's
 * window standing, and such opens are rare. Nothing to report: a failed send
 * is dropped, so the next open sends again. */
export function useVisitWorkspace() {
  const qc = useQueryClient();
  const { mutate } = useMutation({
    meta: { errorToast: false },
    mutationFn: ({ id }: { id: string; visitor: boolean }) =>
      api.post<void>(`/workspaces/${id}/visit`),
    onError: (_error, { id }) => dropOpen(`workspace:${id}`),
    onSuccess: (_data, { visitor }) => invalidateVisitLists(qc, visitor),
  });
  return useCallback(
    (visit: { id: string; visitor: boolean }) => {
      if (takeOpen(`workspace:${visit.id}`) || visit.visitor) mutate(visit);
    },
    [mutate]
  );
}

/** Forget: a workspace the caller reaches only as a visitor leaves their
 * lists until they open it again. */
export function useForgetWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/workspaces/${id}/visit`),
    onSuccess: (_data, id) => {
      dropOpen(`workspace:${id}`);
      invalidateVisitLists(qc, true);
    },
  });
}

/** How many opens Recent Files and the quick open read (one shared list). */
export const RECENT_LIMIT = 20;

/** The dashboard's Recent Files and the phone quick open: the caller's
 * newest opened (or created) files and materials they can still open, in
 * open order, from any device. */
export const recentQuery = () =>
  queryOptions({
    queryFn: () => api.get<RecentPage>(`/recent?limit=${RECENT_LIMIT}`),
    queryKey: qk.recent,
    ...persisted,
  });

/** Notes an open of a file or material in the centre pane, at most once per
 * item per `OPEN_WINDOW_MS` from this browser (the server holds the same
 * window). Nothing to report: a failed send is dropped, so the next open
 * sends again. */
export function useRecordOpen() {
  const { mutate } = useMutation({
    meta: { errorToast: false },
    mutationFn: ({ kind, id }: { kind: 'file' | 'material'; id: string }) =>
      api.post<void>(`/${kind === 'file' ? 'files' : 'materials'}/${id}/open`),
    onError: (_error, { kind, id }) => dropOpen(`${kind}:${id}` as OpenKey),
  });
  return useCallback(
    (open: { kind: 'file' | 'material'; id: string }) => {
      if (takeOpen(`${open.kind}:${open.id}`)) mutate(open);
    },
    [mutate]
  );
}

/* ---------------- chapters & files ---------------- */
/** A presigned pair is read once, at fetch time, by whichever consumer mounts
 * it: nothing tracks expiresAt, nothing invalidates it, and neither focus nor
 * reconnect refetches, so a mounted view never sees a changed URL. gcTime 0
 * drops the pair on unmount so a reopen never renders a cached URL that may
 * have expired. */
export const fileLinksQuery = (
  fileId: string,
  consumer: 'view' | 'preview' = 'view'
) =>
  queryOptions({
    enabled: !!fileId,
    gcTime: 0,
    queryFn: () =>
      api.get<FileLinks>(`/files/${encodeURIComponent(fileId)}/links`),
    queryKey: qk.fileLinks(fileId, consumer),
    refetchOnReconnect: false,
  });
export const useFileLinks = (fileId: string, options?: QueryUiOptions) =>
  useQuery({ ...fileLinksQuery(fileId), meta: queryMeta(options) });
export const sourceUploadPolicyQuery = (wsId?: string) =>
  queryOptions({
    queryFn: () =>
      api.get<SourceUploadPolicy>(
        wsId
          ? `/source-upload-policy?workspaceId=${encodeURIComponent(wsId)}`
          : '/source-upload-policy'
      ),
    queryKey: qk.sourceUploadPolicy(wsId),
  });
export const useSourceUploadPolicy = (
  wsId?: string,
  options?: QueryUiOptions
) => useQuery({ ...sourceUploadPolicyQuery(wsId), meta: queryMeta(options) });

export const chaptersQuery = (wsId: string) =>
  queryOptions({
    ...persisted,
    enabled: !!wsId,
    queryFn: () => api.get<Chapter[]>(`/workspaces/${wsId}/chapters`),
    queryKey: qk.chapters(wsId),
  });
export const useChapters = (wsId: string, options?: QueryUiOptions) =>
  useQuery({
    ...chaptersQuery(wsId),
    meta: queryMeta(options),
    refetchOnWindowFocus: true,
  });

export const filesQuery = (wsId: string) =>
  queryOptions({
    ...persisted,
    enabled: !!wsId,
    queryFn: async ({ client }) => {
      const files = await api.get<SourceFile[]>(`/workspaces/${wsId}/files`);
      // `ingestPct` lives only in this cache (stream events patch it in), so
      // carry it over for rows still ingesting or a list read mid-ingest
      // would snap the progress bar back to zero.
      const previous = new Map(
        client
          .getQueryData<SourceFile[]>(qk.files(wsId))
          ?.map((file) => [file.id, file.ingestPct])
      );
      for (const file of files) {
        if (file.status === 'pending' || file.status === 'processing') {
          file.ingestPct = previous.get(file.id);
          continue;
        }
        // A terminal event may have been missed before subscribing or while
        // disconnected. Refresh the body too when a list read finds completion.
        const queryKey = qk.file(file.id);
        const cached = client.getQueryData<SourceFile>(queryKey);
        if (cached?.status === 'pending' || cached?.status === 'processing') {
          void client.invalidateQueries({ queryKey });
        }
      }
      return files;
    },
    queryKey: qk.files(wsId),
  });
export const useFiles = (wsId: string, options?: QueryUiOptions) =>
  useQuery({
    ...filesQuery(wsId),
    meta: queryMeta(options),
    refetchOnWindowFocus: true,
  });

/** The empty viewer's quick-open grid: the workspace's four newest files and
 * materials with thumbnails and previews, for members and link readers alike. */
export const useWorkspaceRecent = (wsId: string) =>
  useQuery({
    meta: queryMeta({ errorBoundary: false }),
    queryFn: () => api.get<WorkspaceRecent>(`/workspaces/${wsId}/recent`),
    queryKey: qk.filesRecent(wsId),
  });

export const fileQuery = (id: string | null) =>
  queryOptions({
    ...persisted,
    enabled: !!id,
    queryFn: () => api.get<SourceFile>(`/files/${id}`),
    queryKey: qk.file(id ?? ''),
    staleTime: 5000,
  });
export const useFile = (id: string | null, options?: QueryUiOptions) =>
  useQuery({ ...fileQuery(id), meta: queryMeta(options) });

/** Query string for the owner-scoped listings: comma-joined lists, blanks
 * dropped, the page cursor last. */
function listSearch(
  params: Record<string, string | readonly string[] | undefined>,
  cursor: string
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      if (value.length) search.set(key, value.join(','));
    } else if (typeof value === 'string' && value) {
      search.set(key, value);
    }
  }
  if (cursor) search.set('cursor', cursor);
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const ownedFilesQuery = (params: FileListParams = {}) => ({
  getNextPageParam: (last: FilePage) => last.nextCursor || undefined,
  initialPageParam: '',
  queryFn: ({ pageParam }: { pageParam: string }) =>
    api.get<FilePage>(
      `/files${listSearch(
        {
          dir: params.dir,
          kind: params.kinds,
          location: params.locations,
          q: params.q,
          scope: params.scope,
          sort: params.sort,
          workspaceId: params.workspaceIds,
        },
        pageParam
      )}`
    ),
  queryKey: qk.ownedFiles(params),
});
/** Files of every workspace the caller owns, newest first by default. */
// The sorted and filtered lists keep showing the rows they have while a new
// sort or filter loads; only a list with nothing to show yet draws skeletons.
export const useOwnedFiles = (params: FileListParams = {}) =>
  useInfiniteQuery({
    ...ownedFilesQuery(params),
    placeholderData: keepPreviousData,
  });

/** The images and audio the caller pays for (M16), newest first, each marked
 * when its note can no longer be opened: the Files page's Embeds tab. A new
 * access filter loads afresh, so its notice never sits over the previous
 * filter's rows. */
export const useEditorAssets = (access?: EditorAssetAccess) =>
  useInfiniteQuery({
    getNextPageParam: (last: EditorAssetPage) => last.nextCursor || undefined,
    initialPageParam: '',
    queryFn: ({ pageParam }: { pageParam: string }) =>
      api.get<EditorAssetPage>(
        `/editor-assets${listSearch({ access }, pageParam)}`
      ),
    queryKey: qk.editorAssets(access),
  });

/** Deletes one of them at once, wherever it sits: nothing restores it, and
 * its note shows it as removed by its uploader. */
export function useDeleteEditorAsset() {
  const qc = useQueryClient();
  return useMutation({
    // Its confirmation shows the failure.
    meta: { errorToast: false },
    mutationFn: (assetId: string) =>
      api.del<void>(`/editor-assets/${encodeURIComponent(assetId)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.editorAssetsRoot });
      qc.invalidateQueries({ queryKey: qk.usage });
    },
  });
}

export function useUpdateFile(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateFileReq & { id: string }) =>
      api.patch<SourceFile>(`/files/${id}`, body),
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: qk.files(wsId) });
      qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
      qc.invalidateQueries({ queryKey: qk.file(file.id) });
      qc.invalidateQueries({ queryKey: qk.chapters(wsId) });
    },
  });
}
/** File a source under a chapter (membership), or unfile it (chapterId=null).
 * The API uses an empty-string sentinel to unfile; null maps to "". Optimistic:
 * patches the files cache, rolls back on error, reconciles chapters on settle. */
export function useMoveFile(wsId: string) {
  const qc = useQueryClient();
  return useMutation<
    SourceFile,
    Error,
    { id: string; chapterId: string | null },
    { prev?: SourceFile[] }
  >({
    meta: { errorToast: false },
    mutationFn: ({ id, chapterId }: { id: string; chapterId: string | null }) =>
      api.patch<SourceFile>(`/files/${id}`, { chapterId: chapterId ?? '' }),
    mutationKey: contentMutationKey(wsId),
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.files(wsId), ctx.prev);
    },
    onMutate: async ({ id, chapterId }) => {
      await qc.cancelQueries({ queryKey: qk.files(wsId) });
      const prev = qc.getQueryData<SourceFile[]>(qk.files(wsId));
      qc.setQueryData<SourceFile[]>(qk.files(wsId), (list) =>
        list?.map((f) => (f.id === id ? { ...f, chapterId } : f))
      );
      return { prev };
    },
    onSettled: () => refetchContentIfLast(qc, wsId),
  });
}
/** Move files into a workspace the caller edits (never out of one). `from`
 * holds the workspaces they leave, whose lists, chapters, stats and study
 * progress change too. A 409 `progress_loss` asks before dropping study
 * progress: resend with `confirmProgressLoss`. */
export function useMoveFiles(options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: ({ body }: { body: MoveFilesReq; from: string[] }) =>
      api.post<SourceFile[]>('/files/move', body),
    onSuccess: (files, { body, from }) => {
      for (const wsId of new Set([...from, body.workspaceId]))
        if (wsId) qc.invalidateQueries({ queryKey: qk.workspace(wsId) });
      for (const file of files)
        qc.invalidateQueries({ queryKey: qk.file(file.id) });
      qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
      qc.invalidateQueries({ queryKey: qk.recent });
      // The left workspaces' progress and plan steps for the files are gone.
      void invalidateStudy(qc);
    },
  });
}
function invalidateAfterFileDelete(qc: QueryClient, wsId: string) {
  qc.invalidateQueries({ queryKey: qk.files(wsId) });
  qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
  qc.invalidateQueries({ queryKey: qk.chapters(wsId) });
  qc.invalidateQueries({ queryKey: qk.workspaceStats(wsId) });
  qc.invalidateQueries({ queryKey: qk.trash() });
}

/** Deleting a file moves it to the trash; the owner can restore it from
 * Files › Trash for 30 days. Its bytes stay charged until purged. */
export function useDeleteFile(wsId: string, options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (id: string) => api.del<void>(`/files/${id}`),
    onSuccess: () => invalidateAfterFileDelete(qc, wsId),
  });
}

const retryProcessingKey = (wsId: string | null) =>
  ['retryProcessing', wsId ?? ''] as const;

/** Process a failed file again on its stored bytes (owner only, charged like
 * automatic reprocessing). The file list shows it pending once it lands. */
export function useRetryFileProcessing(wsId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, parseMode }: { id: string } & RetryProcessingReq) =>
      api.post<void>(`/files/${encodeURIComponent(id)}/retry-processing`, {
        parseMode,
      } satisfies RetryProcessingReq),
    mutationKey: retryProcessingKey(wsId),
    // Awaited, so the retry stays pending until the refetched list shows the
    // file out of `failed` (useRetryingFileIds).
    onSettled: (_data, _error, { id }) =>
      Promise.all(
        wsId
          ? [
              qc.invalidateQueries({ queryKey: qk.files(wsId) }),
              qc.invalidateQueries({ queryKey: qk.workspaceStats(wsId) }),
            ]
          : // A standalone file: the Files page's list and its own query.
            [
              qc.invalidateQueries({ queryKey: qk.ownedFilesRoot }),
              qc.invalidateQueries({ queryKey: qk.file(id) }),
            ]
      ),
  });
}

/** Files whose Retry processing is still running: the POST, then the list
 * refetch. Their Retry stays off, so no second click meets the queued job's
 * 409. */
export const useRetryingFileIds = (wsId: string | null) =>
  useMutationState({
    filters: { mutationKey: retryProcessingKey(wsId), status: 'pending' },
    select: (mutation) =>
      (mutation.state.variables as Pick<SourceFile, 'id'>).id,
  });

export function useDeleteOwnedFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: Pick<SourceFile, 'id' | 'workspaceId'>) =>
      api.del<void>(`/files/${id}`),
    onSuccess: (_data, file) => invalidateAfterFileDelete(qc, file.workspaceId),
  });
}

/** One chat Undo or Redo: each click is its own request (the key is not
 * reused across retries), and the server answers every request for a step it
 * reversed already with that receipt. An edit step sends the payload the browser kept;
 * the answer's payload (the next step's) is kept and the used one dropped,
 * whether or not the receipt is still on screen. Offline it fails at once;
 * nothing waits to be sent. */
export function useUndoEdit() {
  return useMutation({
    meta: { errorToast: false },
    mutationFn: ({
      operationId,
      payload,
    }: {
      operationId: string;
      payload?: UndoPayload;
    }) =>
      api.post<OperationReceipt>(`/chat/edit-operations/${operationId}/undo`, {
        payload,
        requestId: crypto.randomUUID(),
      } satisfies UndoEditReq),
    networkMode: 'always',
    onSuccess: (receipt, { operationId }) => {
      forgetUndoPayload(operationId);
      if (receipt.undoPayload) keepUndoPayloads([receipt.undoPayload]);
    },
  });
}

/* ---------------- trash ---------------- */

export const trashQuery = (wsId?: string) => ({
  getNextPageParam: (last: TrashPage) => last.nextCursor || undefined,
  initialPageParam: '',
  queryFn: ({ pageParam }: { pageParam: string }) => {
    const params = new URLSearchParams();
    if (wsId) params.set('workspaceId', wsId);
    if (pageParam) params.set('cursor', pageParam);
    const query = params.toString();
    return api.get<TrashPage>(`/trash${query ? `?${query}` : ''}`);
  },
  queryKey: qk.trash(wsId),
});
/** Owner-scoped trash listing. Lazy: the Files page only loads it when the
 * Trash tab is open. Secondary query, so it renders its own error state. */
export const useTrash = (wsId: string | undefined, enabled: boolean) =>
  useInfiniteQuery({
    ...trashQuery(wsId),
    enabled,
    meta: { errorBoundary: false },
  });

function invalidateAfterTrashChange(qc: QueryClient, item: TrashItem) {
  qc.invalidateQueries({ queryKey: qk.trash() });
  qc.invalidateQueries({ queryKey: qk.ownedMaterialsRoot });
  qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
  qc.invalidateQueries({ queryKey: qk.usage });
  if (item.workspaceId) {
    qc.invalidateQueries({ queryKey: qk.files(item.workspaceId) });
    qc.invalidateQueries({ queryKey: qk.materials(item.workspaceId) });
    qc.invalidateQueries({ queryKey: qk.chapters(item.workspaceId) });
    qc.invalidateQueries({ queryKey: qk.workspaceStats(item.workspaceId) });
    qc.invalidateQueries({ queryKey: qk.workspace(item.workspaceId) });
  }
}

/** Restore one trash episode. Each click is its own request; a second click
 * on the same episode is refused by the server's episode check, not replayed. */
export function useRestoreTrashed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (item: TrashItem) =>
      api.post<OperationReceipt>(`/trash/${item.kind}/${item.id}/restore`, {
        episodeId: item.episodeId,
        requestId: crypto.randomUUID(),
      } satisfies TrashActionReq),
    onSuccess: (_receipt, item) => invalidateAfterTrashChange(qc, item),
  });
}

/** Permanently delete one trash episode. Irreversible. */
export function usePurgeTrashed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (item: TrashItem) =>
      api.del<OperationReceipt>(
        `/trash/${item.kind}/${item.id}?${new URLSearchParams({
          episodeId: item.episodeId,
          requestId: crypto.randomUUID(),
        })}`
      ),
    onSuccess: (_receipt, item) => invalidateAfterTrashChange(qc, item),
  });
}

export function useAddChapter(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<Chapter>(`/workspaces/${wsId}/chapters`, { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chapters(wsId) }),
  });
}
export function useUpdateChapter(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateChapterReq & { id: string }) =>
      api.patch<Chapter>(`/chapters/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chapters(wsId) }),
  });
}
export function useReorderChapters(wsId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, string[], { prev?: Chapter[] }>({
    mutationFn: (ids) =>
      api.post<void>(`/workspaces/${wsId}/chapters/reorder`, { ids }),
    mutationKey: contentMutationKey(wsId),
    onError: (_error, _ids, context) => {
      if (context?.prev) qc.setQueryData(qk.chapters(wsId), context.prev);
    },
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: qk.chapters(wsId) });
      const prev = qc.getQueryData<Chapter[]>(qk.chapters(wsId));
      const positions = new Map(ids.map((id, order) => [id, order]));
      qc.setQueryData<Chapter[]>(qk.chapters(wsId), (list) =>
        list
          ?.map((chapter) => {
            const order = positions.get(chapter.id);
            return order === undefined ? chapter : { ...chapter, order };
          })
          .sort((a, b) => a.order - b.order)
      );
      return { prev };
    },
    onSettled: () => refetchContentIfLast(qc, wsId),
  });
}

/** Move and reorder the mixed file/material rows in one destination bucket. */
export function useReorderContent(wsId: string) {
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    { chapterId: string | null; items: ContentOrderItem[] },
    { prevFiles?: SourceFile[]; prevMaterials?: MaterialRef[] }
  >({
    meta: { errorToast: false },
    mutationFn: ({
      chapterId,
      items,
    }: {
      chapterId: string | null;
      items: ContentOrderItem[];
    }) =>
      api.post<void>(`/workspaces/${wsId}/content/reorder`, {
        chapterId,
        items,
      }),
    mutationKey: contentMutationKey(wsId),
    onError: (_error, _variables, context) => {
      if (context?.prevFiles)
        qc.setQueryData(qk.files(wsId), context.prevFiles);
      if (context?.prevMaterials)
        qc.setQueryData(qk.materials(wsId), context.prevMaterials);
    },
    onMutate: async ({ chapterId, items }) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: qk.files(wsId) }),
        qc.cancelQueries({ queryKey: qk.materials(wsId) }),
      ]);
      const prevFiles = qc.getQueryData<SourceFile[]>(qk.files(wsId));
      const prevMaterials = qc.getQueryData<MaterialRef[]>(qk.materials(wsId));
      const positions = new Map(
        items.map((item, position) => [`${item.type}:${item.id}`, position])
      );
      qc.setQueryData<SourceFile[]>(qk.files(wsId), (list) =>
        list?.map((file) => {
          const position = positions.get(`file:${file.id}`);
          return position === undefined
            ? file
            : { ...file, chapterId, position };
        })
      );
      qc.setQueryData<MaterialRef[]>(qk.materials(wsId), (list) =>
        list?.map((material) => {
          const position = positions.get(`material:${material.id}`);
          return position === undefined
            ? material
            : { ...material, chapterId, position };
        })
      );
      return { prevFiles, prevMaterials };
    },
    onSettled: () => refetchContentIfLast(qc, wsId),
  });
}

export function useDeleteChapter(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/chapters/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.chapters(wsId) });
      qc.invalidateQueries({ queryKey: qk.files(wsId) });
    },
  });
}
/** Patch a single file across its list cache (the workspace's, or the owned
 * files lists for a standalone file) and its detail cache. */
function patchFileInCache(
  qc: QueryClient,
  wsId: string | null,
  fileId: string,
  patch: Partial<SourceFile>
) {
  const apply = (f: SourceFile) => (f.id === fileId ? { ...f, ...patch } : f);
  if (wsId) {
    qc.setQueryData<SourceFile[]>(qk.files(wsId), (prev) => prev?.map(apply));
  } else {
    qc.setQueriesData<InfiniteData<FilePage>>(
      { queryKey: qk.ownedFilesRoot },
      (prev) =>
        prev && {
          ...prev,
          pages: prev.pages.map((page) => ({
            ...page,
            items: page.items.map(apply),
          })),
        }
    );
  }
  qc.setQueryData<SourceFile>(qk.file(fileId), (prev) =>
    prev ? { ...prev, ...patch } : prev
  );
}

// MSW has no SSE channel, so fake the progress animation client-side in dev.
function trackIngestTerminal(
  qc: QueryClient,
  wsId: string | null,
  fileId: string,
  status: 'ready' | 'failed',
  stage?: unknown
) {
  const taken = ingestTracker.takeTerminal(fileId, status);
  if (!taken) return;
  const file = wsId
    ? qc
        .getQueryData<SourceFile[]>(qk.files(wsId))
        ?.find((entry) => entry.id === fileId)
    : qc.getQueryData<SourceFile>(qk.file(fileId));
  const kind = file?.kind ?? 'unknown';
  if (status === 'ready') {
    track('source_ingest_completed', {
      durationBucket: durationBucket(taken.durationMs),
      indexed: file?.indexed === true,
      kind,
    });
    return;
  }
  track('source_ingest_failed', {
    kind,
    reason: ingestFailReason(stage),
    stage: ingestStageCode(stage),
  });
}

/** Animates a mock ingest, then reads the outcome from the mock server, which
 * decides it (ready, unindexed or failed) the way a worker would. */
function simulateMswProgress(
  qc: QueryClient,
  wsId: string | null,
  fileId: string
) {
  let pct = 0;
  ingestTracker.markStart(fileId);
  const timer = setInterval(() => {
    pct += 20;
    if (pct < 100) {
      patchFileInCache(qc, wsId, fileId, {
        ingestPct: pct,
        status: pct < 40 ? 'pending' : 'processing',
      });
      return;
    }
    clearInterval(timer);
    void qc.invalidateQueries({
      queryKey: wsId ? qk.files(wsId) : qk.ownedFilesRoot,
    });
    void qc.invalidateQueries({ queryKey: qk.file(fileId) });
  }, 450);
}

/** MSW answers an XHR without upload progress events, so mock uploads tick
 * through progress before the request goes out. */
async function simulateMswUploadProgress(
  onUploadProgress: ((pct: number) => void) | undefined,
  signal: AbortSignal | undefined
) {
  for (let pct = 10; pct < 100; pct += 10) {
    if (signal?.aborted) return;
    onUploadProgress?.(pct);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Stream the file through the gateway, which stores it, records its SHA-256
 * and queues its processing in the same request (Epo 2026-10-22). */
export function useUploadSource(wsId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: async ({
      file,
      kind,
      chapterId,
      chapterName,
      parseMode,
      estimatedCreditMicros,
      pageCount,
      durationSeconds,
      batchId,
      batchTotal,
      onQueued,
      onUploadProgress,
      signal,
    }: {
      file: File;
      kind: SourceFile['kind'];
      /** The submission this file belongs to and its file count; the server
       * sends one notification once every file of the batch settles. */
      batchId: string;
      batchTotal: number;
      chapterId?: string | null;
      chapterName?: string | null;
      /** fast = OpenDataLoader, with OCR on text-less pages; none = store-only
       * for non-text kinds (no parse, not indexed). Text kinds (txt/md/json)
       * still index under none — there is no parse route to pick. */
      parseMode?: 'fast' | 'none';
      /** Browser-side cost estimate at the upload policy rates. The gateway
       * refuses a reservation that would land past its credit headroom; the
       * parser receipt still bills the measured pages. */
      estimatedCreditMicros?: number;
      /** The analysed page count of a fast-parse document; the gateway
       * refuses one past the policy's maxPages. */
      pageCount?: number;
      /** An audio file's length as the browser read it, in whole seconds;
       * the gateway refuses one past the policy's audioMaxDurationSeconds. */
      durationSeconds?: number;
      /** The upload's place in the gateway's line while it waits, 0 once
       * its turn comes (uploadWithTicket). */
      onQueued?: (position: number) => void;
      onUploadProgress?: (pct: number) => void;
      signal?: AbortSignal;
    }) => {
      const metadata = {
        batchId,
        batchTotal,
        // A standalone file has no chapter: the fields stay out.
        ...(wsId
          ? { chapterId: chapterId ?? null, chapterName: chapterName ?? null }
          : {}),
        contentType: file.type || 'application/octet-stream',
        durationSeconds: durationSeconds || undefined,
        estimatedCreditMicros: estimatedCreditMicros || undefined,
        kind,
        name: file.name,
        pageCount: pageCount || undefined,
        parseMode,
        sizeBytes: file.size,
      };
      return uploadWithTicket(
        `${sourcesPath(wsId)}/uploads`,
        metadata,
        async (path) => {
          if (USE_MSW)
            await simulateMswUploadProgress(onUploadProgress, signal);
          // The metadata part comes first: the gateway reserves storage from
          // it before it reads the file part.
          const form = new FormData();
          form.append('metadata', JSON.stringify(metadata));
          form.append('file', file);
          return api.upload<SourceFile>(path, form, onUploadProgress, signal);
        },
        { onQueued, signal }
      );
    },
    onSuccess: (file, vars) => {
      track('source_uploaded', {
        kind: vars.kind,
        parseMode: vars.parseMode ?? 'fast',
        sizeBucket: sizeBucket(vars.file.size),
      });
      ingestTracker.markStart(file.id);
      const added = { ...file, ingestPct: 0, status: file.status ?? 'pending' };
      if (wsId) {
        // Insert immediately so the row (with its progress bar) shows up at once.
        qc.setQueryData<SourceFile[]>(qk.files(wsId), (prev) => {
          const next = prev ? [...prev] : [];
          if (!next.some((f) => f.id === file.id)) next.push(added);
          return next;
        });
        qc.invalidateQueries({ queryKey: qk.chapters(wsId) });
        // The file counts against the workspace from upload, not from ingest.
        qc.invalidateQueries({ queryKey: qk.workspace(wsId) });
        qc.invalidateQueries({ queryKey: qk.workspaceStats(wsId) });
      } else {
        // A standalone file's status lives in its own query, which its
        // ingest events patch, and in the Files page's list.
        qc.setQueryData<SourceFile>(qk.file(file.id), added);
        qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
      }
      if (file.status === 'ready') {
        trackIngestTerminal(qc, wsId, file.id, 'ready', 'done');
      }
      if (USE_MSW) simulateMswProgress(qc, wsId, file.id);
    },
  });
}

/** Patch the file caches from one ingest progress event; a standalone file's
 * (no workspace) patches the owned files lists. */
function applyIngestEvent(
  qc: QueryClient,
  wsId: string | null,
  value: IngestEvent
) {
  const { fileId, status } = value;
  const patch: Partial<SourceFile> = { ingestPct: value.pct, status };
  if (typeof value.indexed === 'boolean') patch.indexed = value.indexed;
  if (status === 'pending' || status === 'processing') {
    ingestTracker.markStart(fileId);
  }
  patchFileInCache(qc, wsId, fileId, patch);
  if (status === 'ready' || status === 'failed') {
    trackIngestTerminal(qc, wsId, fileId, status, value.stage);
    // The refetch brings the thumbnail.
    qc.invalidateQueries({
      queryKey: wsId ? qk.files(wsId) : qk.ownedFilesRoot,
    });
    qc.invalidateQueries({ queryKey: qk.file(fileId) });
    // A ready file has downloadable source bytes; refresh pending links.
    qc.invalidateQueries({
      queryKey: qk.fileLinks(fileId),
      refetchType: 'active',
    });
  }
}

/* ---------------- chat & generate ---------------- */

/** A chat's conversations route: one workspace's, or with null the account
 * chat's (chat across all the user's files). */
export const conversationsPath = (wsId: string | null) =>
  wsId ? `/workspaces/${wsId}/conversations` : '/conversations';

export const conversationsQuery = (wsId: string | null) =>
  queryOptions({
    ...persisted,
    enabled: wsId !== '',
    queryFn: () => api.get<Conversation[]>(conversationsPath(wsId)),
    queryKey: qk.conversations(wsId),
  });
export const useConversations = (
  wsId: string | null,
  options?: QueryUiOptions
) => useQuery({ ...conversationsQuery(wsId), meta: queryMeta(options) });

export const messagesQuery = (convId: string | null) =>
  queryOptions({
    enabled: !!convId,
    queryFn: () => api.get<WireMessage[]>(`/conversations/${convId}/messages`),
    queryKey: qk.messages(convId ?? ''),
  });
export const useMessages = (convId: string | null, options?: QueryUiOptions) =>
  useQuery({ ...messagesQuery(convId), meta: queryMeta(options) });

/** Transcribes a chat voice recording for the composer; it shows failures
 * inline, and the user records again (nothing retries). */
export function useTranscribeVoice(wsId: string | null) {
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (clip: Blob) =>
      api.postBlob<VoiceTranscription>(
        wsId
          ? `/workspaces/${wsId}/voice-transcriptions`
          : '/voice-transcriptions',
        clip
      ),
  });
}

export const useArchivedConversations = (
  wsId: string | null,
  enabled: boolean,
  options?: QueryUiOptions
) =>
  useQuery({
    enabled: enabled && wsId !== '',
    meta: queryMeta(options),
    queryFn: () =>
      api.get<Conversation[]>(`${conversationsPath(wsId)}?archived=true`),
    queryKey: qk.archivedConversations(wsId),
  });

/** Rename, pin or archive one thread; the live and archived lists refetch. */
export function useUpdateConversation(
  wsId: string | null,
  options?: MutationUiOptions
) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: ({ id, ...body }: UpdateConversationReq & { id: string }) =>
      api.patch<Conversation>(`/conversations/${id}`, body),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.conversations(wsId) }),
  });
}

/** Stop a running turn: the server saves it as it stands and starts nothing
 * further; a failure toasts and the turn goes on. */
export function useStopChatTurn(options?: MutationUiOptions) {
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: ({
      conversationId,
      messageId,
    }: {
      conversationId: string;
      messageId: string;
    }) =>
      api.post<void>(
        `/conversations/${conversationId}/messages/${messageId}/stop`
      ),
  });
}

export function useDeleteConversation(
  wsId: string | null,
  options?: MutationUiOptions
) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (convId: string) => api.del<void>(`/conversations/${convId}`),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.conversations(wsId) }),
  });
}

/** Unarchive all or delete all of a workspace's archived threads, or with
 * null the account chat's. */
export function useArchivedConversationsAction(
  wsId: string | null,
  options?: MutationUiOptions
) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (action: 'unarchive' | 'delete') => {
      const base = wsId
        ? `/workspaces/${wsId}/conversations`
        : '/conversations';
      return action === 'unarchive'
        ? api.post<void>(`${base}/unarchive`)
        : api.del<void>(`${base}/archived`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.conversations(wsId) }),
  });
}
export function useGenerate(wsId: string, options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (opts: GenerateOptions) =>
      api.post<unknown>(`/workspaces/${wsId}/generate`, opts),
    onError: (error, opts) => {
      track('material_generate_failed', {
        kind: opts.kind,
        reason: failureReason(error),
      });
    },
    onSuccess: async (_data, opts) => {
      track('material_generated', { kind: opts.kind, workspaceId: wsId });
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.materials(wsId) }),
        qc.invalidateQueries({ queryKey: qk.ownedMaterialsRoot }),
      ]);
    },
  });
}

/* ---------------- study materials ---------------- */
/** Unified, workspace-scoped list of study materials (mindmaps, diagrams,
 * quizzes, flashcardSets) for the left panel. Not chapter-scoped. */
export const materialsQuery = (wsId: string) =>
  queryOptions({
    ...persisted,
    enabled: !!wsId,
    queryFn: () => api.get<MaterialRef[]>(`/workspaces/${wsId}/materials`),
    queryKey: qk.materials(wsId),
  });
export const useMaterials = (wsId: string, options?: QueryUiOptions) =>
  useQuery({
    ...materialsQuery(wsId),
    meta: queryMeta(options),
    refetchOnWindowFocus: true,
  });

export const materialQuery = (id: string | null) =>
  queryOptions({
    enabled: !!id,
    queryFn: () => api.get<Material>(`/materials/${id}`),
    queryKey: qk.material(id ?? ''),
    staleTime: 5000,
  });
export const useMaterial = (id: string | null, options?: QueryUiOptions) =>
  useQuery({ ...materialQuery(id), meta: queryMeta(options) });

/** Deleting a material moves it to the trash (see useDeleteFile). */
export const ownedMaterialsQuery = (params: MaterialListParams = {}) => ({
  getNextPageParam: (last: MaterialPage) => last.nextCursor || undefined,
  initialPageParam: '',
  queryFn: ({ pageParam }: { pageParam: string }) =>
    api.get<MaterialPage>(
      `/materials${listSearch(
        {
          dir: params.dir,
          kind: params.kinds,
          location: params.locations,
          scope: params.scope,
          sort: params.sort,
          workspaceId: params.workspaceIds,
        },
        pageParam
      )}`
    ),
  queryKey: qk.ownedMaterials(params),
});
/** Notes, quizzes and flashcard sets the caller owns, standalone or in their
 * own workspaces; the Create page's list. */
export const useOwnedMaterials = (params: MaterialListParams = {}) =>
  useInfiniteQuery({
    ...ownedMaterialsQuery(params),
    placeholderData: keepPreviousData,
  });
function invalidateOwnedMaterials(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: qk.ownedMaterialsRoot });
}

/** Create a note outside any workspace. */
export function useCreateStandaloneNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title?: string }) =>
      api.post<Material>('/materials', { kind: 'note', ...body }),
    onSuccess: () => invalidateOwnedMaterials(qc),
  });
}

/** Copy a material into a workspace the caller edits (in a chapter, an
 * existing one or one named), or with no workspace into a private copy. */
export function useCloneMaterial(options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: ({ id, body }: { id: string; body: CloneMaterialReq }) =>
      api.post<Material>(`/materials/${id}/clone`, body),
    onSuccess: (material, { body }) => {
      trackItemCloned(
        material.kind === 'quiz' || material.kind === 'flashcards'
          ? material.kind
          : 'material'
      );
      invalidateAllMaterials(qc);
      // Explore lists clone counts.
      qc.invalidateQueries({ queryKey: qk.exploreQuizzes });
      qc.invalidateQueries({ queryKey: qk.exploreFlashcardSets });
      if (body.chapterName && material.workspaceId)
        qc.invalidateQueries({ queryKey: qk.chapters(material.workspaceId) });
    },
  });
}

/** Copy a file into a workspace the caller edits, in a chapter or none, or
 * into No workspace (no workspaceId). */
export function useCloneFile(options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: ({ id, body }: { id: string; body: CloneFileReq }) =>
      api.post<SourceFile>(`/files/${id}/clone`, body),
    onSuccess: (file, { body }) => {
      trackItemCloned('file');
      if (file.workspaceId)
        qc.invalidateQueries({ queryKey: qk.files(file.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
      if (body.chapterName)
        qc.invalidateQueries({ queryKey: qk.chapters(file.workspaceId) });
    },
  });
}

/** The Create tab's Blank DOCX and Blank XLSX: a stored, unprocessed file
 * the caller pays for. */
export function useCreateBlankFile(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBlankFileReq) =>
      api.post<SourceFile>(`/workspaces/${wsId}/files/blank`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.files(wsId) });
      qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
      qc.invalidateQueries({ queryKey: qk.workspace(wsId) });
      qc.invalidateQueries({ queryKey: qk.workspaceStats(wsId) });
    },
  });
}

/** Standalone material sharing (notes); quizzes and flashcard sets keep their
 * typed sharing routes. */
export function useUpdateMaterialSharing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, privacy }: { id: string; privacy: Privacy }) =>
      api.patch<Material>(`/materials/${id}/sharing`, { privacy }),
    onSuccess: (material) => {
      qc.setQueryData<Material>(qk.material(material.id), material);
      invalidateOwnedMaterials(qc);
    },
  });
}

export function useDeleteMaterial(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/materials/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.materials(wsId) });
      invalidateOwnedMaterials(qc);
      qc.invalidateQueries({ queryKey: qk.trash() });
    },
  });
}

/** Delete a block from a list spanning workspaces (Files › Blocks): each
 * delete refreshes the block's own workspace. */
export function useDeleteOwnedMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: Pick<MaterialListItem, 'id' | 'workspaceId'>) =>
      api.del<void>(`/materials/${id}`),
    onSuccess: (_data, { workspaceId }) => {
      if (workspaceId)
        qc.invalidateQueries({ queryKey: qk.materials(workspaceId) });
      invalidateOwnedMaterials(qc);
      qc.invalidateQueries({ queryKey: qk.trash() });
    },
  });
}

/** Create the quiz or flashcard set a note embeds; the caller inserts the
 * returned id as a reference block. */
export function useCreateEmbeddedMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      noteId,
      ...body
    }: CreateEmbeddedMaterialReq & { noteId: string }) =>
      api.post<Material>(`/materials/${noteId}/embedded`, body),
    onSuccess: () => {
      invalidateOwnedMaterials(qc);
    },
  });
}

/** Create a workspace material of any kind; non-note kinds pass content
 * holding their element. */
export function useCreateMaterial(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMaterialReq) =>
      api.post<Material>(`/workspaces/${wsId}/materials`, body),
    onSuccess: (mt) => {
      if (mt.kind === 'note') track('note_created', { workspaceId: wsId });
      qc.invalidateQueries({ queryKey: qk.materials(wsId) });
      invalidateOwnedMaterials(qc);
      qc.setQueryData(qk.material(mt.id), mt);
    },
  });
}

/** Patch material metadata. Content is authoritative in the Yjs room. */
export function useUpdateMaterial(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateMaterialReq }) =>
      api.patch<MaterialUpdateResult>(`/materials/${id}/metadata`, patch),
    onSuccess: (result, { id, patch }) => {
      invalidateOwnedMaterials(qc);
      qc.setQueryData<Material>(qk.material(id), (current) =>
        current
          ? {
              ...current,
              ...(patch.title === undefined ? {} : { title: patch.title }),
              ...(patch.scopeChapters === undefined
                ? {}
                : { scopeChapters: patch.scopeChapters }),
              ...(patch.scopeFileNames === undefined
                ? {}
                : { scopeFileNames: patch.scopeFileNames }),
              contentBytes: result.contentBytes,
              revision: result.revision,
              updatedAt: result.updatedAt,
            }
          : current
      );
      if (
        patch.title !== undefined ||
        patch.scopeChapters !== undefined ||
        patch.scopeFileNames !== undefined
      ) {
        qc.invalidateQueries({ queryKey: qk.materials(wsId) });
      }
    },
  });
}

/* ---------------- editor collaboration ---------------- */
export const workspaceMembersQuery = (workspaceId: string, enabled = true) =>
  queryOptions({
    enabled: !!workspaceId && enabled,
    queryFn: () =>
      api.get<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`),
    queryKey: qk.workspaceMembers(workspaceId),
  });

export const useWorkspaceMembers = (
  workspaceId: string,
  enabled = true,
  options?: QueryUiOptions
) =>
  useQuery({
    ...workspaceMembersQuery(workspaceId, enabled),
    meta: queryMeta(options),
  });

/**
 * Mention directory. Unlike the member roster this is readable by shared-link
 * collaborators, so the editor may request it without knowing whether the
 * current user holds a membership row.
 */
export const workspaceCollaboratorsQuery = (
  workspaceId: string,
  enabled = true
) =>
  queryOptions({
    enabled: !!workspaceId && enabled,
    queryFn: () =>
      api.get<WorkspaceCollaborator[]>(
        `/workspaces/${workspaceId}/collaborators`
      ),
    queryKey: qk.workspaceCollaborators(workspaceId),
  });

export const useWorkspaceCollaborators = (
  workspaceId: string,
  enabled = true,
  options?: QueryUiOptions
) =>
  useQuery({
    ...workspaceCollaboratorsQuery(workspaceId, enabled),
    meta: queryMeta(options),
  });

/** The owner's pending invites: every typed address, as typed. */
export const useWorkspaceInvites = (
  workspaceId: string,
  options?: QueryUiOptions
) =>
  useQuery({
    enabled: !!workspaceId,
    meta: queryMeta(options),
    queryFn: () =>
      api.get<PendingWorkspaceInvite[]>(`/workspaces/${workspaceId}/invites`),
    queryKey: qk.workspaceInvites(workspaceId),
  });

// Invite and cancel failures render inside the form, not as toasts.
export function useCreateWorkspaceInvite(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: CreateWorkspaceInviteReq) =>
      api.post<void>(`/workspaces/${workspaceId}/invites`, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.workspaceInvites(workspaceId) }),
  });
}

export function useCancelWorkspaceInvite(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (inviteId: string) =>
      api.del<void>(`/workspaces/${workspaceId}/invites/${inviteId}`),
    onSettled: () =>
      qc.invalidateQueries({ queryKey: qk.workspaceInvites(workspaceId) }),
  });
}

export function useAcceptWorkspaceInvite() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (token: string) =>
      api.post<WorkspaceMember>(
        `/workspace-invites/${encodeURIComponent(token)}/accept`
      ),
    onSuccess: (member) => {
      track('invite_accepted', { role: member.role });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: qk.workspace(member.workspaceId) });
      qc.invalidateQueries({
        queryKey: qk.workspaceMembers(member.workspaceId),
      });
      qc.invalidateQueries({ queryKey: qk.notifications });
      qc.invalidateQueries({ queryKey: qk.notificationUnread });
    },
  });
}

export function useUpdateWorkspaceMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      ...body
    }: UpdateWorkspaceMemberReq & { userId: string }) =>
      api.patch<void>(`/workspaces/${workspaceId}/members/${userId}`, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.workspaceMembers(workspaceId) }),
  });
}

/** A member leaving `workspaceId`: the owner's remove call on its own row.
 * Its files drop out of the All files lists and search, as a visitor's do. */
export function useLeaveWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.del<void>(`/workspaces/${workspaceId}/members/${userId}`),
    onSuccess: () => invalidateVisitLists(qc, true),
  });
}

export function useRemoveWorkspaceMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.del<void>(`/workspaces/${workspaceId}/members/${userId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.workspaceMembers(workspaceId) });
      // A removed member also leaves the mention directory. Role changes do
      // not, since the directory carries no roles.
      qc.invalidateQueries({
        queryKey: qk.workspaceCollaborators(workspaceId),
      });
    },
  });
}

export const materialDiscussionsQuery = (materialId: string) =>
  queryOptions({
    enabled: !!materialId,
    queryFn: () =>
      api.get<MaterialDiscussion[]>(`/materials/${materialId}/discussions`),
    queryKey: qk.materialDiscussions(materialId),
  });

export const useMaterialDiscussions = (
  materialId: string,
  options?: QueryUiOptions
) =>
  useQuery({
    ...materialDiscussionsQuery(materialId),
    meta: queryMeta(options),
  });

export function useCreateMaterialDiscussion(materialId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDiscussionReq) =>
      api.post<MaterialDiscussion>(
        `/materials/${materialId}/discussions`,
        body
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.materialDiscussions(materialId) }),
  });
}

export function useCreateMaterialComment(materialId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      discussionId,
      ...body
    }: CreateCommentReq & { discussionId: string }) =>
      api.post<MaterialComment>(`/discussions/${discussionId}/comments`, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.materialDiscussions(materialId) }),
  });
}

export function useUpdateMaterialComment(materialId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      commentId,
      ...body
    }: UpdateCommentReq & { commentId: string }) =>
      api.patch<MaterialComment>(`/comments/${commentId}`, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.materialDiscussions(materialId) }),
  });
}

export function useDeleteMaterialComment(materialId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => api.del<void>(`/comments/${commentId}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.materialDiscussions(materialId) }),
  });
}

export function useDeleteMaterialDiscussion(materialId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (discussionId: string) =>
      api.del<void>(`/discussions/${discussionId}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.materialDiscussions(materialId) }),
  });
}

/** A room token; `keys` asks for a quiz's keys document (editors who can
 * write only, live-items), `read` for a read channel whatever the user may do
 * (a View or a study page, which never write: REVIEW5 N2). `previousToken`,
 * the session's last token for the room, asks for its client id again
 * (Q236). */
export const getMaterialCollaborationToken = (
  materialId: string,
  {
    access,
    document,
    previousToken,
  }: { access?: 'read'; document?: 'keys'; previousToken?: string } = {}
) =>
  api
    .post<MaterialCollaborationToken>(
      `/materials/${materialId}/collaboration-token`,
      document || access || previousToken
        ? { access, document, previousToken }
        : undefined
    )
    .then((token) => {
      // A newer room schema retires the material's agent Undo payloads (Q122).
      sawRoom(token.room);
      return token;
    });

export function useMaterialCollaborationToken(
  materialId: string,
  enabled = true,
  options?: QueryUiOptions
) {
  return useQuery({
    enabled: !!materialId && enabled,
    meta: queryMeta(options),
    queryFn: () => getMaterialCollaborationToken(materialId),
    queryKey: ['material', materialId, 'collaboration-token'],
    staleTime: 3 * 60 * 1000,
  });
}

/** File a material under a chapter (membership), or unfile it (chapterId=null).
 * The API uses an empty-string sentinel to unfile; null maps to "". Optimistic:
 * patches the materials list + single-material caches, rolls back on error. */
export function useMoveMaterial(wsId: string) {
  const qc = useQueryClient();
  return useMutation<
    MaterialUpdateResult,
    Error,
    { id: string; chapterId: string | null },
    { prevList?: MaterialRef[]; prevMaterial?: Material }
  >({
    meta: { errorToast: false },
    mutationFn: ({ id, chapterId }: { id: string; chapterId: string | null }) =>
      api.patch<MaterialUpdateResult>(`/materials/${id}/metadata`, {
        chapterId: chapterId ?? '',
      }),
    mutationKey: contentMutationKey(wsId),
    onError: (_e, { id }, ctx) => {
      if (ctx?.prevList) qc.setQueryData(qk.materials(wsId), ctx.prevList);
      if (ctx?.prevMaterial) qc.setQueryData(qk.material(id), ctx.prevMaterial);
    },
    onMutate: async ({ id, chapterId }) => {
      await qc.cancelQueries({ queryKey: qk.materials(wsId) });
      const prevList = qc.getQueryData<MaterialRef[]>(qk.materials(wsId));
      const prevMaterial = qc.getQueryData<Material>(qk.material(id));
      qc.setQueryData<MaterialRef[]>(qk.materials(wsId), (prev) =>
        prev?.map((r) => (r.id === id ? { ...r, chapterId } : r))
      );
      qc.setQueryData<Material>(qk.material(id), (prev) =>
        prev ? { ...prev, chapterId } : prev
      );
      return { prevList, prevMaterial };
    },
    onSettled: () => refetchContentIfLast(qc, wsId),
    onSuccess: (result) =>
      qc.setQueryData<Material>(qk.material(result.id), (current) =>
        current ? { ...current, ...result } : current
      ),
  });
}

/* ---------------- quizzes ---------------- */
export const quizQuery = (id: string) =>
  queryOptions({
    enabled: !!id,
    queryFn: () => api.get<Quiz>(`/quizzes/${id}`),
    queryKey: qk.quiz(id),
  });
export const useQuiz = (
  id: string,
  options?: QueryUiOptions & { fresh?: boolean }
) =>
  useQuery({
    ...quizQuery(id),
    ...(options?.fresh ? { refetchOnMount: 'always' as const } : {}),
    meta: queryMeta(options),
  });
/** The quiz with its answer key, for those who may edit it (the editor and
 * note export). Every other read is answer-free. */
export const quizEditQuery = (id: string) =>
  queryOptions({
    enabled: !!id,
    queryFn: () => api.get<EditableQuiz>(`/quizzes/${id}/edit`),
    queryKey: [...qk.quiz(id), 'edit'] as const,
  });

const ATTEMPTS_PAGE = 30;
/** Learning → All results: quiz and flashcard attempts, newest first by default. */
export const attemptsQuery = (params: AttemptParams = {}) => ({
  getNextPageParam: (
    last: { items: Attempt[]; more: boolean },
    pages: unknown[]
  ) => (last.more ? pages.length * ATTEMPTS_PAGE : undefined),
  initialPageParam: 0,
  queryFn: ({ pageParam }: { pageParam: number }) =>
    api.get<{ items: Attempt[]; more: boolean }>(
      `/attempts${listSearch(
        {
          dir: params.dir,
          kind: params.kinds,
          limit: String(ATTEMPTS_PAGE),
          offset: pageParam ? String(pageParam) : undefined,
          sort: params.sort,
          workspaceId: params.workspaceIds,
        },
        ''
      )}`
    ),
  queryKey: qk.attempts(params),
});
export const useAttempts = (params: AttemptParams = {}) =>
  useInfiniteQuery({
    ...attemptsQuery(params),
    placeholderData: keepPreviousData,
  });

// Persisted: the quiz page resumes its open attempt from it.
export const attemptQuery = (id: string) =>
  queryOptions({
    ...persisted,
    enabled: !!id,
    queryFn: () => api.get<AttemptDetail>(`/attempts/${id}`),
    queryKey: qk.attempt(id),
  });
export const useAttempt = (id: string, options?: QueryUiOptions) =>
  useQuery({ ...attemptQuery(id), meta: queryMeta(options) });

/** Invalidate every workspace's materials list (quiz/flashcardSet edits change titles
 * shown in the left panel but don't carry a workspace id). */
function invalidateAllMaterials(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({
    predicate: (q) =>
      Array.isArray(q.queryKey) &&
      q.queryKey[0] === 'workspace' &&
      q.queryKey[2] === 'materials',
  });
  invalidateOwnedMaterials(qc);
}

export function useCreateQuiz() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateQuizReq) =>
      api.post<EditableQuiz>('/quizzes', body),
    onSuccess: () => {
      invalidateOwnedMaterials(qc);
      invalidateAllMaterials(qc);
    },
  });
}
function invalidateQuiz(qc: ReturnType<typeof useQueryClient>, id: string) {
  invalidateOwnedMaterials(qc);
  qc.invalidateQueries({ queryKey: qk.quiz(id) });
  qc.invalidateQueries({ queryKey: qk.material(id) });
  invalidateAllMaterials(qc);
}

export function useUpdateQuizSharing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: UpdateStandaloneSharingReq & { id: string }) =>
      api.patch<EditableQuiz>(`/quizzes/${id}/sharing`, body),
    onSuccess: (_d, v) => invalidateQuiz(qc, v.id),
  });
}
export function useDeleteQuiz() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/quizzes/${id}`),
    onSuccess: () => {
      invalidateOwnedMaterials(qc);
      qc.invalidateQueries({ queryKey: qk.trash() });
      invalidateAllMaterials(qc);
    },
  });
}
/** Checks one question of a quiz attempt: the server grades it, adds it to
 * the attempt (a new one when `attemptId` is missing or unknown) and returns
 * the attempt so far, with the key for each checked question. */
export function useCheckQuizQuestion(options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: ({
      quizId,
      ...body
    }: CheckQuizQuestionReq & { quizId: string }) =>
      api.post<AttemptDetail>(`/quizzes/${quizId}/check`, body),
    onSuccess: (attempt) => {
      // An embedded quiz records nothing: its attempt comes back without an id.
      if (!attempt.id) return;
      qc.setQueryData(qk.attempt(attempt.id), attempt);
      qc.invalidateQueries({ queryKey: qk.attemptsRoot });
      void invalidateStudy(qc);
    },
  });
}

/* ---------------- flashcards ---------------- */
export function useCreateFlashcardSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFlashcardSetReq) =>
      api.post<FlashcardSet>('/flashcards', body),
    onSuccess: () => {
      invalidateAllMaterials(qc);
    },
  });
}

export const flashcardSetQuery = (id: string) =>
  queryOptions({
    enabled: !!id,
    queryFn: () => api.get<FlashcardSet>(`/flashcards/${id}`),
    queryKey: qk.flashcardSet(id),
  });

export const useFlashcardSet = (
  id: string,
  options?: QueryUiOptions & { fresh?: boolean }
) =>
  useQuery({
    ...flashcardSetQuery(id),
    ...(options?.fresh ? { refetchOnMount: 'always' as const } : {}),
    meta: queryMeta(options),
  });

export const cardsQuery = (flashcardSetId: string) =>
  queryOptions({
    enabled: !!flashcardSetId,
    queryFn: () => api.get<Flashcard[]>(`/flashcards/${flashcardSetId}/cards`),
    queryKey: qk.cards(flashcardSetId),
  });
export const useCards = (
  flashcardSetId: string,
  options?: QueryUiOptions & { fresh?: boolean }
) =>
  useQuery({
    ...cardsQuery(flashcardSetId),
    ...(options?.fresh ? { refetchOnMount: 'always' as const } : {}),
    meta: queryMeta(options),
  });
/* ---------------- study progress and review ---------------- */
export const workspaceStudyQuery = (workspaceId: string) =>
  queryOptions({
    ...persisted,
    queryFn: () => api.get<StudySummary>(`/workspaces/${workspaceId}/study`),
    queryKey: qk.study(workspaceId),
  });
/** The requester's own progress in a workspace: marks, Study tab, Continue. */
export const useWorkspaceStudy = (
  workspaceId: string,
  options?: QueryUiOptions
) =>
  useQuery({ ...workspaceStudyQuery(workspaceId), meta: queryMeta(options) });

/** The workspace's summary with its review parts (Reviewable, Quick review,
 * Continue review) drawn from one of the user's plans kept in it. */
export const usePlanStudy = (
  workspaceId: string,
  planId: string | undefined,
  options?: QueryUiOptions
) =>
  useQuery({
    ...persisted,
    enabled: !!planId,
    meta: queryMeta(options),
    queryFn: () =>
      api.get<StudySummary>(
        `/workspaces/${workspaceId}/study${listSearch({ planId }, '')}`
      ),
    queryKey: qk.planStudy(workspaceId, planId ?? ''),
  });

/** Each quiz's and set's attempt count and latest attempts in a workspace,
 * for the Study progress page; refreshed with the Study tab. */
export const workspaceAttemptsQuery = (workspaceId: string) =>
  queryOptions({
    queryFn: () =>
      api.get<{ items: ItemAttempts[] }>(
        `/workspaces/${workspaceId}/study/attempts`
      ),
    queryKey: qk.studyAttempts(workspaceId),
  });
export const useWorkspaceAttempts = (
  workspaceId: string,
  options?: QueryUiOptions
) =>
  useQuery({
    ...workspaceAttemptsQuery(workspaceId),
    meta: queryMeta(options),
  });

/** Refreshes the Study tab, marks, review and Learning after practice in
 * `workspaceId`, or in every workspace when the caller does not know which. */
export function invalidateStudy(
  qc: ReturnType<typeof useQueryClient>,
  workspaceId?: string
) {
  // qk.study and qk.workspaceReview: ['workspace', id, 'study' | 'review'];
  // every workspace's plans and plan summaries, since a plan counts steps
  // and draws review items from other workspaces.
  return Promise.all([
    qc.invalidateQueries({
      predicate: ({ queryKey: [scope, id, kind, part] }) =>
        scope === 'workspace' &&
        (((!workspaceId || id === workspaceId) &&
          (kind === 'study' || kind === 'review')) ||
          (kind === 'study' && (part === 'plans' || part === 'plan'))),
    }),
    qc.invalidateQueries({ queryKey: qk.reviewRoot }),
    qc.invalidateQueries({ queryKey: qk.learningRoot }),
  ]);
}

/** Mark as read (done), Stop tracking (removed), or untouched again (null). */
export function useSetStudyItem(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, SetStudyItemReq, { prev?: StudySummary }>({
    mutationFn: (body) =>
      api.put<void>(`/workspaces/${workspaceId}/study/items`, body),
    mutationKey: qk.study(workspaceId),
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.study(workspaceId), ctx.prev);
    },
    // The read toggle and row marks flip at once; the refetch settles it.
    onMutate: async ({ fileId, materialId, state }) => {
      await qc.cancelQueries({ queryKey: qk.study(workspaceId) });
      const prev = qc.getQueryData<StudySummary>(qk.study(workspaceId));
      qc.setQueryData<StudySummary>(qk.study(workspaceId), (summary) => {
        if (!summary) return summary;
        const items = summary.items.filter((it) =>
          fileId ? it.fileId !== fileId : it.materialId !== materialId
        );
        if (state)
          items.push({
            fileId,
            materialId,
            state,
            updatedAt: new Date().toISOString(),
          });
        return { ...summary, items };
      });
      return { prev };
    },
    onSettled: () =>
      refetchIfLast(qc, qk.study(workspaceId), () =>
        invalidateStudy(qc, workspaceId)
      ),
  });
}

export function useSetWorkspaceStudyEnabled(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<void>(`/workspaces/${workspaceId}/study/enabled`, { enabled }),
    onSuccess: () => invalidateStudy(qc, workspaceId),
  });
}

export function useResetWorkspaceStudy(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>(`/workspaces/${workspaceId}/study/reset`),
    onSuccess: () => invalidateStudy(qc, workspaceId),
  });
}

/** A new review session: a suggestion's items, or the whole workspace's
 * without a mode. Fetched fresh for each session. */
export const workspaceReviewQuery = (workspaceId: string, start: ReviewStart) =>
  queryOptions({
    queryFn: () =>
      api.get<ReviewSession>(
        `/workspaces/${workspaceId}/review${listSearch({ ...start }, '')}`
      ),
    queryKey: qk.workspaceReview(workspaceId, start),
    staleTime: 0,
  });
export const useWorkspaceReview = (
  workspaceId: string,
  start: ReviewStart,
  options?: QueryUiOptions & { enabled?: boolean }
) =>
  useQuery({
    ...workspaceReviewQuery(workspaceId, start),
    enabled: options?.enabled,
    meta: queryMeta(options),
  });

/** An unfinished session's items still to answer, for Continue. */
export const useResumeReviewSession = (
  sessionId: string,
  options?: QueryUiOptions & { enabled?: boolean }
) =>
  useQuery({
    enabled: options?.enabled,
    meta: queryMeta(options),
    queryFn: () => api.get<ReviewSession>(`/review/sessions/${sessionId}`),
    queryKey: qk.reviewSession(sessionId),
    staleTime: 0,
  });

/** A session's result page, finished or just ended. */
export const useReviewResult = (
  sessionId: string,
  options?: QueryUiOptions & { enabled?: boolean }
) =>
  useQuery({
    enabled: options?.enabled,
    meta: queryMeta(options),
    queryFn: () =>
      api.get<ReviewResult>(`/review/sessions/${sessionId}/result`),
    queryKey: qk.reviewResult(sessionId),
  });

/** Ends a session before its last item (Done). */
export function useFinishReviewSession() {
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (sessionId: string) =>
      api.post<void>(`/review/sessions/${sessionId}/finish`),
  });
}

/** Learning → Review: suggestions, sessions to continue, every workspace. */
export const reviewOverviewQuery = () =>
  queryOptions({
    ...persisted,
    queryFn: () => api.get<ReviewOverview>('/review/overview'),
    queryKey: qk.reviewOverview,
  });
export const useReviewOverview = (options?: QueryUiOptions) =>
  useQuery({ ...reviewOverviewQuery(), meta: queryMeta(options) });

const PAST_REVIEWS_PAGE = 30;
/** Learning → Past reviews: finished sessions, newest first by default. */
export const pastReviewsQuery = (params: PastReviewParams = {}) => ({
  getNextPageParam: (
    last: { items: PastReview[]; more: boolean },
    pages: unknown[]
  ) => (last.more ? pages.length * PAST_REVIEWS_PAGE : undefined),
  initialPageParam: 0,
  queryFn: ({ pageParam }: { pageParam: number }) =>
    api.get<{ items: PastReview[]; more: boolean }>(
      `/review/sessions${listSearch(
        {
          dir: params.dir,
          has: params.has,
          limit: String(PAST_REVIEWS_PAGE),
          offset: pageParam ? String(pageParam) : undefined,
          sort: params.sort,
          workspaceId: params.workspaceIds,
        },
        ''
      )}`
    ),
  queryKey: qk.pastReviews(params),
});
export const usePastReviews = (params: PastReviewParams = {}) =>
  useInfiniteQuery({
    ...pastReviewsQuery(params),
    placeholderData: keepPreviousData,
  });

/** Learning → Progress: workspaces in progress and finished, the leading
 * one's items; `lead` asks for that listed workspace's map instead. */
export const learningProgressQuery = (lead?: string, all = false) =>
  queryOptions({
    ...persisted,
    queryFn: () =>
      api.get<LearningProgress>(
        `/learning/progress${listSearch({ all: all ? 'true' : undefined, lead }, '')}`
      ),
    queryKey: [...qk.learningProgress, lead ?? null, all],
  });
/** `all` (Show all) also lists workspaces hiding study progress. */
export const useLearningProgress = (
  lead?: string,
  all = false,
  options?: QueryUiOptions
) =>
  useQuery({
    ...learningProgressQuery(lead, all),
    meta: queryMeta(options),
    placeholderData: keepPreviousData,
  });

/* ---------------- study plans ---------------- */
/** Plans kept in a workspace, then the user's plans elsewhere with a step in it. */
export const workspacePlansQuery = (workspaceId: string) =>
  queryOptions({
    ...persisted,
    queryFn: () =>
      api.get<StudyPlans>(`/workspaces/${workspaceId}/study/plans`),
    queryKey: qk.studyPlans(workspaceId),
  });
export const useWorkspacePlans = (
  workspaceId: string,
  options?: QueryUiOptions
) =>
  useQuery({ ...workspacePlansQuery(workspaceId), meta: queryMeta(options) });

/** Every plan of the user, for Learning → Progress. */
export const useLearningPlans = (options?: QueryUiOptions) =>
  useQuery({
    meta: queryMeta(options),
    queryFn: () => api.get<StudyPlans>('/learning/plans'),
    queryKey: qk.learningPlans,
  });

const invalidatePlans = (qc: QueryClient) =>
  Promise.all([
    qc.invalidateQueries({
      // The plans, and each plan's review parts its steps feed.
      predicate: ({ queryKey: [scope, , kind, part] }) =>
        scope === 'workspace' &&
        kind === 'study' &&
        (part === 'plans' || part === 'plan'),
    }),
    qc.invalidateQueries({ queryKey: qk.learningPlans }),
  ]);

export function useCreateStudyPlan(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<StudyPlan>(`/workspaces/${workspaceId}/study/plans`, { name }),
    onSettled: () => invalidatePlans(qc),
  });
}

/** Renames a plan and/or replaces its steps. Optimistic in the workspace's
 * list, so a dragged row lands at once; the refetch settles it. */
export function useUpdateStudyPlan(workspaceId: string) {
  const qc = useQueryClient();
  type Patch = { id: string; name?: string; steps?: PlanStepInput[] };
  return useMutation<void, Error, Patch, { prev?: StudyPlans }>({
    mutationFn: ({ id, ...body }) =>
      api.patch<void>(`/study/plans/${id}`, body),
    mutationKey: qk.studyPlans(workspaceId),
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.studyPlans(workspaceId), ctx.prev);
    },
    onMutate: async ({ id, name, steps }) => {
      await qc.cancelQueries({ queryKey: qk.studyPlans(workspaceId) });
      const prev = qc.getQueryData<StudyPlans>(qk.studyPlans(workspaceId));
      qc.setQueryData<StudyPlans>(qk.studyPlans(workspaceId), (list) => {
        if (!list) return list;
        return {
          ...list,
          plans: list.plans.map((p) => {
            if (p.id !== id) return p;
            // Held steps keep their titles; new ones are in the list at once
            // (a save before the refetch must keep them) and get theirs then.
            const held = new Map(
              p.steps.map((st) => [stepKey(st), st] as const)
            );
            return {
              ...p,
              name: name ?? p.name,
              steps: steps
                ? steps.map(
                    (st) =>
                      held.get(stepKey(st)) ?? {
                        ...st,
                        locked: false,
                        title: '',
                      }
                  )
                : p.steps,
            };
          }),
        };
      });
      return { prev };
    },
    onSettled: () =>
      refetchIfLast(qc, qk.studyPlans(workspaceId), () => invalidatePlans(qc)),
  });
}

/** One identity per step target, the server's uniqueness. */
export const stepKey = (st: PlanStepInput) =>
  `${st.kind}:${st.workspaceId}:${st.targetId}`;

export function useDeleteStudyPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/study/plans/${id}`),
    onSettled: () => invalidatePlans(qc),
  });
}

/** Records one rating; the study page toasts a failure once. Each rating
 * refreshes `workspaceId`'s progress, or every workspace's when omitted; a
 * review session passes `null` and refreshes once it ends. */
export function useRateReviewItem(workspaceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: RateReviewItemReq) =>
      api.post<void>('/review/ratings', body),
    onSuccess: (_d, body) => {
      if (body.attempt) qc.invalidateQueries({ queryKey: qk.attemptsRoot });
      if (workspaceId !== null) void invalidateStudy(qc, workspaceId);
    },
  });
}

/* ---------------- schedule ---------------- */
export const eventsQuery = () =>
  queryOptions({
    ...persisted,
    queryFn: () => api.get<CalendarEvent[]>('/events'),
    queryKey: qk.events,
  });
export const useEvents = (options?: QueryUiOptions) =>
  useQuery({ ...eventsQuery(), meta: queryMeta(options) });

export const labelsQuery = () =>
  queryOptions({
    ...persisted,
    queryFn: () => api.get<Label[]>('/labels'),
    queryKey: qk.labels,
  });
export const useLabels = (options?: QueryUiOptions) =>
  useQuery({ ...labelsQuery(), meta: queryMeta(options) });
export function useUpdateLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateLabelReq & { id: string }) =>
      api.patch<Label>(`/labels/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.labels }),
  });
}
export function useDeleteLabel() {
  const qc = useQueryClient();
  return useMutation({
    // A label that is already gone counts as deleted: no toast, the list
    // refreshes (Epo 2026-10-21).
    mutationFn: async (id: string) => {
      try {
        await api.del<void>(`/labels/${id}`);
      } catch (error) {
        if (!(isApiError(error) && error.status === 404)) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.labels });
      qc.invalidateQueries({ queryKey: qk.events });
    },
  });
}
export function useCreateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEventReq) =>
      api.post<CalendarEvent>('/events', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.events }),
  });
}
export function useUpdateEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateEventReq & { id: string }) =>
      api.patch<CalendarEvent>(`/events/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.events }),
  });
}

/* ---------------- tasks ---------------- */
export const tasksQuery = () =>
  queryOptions({
    ...persisted,
    queryFn: () => api.get<Task[]>('/tasks'),
    queryKey: qk.tasks,
  });
export const useTasks = (options?: QueryUiOptions) =>
  useQuery({ ...tasksQuery(), meta: queryMeta(options) });

interface TasksMutationContext {
  prev?: Task[];
}

function patchTasksCache(
  qc: ReturnType<typeof useQueryClient>,
  mutate: (tasks: Task[]) => Task[]
) {
  const prev = qc.getQueryData<Task[]>(qk.tasks);
  if (prev) qc.setQueryData<Task[]>(qk.tasks, mutate(prev));
  return prev;
}

export function useToggleTask() {
  const qc = useQueryClient();
  return useMutation<
    Task,
    Error,
    { id: string; done: boolean },
    TasksMutationContext
  >({
    meta: { errorToast: false },
    mutationFn: ({ id, done }) => api.patch<Task>(`/tasks/${id}`, { done }),
    mutationKey: qk.tasks,
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.tasks, ctx.prev);
    },
    onMutate: async ({ id, done }) => {
      await qc.cancelQueries({ queryKey: qk.tasks });
      const prev = patchTasksCache(qc, (tasks) =>
        tasks.map((t) => (t.id === id ? { ...t, done } : t))
      );
      return { prev };
    },
    onSettled: () =>
      refetchIfLast(qc, qk.tasks, () =>
        qc.invalidateQueries({ queryKey: qk.tasks })
      ),
  });
}
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation<
    Task,
    Error,
    UpdateTaskReq & { id: string },
    TasksMutationContext
  >({
    meta: { errorToast: false },
    mutationFn: ({ id, ...patch }) => api.patch<Task>(`/tasks/${id}`, patch),
    mutationKey: qk.tasks,
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.tasks, ctx.prev);
    },
    onMutate: async ({ id, ...patch }) => {
      await qc.cancelQueries({ queryKey: qk.tasks });
      const prev = patchTasksCache(qc, (tasks) =>
        tasks.map((t) => (t.id === id ? { ...t, ...patch } : t))
      );
      return { prev };
    },
    onSettled: () =>
      refetchIfLast(qc, qk.tasks, () =>
        qc.invalidateQueries({ queryKey: qk.tasks })
      ),
  });
}
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation<void, Error, string, TasksMutationContext>({
    meta: { errorToast: false },
    mutationFn: (id) => api.del<void>(`/tasks/${id}`),
    mutationKey: qk.tasks,
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.tasks, ctx.prev);
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.tasks });
      const prev = patchTasksCache(qc, (tasks) =>
        tasks.filter((t) => t.id !== id)
      );
      return { prev };
    },
    onSettled: () =>
      refetchIfLast(qc, qk.tasks, () =>
        qc.invalidateQueries({ queryKey: qk.tasks })
      ),
  });
}

/* ---------------- explore ---------------- */
// Explore lists come 50 at a time, most cloned first.
export const exploreWorkspacesQuery = () => ({
  ...persisted,
  getNextPageParam: (last: PublicWorkspacePage) => last.nextCursor || undefined,
  initialPageParam: '',
  queryFn: ({ pageParam }: { pageParam: string }) =>
    api.get<PublicWorkspacePage>(
      `/explore/workspaces${listSearch({}, pageParam)}`
    ),
  queryKey: qk.exploreWorkspaces,
});
export const useExploreWorkspaces = () =>
  useInfiniteQuery(exploreWorkspacesQuery());

export const exploreQuizzesQuery = () => ({
  ...persisted,
  getNextPageParam: (last: PublicQuizPage) => last.nextCursor || undefined,
  initialPageParam: '',
  queryFn: ({ pageParam }: { pageParam: string }) =>
    api.get<PublicQuizPage>(`/explore/quizzes${listSearch({}, pageParam)}`),
  queryKey: qk.exploreQuizzes,
});
export const useExploreQuizzes = () => useInfiniteQuery(exploreQuizzesQuery());

export const exploreFlashcardSetsQuery = () => ({
  ...persisted,
  getNextPageParam: (last: PublicFlashcardSetPage) =>
    last.nextCursor || undefined,
  initialPageParam: '',
  queryFn: ({ pageParam }: { pageParam: string }) =>
    api.get<PublicFlashcardSetPage>(
      `/explore/flashcards${listSearch({}, pageParam)}`
    ),
  queryKey: qk.exploreFlashcardSets,
});
export const useExploreFlashcardSets = () =>
  useInfiniteQuery(exploreFlashcardSetsQuery());

/* ---------------- sharing & cloning ---------------- */

/** Deep-copy a shared workspace (chapters, files, materials and — via the
 * pipeline — the parsed knowledge graph) into the caller's account, under the
 * name, description, icon, tags and cover in `body`. */
export function useCloneWorkspace(options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: ({ id, body }: { id: string; body: CreateWorkspaceReq }) =>
      api.post<CloneWorkspaceResult>(`/workspaces/${id}/clone`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      invalidateOwnedMaterials(qc);
      qc.invalidateQueries({ queryKey: qk.exploreWorkspaces });
    },
  });
}

/** Rename or recolor flashcards without touching Plate content. */
export function useUpdateFlashcardSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateFlashcardSetReq & { id: string }) =>
      api.patch<FlashcardSet>(`/flashcards/${id}/metadata`, body),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: qk.flashcardSet(v.id) });
      invalidateAllMaterials(qc);
    },
  });
}

export function useUpdateFlashcardSetSharing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: UpdateStandaloneSharingReq & { id: string }) =>
      api.patch<FlashcardSet>(`/flashcards/${id}/sharing`, body),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: qk.flashcardSet(v.id) });
      invalidateAllMaterials(qc);
    },
  });
}
