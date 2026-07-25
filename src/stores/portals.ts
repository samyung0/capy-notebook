import { create } from 'zustand';
import type { CreateWorkspaceReq, UpdateWorkspaceReq } from '@/api/gen/model';
import type { CalendarEvent, Label, Task } from '@/api/types';
import type { EventDraft } from '@/features/schedule/EventFormDialog';
import { createWorkspaceDefaultValues } from '@/stores/defaultValues';

export interface ConfirmConfig {
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  title: string;
}

interface DialogState {
  addSource: { workspaceId: string } | null;
  closeAddSource: () => void;
  closeConfirm: () => void;
  closeEventDetail: () => void;
  closeEventForm: () => void;
  closeLabelEdit: () => void;
  closeMsImport: () => void;
  closeTaskEdit: () => void;

  closeWorkspaceCreate: () => void;
  closeWorkspaceEdit: () => void;
  closeWorkspaceStats: () => void;
  confirm: ConfirmConfig | null;
  eventDetail: CalendarEvent | null;
  eventForm: EventDraft | null;

  isTopBarSearchOpen: boolean;
  labelEdit: Label | null;
  msImport: { workspaceId: string } | null;
  openAddSource: (workspaceId: string) => void;
  openConfirm: (config: ConfirmConfig) => void;
  openEventDetail: (event: CalendarEvent) => void;
  openEventForm: (draft?: EventDraft) => void;
  openLabelEdit: (label: Label) => void;
  openMsImport: (workspaceId: string) => void;
  openTaskEdit: (task: Task) => void;

  openWorkspaceCreate: (workspace?: CreateWorkspaceReq) => void;
  openWorkspaceEdit: (workspace: UpdateWorkspaceReq, id: string) => void;
  openWorkspaceStats: (id: string) => void;
  setTopBarSearchOpen: (open: boolean) => void;
  taskEdit: Task | null;
  // these forms re-renders on the object change, so the initial value
  // in tanstack form changes together without any shenanigans (otherwise we need some useeffect hook to listen to prop changes and then programmatically changes the defaultValue as defaultValue is not reactive)
  // the state of this zustand store is also not tied with other states like react query
  // because its gonna cause a lot of issues, and also some dialogs like the worksapce
  // can let you add new/modify existing workspaces, and tying them to react query
  // is going to be messy
  // TLDR zustand is not synced with react query
  // flow should be:
  //      -- get: react query -> map Workspace to WorkspaceForm -> opendialog with existing
  //              -> populate tanstack form with initial values
  //      -- create: open dialog with default values -> submit -> react query mutation -> close dialog
  workspaceCreate: CreateWorkspaceReq | null;
  workspaceEdit: UpdateWorkspaceReq | null;
  workspaceId: string | null;
  workspaceStatsId: string | null;
}

export const usePortals = create<DialogState>((set) => ({
  addSource: null,
  closeAddSource: () => set({ addSource: null }),
  closeConfirm: () => set({ confirm: null }),
  closeEventDetail: () => set({ eventDetail: null }),
  closeEventForm: () => set({ eventForm: null }),
  closeLabelEdit: () => set({ labelEdit: null }),
  closeMsImport: () => set({ msImport: null }),
  closeTaskEdit: () => set({ taskEdit: null }),

  closeWorkspaceCreate: () => set({ workspaceCreate: null }),
  closeWorkspaceEdit: () => set({ workspaceEdit: null }),
  closeWorkspaceStats: () => set({ workspaceStatsId: null }),
  confirm: null,
  eventDetail: null,
  eventForm: null,

  isTopBarSearchOpen: false,
  labelEdit: null,
  msImport: null,
  openAddSource: (workspaceId) => set({ addSource: { workspaceId } }),
  openConfirm: (config) => set({ confirm: config }),
  openEventDetail: (event) => set({ eventDetail: event }),
  openEventForm: (draft) => set({ eventForm: draft ?? {} }),
  openLabelEdit: (label) => set({ labelEdit: label }),
  openMsImport: (workspaceId) => set({ msImport: { workspaceId } }),
  openTaskEdit: (task) => set({ taskEdit: task }),

  openWorkspaceCreate: (workspace?) =>
    set({
      workspaceCreate: workspace ?? createWorkspaceDefaultValues,
    }),
  openWorkspaceEdit: (workspace, id) =>
    set({ workspaceEdit: workspace, workspaceId: id }),
  openWorkspaceStats: (id) => set({ workspaceStatsId: id }),
  setTopBarSearchOpen: (open) => set({ isTopBarSearchOpen: open }),
  taskEdit: null,
  workspaceCreate: null,
  workspaceEdit: null,
  workspaceId: null,
  workspaceStatsId: null,
}));
