const configuredSecret = process.env.E2E_AUTH_SECRET;
if (!configuredSecret) {
  throw new Error('E2E_AUTH_SECRET must be set by playwright.config.ts');
}
export const E2E_SECRET = configuredSecret;

export const users = {
  commenter: 'u_commenter',
  editor: 'u_editor',
  other: 'u_other',
  owner: 'u_owner',
  viewer: 'u_viewer',
} as const;

export const seed = {
  commenterNote: {
    body: 'Suggest a clearer sentence',
    id: 'note_e2e_public',
    name: 'E2E Commenter Note',
  },
  commentNote: {
    body: 'Comment on this selected sentence',
    id: 'note_e2e_comment',
    name: 'E2E Comment Highlight Note',
  },
  editableNote: {
    body: 'Signed-in editors can change this text',
    id: 'note_e2e_edit',
    name: 'E2E Editable Note',
  },
  editableWorkspace: {
    id: 'ws_e2e_edit',
    name: 'E2E Editable Link Workspace',
  },
  inviteWorkspace: {
    id: 'ws_e2e_invite',
    name: 'E2E Invite Only Workspace',
  },
  linkDeck: {
    front: 'Link front',
    id: 'dk_e2e_link',
    name: 'E2E Link Deck',
  },
  linkQuiz: {
    id: 'qz_e2e_link',
    name: 'E2E Link Quiz',
    prompt: 'Link quiz prompt?',
  },
  linkWorkspace: {
    id: 'ws_e2e_link',
    name: 'E2E Link Workspace',
  },
  mutateDeck: {
    id: 'dk_e2e_mutate',
    name: 'E2E Mutate Deck',
  },
  mutateQuiz: {
    id: 'qz_e2e_mutate',
    name: 'E2E Mutate Quiz',
  },
  mutateWorkspace: {
    id: 'ws_e2e_mutate',
    name: 'E2E Mutate Workspace',
  },
  privateDeck: {
    front: 'Private front',
    id: 'dk_e2e_private',
    name: 'E2E Private Deck',
  },
  privateQuiz: {
    id: 'qz_e2e_private',
    name: 'E2E Private Quiz',
    prompt: 'Private quiz prompt?',
  },
  privateWorkspace: {
    id: 'ws_e2e_private',
    name: 'E2E Private Workspace',
    secretFile: 'secret-notes.md',
    secretTitle: 'Secret private title',
  },
  publicDeck: {
    front: 'Public front',
    id: 'dk_e2e_public',
    name: 'E2E Public Deck',
  },
  publicQuiz: {
    id: 'qz_e2e_public',
    name: 'E2E Public Quiz',
    prompt: 'Public quiz prompt?',
  },
  publicWorkspace: {
    id: 'ws_e2e_public',
    name: 'E2E Public Workspace',
  },
  reviewNote: {
    body: 'Original review sentence',
    id: 'note_e2e_review',
    name: 'E2E Suggestion Review Note',
  },
  viewerNote: {
    body: 'Static viewer content',
    id: 'note_e2e_link',
    name: 'E2E Viewer Note',
  },
} as const;

export function e2eHeaders(userId: string): Record<string, string> {
  return {
    'X-E2E-Secret': E2E_SECRET,
    'X-E2E-User-Id': userId,
  };
}
