package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// recentMaterialKinds are the top-level materials Recent lists, as the
// material list accepts them.
var recentMaterialKinds = []string{"note", "quiz", "flashcards", "mindmap", "diagram"}

type recentInput struct {
	Limit int `query:"limit" minimum:"1" maximum:"50" default:"20"`
}

// RecentOpen is one Recent row: exactly one of file and material.
type RecentOpen struct {
	OpenedAt time.Time                  `json:"openedAt"`
	File     *apimodel.File             `json:"file,omitempty"`
	Material *apimodel.MaterialListItem `json:"material,omitempty"`
}

type recentOutput struct {
	Body struct {
		Items []RecentOpen `json:"items" nullable:"false"`
	}
}

func (a *api) registerOpens(api huma.API) {
	const tag = "Recent"
	reg(api, http.MethodGet, "/api/recent", "listRecent", tag, "The caller's newest opened files and materials", http.StatusOK, a.listRecent)
	reg(api, http.MethodPost, "/api/files/{id}/open", "openFile", tag, "Note that the caller opened a file", http.StatusNoContent, a.openFile)
	reg(api, http.MethodPost, "/api/materials/{id}/open", "openMaterial", tag, "Note that the caller opened a material", http.StatusNoContent, a.openMaterial)
}

// openFile and openMaterial record the opens behind Recent; repeats within a
// few minutes are acknowledged without a write.
func (a *api) openFile(ctx context.Context, in *fileIDInput) (*Empty, error) {
	return &Empty{}, hErr(a.s.RecordItemOpen(ctx, userID(ctx), store.OpenFile, in.ID))
}

func (a *api) openMaterial(ctx context.Context, in *materialIDInput) (*Empty, error) {
	return &Empty{}, hErr(a.s.RecordItemOpen(ctx, userID(ctx), store.OpenMaterial, in.ID))
}

// listRecent serves the dashboard's Recent Files and the quick open: the
// caller's opens (creating counts), newest first, read back through the
// Member listings so each row carries what those lists show.
func (a *api) listRecent(ctx context.Context, in *recentInput) (*recentOutput, error) {
	user := userID(ctx)
	opens, err := a.s.RecentOpens(ctx, user, recentMaterialKinds, in.Limit)
	if err != nil {
		return nil, hErr(err)
	}
	var fileIDs, materialIDs []string
	for _, open := range opens {
		if open.Kind == store.OpenFile {
			fileIDs = append(fileIDs, open.ID)
		} else {
			materialIDs = append(materialIDs, open.ID)
		}
	}
	files := map[string]*store.File{}
	if len(fileIDs) > 0 {
		page, err := a.s.ListOwnedFiles(ctx, user, store.FileListFilter{IDs: fileIDs, Member: true, Limit: len(fileIDs)})
		if err != nil {
			return nil, hErr(err)
		}
		if err := a.signFileThumbnails(ctx, page.Items); err != nil {
			return nil, hErr(err)
		}
		for i := range page.Items {
			files[page.Items[i].ID] = &page.Items[i]
		}
	}
	materials := map[string]*store.MaterialListItem{}
	if len(materialIDs) > 0 {
		page, err := a.s.ListOwnedMaterials(ctx, user, store.MaterialListFilter{
			IDs: materialIDs, Kinds: recentMaterialKinds, Member: true, Limit: len(materialIDs),
		})
		if err != nil {
			return nil, hErr(err)
		}
		for i := range page.Items {
			materials[page.Items[i].ID] = &page.Items[i]
		}
	}
	out := &recentOutput{}
	out.Body.Items = []RecentOpen{}
	// A row the listings left out (trashed or out of reach since) is skipped.
	for _, open := range opens {
		row := RecentOpen{OpenedAt: open.OpenedAt, File: files[open.ID]}
		if open.Kind == store.OpenMaterial {
			row = RecentOpen{OpenedAt: open.OpenedAt, Material: materials[open.ID]}
		}
		if row.File != nil || row.Material != nil {
			out.Body.Items = append(out.Body.Items, row)
		}
	}
	return out, nil
}
