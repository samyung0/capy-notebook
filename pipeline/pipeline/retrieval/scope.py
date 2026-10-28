"""What a chat turn reaches (todo-account-chat.md): one workspace, or the
user's account, fixed for the conversation's life. Go resolves both
(``scope`` on the turn payload); every tool call is checked again there."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WorkspaceScope:
    workspace_id: str


@dataclass(frozen=True)
class ScopeWorkspace:
    """One workspace an account turn reaches: its name and whether the user
    may edit its content, as Go said when the turn started."""

    id: str
    name: str
    can_edit: bool


@dataclass(frozen=True)
class AccountScope:
    """The caller's owned and member workspaces plus their files with no
    workspace (Epo 2026-10-27, D2). Go sends the workspaces with each turn and
    search labels its hits from them; every read still asks Go about its item
    (Epo 2026-10-28)."""

    user_id: str
    workspaces: tuple[ScopeWorkspace, ...] = ()

    @property
    def workspace_ids(self) -> tuple[str, ...]:
        return tuple(w.id for w in self.workspaces)

    def workspace(self, workspace_id: str) -> ScopeWorkspace | None:
        return next((w for w in self.workspaces if w.id == workspace_id), None)


Scope = WorkspaceScope | AccountScope
