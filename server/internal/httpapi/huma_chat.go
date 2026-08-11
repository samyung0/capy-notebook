package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
)

// Conversation CRUD is plain JSON, so it lives on huma (and in the OpenAPI spec
// the frontend generates from). The token stream itself can't be modelled by
// huma and stays on raw chi — see chat_stream.go.

type wsConversationsInput struct {
	ID string `path:"id" doc:"Workspace id"`
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
	reg(api, http.MethodGet, "/api/conversations/{id}/messages", "listMessages", tag, "Load a conversation's message history", http.StatusOK, a.listMessages)
	reg(api, http.MethodDelete, "/api/conversations/{id}", "deleteConversation", tag, "Delete a conversation", http.StatusNoContent, a.deleteConversation)
}

func (a *api) listConversations(ctx context.Context, in *wsConversationsInput) (*conversationsOutput, error) {
	res, err := a.s.ListConversations(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &conversationsOutput{Body: res}, nil
}

func (a *api) createConversation(ctx context.Context, in *createConversationInput) (*conversationOutput, error) {
	res, err := a.s.CreateConversation(ctx, userID(ctx), in.ID, in.Body.Title)
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
