package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type createBlankFileInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateBlankFileReq
}

// createBlankFile is the Create tab's Blank DOCX and Blank XLSX: the
// collaboration server's Office engine builds the file from its starter (the
// one the agent's create starts from) and it is stored as a source the actor
// pays for, not processed (Epo 2026-10-25).
func (a *api) createBlankFile(ctx context.Context, in *createBlankFileInput) (*fileOutput, error) {
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	actor := userID(ctx)
	b := in.Body
	title := strings.Join(strings.Fields(officeTitleUnsafe.ReplaceAllString(string(b.Name), " ")), " ")
	// A name given with its extension keeps one.
	if ext := "." + b.Format; len(title) > len(ext) && strings.EqualFold(title[len(title)-len(ext):], ext) {
		title = strings.TrimSpace(title[:len(title)-len(ext)])
	}
	if title == "" {
		return nil, huma.Error422UnprocessableEntity("the file needs a name")
	}
	name := fieldlimits.ClampFileName(title + "." + b.Format)
	// Refused before the engine builds anything: access, the account, its
	// storage, the workspace's file cap and then the chapter, as an upload's.
	// The insert gates them again.
	if err := a.s.AssertSourceUploadRoom(ctx, in.ID, actor, 0); err != nil {
		return nil, hErr(err)
	}
	var chapterID *string
	if b.ChapterID != "" {
		chapterWorkspace, err := a.s.ChapterWorkspaceID(ctx, b.ChapterID)
		if err != nil || chapterWorkspace != in.ID {
			return nil, huma.Error400BadRequest("chapter does not belong to this workspace")
		}
		chapterID = &b.ChapterID
	}
	file, err := a.addBlankOfficeFile(ctx, actor, in.ID, b.Format, name, chapterID)
	if err != nil {
		return nil, err
	}
	return &fileOutput{Body: file}, nil
}

// addBlankOfficeFile builds a blank Office file from the engine's starter and
// stores it in the workspace as the actor's unprocessed source: the Create
// tab's Blank DOCX and XLSX, and the starter workspace's Word file.
func (a *api) addBlankOfficeFile(ctx context.Context, actor, wsID, format, name string, chapterID *string) (store.File, error) {
	if a.blob == nil {
		return store.File{}, huma.Error503ServiceUnavailable("blob store not configured")
	}
	created, err := a.s.CreateOfficeDocument(ctx, actor, format, []json.RawMessage{})
	if err != nil {
		return store.File{}, hErr(err)
	}
	kind := kindFromName(name)
	maxBytes, err := a.sourceMaxBytes(ctx, actor)
	if err != nil {
		return store.File{}, hErr(err)
	}
	if err := sourceupload.Validate(name, kind, sourceupload.ParseModeNone, int64(len(created.Content)), maxBytes); err != nil {
		return store.File{}, huma.Error422UnprocessableEntity(err.Error())
	}
	sum := sha256.Sum256(created.Content)
	blobPath, size, err := a.blob.Put(sourceObjectKey(store.ObjectKeyID("blob")), bytes.NewReader(created.Content))
	if err != nil {
		return store.File{}, hErr(err)
	}
	// Uncancelled from here: a browser that leaves after the commit must not
	// have its file's object deleted.
	ctx = context.WithoutCancel(ctx)
	file, err := a.s.CreateBlankFile(ctx, store.BlankFileDraft{
		WorkspaceID: wsID, ActorUserID: actor, Name: name, Kind: kind, ChapterID: chapterID,
		SizeBytes: size, BlobPath: blobPath, Parser: a.parser, SHA256: hex.EncodeToString(sum[:]),
	})
	if err != nil {
		// A refused or failed insert leaves no row for the object.
		_ = a.blob.Delete(ctx, blobPath)
		return store.File{}, hErr(err)
	}
	return file, nil
}
