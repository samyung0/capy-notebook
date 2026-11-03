import type { SourceFile, WorkspaceSummary } from '@/api/types';
import { files, topics, user, workspaces } from './db';

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
    description: workspace.description,
    files: sources.filter((file) => !file.topicId).map(projectFile),
    iconId: workspace.iconId,
    name: workspace.name,
    privacy: workspace.privacy,
    tags: workspace.tags.map((tag) => tag.value),
    topics: topics
      .filter((topic) => topic.workspaceId === id)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((topic) => ({
        files: sources
          .filter((file) => file.topicId === topic.id)
          .map(projectFile),
        name: topic.name,
      })),
  };
}
