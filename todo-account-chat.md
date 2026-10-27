# Chat outside a workspace (account scope)

Status 2026-10-27: every decision made (D1-D4), nothing built; builds after
the release train. Placement mocks (D1):
https://claude.ai/artifact/WthyueHjY3Y74HT1Af4JBb (A dashboard, B Chat page, C Files
panel, D ⌘K Ask). MSW seed has standalone PDF, DOCX, MD, CSV, image and audio. Builds after the
release train (it touches `retrieval/agent.py`, `tools.py`, `pending.py`,
`store.py`, which the train also edits). Workspace chat keeps its prompts and
tools byte for byte.

## Today

Chat is bound to one workspace at every layer:

- Go route `POST /api/workspaces/{id}/chat/stream` (`chat_stream.go`);
  `conversations.workspace_id` NOT NULL; operations from the workspace role
  (`agenttools.OperationsForRole`); embedding rates from the workspace pin.
- Python `ChatStreamReq.workspaceId` → `ToolContext.workspace_id`; one tool
  list narrowed by role (`tools._offered`); the prompt in `prompts/chat.py`,
  turn context in `retrieval/turn_context.py`, skills in `prompts/skills.py`.
  About 45 prompt and tool-description lines say "workspace".
- Search embeds the query with the workspace pin and filters every leg by
  `workspace_id` (`store._SEARCH_SQL_TEMPLATE`).
- Cache rule: a conversation's prompt and tool list never change once it
  starts (adding a tool mid-conversation missed GLM's cache every time).

## Proposal: a scope fixed per conversation, a profile per scope

1. **Conversation scope.** `conversations.workspace_id` becomes nullable
   (NULL = account scope, owner = `user_id`). A conversation keeps its scope
   for life, which the cache rule requires anyway. Route
   `POST /api/chat/stream` (no workspace) beside the workspace route; same
   AI rate class (suffix `/chat/stream`), same `chat` slot and surface.
2. **Go builds one `ChatScope`** in the existing `chatAccess`/`chatTurn`
   trio: for a workspace the role, operations and one pin, as now; for the
   account the readable set (see D2), its pins grouped, and the account
   operations. Python receives `scope: {kind, workspaceId?, targets: [{pin,
   workspaces, standalone}]}`.
3. **Tool catalog gains a scope tag** in `agenttools.go`: each definition is
   `workspace`, `account` or `both`. The workspace list stays exactly as it
   is. Tools whose meaning differs get their own names in account scope
   (`search_files` and `list_files` listing workspace and file, not
   `search_workspace`/`list_sources`); shared ones (knowledge, web,
   `read_skill`, `read_document` by file id, `capture_page`) are `both`.
   One contract version bump.
4. **Python profiles.** `retrieval/profiles/workspace.py` holds today's
   assembly (prompt, tool set, turn context, skills); a new
   `profiles/account.py` holds the account one. The loop, compaction,
   citations, events and metering stay shared. `ToolContext` carries the
   scope instead of `workspace_id`; handlers ask it for search targets and
   access checks rather than reading an id.
5. **Search across spaces.** `search.search` takes a list of targets: one
   query embedding per distinct pin (one today), `hybrid_search` per target
   with a set predicate (`workspace_id = ANY(...)`, or `workspace_id IS NULL
   AND rc.user_id = me`), merged by RRF, then one rerank pass over the union.
   Access is the global search's (`visibleWorkspacesSQL` plus the owner
   lifecycle checks), re-checked per tool call.
6. **Citations carry provenance.** Passages and stored citations gain the
   workspace id and name (or none for a standalone file), so an answer can
   say where a source lives and the UI can open it.
7. **Prompts and skills.** `prompts/account_chat.py` with its own system
   prompt; skills tagged by profile where their wording names the workspace
   (writing, deck building), the rest shared.

## Decisions needed

- **D1, decided (E):** the workspace panels, the Chats left panel in the app
  sidebar's place and the Chat panel filling the rest; a Chat item in the app
  sidebar opens it, and the header's back arrow returns to where the user
  came from.
- **D2, decided:** owned and member workspaces plus standalone files; not
  link or public workspaces the user only reached.
- **D3, decided:** account chat may write. `read_document` and
  `inspect_document` return each file's edit permission and workspace with
  its content (inspect already precedes every edit), and every write checks
  the permission on the server as today. Created items land in No workspace
  unless the user names a workspace they can edit.
- **D4, decided:** the sources switch stays, reading "Your files only" in
  place of "Workspace only".

## Build contract (2026-10-27, branch `wip/mac-account-chat`)

Worktree `.claude/worktrees/account-chat`, stacked on `ae9edff0e` (the
standalone branch the train merged). Migration **0126**. Local DB tests use
untracked copies of the train's migrations as 0122-0124 (excluded in
`.git/info/exclude`; never commit them). Rebased onto main after the train;
overlaps with the train in `tools.py`, `pending.py`, `agent.py`, `store.py`
are resolved then.

First version tools (Epo 2026-10-27): read and search, create, edit existing
files. Trash, restore, study progress, source-change resolution and the trash
listing stay workspace-only.

### Go

- **0126:** `conversations.workspace_id` nullable (NULL = account chat, owned
  by `user_id`), an index for the account list;
  `rag_search_events.workspace_id` nullable.
- **Routes:** `POST /api/chat/stream` (account turn, same body as the
  workspace route; same AI rate class through the `/chat/stream` suffix);
  `GET/POST /api/conversations` (account list and create, the same shapes as
  `/api/workspaces/{id}/conversations`). `/api/conversations/{id}/…`
  (messages, stop, rename, delete, pin, archive) serve an account
  conversation to its owner alone.
- **Scope set (D2):** owned workspaces plus member workspaces whose owner is
  live; never workspaces reached only by link or visit (a stricter sibling
  of `visibleWorkspacesSQL`). Standalone files of the caller.
- **Operations:** `source.read`, `material.read`, `material.create`,
  `document.edit`, `library.read`, narrowed as workspace chat narrows them
  for a frozen or full account.
- **Payload to the pipeline:** the workspace body without `workspaceId`,
  `role`, `openResource`, `studyProgress`, plus
  `scope: {"kind": "account", "workspaceIds": [...], "userId": "<caller>"}`.
  Workspace turns send `scope: {"kind": "workspace", "workspaceId": ...}` as
  well, so the pipeline reads one field.
- **Internal endpoints** (`/api/internal/documents/{list,inspect,edit}`,
  `/documents/office/create`, `/materials`, `/files`): a request with
  `scope: "account"` and no `workspaceId` checks the actor's access to the
  target itself (its workspace role among the scope set, or the owner of a
  standalone item; edit needs an editor role). Creation with no workspace
  makes a standalone item; with a `workspaceId` it needs an editor role
  there.
- **New `POST /api/internal/documents/access`**
  `{actorUserId, items: [{kind, id}]}` →
  `[{kind, id, workspaceId, workspaceName, canRead, canEdit}]`, one query.
  The pipeline uses it before account-scope reads and to label results.
- **Agent tool catalog:** each `Definition` gets `Scopes` (workspace,
  account). Workspace definitions keep their text byte for byte. New
  account-only `search_files` and `list_files`. `ContractVersion` 43, and
  the generated `agent_tools.json` regenerated.
- **Billing:** surface `chat`; the query embedding is charged at each
  searched pin's rates.

### Pipeline

- **Request:** `ChatStreamReq` reads `scope`. `ToolContext.scope` is
  `WorkspaceScope(workspace_id)` or `AccountScope(user_id, workspace_ids)`;
  workspace code keeps `ctx.workspace_id`.
- **Profiles:** `retrieval/profiles/workspace.py` (today's prompt, tools,
  turn context, skills, unchanged) and `profiles/account.py`. The loop,
  compaction, citations and events are shared. A conversation keeps its
  profile for life (cache rule).
- **`search_files`:** the targets are the workspaces grouped by embedding
  pin, plus the caller's standalone content grouped by its recorded pin.
  Embed the query once per pin, run `hybrid_search` per target, merge by
  RRF, then rerank once. Passages carry `workspaceId` and `workspaceName`
  (none for standalone).
- **`list_files`:** through Go `documents/list` with the account scope:
  name, kind, workspace and id.
- **`read_document`, `capture_page`:** check access through Go
  `documents/access` before reading, and return `{workspaceId,
  workspaceName, canEdit}` with the content.
- **`inspect_document`, `inspect_office_document`:** return the same access
  block. Edits go through Go with the account scope.
- **Create tools:** an optional `workspace_id` argument. Without it the item
  is standalone; with it the item lands in that workspace, which must be
  editable.
- **Prompt:** `prompts/account_chat.py` and an account turn context (no open
  item, no role line). The sources switch reads "Your files only".
  Citations keep their workspace provenance.

### Frontend

- **Entry:** a Chat item in the app sidebar opens `/chat` (and
  `/chat/$conversationId`).
- **Layout:** the workspace Chats left panel takes the app sidebar's place,
  and the Chat panel fills the rest. The header's back arrow returns to the
  previous page.
- **Data:** account conversations list and create, and the account stream
  route.
- **Copy:** the sources switch says "Your files only". Citations show their
  workspace, or No workspace.

## After the first version

- **Search ranking (decided 2026-10-27):** each embedding space runs one
  search over its workspace files and the caller's no-workspace files
  together, so owned, member and no-workspace files rank alike. Spaces of
  different embedding models still merge by rank before the one rerank.
  Epo expects workspaces with different embedding models or dimensions only
  after the desktop app ships, which is far off, so mixed-pin ranking needs
  no tuning now.
- **Tuning and scale (Windows PC):** account search quality, and the
  no-workspace vector leg. It filters on `workspace_id IS NULL`, which every
  user's standalone vectors share, so the vector index may return few of the
  caller's rows at scale.
- **Planned tools:** account-level tools such as creating a workspace.
- **Open gaps:** some shared Go tool texts still say `list_sources` and
  "workspace", and the `write_sources` refusal says "Workspace only is on".
  `add_questions` starting a quiz and a new Office file take no
  `workspace_id`, so they always land in No workspace.
