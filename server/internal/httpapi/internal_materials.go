package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

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
	secret := a.cfg.PipelineSecret
	if secret == "" ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Pipeline-Secret")), []byte(secret)) != 1 {
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
	ctx := r.Context()
	if err := a.s.AssertWorkspaceEditor(ctx, req.UserID, req.WorkspaceID); err != nil {
		a.fail(w, err)
		return
	}
	if err := a.generationCreditsAllowed(ctx, req.UserID); err != nil {
		a.fail(w, err)
		return
	}

	wsName := "Workspace"
	if ws, err := a.s.GetWorkspaceShared(ctx, req.WorkspaceID); err == nil {
		wsName = ws.Name
	}
	title := strings.TrimSpace(req.Title)

	switch req.Kind {
	case "quiz":
		if title == "" {
			title = wsName + " quiz"
		}
		quiz, err := a.s.CreateQuiz(ctx, store.Quiz{
			UserID: req.UserID, Name: title, WorkspaceID: req.WorkspaceID, WorkspaceName: wsName,
			Chapters: req.Chapters, Questions: req.Questions, Privacy: "private",
			TimeLimitMin: req.TimeLimitMin,
		})
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"kind": "quiz", "materialId": quiz.ID, "title": quiz.Name,
		})
	case "flashcards":
		if title == "" {
			title = wsName + " flashcards"
		}
		cards := make([][2]string, 0, len(req.Cards))
		for _, c := range req.Cards {
			cards = append(cards, [2]string{c.Front, c.Back})
		}
		deck, err := a.s.CreateDeckWithCards(ctx, req.UserID, title, "green", req.WorkspaceID, cards)
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"kind": "flashcards", "materialId": deck.ID, "title": title, "count": len(cards),
		})
	case "mindmap", "diagram", "note":
		if title == "" {
			title = wsName + " " + req.Kind
		}
		mt, err := a.s.CreateMaterial(ctx, store.Material{
			CreatedBy: req.UserID, WorkspaceID: req.WorkspaceID, WorkspaceName: wsName,
			Kind: store.MaterialKind(req.Kind), Title: title, Content: req.Content,
			ScopeChapters: req.Chapters, ScopeFileNames: req.FileNames, Privacy: "private",
		})
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"kind": req.Kind, "materialId": mt.ID, "title": mt.Title,
		})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "unsupported material kind " + req.Kind})
	}
}
