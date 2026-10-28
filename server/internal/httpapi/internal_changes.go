package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// An item's unindexed changes, read when a chat reads the item (Epo
// 2026-10-28): the actor's access is checked per item, with no workspace
// filter, so account chat attaches them as workspace chat's reads do. A
// text file's changes are stored with each save; an Office file's come from
// the collaboration service, one call per workspace, the files with no
// workspace under "" (Epo 2026-10-28); a note's are computed from its stored
// content, or with live from its open room when that room holds unsaved
// edits (one call either way). A note with no workspace is
// never indexed, so it has none.

type internalChangesReq struct {
	ActorUserID string                   `json:"actorUserId"`
	Items       []agenttools.ResourceRef `json:"items"`
	// Live reads one note from its open room (Q417).
	Live bool `json:"live"`
}

// changesItemsMax bounds one call: a read names one item.
const changesItemsMax = 20

// readableItems answers each item's workspace ("" for none) when the actor
// may read every one, or writes the refusal: an item they cannot read is not
// found, which never says it exists.
func (a *api) readableItems(w http.ResponseWriter, r *http.Request, actorID string, items []agenttools.ResourceRef) (map[string]string, bool) {
	if !a.internalAccountActor(w, r, actorID) {
		return nil, false
	}
	if len(items) == 0 || len(items) > changesItemsMax {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "name 1 to 20 items"})
		return nil, false
	}
	rows, err := a.s.AccountDocumentAccess(r.Context(), actorID, items)
	if err != nil {
		a.fail(w, err)
		return nil, false
	}
	places := map[string]string{}
	for _, row := range rows {
		if !row.CanRead {
			a.fail(w, store.ErrNotFound)
			return nil, false
		}
		places[row.ID] = row.WorkspaceID
	}
	return places, true
}

func (a *api) internalChanges(w http.ResponseWriter, r *http.Request) {
	var req internalChangesReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	places, ok := a.readableItems(w, r, req.ActorUserID, req.Items)
	if !ok {
		return
	}
	ctx := r.Context()
	var fileIDs []string
	notes := map[string][]string{} // workspace -> its notes
	for _, item := range req.Items {
		switch item.Kind {
		case agenttools.KindSourceFile:
			fileIDs = append(fileIDs, item.ID)
		case agenttools.KindMaterial:
			if ws := places[item.ID]; ws != "" {
				notes[ws] = append(notes[ws], item.ID)
			}
		}
	}
	if req.Live && (len(req.Items) != 1 || len(fileIDs) != 0) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "a live read names one note"})
		return
	}

	files := []store.SourceChangeRow{}
	unread := []string{}
	office := map[string][]string{} // workspace ("" for none) -> Office files to read
	rows, err := a.s.SourceChangeRows(ctx, fileIDs)
	if err != nil {
		a.fail(w, err)
		return
	}
	byID := map[string]store.SourceChangeRow{}
	for _, row := range rows {
		switch {
		case row.Format == "text":
			if string(row.Changes) != "[]" {
				files = append(files, row)
			}
		case row.OfficePending:
			office[row.WorkspaceID] = append(office[row.WorkspaceID], row.FileID)
			byID[row.FileID] = row
		}
	}
	for ws, ids := range office {
		body, _ := json.Marshal(map[string]any{"workspaceId": ws, "fileIds": ids})
		raw, status, err := a.s.SourceAuthority(ctx, "/internal/source-changes", body)
		var answer struct {
			Files []struct {
				FileID     string          `json:"fileId"`
				Epoch      int64           `json:"epoch"`
				Checkpoint int64           `json:"checkpoint"`
				Changes    json.RawMessage `json:"changes"`
			} `json:"files"`
			Failed []string `json:"failed"`
		}
		if err != nil || status >= 300 || json.Unmarshal(raw, &answer) != nil {
			// The read answers from the index, saying it may be outdated.
			if err != nil {
				obs.CaptureErr(ctx, err, map[string]string{"surface": "pending_office"})
			}
			unread = append(unread, ids...)
			continue
		}
		unread = append(unread, answer.Failed...)
		for _, found := range answer.Files {
			row := byID[found.FileID]
			if len(found.Changes) == 0 || string(found.Changes) == "[]" {
				continue
			}
			row.Epoch, row.Checkpoint, row.Changes = found.Epoch, found.Checkpoint, found.Changes
			files = append(files, row)
		}
	}

	out := map[string]any{"files": files, "unread": unread}
	pending := []map[string]any{}
	live := false
	for ws, ids := range notes {
		var read []store.NotePending
		if req.Live {
			read, live, err = a.s.NoteReadChanges(ctx, ws, ids[0])
		}
		if err == nil && !live {
			// No open room holds unsaved edits: its stored changes stand.
			read, err = a.s.NotePendingChanges(ctx, ws, ids)
		}
		if err != nil {
			a.fail(w, err)
			return
		}
		for _, note := range read {
			pending = append(pending, map[string]any{
				"materialId": note.MaterialID, "title": note.Title, "revision": note.Revision,
				"changes": note.Changes, "workspaceId": ws,
			})
		}
	}
	out["notes"], out["live"] = pending, live
	writeJSON(w, http.StatusOK, out)
}

// internalChangesResolveReq resolves one placeholder of an item the actor
// may read: a file's image change (epoch, checkpoint, changeId) or a note's
// data block (blockId).
type internalChangesResolveReq struct {
	ActorUserID string                 `json:"actorUserId"`
	Item        agenttools.ResourceRef `json:"item"`
	Epoch       int64                  `json:"epoch"`
	Checkpoint  int64                  `json:"checkpoint"`
	ChangeID    string                 `json:"changeId"`
	BlockID     string                 `json:"blockId"`
}

func (a *api) internalResolveChange(w http.ResponseWriter, r *http.Request) {
	var req internalChangesResolveReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	places, ok := a.readableItems(w, r, req.ActorUserID, []agenttools.ResourceRef{req.Item})
	if !ok {
		return
	}
	ws := places[req.Item.ID]
	if req.Item.Kind == agenttools.KindMaterial {
		if ws == "" {
			a.fail(w, store.ErrNotFound)
			return
		}
		text, err := a.s.ResolveNoteChange(r.Context(), ws, req.Item.ID, req.BlockID)
		if errors.Is(err, materialdoc.ErrInvalid) {
			obs.ResponseError(w, err)
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
				"code": "material_content_unreadable", "message": "material content could not be decoded",
			})
			return
		}
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, text)
		return
	}
	// The collaboration authority checks the file, workspace and checkpoint
	// again as the actor.
	body, _ := json.Marshal(map[string]any{
		"workspaceId": ws, "userId": req.ActorUserID, "fileId": req.Item.ID,
		"epoch": req.Epoch, "checkpoint": req.Checkpoint, "changeId": req.ChangeID,
	})
	raw, status, err := a.s.SourceAuthority(r.Context(), "/internal/source-changes/resolve", body)
	if err != nil {
		a.fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
