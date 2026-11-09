import type { WorkspaceMember } from '@/api/types';

/** The mocked workspaces' members, apart from the viewer. */
export const mockWorkspaceMembers: WorkspaceMember[] = [
  // Six viewers, the class the assignment boards draw (W1, G3m).
  {
    createdAt: new Date().toISOString(),
    name: 'Farah Ali',
    role: 'viewer',
    userId: 'u_mock_farah',
    workspaceId: 'ws_bio',
  },
  {
    createdAt: new Date().toISOString(),
    name: 'Gus Ito',
    role: 'viewer',
    userId: 'u_mock_gus',
    workspaceId: 'ws_bio',
  },
  {
    createdAt: new Date().toISOString(),
    name: 'Morgan Lee',
    role: 'editor',
    userId: 'u_mock_collaborator',
    workspaceId: 'ws_bio',
  },
  // A fuller Biology 101 roster so the panel foot's avatar group overflows.
  {
    avatarUrl: '/icons/avataaars-04.svg',
    createdAt: new Date().toISOString(),
    name: 'Priya Nair',
    role: 'editor',
    userId: 'u_mock_priya',
    workspaceId: 'ws_bio',
  },
  {
    createdAt: new Date().toISOString(),
    name: 'Ben Lee',
    role: 'viewer',
    userId: 'u_mock_tom',
    workspaceId: 'ws_bio',
  },
  {
    avatarUrl: '/icons/avataaars-07.svg',
    createdAt: new Date().toISOString(),
    name: 'Aiko Tanaka',
    role: 'editor',
    userId: 'u_mock_aiko',
    workspaceId: 'ws_bio',
  },
  {
    avatarUrl: '/icons/avataaars-12.svg',
    createdAt: new Date().toISOString(),
    name: 'Cara Moss',
    role: 'viewer',
    userId: 'u_mock_diego',
    workspaceId: 'ws_bio',
  },
  {
    createdAt: new Date().toISOString(),
    name: 'Dan Kim',
    role: 'viewer',
    userId: 'u_mock_sara',
    workspaceId: 'ws_bio',
  },
  {
    avatarUrl: '/icons/avataaars-15.svg',
    createdAt: new Date().toISOString(),
    name: 'Liam Walsh',
    role: 'editor',
    userId: 'u_mock_liam',
    workspaceId: 'ws_bio',
  },
  {
    avatarUrl: '/icons/avataaars-18.svg',
    createdAt: new Date().toISOString(),
    name: 'Eve Park',
    role: 'viewer',
    userId: 'u_mock_hana',
    workspaceId: 'ws_bio',
  },
];
