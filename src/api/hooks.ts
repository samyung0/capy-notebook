import type { QueryClient } from '@tanstack/react-query';
import {
  type InfiniteData,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { NOTIFICATION_PAGE_SIZE } from '@/lib/const';
import { USE_MSW } from './auth';
import { API_BASE, api, qk } from './client';
import {
  type NotificationStreamEvent,
  readNotificationStream,
} from './notificationStream';
import type {
  AccountStatus,
  Attempt,
  AttemptDetail,
  BillingCheckoutReq,
  BillingInfo,
  CalendarEvent,
  Chapter,
  CloneWorkspaceResult,
  ContentOrderItem,
  Conversation,
  CreateAttemptReq,
  CreateCardReq,
  CreateCommentReq,
  CreateDeckReq,
  CreateDiscussionReq,
  CreateEventReq,
  CreateMaterialReq,
  CreateQuizReq,
  CreateWorkspaceInviteReq,
  CreateWorkspaceReq,
  Deck,
  DeletionPreflight,
  FileStatus,
  Flashcard,
  GenerateOptions,
  IntegrationsStatus,
  Label,
  Material,
  MaterialCollaborationToken,
  MaterialComment,
  MaterialDiscussion,
  MaterialRef,
  MaterialRevision,
  MaterialUpdateResult,
  NotificationCount,
  NotificationPage,
  NotificationPrefs,
  PublicDeck,
  PublicQuiz,
  PublicWorkspace,
  Quiz,
  RecentFile,
  SaveCanvasReq,
  SearchResult,
  SourceFile,
  SourceUploadPolicy,
  Tag,
  Task,
  ThinkingCanvas,
  UpdateCardReq,
  UpdateChapterReq,
  UpdateCommentReq,
  UpdateDeckReq,
  UpdateDiscussionReq,
  UpdateEventReq,
  UpdateFileReq,
  UpdateLabelReq,
  UpdateMaterialReq,
  UpdateQuizReq,
  UpdateTaskReq,
  UpdateWorkspaceMemberReq,
  UpdateWorkspaceReq,
  UpdateWorkspaceSharingReq,
  URLResp,
  User,
  WireMessage,
  Workspace,
  WorkspaceCollaborator,
  WorkspaceMember,
  WorkspaceStats,
} from './types';

const USE_DIRECT_B2_UPLOAD = import.meta.env.VITE_DIRECT_B2_UPLOAD !== 'false';

export interface QueryUiOptions {
  errorBoundary?: false;
}

export interface MutationUiOptions {
  errorToast?: false;
}

function queryMeta(options?: QueryUiOptions) {
  return options?.errorBoundary === false
    ? ({ errorBoundary: false } as const)
    : undefined;
}

function mutationMeta(options?: MutationUiOptions) {
  return options?.errorToast === false
    ? ({ errorToast: false } as const)
    : undefined;
}

/* ---------------- account / shell ---------------- */
export const meQuery = () =>
  queryOptions({ queryFn: () => api.get<User>('/me'), queryKey: qk.me });
export const useMe = (options?: QueryUiOptions) =>
  useQuery({ ...meQuery(), meta: queryMeta(options) });

export const accountStatusQuery = () =>
  queryOptions({
    queryFn: () => api.get<AccountStatus>('/account/status'),
    queryKey: qk.accountStatus,
  });
export const useAccountStatus = (options?: QueryUiOptions) =>
  useQuery({ ...accountStatusQuery(), meta: queryMeta(options) });

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
    mutationFn: (confirmEmail: string) =>
      api.post<AccountStatus>('/account/deletion', { confirmEmail }),
    onSuccess: (status) => {
      qc.setQueryData(qk.accountStatus, status);
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
      void qc.invalidateQueries({ queryKey: qk.accountStatus });
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
type NotificationStreamState = {
  status: 'connecting' | 'connected' | 'disconnected';
};

export const useNotifications = (options?: QueryUiOptions) =>
  useInfiniteQuery<
    NotificationPage,
    Error,
    NotificationCache,
    typeof qk.notifications,
    string
  >({
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
    meta: queryMeta(options),
    queryFn: () => api.get<NotificationCount>('/notifications/unread-count'),
    queryKey: qk.notificationUnread,
  });

export function applyNotificationEvent(
  qc: QueryClient,
  event: NotificationStreamEvent
) {
  if (event.type === 'created' && event.notification) {
    const notification = event.notification;
    const current = qc.getQueryData<NotificationCache>(qk.notifications);
    if (!current) {
      void qc.invalidateQueries({ queryKey: qk.notifications });
      void qc.invalidateQueries({ queryKey: qk.notificationUnread });
      return;
    }
    const previous = current.pages
      .flatMap((page) => page.items)
      .find((item) => item.id === notification.id);
    const wasUnread = previous ? previous.readAt == null : false;
    const isUnread = notification.readAt == null;
    qc.setQueryData<NotificationCache>(qk.notifications, (cache) => {
      if (!cache) return cache;
      const pages = cache.pages.map((page) => ({
        ...page,
        items: page.items.filter((item) => item.id !== notification.id),
      }));
      if (!pages[0]) return cache;
      pages[0] = {
        ...pages[0],
        items: [notification, ...pages[0].items].slice(
          0,
          NOTIFICATION_PAGE_SIZE
        ),
      };
      return { ...cache, pages };
    });
    if (wasUnread !== isUnread) {
      const count = qc.getQueryData<NotificationCount>(qk.notificationUnread);
      if (count) {
        qc.setQueryData(qk.notificationUnread, {
          count: Math.max(0, count.count + (isUnread ? 1 : -1)),
        });
      } else {
        void qc.invalidateQueries({ queryKey: qk.notificationUnread });
      }
    }
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

export function useNotificationStream(enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || USE_MSW) {
      return;
    }
    let stopped = false;
    let controller: AbortController | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let delay = 1000;

    const reconcile = () => {
      void qc.refetchQueries({ queryKey: qk.notifications, type: 'active' });
      void qc.refetchQueries({
        queryKey: qk.notificationUnread,
        type: 'active',
      });
    };
    const markDisconnected = () => {
      qc.setQueryData<NotificationStreamState>(qk.notificationStream, {
        status: 'disconnected',
      });
      if (!pollTimer) {
        pollTimer = setInterval(reconcile, 30_000);
      }
    };
    const markConnected = () => {
      qc.setQueryData<NotificationStreamState>(qk.notificationStream, {
        status: 'connected',
      });
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      // Redis Pub/Sub is not durable; always reconcile after every connect.
      reconcile();
    };
    const connect = async () => {
      if (stopped) return;
      qc.setQueryData<NotificationStreamState>(qk.notificationStream, {
        status: 'connecting',
      });
      controller = new AbortController();
      try {
        await readNotificationStream(
          (event) => applyNotificationEvent(qc, event),
          controller.signal,
          markConnected
        );
        // A clean end is the server's bounded stream lifetime, not a fault.
        delay = 1000;
      } catch {
        delay = Math.min(delay * 2, 30_000);
      }
      if (stopped) return;
      markDisconnected();
      retryTimer = setTimeout(connect, delay);
    };
    void connect();

    return () => {
      stopped = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearInterval(pollTimer);
      qc.removeQueries({ queryKey: qk.notificationStream });
    };
  }, [enabled, qc]);
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

export const useNotificationPrefs = (options?: QueryUiOptions) =>
  useQuery({
    meta: queryMeta(options),
    queryFn: () => api.get<NotificationPrefs>('/notification-prefs'),
    queryKey: qk.notificationPrefs,
  });

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
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.notificationPrefs });
    },
    onSuccess: (prefs) => qc.setQueryData(qk.notificationPrefs, prefs),
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
export const useBilling = (options?: QueryUiOptions) =>
  useQuery({ ...billingQuery(), meta: queryMeta(options) });

export function useBillingCheckout() {
  return useMutation({
    mutationFn: (planTier: BillingCheckoutReq['planTier']) =>
      api.post<URLResp>('/billing/checkout', { planTier }),
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

export const integrationsQuery = () =>
  queryOptions({
    queryFn: () => api.get<IntegrationsStatus>('/integrations'),
    queryKey: qk.integrations,
  });
export const useIntegrations = (options?: QueryUiOptions) =>
  useQuery({ ...integrationsQuery(), meta: queryMeta(options) });

export function useImportSources(
  workspaceId: string,
  options?: MutationUiOptions
) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (body: {
      provider: 'google' | 'microsoft';
      fileIds: string[];
      chapterId?: string | null;
    }) =>
      api.post<SourceFile[]>(`/workspaces/${workspaceId}/sources/import`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.files(workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspaceStats(workspaceId) });
    },
  });
}

export function useMicrosoftRecentFiles(
  enabled: boolean,
  options?: QueryUiOptions
) {
  return useQuery({
    enabled,
    meta: queryMeta(options),
    queryFn: () => api.get<RecentFile[]>('/integrations/microsoft/recent'),
    queryKey: ['integrations', 'microsoft', 'recent'],
  });
}

/* ---------------- tags ---------------- */
/** The user's tag catalog for one kind — feeds the reuse-existing autocomplete.
 * Loaded once and filtered client-side (no per-keystroke request). */
export const tagsQuery = (kind = 'workspace') =>
  queryOptions({
    queryFn: () => api.get<Tag[]>(`/tags?kind=${encodeURIComponent(kind)}`),
    queryKey: qk.tags(kind),
  });
export const useTags = (kind = 'workspace', options?: QueryUiOptions) =>
  useQuery({ ...tagsQuery(kind), meta: queryMeta(options) });

/* ---------------- workspaces ---------------- */
export interface WorkspaceQuery {
  /** One or more colors; OR-matched with tags on the server. */
  color?: string | string[];
  q?: string;
  sort?: string;
  /** One or more tag values; OR-matched with colors on the server. */
  tag?: string | string[];
}
export const workspacesQuery = (params: WorkspaceQuery = {}) => {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.sort) search.set('sort', params.sort);
  const colors = Array.isArray(params.color)
    ? params.color
    : params.color
      ? [params.color]
      : [];
  const tags = Array.isArray(params.tag)
    ? params.tag
    : params.tag
      ? [params.tag]
      : [];
  if (colors.length) search.set('color', colors.join(','));
  if (tags.length) search.set('tag', tags.join(','));
  const qs = search.toString();
  return queryOptions({
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
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: qk.workspace(v.id) });
      qc.invalidateQueries({ queryKey: ['tags'] });
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

/* ---------------- chapters & files ---------------- */
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
    enabled: !!wsId,
    queryFn: () => api.get<Chapter[]>(`/workspaces/${wsId}/chapters`),
    queryKey: qk.chapters(wsId),
  });
export const useChapters = (wsId: string, options?: QueryUiOptions) =>
  useQuery({ ...chaptersQuery(wsId), meta: queryMeta(options) });

export const filesQuery = (wsId: string) =>
  queryOptions({
    enabled: !!wsId,
    queryFn: () => api.get<SourceFile[]>(`/workspaces/${wsId}/files`),
    queryKey: qk.files(wsId),
  });
export const useFiles = (wsId: string, options?: QueryUiOptions) =>
  useQuery({ ...filesQuery(wsId), meta: queryMeta(options) });

export const useFile = (id: string | null, options?: QueryUiOptions) =>
  useQuery({
    enabled: !!id,
    meta: queryMeta(options),
    queryFn: () => api.get<SourceFile>(`/files/${id}`),
    queryKey: qk.file(id ?? ''),
  });

export const allFilesQuery = () =>
  queryOptions({
    queryFn: () => api.get<SourceFile[]>('/files'),
    queryKey: ['files', 'all'],
  });
export const useAllFiles = () => useQuery(allFilesQuery());

export function useUpdateFile(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateFileReq & { id: string }) =>
      api.patch<SourceFile>(`/files/${id}`, body),
    onSuccess: (file) => {
      qc.invalidateQueries({ queryKey: qk.files(wsId) });
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
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.files(wsId) });
      qc.invalidateQueries({ queryKey: qk.chapters(wsId) });
    },
  });
}
export function useDeleteFile(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/files/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.files(wsId) });
      qc.invalidateQueries({ queryKey: qk.chapters(wsId) });
      qc.invalidateQueries({ queryKey: qk.workspaceStats(wsId) });
    },
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
  return useMutation({
    mutationFn: (ids: string[]) =>
      api.post<void>(`/workspaces/${wsId}/chapters/reorder`, { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.chapters(wsId) }),
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
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.files(wsId) }),
        qc.invalidateQueries({ queryKey: qk.materials(wsId) }),
        qc.invalidateQueries({ queryKey: qk.chapters(wsId) }),
      ]),
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
/** Patch a single file across both the workspace list cache and its detail cache. */
function patchFileInCache(
  qc: QueryClient,
  wsId: string,
  fileId: string,
  patch: Partial<SourceFile>
) {
  qc.setQueryData<SourceFile[]>(qk.files(wsId), (prev) =>
    prev ? prev.map((f) => (f.id === fileId ? { ...f, ...patch } : f)) : prev
  );
  qc.setQueryData<SourceFile>(qk.file(fileId), (prev) =>
    prev ? { ...prev, ...patch } : prev
  );
}

// MSW has no SSE channel, so fake the progress animation client-side in dev.
function simulateMswProgress(qc: QueryClient, wsId: string, fileId: string) {
  let pct = 0;
  const timer = setInterval(() => {
    pct = Math.min(100, pct + 20);
    patchFileInCache(qc, wsId, fileId, {
      ingestPct: pct,
      status: 'processing',
    });
    if (pct >= 100) {
      clearInterval(timer);
      const list = qc.getQueryData<SourceFile[]>(qk.files(wsId));
      const kind = list?.find((entry) => entry.id === fileId)?.kind;
      patchFileInCache(qc, wsId, fileId, {
        indexed: kind !== 'audio',
        ingestPct: 100,
        status: 'ready',
      });
    }
  }, 450);
}

/** Reserve a B2 object, upload it directly, then ask the gateway to verify and
 * enqueue it. File bytes never traverse the Go gateway. */
export function useUploadSource(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: ({
      file,
      kind,
      chapterId,
      chapterName,
      parseMode,
      captionImages,
      onUploadProgress,
      signal,
    }: {
      file: File;
      kind: SourceFile['kind'];
      chapterId?: string | null;
      chapterName?: string | null;
      /** accurate = Modal MinerU hybrid backend, fast = Modal MinerU pipeline
       * backend, none = store only (no parsing/indexing). */
      parseMode?: 'accurate' | 'fast' | 'none';
      /** Caption the figures found while parsing so they become searchable. */
      captionImages?: boolean;
      onUploadProgress?: (pct: number) => void;
      signal?: AbortSignal;
    }) => {
      if (USE_MSW || !USE_DIRECT_B2_UPLOAD) {
        const form = new FormData();
        form.append('file', file, file.name);
        form.append('name', file.name);
        form.append('kind', kind);
        if (chapterId) form.append('chapterId', chapterId);
        if (chapterName) form.append('chapterName', chapterName);
        if (parseMode) form.append('parseMode', parseMode);
        if (captionImages) form.append('captionImages', 'true');
        return api.upload<SourceFile>(
          `/workspaces/${wsId}/sources`,
          form,
          onUploadProgress,
          signal
        );
      }
      return api
        .post<{
          uploadId: string;
          url: string;
          method: 'PUT';
          headers: Record<string, string>;
          expiresAt: string;
        }>(`/workspaces/${wsId}/sources/uploads`, {
          captionImages: captionImages ?? false,
          chapterId: chapterId ?? null,
          chapterName: chapterName ?? null,
          contentType: file.type || 'application/octet-stream',
          kind,
          name: file.name,
          parseMode,
          sizeBytes: file.size,
        })
        .then(async (reservation) => {
          await api.putFile(
            reservation.url,
            file,
            reservation.headers,
            onUploadProgress,
            signal
          );
          onUploadProgress?.(100);
          return api.post<SourceFile>(
            `/workspaces/${wsId}/sources/uploads/${reservation.uploadId}/complete`
          );
        });
    },
    onSuccess: (file) => {
      // Insert immediately so the row (with its progress bar) shows up at once.
      qc.setQueryData<SourceFile[]>(qk.files(wsId), (prev) => {
        const next = prev ? [...prev] : [];
        if (!next.some((f) => f.id === file.id)) {
          next.push({
            ...file,
            ingestPct: 0,
            status: file.status ?? 'processing',
          });
        }
        return next;
      });
      qc.invalidateQueries({ queryKey: qk.chapters(wsId) });
      if (USE_MSW) simulateMswProgress(qc, wsId, file.id);
    },
  });
}

/** Subscribe to live ingest progress for a workspace (SSE) and patch the file
 * caches as events arrive. No-op under MSW (dev mock has no event stream). */
export type IngestStreamState = {
  status: 'connecting' | 'connected' | 'disconnected';
};

export function useIngestProgress(wsId: string, enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    const streamKey = qk.ingestStream(wsId);
    if (!wsId || !enabled || USE_MSW) {
      qc.removeQueries({ queryKey: streamKey });
      return;
    }

    let stopped = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;

    const connect = () => {
      if (stopped) return;
      qc.setQueryData<IngestStreamState>(streamKey, (current) =>
        current?.status === 'disconnected' ? current : { status: 'connecting' }
      );
      source = new EventSource(`${API_BASE}/workspaces/${wsId}/ingest-events`);
      source.onopen = () => {
        retryDelay = 1000;
        qc.setQueryData<IngestStreamState>(streamKey, {
          status: 'connected',
        });
      };
      source.onmessage = (event) => {
        try {
          const value = JSON.parse(event.data) as Record<string, unknown>;
          if (
            typeof value.fileId !== 'string' ||
            typeof value.pct !== 'number' ||
            !Number.isFinite(value.pct) ||
            !['processing', 'ready', 'failed'].includes(String(value.status))
          ) {
            return;
          }
          const status = value.status as FileStatus;
          const patch: Partial<SourceFile> = {
            ingestPct: value.pct,
            status,
          };
          if (typeof value.indexed === 'boolean') {
            patch.indexed = value.indexed;
          }
          patchFileInCache(qc, wsId, value.fileId, patch);
          if (status === 'ready' || status === 'failed') {
            qc.invalidateQueries({ queryKey: qk.files(wsId) });
            qc.invalidateQueries({ queryKey: qk.file(value.fileId) });
          }
        } catch {
          /* ignore malformed events */
        }
      };
      source.onerror = () => {
        source?.close();
        source = undefined;
        if (stopped || retryTimer) return;
        qc.setQueryData<IngestStreamState>(streamKey, {
          status: 'disconnected',
        });
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          connect();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
      qc.removeQueries({ queryKey: streamKey });
    };
  }, [wsId, enabled, qc]);
}

/* ---------------- chat & generate ---------------- */

export const conversationsQuery = (wsId: string) =>
  queryOptions({
    enabled: !!wsId,
    queryFn: () => api.get<Conversation[]>(`/workspaces/${wsId}/conversations`),
    queryKey: qk.conversations(wsId),
  });
export const useConversations = (wsId: string, options?: QueryUiOptions) =>
  useQuery({ ...conversationsQuery(wsId), meta: queryMeta(options) });

export const messagesQuery = (convId: string | null) =>
  queryOptions({
    enabled: !!convId,
    queryFn: () => api.get<WireMessage[]>(`/conversations/${convId}/messages`),
    queryKey: qk.messages(convId ?? ''),
  });
export const useMessages = (convId: string | null, options?: QueryUiOptions) =>
  useQuery({ ...messagesQuery(convId), meta: queryMeta(options) });

export function useDeleteConversation(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (convId: string) => api.del<void>(`/conversations/${convId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.conversations(wsId) }),
  });
}
export function useGenerate(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: GenerateOptions) =>
      api.post<unknown>(`/workspaces/${wsId}/generate`, opts),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.quizzes }),
        qc.invalidateQueries({ queryKey: qk.decks }),
        qc.invalidateQueries({ queryKey: qk.materials(wsId) }),
      ]);
    },
  });
}

/* ---------------- study materials ---------------- */
/** Unified, workspace-scoped list of study materials (mindmaps, diagrams,
 * quizzes, decks) for the left panel. Not chapter-scoped. */
export const materialsQuery = (wsId: string) =>
  queryOptions({
    enabled: !!wsId,
    queryFn: () => api.get<MaterialRef[]>(`/workspaces/${wsId}/materials`),
    queryKey: qk.materials(wsId),
  });
export const useMaterials = (wsId: string, options?: QueryUiOptions) =>
  useQuery({ ...materialsQuery(wsId), meta: queryMeta(options) });

export const materialQuery = (id: string | null) =>
  queryOptions({
    enabled: !!id,
    queryFn: () => api.get<Material>(`/materials/${id}`),
    queryKey: qk.material(id ?? ''),
  });
export const useMaterial = (id: string | null, options?: QueryUiOptions) =>
  useQuery({ ...materialQuery(id), meta: queryMeta(options) });

export function useDeleteMaterial(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/materials/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.materials(wsId) });
      qc.invalidateQueries({ queryKey: qk.quizzes });
      qc.invalidateQueries({ queryKey: qk.decks });
    },
  });
}

/** Create a user-authored note (markdown) material and reveal it in-pane. */
export type CreateNoteInput = Omit<CreateMaterialReq, 'kind'>;
export function useCreateNote(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNoteInput = {}) =>
      api.post<Material>(`/workspaces/${wsId}/materials`, {
        kind: 'note',
        ...input,
      }),
    onSuccess: (mt) => {
      qc.invalidateQueries({ queryKey: qk.materials(wsId) });
      qc.setQueryData(qk.material(mt.id), mt);
    },
  });
}

/** Patch material metadata. Content is authoritative in the Yjs room. */
export function useUpdateMaterial(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateMaterialReq }) =>
      api.patch<MaterialUpdateResult>(`/materials/${id}`, patch),
    onSuccess: (result, { id, patch }) => {
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

export function useCreateWorkspaceInvite(workspaceId: string) {
  return useMutation({
    mutationFn: (body: CreateWorkspaceInviteReq) =>
      api.post<void>(`/workspaces/${workspaceId}/invites`, body),
  });
}

export function useAcceptWorkspaceInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      api.post<WorkspaceMember>(
        `/workspace-invites/${encodeURIComponent(token)}/accept`
      ),
    onSuccess: (member) => {
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

export function useResolveMaterialDiscussion(materialId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      discussionId,
      ...body
    }: UpdateDiscussionReq & { discussionId: string }) =>
      api.patch<void>(`/discussions/${discussionId}`, body),
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

export const materialRevisionsQuery = (materialId: string) =>
  queryOptions({
    enabled: !!materialId,
    queryFn: () =>
      api.get<MaterialRevision[]>(`/materials/${materialId}/revisions`),
    queryKey: qk.materialRevisions(materialId),
  });

export const useMaterialRevisions = (materialId: string) =>
  useQuery(materialRevisionsQuery(materialId));

export function useDeleteMaterialDiscussion(materialId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (discussionId: string) =>
      api.del<void>(`/discussions/${discussionId}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.materialDiscussions(materialId) }),
  });
}

export const getMaterialCollaborationToken = (materialId: string) =>
  api.post<MaterialCollaborationToken>(
    `/materials/${materialId}/collaboration-token`
  );

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
    refetchInterval: 4 * 60 * 1000,
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
      api.patch<MaterialUpdateResult>(`/materials/${id}`, {
        chapterId: chapterId ?? '',
      }),
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
    onSettled: () => qc.invalidateQueries({ queryKey: qk.materials(wsId) }),
    onSuccess: (result) =>
      qc.setQueryData<Material>(qk.material(result.id), (current) =>
        current ? { ...current, ...result } : current
      ),
  });
}

/* ---------------- quizzes ---------------- */
export const quizzesQuery = () =>
  queryOptions({
    queryFn: () => api.get<Quiz[]>('/quizzes'),
    queryKey: qk.quizzes,
  });
export const useQuizzes = () => useQuery(quizzesQuery());

export const quizQuery = (id: string) =>
  queryOptions({
    enabled: !!id,
    queryFn: () => api.get<Quiz>(`/quizzes/${id}`),
    queryKey: qk.quiz(id),
  });
export const useQuiz = (id: string, options?: QueryUiOptions) =>
  useQuery({ ...quizQuery(id), meta: queryMeta(options) });

export const attemptsQuery = () =>
  queryOptions({
    queryFn: () => api.get<Attempt[]>('/attempts'),
    queryKey: qk.attempts,
  });
export const useAttempts = () => useQuery(attemptsQuery());

export const attemptQuery = (id: string) =>
  queryOptions({
    enabled: !!id,
    queryFn: () => api.get<AttemptDetail>(`/attempts/${id}`),
    queryKey: qk.attempt(id),
  });
export const useAttempt = (id: string, options?: QueryUiOptions) =>
  useQuery({ ...attemptQuery(id), meta: queryMeta(options) });

/** Ad-hoc quiz built from recently-missed questions. */
export const mistakesQuery = () =>
  queryOptions({
    queryFn: () => api.get<Quiz>('/mistakes'),
    queryKey: qk.mistakes,
  });
export const useMistakes = (options?: QueryUiOptions) =>
  useQuery({ ...mistakesQuery(), meta: queryMeta(options) });

/** Invalidate every workspace's materials list (quiz/deck edits change titles
 * shown in the left panel but don't carry a workspace id). */
function invalidateAllMaterials(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({
    predicate: (q) =>
      Array.isArray(q.queryKey) &&
      q.queryKey[0] === 'workspace' &&
      q.queryKey[2] === 'materials',
  });
}

export function useCreateQuiz() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateQuizReq) => api.post<Quiz>('/quizzes', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.quizzes });
      invalidateAllMaterials(qc);
    },
  });
}
export function useUpdateQuiz() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateQuizReq & { id: string }) =>
      api.patch<Quiz>(`/quizzes/${id}`, body),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: qk.quizzes });
      qc.invalidateQueries({ queryKey: qk.quiz(v.id) });
      invalidateAllMaterials(qc);
    },
  });
}
export function useDeleteQuiz() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/quizzes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.quizzes });
      invalidateAllMaterials(qc);
    },
  });
}
export function useSubmitAttempt(options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: ({ quizId, ...body }: CreateAttemptReq & { quizId: string }) =>
      api.post<Attempt>(`/quizzes/${quizId}/attempts`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.attempts });
      qc.invalidateQueries({ queryKey: qk.mistakes });
    },
  });
}

/* ---------------- flashcards ---------------- */
export const decksQuery = () =>
  queryOptions({
    queryFn: () => api.get<Deck[]>('/decks'),
    queryKey: qk.decks,
  });
export const useDecks = () => useQuery(decksQuery());

export function useCreateDeck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDeckReq) => api.post<Deck>('/decks', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.decks });
      invalidateAllMaterials(qc);
    },
  });
}
export function useCreateCard(deckId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCardReq) =>
      api.post<Flashcard>(`/decks/${deckId}/cards`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.cards(deckId) });
      qc.invalidateQueries({ queryKey: qk.deck(deckId) });
      qc.invalidateQueries({ queryKey: qk.decks });
    },
  });
}
export function useDeleteCard(deckId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`/cards/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.cards(deckId) });
      qc.invalidateQueries({ queryKey: qk.deck(deckId) });
      qc.invalidateQueries({ queryKey: qk.decks });
    },
  });
}

export const deckQuery = (id: string) =>
  queryOptions({
    enabled: !!id,
    queryFn: () => api.get<Deck>(`/decks/${id}`),
    queryKey: qk.deck(id),
  });
export const useDeck = (id: string, options?: QueryUiOptions) =>
  useQuery({ ...deckQuery(id), meta: queryMeta(options) });

export const cardsQuery = (deckId: string) =>
  queryOptions({
    enabled: !!deckId,
    queryFn: () => api.get<Flashcard[]>(`/decks/${deckId}/cards`),
    queryKey: qk.cards(deckId),
  });
export const useCards = (deckId: string, options?: QueryUiOptions) =>
  useQuery({ ...cardsQuery(deckId), meta: queryMeta(options) });
export function useUpdateCard(deckId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateCardReq & { id: string }) =>
      api.patch<Flashcard>(`/cards/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.cards(deckId) });
      qc.invalidateQueries({ queryKey: qk.deck(deckId) });
      qc.invalidateQueries({ queryKey: qk.decks });
    },
  });
}
/** Persist an SRS review result for a card (updates scheduling + known flag). */
export function useReviewCard(deckId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: ({ id, srs, known }: Pick<Flashcard, 'id' | 'srs' | 'known'>) =>
      api.patch<Flashcard>(`/cards/${id}`, { known, srs }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.deck(deckId) });
      qc.invalidateQueries({ queryKey: qk.decks });
    },
  });
}

/* ---------------- schedule ---------------- */
export const eventsQuery = () =>
  queryOptions({
    queryFn: () => api.get<CalendarEvent[]>('/events'),
    queryKey: qk.events,
  });
export const useEvents = (options?: QueryUiOptions) =>
  useQuery({ ...eventsQuery(), meta: queryMeta(options) });

export const labelsQuery = () =>
  queryOptions({
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
    mutationFn: (id: string) => api.del<void>(`/labels/${id}`),
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
    onSettled: () => qc.invalidateQueries({ queryKey: qk.tasks }),
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
    onSettled: () => qc.invalidateQueries({ queryKey: qk.tasks }),
  });
}
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation<void, Error, string, TasksMutationContext>({
    meta: { errorToast: false },
    mutationFn: (id) => api.del<void>(`/tasks/${id}`),
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
    onSettled: () => qc.invalidateQueries({ queryKey: qk.tasks }),
  });
}

/* ---------------- thinking ---------------- */
export const canvasesQuery = () =>
  queryOptions({
    queryFn: () => api.get<ThinkingCanvas[]>('/thinking'),
    queryKey: qk.thinking,
  });
export const useCanvases = (options?: QueryUiOptions) =>
  useQuery({ ...canvasesQuery(), meta: queryMeta(options) });

export const canvasQuery = (id: string) =>
  queryOptions({
    enabled: !!id,
    queryFn: () => api.get<ThinkingCanvas>(`/thinking/${id}`),
    queryKey: qk.canvas(id),
  });
export const useCanvas = (id: string, options?: QueryUiOptions) =>
  useQuery({ ...canvasQuery(id), meta: queryMeta(options) });
export function useCreateCanvas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<ThinkingCanvas>('/thinking', { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.thinking }),
  });
}
export function useSaveCanvas(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: SaveCanvasReq) =>
      api.put<ThinkingCanvas>(`/thinking/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.thinking }),
  });
}

/* ---------------- explore ---------------- */
export const exploreWorkspacesQuery = () =>
  queryOptions({
    queryFn: () => api.get<PublicWorkspace[]>('/explore/workspaces'),
    queryKey: qk.exploreWorkspaces,
  });
export const useExploreWorkspaces = () => useQuery(exploreWorkspacesQuery());

export const exploreQuizzesQuery = () =>
  queryOptions({
    queryFn: () => api.get<PublicQuiz[]>('/explore/quizzes'),
    queryKey: qk.exploreQuizzes,
  });
export const useExploreQuizzes = () => useQuery(exploreQuizzesQuery());

export const exploreDecksQuery = () =>
  queryOptions({
    queryFn: () => api.get<PublicDeck[]>('/explore/decks'),
    queryKey: qk.exploreDecks,
  });
export const useExploreDecks = () => useQuery(exploreDecksQuery());

/* ---------------- sharing & cloning ---------------- */

/** Deep-copy a shared workspace (chapters, files, materials and — via the
 * pipeline — the parsed knowledge graph) into the caller's account. */
export function useCloneWorkspace(options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (id: string) =>
      api.post<CloneWorkspaceResult>(`/workspaces/${id}/clone`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: qk.quizzes });
      qc.invalidateQueries({ queryKey: qk.decks });
      qc.invalidateQueries({ queryKey: qk.exploreWorkspaces });
    },
  });
}

/** Copy a shared quiz into the caller's library (most recent workspace). */
export function useCloneQuiz(options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (id: string) => api.post<Quiz>(`/quizzes/${id}/clone`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.quizzes });
      qc.invalidateQueries({ queryKey: qk.exploreQuizzes });
      invalidateAllMaterials(qc);
    },
  });
}

/** Copy a shared deck (with reset SRS state) into the caller's library. */
export function useCloneDeck(options?: MutationUiOptions) {
  const qc = useQueryClient();
  return useMutation({
    meta: mutationMeta(options),
    mutationFn: (id: string) => api.post<Deck>(`/decks/${id}/clone`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.decks });
      qc.invalidateQueries({ queryKey: qk.exploreDecks });
      invalidateAllMaterials(qc);
    },
  });
}

/** Rename / recolor a deck or change its visibility (share standalone). */
export function useUpdateDeck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateDeckReq & { id: string }) =>
      api.patch<Deck>(`/decks/${id}`, body),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: qk.decks });
      qc.invalidateQueries({ queryKey: qk.deck(v.id) });
      invalidateAllMaterials(qc);
    },
  });
}
