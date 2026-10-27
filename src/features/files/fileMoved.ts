import type { QueryClient } from '@tanstack/react-query';
import { qk } from '@/api/client';
import { workspaceQuery } from '@/api/hooks';
import type { SourceFile } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** Moves this tab heard of through a file's room (Q454): file id to the
 * workspace it moved to. */
const heard = new Map<string, string>();
/** Moves this tab told the user of, as `file:workspace`. */
const told = new Set<string>();

/** The workspace a file moved to, when this tab heard of the move. */
export function heardMove(fileId: string): string | undefined {
  return heard.get(fileId);
}

/** Tells the user once per tab per move that a file moved, naming the
 * workspace when this user can read it (Q454, Q455). */
export async function toastFileMoved(
  qc: QueryClient,
  fileId: string,
  workspaceId: string
): Promise<void> {
  const key = `${fileId}:${workspaceId}`;
  if (told.has(key)) return;
  told.add(key);
  const name = await qc
    .fetchQuery(workspaceQuery(workspaceId))
    .then((workspace) => workspace.name)
    .catch(() => undefined);
  userToast({
    title: name
      ? m.file_moved_to_workspace({ workspace: name })
      : m.file_moved_elsewhere(),
  });
}

/** A Move's room message (`file-moved`, Q454), heard right before the room
 * drains: toast, then refetch the file and the lists that show it so the
 * header, panel and chapter follow; the drained room's reconnect rejoins
 * through the access check of the file's new place. */
export function fileMoved(
  qc: QueryClient,
  fileId: string,
  workspaceId: string
): void {
  heard.set(fileId, workspaceId);
  const left = qc.getQueryData<SourceFile>(qk.file(fileId))?.workspaceId;
  void toastFileMoved(qc, fileId, workspaceId);
  void qc.invalidateQueries({ queryKey: qk.file(fileId) });
  for (const id of new Set([left, workspaceId]))
    if (id) void qc.invalidateQueries({ queryKey: qk.workspace(id) });
  void qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
  void qc.invalidateQueries({ queryKey: qk.recent });
}
