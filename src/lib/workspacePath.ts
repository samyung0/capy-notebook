const WORKSPACE_PATH = /^\/workspaces\/([^/]+)(?:\/|$)/;

/** The workspace a path is in: `/workspaces/<id>` and its pages
 * (`/workspaces/<id>/assignments`, `/workspaces/<id>/study/practice`, …), or
 * '' elsewhere. */
export function workspaceOfPath(pathname: string) {
  return WORKSPACE_PATH.exec(pathname)?.[1] ?? '';
}
