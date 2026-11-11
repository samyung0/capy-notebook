package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// The Files page's one list (store.ListItems): files, submissions, blocks and
// embeds together.

type itemsListInput struct {
	Kind        string `query:"kind" doc:"Comma-separated kinds: file kinds, note, quiz, flashcards; image and audio also match embedded images and audio"`
	WorkspaceID string `query:"workspaceId" doc:"Comma-separated workspace ids; a submission sits in its assignment's workspace"`
	Location    string `query:"location" doc:"Comma-separated locations: workspace, standalone"`
	Query       string `query:"q" maxLength:"120" doc:"Keeps rows whose shown name holds this text, any case"`
	Scope       string `query:"scope" enum:"owned,all" default:"owned" doc:"owned: what the caller pays for, wherever it sits (My files); all: those plus every file and block of its own workspaces and those it is a member of (All files)"`
	Sort        string `query:"sort" enum:"added,name,size,kind,workspace" default:"added"`
	Dir         string `query:"dir" enum:"asc,desc" default:"desc"`
	Limit       int    `query:"limit" minimum:"1" maximum:"100" default:"40"`
	Cursor      string `query:"cursor" doc:"Opaque cursor from the previous page"`
}

type itemPageOutput struct {
	Body store.ItemPage
}

func (a *api) registerItems(api huma.API) {
	reg(api, http.MethodGet, "/api/items", "listItems", "Content",
		"List the caller's files, handed-in submissions it may delete, notes, quizzes, flashcard sets and embedded images and audio as one list (the Files page)",
		http.StatusOK, a.listItems)
}

func (a *api) listItems(ctx context.Context, in *itemsListInput) (*itemPageOutput, error) {
	for _, location := range csv(in.Location) {
		switch location {
		case "workspace", "standalone":
		default:
			return nil, huma.Error400BadRequest("unsupported location")
		}
	}
	page, err := a.s.ListItems(ctx, userID(ctx), store.ItemListFilter{
		Kinds: csv(in.Kind), WorkspaceIDs: csv(in.WorkspaceID), Locations: csv(in.Location),
		Query: strings.TrimSpace(in.Query), All: in.Scope == "all",
		Sort: in.Sort, Ascending: in.Dir == "asc", Limit: in.Limit, Cursor: in.Cursor,
	})
	if err != nil {
		return nil, hErr(err)
	}
	// Every row is one the caller may read, so it may see its thumbnail.
	for _, item := range page.Items {
		switch {
		case item.File != nil:
			files := []store.File{*item.File}
			if err := a.signFileThumbnails(ctx, files); err != nil {
				return nil, hErr(err)
			}
			*item.File = files[0]
		case item.Embed != nil:
			if item.Embed.ThumbnailURL, err = a.thumbnailURL(ctx, item.Embed.ThumbnailKey); err != nil {
				return nil, hErr(err)
			}
		}
	}
	return &itemPageOutput{Body: page}, nil
}
