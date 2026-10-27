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
