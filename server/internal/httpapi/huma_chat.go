package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Conversation CRUD is plain JSON, so it lives on huma (and in the OpenAPI spec
// the frontend generates from). The token stream itself can't be modelled by
// huma and stays on raw chi — see chat_stream.go.

type wsConversationsInput struct {
	ID string `path:"id" doc:"Workspace id"`
}
type listConversationsInput struct {
	ID       string `path:"id" doc:"Workspace id"`
	Archived bool   `query:"archived" doc:"true lists the archived threads instead of the live list"`
}
type listAccountConversationsInput struct {
	Archived bool `query:"archived" doc:"true lists the archived threads instead of the live list"`
}
type createAccountConversationInput struct {
	Body apimodel.CreateConversationReq
}
type updateConversationInput struct {
	ID   string `path:"id" doc:"Conversation id"`
	Body apimodel.UpdateConversationReq
}
type createConversationInput struct {
	ID   string `path:"id" doc:"Workspace id"`
	Body apimodel.CreateConversationReq
}
type conversationIDInput struct {
	ID string `path:"id" doc:"Conversation id"`
}

type conversationsOutput struct {
	Body []apimodel.Conversation `nullable:"false"`
}
type conversationOutput struct {
	Body apimodel.Conversation
}
type messagesOutput struct {
	Body []apimodel.Message `nullable:"false"`
}

func (a *api) registerChat(api huma.API) {
	const tag = "Chat"
	reg(api, http.MethodGet, "/api/workspaces/{id}/conversations", "listConversations", tag, "List a workspace's chat conversations", http.StatusOK, a.listConversations)
	reg(api, http.MethodPost, "/api/workspaces/{id}/conversations", "createConversation", tag, "Start a new chat conversation", http.StatusCreated, a.createConversation)
	// Account chat (Epo 2026-10-27): the caller's conversations outside any
	// workspace; the per-conversation routes below serve them to their owner.
	reg(api, http.MethodGet, "/api/conversations", "listAccountConversations", tag, "List the caller's account chat conversations", http.StatusOK, a.listAccountConversations)
	reg(api, http.MethodPost, "/api/conversations", "createAccountConversation", tag, "Start a new account chat conversation", http.StatusCreated, a.createAccountConversation)
	reg(api, http.MethodGet, "/api/conversations/{id}/messages", "listMessages", tag, "Load a conversation's message history", http.StatusOK, a.listMessages)
	reg(api, http.MethodPost, "/api/conversations/{id}/messages/{messageId}/stop", "stopChatTurn", tag, "Stop a conversation's running turn", http.StatusNoContent, a.stopTurn)
	reg(api, http.MethodPatch, "/api/conversations/{id}", "updateConversation", tag, "Rename, pin or archive a conversation", http.StatusOK, a.updateConversation)
	reg(api, http.MethodDelete, "/api/conversations/{id}", "deleteConversation", tag, "Delete a conversation", http.StatusNoContent, a.deleteConversation)
	reg(api, http.MethodPost, "/api/workspaces/{id}/conversations/unarchive", "unarchiveConversations", tag, "Put every archived conversation back in the list", http.StatusNoContent, a.unarchiveConversations)
	reg(api, http.MethodDelete, "/api/workspaces/{id}/conversations/archived", "deleteArchivedConversations", tag, "Delete every archived conversation", http.StatusNoContent, a.deleteArchivedConversations)
	reg(api, http.MethodPost, "/api/conversations/unarchive", "unarchiveAccountConversations", tag, "Put every archived account conversation back in the list", http.StatusNoContent,
		func(ctx context.Context, _ *struct{}) (*Empty, error) {
			return a.unarchiveConversations(ctx, &wsConversationsInput{})
		})
	reg(api, http.MethodDelete, "/api/conversations/archived", "deleteArchivedAccountConversations", tag, "Delete every archived account conversation", http.StatusNoContent,
		func(ctx context.Context, _ *struct{}) (*Empty, error) {
			return a.deleteArchivedConversations(ctx, &wsConversationsInput{})
		})
}

func (a *api) listConversations(ctx context.Context, in *listConversationsInput) (*conversationsOutput, error) {
	res, err := a.s.ListConversations(ctx, userID(ctx), in.ID, in.Archived)
	if err != nil {
		return nil, hErr(err)
	}
	return &conversationsOutput{Body: res}, nil
}

func (a *api) createConversation(ctx context.Context, in *createConversationInput) (*conversationOutput, error) {
	res, err := a.s.CreateConversation(ctx, userID(ctx), in.ID, string(in.Body.Title))
	if err != nil {
		return nil, hErr(err)
	}
	return &conversationOutput{Body: res}, nil
}

func (a *api) listAccountConversations(ctx context.Context, in *listAccountConversationsInput) (*conversationsOutput, error) {
	res, err := a.s.ListConversations(ctx, userID(ctx), "", in.Archived)
	if err != nil {
		return nil, hErr(err)
	}
	return &conversationsOutput{Body: res}, nil
}

func (a *api) createAccountConversation(ctx context.Context, in *createAccountConversationInput) (*conversationOutput, error) {
	res, err := a.s.CreateConversation(ctx, userID(ctx), "", string(in.Body.Title))
	if err != nil {
		return nil, hErr(err)
	}
	return &conversationOutput{Body: res}, nil
}

func (a *api) listMessages(ctx context.Context, in *conversationIDInput) (*messagesOutput, error) {
	res, err := a.s.ListMessages(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &messagesOutput{Body: res}, nil
}

func (a *api) deleteConversation(ctx context.Context, in *conversationIDInput) (*Empty, error) {
	if err := a.s.DeleteConversation(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) updateConversation(ctx context.Context, in *updateConversationInput) (*conversationOutput, error) {
	u := store.ConversationUpdate{Pinned: in.Body.Pinned, Archived: in.Body.Archived}
	if in.Body.Title != nil {
		title := string(*in.Body.Title)
		u.Title = &title
	}
	res, err := a.s.UpdateConversation(ctx, userID(ctx), in.ID, u)
	if err != nil {
		return nil, hErr(err)
	}
	return &conversationOutput{Body: res}, nil
}

func (a *api) unarchiveConversations(ctx context.Context, in *wsConversationsInput) (*Empty, error) {
	if err := a.s.UnarchiveConversations(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) deleteArchivedConversations(ctx context.Context, in *wsConversationsInput) (*Empty, error) {
	if err := a.s.DeleteArchivedConversations(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
