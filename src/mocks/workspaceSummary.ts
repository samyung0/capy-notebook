import type { SourceFile, WorkspaceSummary } from '@/api/types';
import { chapters, files, user, workspaces } from './db';

/** Server-side mock for the summary renderer, which runs before browser MSW. */
export function mockWorkspaceSummary(id: string): WorkspaceSummary | undefined {
  const workspace = workspaces.find((entry) => entry.id === id);
  if (!workspace || workspace.privacy === 'private') return;
  const sources = files
    .filter((file) => file.workspaceId === id)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const projectFile = ({ name, sizeBytes, addedAt }: SourceFile) => ({
    addedAt,
    name,
    sizeBytes,
  });
  return {
    author: user.name,
    authorAvatarUrl: user.avatarUrl,
    chapters: chapters
      .filter((chapter) => chapter.workspaceId === id)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((chapter) => ({
        files: sources
          .filter((file) => file.chapterId === chapter.id)
          .map(projectFile),
        name: chapter.name,
      })),
    description: workspace.description,
    files: sources.filter((file) => !file.chapterId).map(projectFile),
    iconId: workspace.iconId,
    name: workspace.name,
    privacy: workspace.privacy,
    tags: workspace.tags.map((tag) => tag.value),
  };
}
