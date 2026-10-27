import type { QueryClient } from '@tanstack/react-query';
import { qk } from '@/api/client';
import { workspaceQuery } from '@/api/hooks';
import type { SourceFile } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

/** The open workspace page's follow of a moved file: into `workspaceId`
 * when this user can read it, else closed where it is (`null`). */
type Follow = (fileId: string, workspaceId: string | null) => void;
const follows = new Set<Follow>();
/** Room messages already acted on (one per Move, however many of this tab's
 * sessions of the file hear it). */
const handled = new Set<string>();

/** Registers the open workspace page's follow; returns its removal. */
export function followMoves(follow: Follow): () => void {
  follows.add(follow);
  return () => {
    follows.delete(follow);
  };
}

/** A Move's room message (`file-moved`, Q454), heard right before the room
 * drains, acted on at once (Q467): the lists that show the file refetch, the
 * toast names the target workspace when this user can read it, and the open
 * workspace page follows the file there, or closes it where it is when the
 * workspace cannot be read. Nothing is remembered: a later open of the file
 * follows the general rule. */
export async function fileMoved(
  qc: QueryClient,
  fileId: string,
  workspaceId: string,
  eventId: string | undefined
): Promise<void> {
  if (eventId) {
    if (handled.has(eventId)) return;
    handled.add(eventId);
  }
  const left = qc.getQueryData<SourceFile>(qk.file(fileId))?.workspaceId;
  void qc.invalidateQueries({ queryKey: qk.file(fileId) });
  for (const id of new Set([left, workspaceId]))
    if (id) void qc.invalidateQueries({ queryKey: qk.workspace(id) });
  void qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
  void qc.invalidateQueries({ queryKey: qk.recent });
  const name = await qc
    .fetchQuery(workspaceQuery(workspaceId))
    .then((workspace) => workspace.name)
    .catch(() => undefined);
  userToast({
    title: name
      ? m.file_moved_to_workspace({ workspace: name })
      : m.file_moved_elsewhere(),
  });
  for (const follow of follows)
    follow(fileId, name === undefined ? null : workspaceId);
}
