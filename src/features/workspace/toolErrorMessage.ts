import type { ToolError } from '@/api/types';
import { m } from '@/i18n';

/** Localized copy for a stable tool error code; the code itself never changes. */
export function toolErrorMessage(error: ToolError | undefined): string {
  switch (error?.code) {
    case 'unsupported_format':
      return m.chat_tool_error_unsupported_format();
    case 'unsupported_operation':
      return m.chat_tool_error_unsupported_operation();
    case 'invalid_input':
      return m.chat_tool_error_invalid_input();
    case 'unavailable_target':
      return m.chat_tool_error_unavailable_target();
    case 'stale_target':
      return m.chat_tool_error_stale_target();
    case 'quota_rejected':
      return m.chat_tool_error_quota_rejected();
    case 'lifecycle_rejected':
      return m.chat_tool_error_lifecycle_rejected();
    case 'outcome_unknown':
      return m.chat_tool_error_outcome_unknown();
    case 'limit_reached':
      return m.chat_tool_error_limit_reached();
    case 'office_editing_paused':
      return m.chat_tool_error_office_editing_paused();
    default:
      return m.chat_tool_failed();
  }
}
