package httpapi

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/store"
)

// The chat agent can create study materials mid-conversation. It cannot do that
// by streaming a "material" event back through the SSE relay, because that
// channel is one-directional: the model would be told the quiz exists before Go
// had run the owner's storage quota check, and it would have no material id to
// refer to afterwards. The tool calls in here synchronously instead, so a quota
// rejection reaches the model in time for it to say so.
//
// Authentication is a shared secret rather than a user session. The retrieval
// service is trusted infrastructure — it already holds the same Postgres
// credentials as this process — so the secret only keeps the route off the
// public internet. The workspace-editor check below is what actually constrains
// what may be written and on whose behalf.
type internalMaterialReq struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	UserID      string   `json:"userId"`
	Kind        string   `json:"kind"`
	Title       string   `json:"title"`
	Chapters    []string `json:"chapters"`
	FileNames   []string `json:"fileNames"`

	Questions json.RawMessage `json:"questions"`
	Cards     []struct {
		Front string `json:"front"`
		Back  string `json:"back"`
	} `json:"cards"`
	Content      string `json:"content"`
	TimeLimitMin *int   `json:"timeLimitMin"`
}

func (a *api) internalCreateMaterial(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}

	var req internalMaterialReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if req.WorkspaceID == "" || req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "workspaceId and userId are required"})
		return
	}
	switch req.Kind {
	case "quiz", "flashcards", "mindmap", "diagram", "note":
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "unsupported material kind " + req.Kind})
		return
	}
	ctx := r.Context()
	if err := a.s.AssertWorkspaceEditor(ctx, req.UserID, req.WorkspaceID); err != nil {
		a.fail(w, err)
		return
	}

	if req.ID != "" {
		existing, err := a.s.GetMaterial(ctx, req.ID)
		if err == nil {
			if materialReplayMatches(existing, req) {
				writeMaterialOK(w, existing)
				return
			}
			a.fail(w, store.ErrMaterialConflict)
			return
		}
		if !errors.Is(err, store.ErrNotFound) {
			a.fail(w, err)
			return
		}
	}

	// Do not recheck inference credits here. The provider call that emitted this
	// accepted tool may have exhausted them, and the turn contract requires its
	// already-paid tools to finish. The pipeline secret plus the editor check
	// above authorize the write; storage quota is still enforced by the store.

	ws, err := a.s.GetWorkspaceShared(ctx, req.WorkspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	wsName := ws.Name
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = wsName + " " + req.Kind
	}
	disambiguated, err := a.s.DisambiguateMaterialTitle(ctx, req.WorkspaceID, title)
	if err != nil {
		a.fail(w, err)
		return
	}
	title = disambiguated

	created, err := a.insertInternalMaterial(ctx, req, title, wsName)
	if errors.Is(err, store.ErrMaterialIDTaken) && req.ID != "" {
		existing, getErr := a.s.GetMaterial(ctx, req.ID)
		if getErr == nil {
			if materialReplayMatches(existing, req) {
				writeMaterialOK(w, existing)
				return
			}
			a.fail(w, store.ErrMaterialConflict)
			return
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"code":    "material_lookup_failed",
			"message": "material create outcome is unknown",
		})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, created)
}

func (a *api) insertInternalMaterial(ctx context.Context, req internalMaterialReq, title, wsName string) (map[string]any, error) {
	switch req.Kind {
	case "quiz":
		quiz, err := a.s.CreateQuiz(ctx, store.Quiz{
			ID: req.ID, UserID: req.UserID, Name: title, WorkspaceID: req.WorkspaceID, WorkspaceName: wsName,
			Chapters: req.Chapters, Questions: req.Questions, Privacy: "private",
			TimeLimitMin: req.TimeLimitMin,
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"kind": "quiz", "materialId": quiz.ID, "title": quiz.Name}, nil
	case "flashcards":
		cards := make([][2]string, 0, len(req.Cards))
		for _, c := range req.Cards {
			cards = append(cards, [2]string{c.Front, c.Back})
		}
		deck, err := a.s.CreateDeckWithCards(ctx, req.UserID, title, "green", req.WorkspaceID, cards, req.ID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"kind": "flashcards", "materialId": deck.ID, "title": title, "count": len(cards)}, nil
	case "mindmap", "diagram", "note":
		mt, err := a.s.CreateMaterial(ctx, store.Material{
			ID: req.ID, CreatedBy: req.UserID, WorkspaceID: req.WorkspaceID, WorkspaceName: wsName,
			Kind: store.MaterialKind(req.Kind), Title: title, Content: req.Content,
			ScopeChapters: req.Chapters, ScopeFileNames: req.FileNames, Privacy: "private",
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"kind": req.Kind, "materialId": mt.ID, "title": mt.Title}, nil
	default:
		return nil, errUnsupportedMaterialKind(req.Kind)
	}
}

type unsupportedMaterialKindError string

func (e unsupportedMaterialKindError) Error() string {
	return "unsupported material kind " + string(e)
}

func errUnsupportedMaterialKind(kind string) error {
	return unsupportedMaterialKindError(kind)
}

func (a *api) internalGetMaterial(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	materialID := chi.URLParam(r, "materialId")
	if materialID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "materialId is required"})
		return
	}
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if workspaceID == "" || userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "workspaceId and userId are required"})
		return
	}
	if err := a.s.AssertWorkspaceEditor(r.Context(), userID, workspaceID); err != nil {
		a.fail(w, err)
		return
	}
	mt, err := a.s.GetMaterial(r.Context(), materialID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "not found"})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	if mt.WorkspaceID != workspaceID {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "not found"})
		return
	}
	writeMaterialOK(w, mt)
}

func (a *api) pipelineSecretOK(r *http.Request) bool {
	secret := a.cfg.PipelineSecret
	return secret != "" &&
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Pipeline-Secret")), []byte(secret)) == 1
}

func writeMaterialOK(w http.ResponseWriter, mt store.Material) {
	writeJSON(w, http.StatusOK, map[string]any{
		"kind": mt.Kind, "materialId": mt.ID, "title": mt.Title,
	})
}

func materialReplayMatches(mt store.Material, req internalMaterialReq) bool {
	if mt.WorkspaceID != req.WorkspaceID || mt.CreatedBy != req.UserID || string(mt.Kind) != req.Kind {
		return false
	}
	switch req.Kind {
	case "quiz":
		questions, _, err := materialdoc.ExtractQuiz(mt.Content)
		if err != nil {
			return false
		}
		return jsonBytesEqual(questions, req.Questions)
	case "flashcards":
		cards, err := materialdoc.ExtractFlashcards(mt.Content)
		if err != nil || len(cards) != len(req.Cards) {
			return false
		}
		for i, card := range cards {
			if card.Front != req.Cards[i].Front || card.Back != req.Cards[i].Back {
				return false
			}
		}
		return true
	case "mindmap", "diagram":
		got, err := materialdoc.ExtractMermaidSource(mt.Content)
		if err != nil {
			return false
		}
		return got == materialdoc.IncomingMermaidSource(req.Content)
	default:
		got, err := materialdoc.ExtractNoteText(mt.Content)
		if err != nil {
			return false
		}
		return got == materialdoc.IncomingNoteText(req.Content)
	}
}

func jsonBytesEqual(a, b []byte) bool {
	if len(bytes.TrimSpace(a)) == 0 && len(bytes.TrimSpace(b)) == 0 {
		return true
	}
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return bytes.Equal(bytes.TrimSpace(a), bytes.TrimSpace(b))
	}
	ax, _ := json.Marshal(x)
	ay, _ := json.Marshal(y)
	return bytes.Equal(ax, ay)
}
