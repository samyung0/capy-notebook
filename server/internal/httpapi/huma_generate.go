package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type generateInput struct {
	ID   string `path:"id"`
	Body apimodel.GenerateReq
}

type generateOutput struct {
	Body map[string]any
}

// generateMixShare is how much of a quiz "Mix in questions I have answered"
// takes (Claude's value).
const generateMixShare = 0.3

func (a *api) registerGenerate(api huma.API) {
	reg(api, http.MethodPost, "/api/workspaces/{id}/generate", "generate", "Generate", "Generate a quiz from workspace sources", http.StatusOK, a.generate)
}

// generate writes a quiz from workspace sources (Make my own practice, Epo
// 2026-11-04). Anyone who can read the workspace may, on their own credits. An
// owner's or editor's quiz is a file of the workspace; anyone else's is their
// own standalone material linked to it, which nobody else can reach.
func (a *api) generate(ctx context.Context, in *generateInput) (*generateOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	role, err := a.s.WorkspaceEffectiveRole(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	canEdit := store.RoleCanEdit(role)
	// Refuse a frozen actor, or one at its storage limit (it pays for the
	// material), before credits are reserved or spent; the material insert
	// would refuse it anyway.
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if err := a.s.StorageFullErr(ctx, userID(ctx)); err != nil {
		return nil, hErr(err)
	}
	actor := userID(ctx)
	wsID := in.ID
	ctx, cancelLiveAuthorization := a.liveWorkspaceContext(ctx, actor, wsID)
	defer cancelLiveAuthorization()
	llm, err := a.resolveLLM(ctx, actor, models.SlotChat)
	if err != nil {
		return nil, hErr(err)
	}
	embed, err := a.resolveEmbedding(ctx, wsID)
	if err != nil {
		return nil, hErr(err)
	}
	charge, err := a.beginProviderSession(ctx, actor, wsID, store.SurfaceGenerate, llm.Rates, embed.Rates, llm.Thinking)
	if err != nil {
		return nil, hErr(err)
	}
	defer charge.release(ctx)

	title, err := normalizeGenerateTitle(string(in.Body.Title))
	if err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	if canEdit {
		if title, err = a.freeGenerateTitle(ctx, wsID, title); err != nil {
			return nil, hErr(err)
		}
	}
	ws, err := a.s.GetWorkspaceShared(ctx, wsID)
	if err != nil {
		return nil, hErr(err)
	}

	if a.pipe == nil {
		return nil, hErr(errAIUnavailable)
	}
	opts := generateOptsFrom(in.Body, title)
	opts.CanEdit = canEdit
	payload, _, err := a.generateViaPipe(ctx, actor, wsID, ws.Name, &opts, llm, charge.id)
	if err != nil {
		var unknown unknownScopeIDError
		if errors.As(err, &unknown) {
			return nil, huma.Error400BadRequest(unknown.Error())
		}
		return nil, hErr(err)
	}
	charge.settle(ctx)
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
	Count   int
	Types   []string
	Levels  []string
	Topics  []string
	FileIds []string
	Title   string
	// Mix adds the caller's answered questions to the new ones.
	Mix bool
	// CanEdit makes the quiz a file of the workspace.
	CanEdit bool
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
		Count:   req.Count,
		Types:   types,
		Levels:  levels,
		Topics:  req.Topics,
		FileIds: req.FileIds,
		Title:   title,
		Mix:     req.Mix,
	}
}

// freeGenerateTitle numbers a title the workspace already holds: nobody typed it.
func (a *api) freeGenerateTitle(ctx context.Context, wsID, title string) (string, error) {
	candidate := title
	for n := 2; ; n++ {
		taken, err := a.s.MaterialTitleTaken(ctx, wsID, candidate)
		if err != nil || !taken {
			return candidate, err
		}
		candidate = fmt.Sprintf("%s %d", title, n)
	}
}

// normalizeGenerateTitle trims the title; its length is validated by the
// request schema (apimodel.MaterialTitle).
func normalizeGenerateTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return "", errors.New("title is required")
	}
	return title, nil
}

// resolveScope resolves the dialog's ids: any untrashed file or top-level
// material the caller can read, and topics, which add every such item filed in
// them. No ids means every item. Items without indexed text
// contribute none; a scope with no text at all is refused.
func (a *api) resolveScope(ctx context.Context, wsID string, opts *generateOpts) (fileIDs, fileNames, topicNames []string, err error) {
	items, err := a.s.VisibleSourceItems(ctx, wsID, userID(ctx))
	if err != nil {
		return nil, nil, nil, err
	}
	byID := make(map[string]store.SourceItem, len(items))
	for _, item := range items {
		byID[item.ID] = item
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
		if _, ok := byID[id]; !ok {
			return nil, nil, nil, unknownScopeIDError{kind: "item", id: id}
		}
		add(id)
	}
	if len(opts.FileIds) == 0 && len(opts.Topics) == 0 {
		for _, item := range items {
			add(item.ID)
		}
	}
	if len(opts.Topics) > 0 {
		topics, err := a.s.ListTopics(ctx, wsID)
		if err != nil {
			return nil, nil, nil, err
		}
		names := make(map[string]string, len(topics))
		for _, ch := range topics {
			names[ch.ID] = ch.Name
		}
		for _, id := range opts.Topics {
			name, ok := names[id]
			if !ok {
				return nil, nil, nil, unknownScopeIDError{kind: "topic", id: id}
			}
			topicNames = append(topicNames, name)
			for _, item := range items {
				if item.TopicID != nil && *item.TopicID == id {
					add(item.ID)
				}
			}
		}
	}
	fileNames = make([]string, 0, len(fileIDs))
	hasIndexed := false
	for _, id := range fileIDs {
		fileNames = append(fileNames, byID[id].Name)
		hasIndexed = hasIndexed || byID[id].Indexed
	}
	if !hasIndexed {
		return nil, nil, nil, errScopeNoIndexedContent
	}
	return fileIDs, fileNames, topicNames, nil
}

type unknownScopeIDError struct {
	kind string // item or topic
	id   string
}

func (e unknownScopeIDError) Error() string {
	if e.kind == "topic" {
		return fmt.Sprintf("No topic has the id %q: it may have been deleted.", e.id)
	}
	return fmt.Sprintf("No workspace item has the id %q: it may have been deleted or moved to trash.", e.id)
}

func (a *api) generateViaPipe(
	ctx context.Context,
	userID, wsID, wsName string,
	opts *generateOpts,
	llm resolvedLLM,
	spendSessionID string,
) (any, pipeUsage, error) {
	fileIDs, fileNames, topicNames, err := a.resolveScope(ctx, wsID, opts)
	if err != nil {
		return nil, pipeUsage{}, err
	}
	// Nothing readable to draw on: an empty list would read as the whole workspace.
	if len(fileIDs) == 0 {
		return nil, pipeUsage{}, errGenerateEmpty
	}
	mixed := []map[string]any{}
	if opts.Mix {
		if mixed, err = a.s.MixInQuestions(ctx, userID, wsID, opts.Topics, int(math.Round(float64(opts.Count)*generateMixShare)), time.Now()); err != nil {
			return nil, pipeUsage{}, err
		}
		opts.Count -= len(mixed)
	}
	body := map[string]any{
		"workspaceId": wsID, "readsHidden": opts.CanEdit, "count": opts.Count, "types": opts.Types, "levels": opts.Levels,
		"topics": topicNames, "fileIds": fileIDs, "fileNames": fileNames,
		"locale":         a.userLocale(ctx, userID),
		"spendSessionId": spendSessionID,
	}
	llm.attach(body)
	var usage pipeUsage
	raw, err := a.pipe.PostRaw(ctx, "/generate", body)
	if err != nil {
		if mapped := pipelineLLMError(err); mapped != nil {
			return nil, usage, mapped
		}
		if mapped := pipelineGenerateError(err); mapped != nil {
			if tooLarge, ok := mapped.(*pendingSourcesTooLargeError); ok {
				a.notifyPendingOverflow(ctx, wsID, tooLarge.FileIDs)
			}
			return nil, usage, mapped
		}
		return nil, usage, &aiServiceError{cause: err}
	}
	usage = usageFrom(raw)
	var qp struct {
		Questions []map[string]any `json:"questions"`
	}
	if json.Unmarshal(raw, &qp) != nil {
		return nil, usage, fmt.Errorf("%w: invalid generate response", errAIUnavailable)
	}
	if len(qp.Questions) == 0 {
		return nil, usage, errGenerateEmpty
	}
	questions, err := json.Marshal(append(qp.Questions, mixed...))
	if err != nil {
		return nil, usage, err
	}
	draft := store.MaterialDraft{
		ActorUserID: userID, Kind: "quiz", Title: opts.Title, Questions: questions,
		ScopeTopics: topicNames, ScopeFileNames: fileNames,
	}
	if opts.CanEdit {
		draft.WorkspaceID, draft.WorkspaceName = wsID, wsName
		if len(opts.Topics) == 1 {
			draft.TopicID = &opts.Topics[0]
		}
	} else {
		draft.PracticeWorkspaceID = wsID
		if len(opts.Topics) == 1 {
			draft.PracticeTopicID = &opts.Topics[0]
		}
	}
	mt, err := a.s.CreateMaterialDraft(ctx, draft)
	if err != nil {
		return nil, usage, err
	}
	quiz, err := a.s.GetQuiz(ctx, mt.ID)
	if err != nil {
		return nil, usage, err
	}
	return map[string]any{"quiz": quiz}, usage, nil
}
