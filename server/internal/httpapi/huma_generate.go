package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
)

type generateInput struct {
	ID   string `path:"id"`
	Body apimodel.GenerateReq
}

type generateOutput struct {
	Body map[string]any
}

func (a *api) registerGenerate(api huma.API) {
	reg(api, http.MethodPost, "/api/workspaces/{id}/generate", "generate", "Generate", "Generate a quiz, deck, mindmap, or diagram", http.StatusOK, a.generate)
}

func (a *api) generate(ctx context.Context, in *generateInput) (*generateOutput, error) {
	if err := a.assertWorkspaceEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	actor := userID(ctx)
	wsID := in.ID
	llm, err := a.resolveLLM(ctx, actor, models.SurfaceGenerate)
	if err != nil {
		return nil, hErr(err)
	}
	llmRates := llm.Rates
	embed, err := a.resolveEmbedding(ctx, wsID)
	if err != nil {
		return nil, hErr(err)
	}
	charge, err := a.beginSpend(ctx, actor, wsID, store.SurfaceGenerate, llm.PaidBy)
	if err != nil {
		return nil, hErr(err)
	}
	defer charge.release(ctx)

	title, err := normalizeGenerateTitle(in.Body.Title)
	if err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	taken, err := a.s.MaterialTitleTaken(ctx, wsID, title)
	if err != nil {
		return nil, hErr(err)
	}
	if taken {
		return nil, hErr(store.ErrTitleTaken)
	}
	ws, err := a.s.GetWorkspaceShared(ctx, wsID)
	if err != nil {
		return nil, hErr(err)
	}

	if a.pipe == nil {
		return nil, hErr(errAIUnavailable)
	}
	opts := generateOptsFrom(in.Body, title)
	payload, usage, err := a.generateViaPipe(ctx, actor, wsID, ws.Name, &opts, llm)
	if err != nil {
		var unknown unknownScopeIDError
		if errors.As(err, &unknown) {
			return nil, huma.Error400BadRequest(unknown.Error())
		}
		return nil, hErr(err)
	}
	charge.settle(ctx, usage.events(actor, wsID, store.SurfaceGenerate, llmRates, embed.Rates, llm.PaidBy)...)
	body, ok := payload.(map[string]any)
	if !ok {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, hErr(fmt.Errorf("%w: invalid generate response", errAIUnavailable))
		}
		if err := json.Unmarshal(encoded, &body); err != nil {
			return nil, hErr(fmt.Errorf("%w: invalid generate response", errAIUnavailable))
		}
	}
	return &generateOutput{Body: body}, nil
}

type generateOpts struct {
	Kind         store.MaterialKind
	Length       string
	Format       string
	Count        int
	Style        string
	Types        []string
	Levels       []string
	Chapters     []string
	FileIds      []string
	Detail       string
	DiagramType  string
	TimeLimitMin *int
	Title        string
}

func generateOptsFrom(req apimodel.GenerateReq, title string) generateOpts {
	types := make([]string, len(req.Types))
	for i, t := range req.Types {
		types[i] = string(t)
	}
	levels := make([]string, len(req.Levels))
	for i, lvl := range req.Levels {
		levels[i] = string(lvl)
	}
	return generateOpts{
		Kind:         req.Kind.MaterialKind(),
		Length:       req.Length,
		Format:       req.Format,
		Count:        req.Count,
		Style:        req.Style,
		Types:        types,
		Levels:       levels,
		Chapters:     req.Chapters,
		FileIds:      req.FileIds,
		Detail:       string(req.Detail),
		DiagramType:  string(req.DiagramType),
		TimeLimitMin: req.TimeLimitMin,
		Title:        title,
	}
}

const generateTitleMaxRunes = 200

func normalizeGenerateTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return "", errors.New("title is required")
	}
	if utf8.RuneCountInString(title) > generateTitleMaxRunes {
		return "", errors.New("title must be at most 200 characters")
	}
	return title, nil
}

func (a *api) resolveScope(ctx context.Context, wsID string, opts *generateOpts) (fileIDs, fileNames, chapterNames []string, err error) {
	files, err := a.s.ListFiles(ctx, "", wsID)
	if err != nil {
		return nil, nil, nil, err
	}
	fileNamesByID := make(map[string]string, len(files))
	for _, file := range files {
		fileNamesByID[file.ID] = file.Name
	}
	seen := map[string]struct{}{}
	fileIDs = make([]string, 0, len(opts.FileIds))
	add := func(id string) {
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		fileIDs = append(fileIDs, id)
	}
	for _, id := range opts.FileIds {
		if _, ok := fileNamesByID[id]; !ok {
			return nil, nil, nil, unknownScopeIDError{kind: "file", id: id}
		}
		add(id)
	}
	if len(opts.Chapters) > 0 {
		chapters, err := a.s.ListChapters(ctx, wsID)
		if err != nil {
			return nil, nil, nil, err
		}
		byID := make(map[string]store.Chapter, len(chapters))
		for _, ch := range chapters {
			byID[ch.ID] = ch
		}
		for _, id := range opts.Chapters {
			ch, ok := byID[id]
			if !ok {
				return nil, nil, nil, unknownScopeIDError{kind: "chapter", id: id}
			}
			chapterNames = append(chapterNames, ch.Name)
			for _, fid := range ch.FileIDs {
				if _, ok := fileNamesByID[fid]; !ok {
					return nil, nil, nil, unknownScopeIDError{kind: "file", id: fid}
				}
				add(fid)
			}
		}
	}
	fileNames = make([]string, 0, len(fileIDs))
	for _, id := range fileIDs {
		fileNames = append(fileNames, fileNamesByID[id])
	}
	return fileIDs, fileNames, chapterNames, nil
}

type unknownScopeIDError struct {
	kind string
	id   string
}

func (e unknownScopeIDError) Error() string {
	return fmt.Sprintf("unknown %s id %q", e.kind, e.id)
}

func (a *api) generateViaPipe(
	ctx context.Context,
	userID, wsID, wsName string,
	opts *generateOpts,
	llm resolvedLLM,
) (any, pipeUsage, error) {
	fileIDs, fileNames, chapterNames, err := a.resolveScope(ctx, wsID, opts)
	if err != nil {
		return nil, pipeUsage{}, err
	}
	body := map[string]any{
		"workspaceId": wsID, "kind": opts.Kind, "length": opts.Length, "format": opts.Format,
		"count": opts.Count, "style": opts.Style, "types": opts.Types, "levels": opts.Levels,
		"chapters": chapterNames, "fileIds": fileIDs,
		"detail": opts.Detail, "diagramType": opts.DiagramType, "timeLimitMin": opts.TimeLimitMin,
		"locale": a.userLocale(ctx, userID),
	}
	llm.attach(body)
	var usage pipeUsage
	raw, err := a.pipe.PostRaw(ctx, "/generate", body)
	if err != nil {
		if mapped := pipelineLLMError(err); mapped != nil {
			return nil, usage, mapped
		}
		if mapped := pipelineGenerateError(err); mapped != nil {
			return nil, usage, mapped
		}
		return nil, usage, fmt.Errorf("%w: %v", errAIUnavailable, err)
	}
	usage = usageFrom(raw)
	var head struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(raw, &head) != nil {
		return nil, usage, fmt.Errorf("%w: invalid generate response", errAIUnavailable)
	}
	switch head.Kind {
	case "quiz":
		var qp struct {
			Name         string          `json:"name"`
			Chapters     []string        `json:"chapters"`
			Questions    json.RawMessage `json:"questions"`
			TimeLimitMin *int            `json:"timeLimitMin"`
		}
		_ = json.Unmarshal(raw, &qp)
		name := opts.Title
		chapters := qp.Chapters
		if chapters == nil {
			chapters = chapterNames
		}
		qs := strings.TrimSpace(string(qp.Questions))
		if qs == "" || qs == "[]" || qs == "null" {
			return nil, usage, errGenerateEmpty
		}
		quiz, err := a.s.CreateQuiz(ctx, store.Quiz{
			UserID: userID, Name: name, WorkspaceID: wsID, WorkspaceName: wsName, Chapters: chapters,
			Questions: qp.Questions, Privacy: "private", TimeLimitMin: qp.TimeLimitMin,
		})
		if err != nil {
			return nil, usage, err
		}
		return map[string]any{"kind": "quiz", "quiz": quiz}, usage, nil
	case "flashcards":
		var fp struct {
			Cards []struct {
				Front string `json:"front"`
				Back  string `json:"back"`
			} `json:"cards"`
		}
		_ = json.Unmarshal(raw, &fp)
		fronts := make([][2]string, 0, len(fp.Cards))
		for _, c := range fp.Cards {
			fronts = append(fronts, [2]string{c.Front, c.Back})
		}
		res, err := a.persistDeck(ctx, userID, wsID, opts.Title, fronts)
		if err != nil {
			return nil, usage, err
		}
		return res, usage, nil
	case "mindmap", "diagram":
		var mp struct {
			Title   string `json:"title"`
			Content string `json:"content"`
		}
		_ = json.Unmarshal(raw, &mp)
		res, err := a.persistMaterial(ctx, userID, wsID, wsName, store.MaterialKind(head.Kind), opts.Title, mp.Content, chapterNames, fileNames)
		if err != nil {
			return nil, usage, err
		}
		return res, usage, nil
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil, usage, fmt.Errorf("%w: invalid generate response", errAIUnavailable)
	}
	return m, usage, nil
}

func (a *api) persistDeck(ctx context.Context, userID, wsID, title string, cards [][2]string) (any, error) {
	if len(cards) == 0 {
		return nil, errGenerateEmpty
	}
	deck, err := a.s.CreateDeckWithCards(
		ctx, userID, title, "green", wsID, cards, "",
	)
	if err != nil {
		return nil, err
	}
	out, err := a.s.ListCards(ctx, deck.ID)
	if err != nil {
		return nil, err
	}
	deck, _ = a.s.GetDeck(ctx, deck.ID)
	return map[string]any{"kind": "flashcards", "deck": deck, "cards": out}, nil
}

func (a *api) persistMaterial(ctx context.Context, userID, wsID, wsName string, kind store.MaterialKind, title, content string, chapterNames, fileNames []string) (any, error) {
	if strings.TrimSpace(content) == "" {
		return nil, errGenerateEmpty
	}
	mt, err := a.s.CreateMaterial(ctx, store.Material{
		CreatedBy: userID, WorkspaceID: wsID, WorkspaceName: wsName, Kind: kind, Title: title,
		Content: content, ScopeChapters: chapterNames, ScopeFileNames: fileNames, Privacy: "private",
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"kind": kind, "material": mt}, nil
}
