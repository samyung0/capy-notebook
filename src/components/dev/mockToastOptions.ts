import type { ToastProps } from '@/components/ui/Sonner';
import { m } from '@/i18n';

type MockToast = Omit<ToastProps, 'id'>;

/** A button preview: clicking it only dismisses the toast. */
const action = (label: string) => ({ label, onClick: () => {} });

/** Toasts the application shows, with the copy their call sites use. Built on
 * click so the current locale applies. */
export const mockToastOptions: {
  group: string;
  label: string;
  toast: () => MockToast;
}[] = [
  // Success and plain notices
  {
    group: 'Success and notices',
    label: 'Share settings updated',
    toast: () => ({ title: m.share_updated(), variant: 'success' }),
  },
  {
    group: 'Success and notices',
    label: 'Workspace cloned',
    toast: () => ({ title: m.workspace_cloned(), variant: 'success' }),
  },
  {
    group: 'Success and notices',
    label: 'Ownership transferred',
    toast: () => ({
      title: m.workspace_transfer_success(),
      variant: 'success',
    }),
  },
  {
    group: 'Success and notices',
    label: 'File processing started',
    toast: () => ({
      description: m.files_process_started_body(),
      title: m.files_process_started_title(),
      variant: 'success',
    }),
  },
  {
    group: 'Success and notices',
    label: 'Questions copied to a quiz',
    toast: () => ({
      button: action(m.question_ui_open_quiz()),
      title: m.question_ui_copied(),
      variant: 'success',
    }),
  },
  {
    group: 'Success and notices',
    label: 'Topic finished',
    toast: () => ({
      button: action(m.common_go_check()),
      description: m.question_ui_topic_finished_toast({
        topic: 'Cell biology',
      }),
      title: m.question_ui_topic_finished(),
      variant: 'success',
    }),
  },
  {
    group: 'Success and notices',
    label: 'Workspace finished',
    toast: () => ({
      button: action(m.common_go_check()),
      description: m.learning_workspace_finished_toast({
        workspace: 'Biology 101',
      }),
      title: m.learning_workspace_finished(),
      variant: 'success',
    }),
  },
  {
    group: 'Success and notices',
    label: 'Account deletion requested',
    toast: () => ({
      title: m.settings_deletion_requested_toast(),
      variant: 'success',
    }),
  },
  {
    group: 'Success and notices',
    label: 'Invite sent',
    toast: () => ({
      description: m.members_invite_sent_body(),
      title: m.members_invite_sent_title(),
    }),
  },
  {
    group: 'Success and notices',
    label: 'Sign in to keep grading',
    toast: () => ({
      button: action(m.action_sign_in()),
      description: m.quiz_anonymous_limit_body(),
      title: m.quiz_anonymous_limit_title(),
    }),
  },
  {
    group: 'Success and notices',
    label: 'Print truncated',
    toast: () => ({ title: m.files_office_print_truncated({ count: '50' }) }),
  },
  // Warnings
  {
    group: 'Warnings',
    label: 'Offline in a workspace',
    toast: () => ({
      description: m.connection_offline_body(),
      title: m.connection_offline_title(),
      variant: 'warning',
    }),
  },
  {
    group: 'Warnings',
    label: 'Storage nearly full',
    toast: () => ({
      button: action(m.action_details()),
      description: m.workspace_storage_near_self_short(),
      title: m.workspace_storage_near_self_title(),
      variant: 'warning',
    }),
  },
  {
    group: 'Warnings',
    label: 'Auto-reload turned off',
    toast: () => ({
      description: m.billing_reload_disarmed_body(),
      title: m.billing_reload_disarmed_title(),
      variant: 'warning',
    }),
  },
  {
    group: 'Warnings',
    label: 'Spending limit reached',
    toast: () => ({
      description: m.billing_limit_toast_over_body({ limit: '$20.00' }),
      title: m.billing_limit_toast_over_title(),
      variant: 'warning',
    }),
  },
  {
    group: 'Warnings',
    label: 'Copy limit',
    toast: () => ({
      title: m.question_ui_copy_limit({ count: 50 }),
      variant: 'warning',
    }),
  },
  {
    group: 'Warnings',
    label: 'Computation check',
    toast: () => ({
      description: m.question_computation_warning_body(),
      title: m.question_computation_warning_title(),
      variant: 'warning',
    }),
  },
  {
    group: 'Warnings',
    label: 'Quiz block not added',
    toast: () => ({
      description: m.editor_quiz_fence_invalid(),
      title: m.editor_quiz_not_added(),
      variant: 'warning',
    }),
  },
  // Errors
  {
    group: 'Errors',
    label: 'Request failed (network)',
    toast: () => ({
      description: m.error_network_body(),
      title: m.error_network_title(),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Signed out',
    toast: () => ({
      button: action(m.action_sign_in()),
      description: m.error_auth_body(),
      title: m.error_auth_title(),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Storage full',
    toast: () => ({
      button: action(m.action_details()),
      description: m.workspace_storage_owner_self_short(),
      title: m.workspace_storage_owner_self_title(),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Uploads failed',
    toast: () => ({
      description: [
        m.source_import_file_error({
          name: 'lecture-01.pdf, lecture-02.pdf',
          reason: m.error_network_title(),
        }),
      ].join('\n'),
      title: m.source_transfer_failed_many({ count: 2 }),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Files too large',
    toast: () => ({
      description: 'scan.pdf, recording.mp4',
      title: m.source_files_too_large({ count: 2, limit: '100 MB' }),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Workspace file limit',
    toast: () => ({
      title: m.source_workspace_file_full({ limit: 50 }),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Generation failed',
    toast: () => ({
      description: m.error_generic_body(),
      title: m.generate_failed(),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Save failed, edits undone',
    toast: () => ({
      description: m.editor_save_failed_undone(),
      title: m.editor_save_failed(),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Drafts lost',
    toast: () => ({ title: m.editor_drafts_lost(), variant: 'error' }),
  },
  {
    group: 'Errors',
    label: 'Image upload failed',
    toast: () => ({
      description: m.error_quota_body(),
      title: m.editor_upload_failed(),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Grading failed',
    toast: () => ({
      description: m.quiz_grade_failed_body(),
      title: m.quiz_grade_failed(),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Flashcard review failed',
    toast: () => ({
      title: m.flashcards_review_failed(),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Chat undo failed',
    toast: () => ({
      description: m.chat_undo_unavailable(),
      title: m.chat_undo_failed_edit(),
      variant: 'error',
    }),
  },
  {
    group: 'Errors',
    label: 'Annotations failed',
    toast: () => ({
      title: m.pdf_annotations_failed(),
      variant: 'error',
    }),
  },
];
