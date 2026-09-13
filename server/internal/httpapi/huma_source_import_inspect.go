package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/integrations"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

type inspectSourceImportsReq struct {
	Provider string   `json:"provider" enum:"google,microsoft"`
	FileIDs  []string `json:"fileIds" minItems:"1" maxItems:"20" nullable:"false"`
	DriveIDs []string `json:"driveIds,omitempty" nullable:"false"`
}

type inspectSourceImportsInput struct {
	ID   string `path:"id"`
	Body inspectSourceImportsReq
}

type inspectedSourceImport struct {
	FileID       string `json:"fileId"`
	DriveID      string `json:"driveId,omitempty"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	ContentType  string `json:"contentType"`
	SizeBytes    int64  `json:"sizeBytes"`
	SizeEstimate bool   `json:"sizeEstimate"`
	AnalysisURL  string `json:"analysisUrl"`
}

type inspectSourceImportRejected struct {
	FileID string `json:"fileId"`
	Code   string `json:"code"`
}

type inspectSourceImportsResponse struct {
	Items    []inspectedSourceImport       `json:"items" nullable:"false"`
	Rejected []inspectSourceImportRejected `json:"rejected" nullable:"false"`
}

type inspectSourceImportsOutput struct {
	Body inspectSourceImportsResponse
}

func (a *api) inspectSourceImports(
	ctx context.Context,
	in *inspectSourceImportsInput,
) (*inspectSourceImportsOutput, error) {
	if err := a.assertWorkspaceEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if in.Body.Provider != integrations.ProviderGoogle &&
		in.Body.Provider != integrations.ProviderMicrosoft {
		return nil, huma.Error400BadRequest("unknown provider")
	}
	refs, err := integrations.ZipImportDriveIDs(in.Body.FileIDs, in.Body.DriveIDs)
	if err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	if len(refs) == 0 {
		return nil, huma.Error400BadRequest("provider and fileIds required")
	}
	token, scopes, err := integrations.ClerkAccessTokenScopes(ctx, userID(ctx), in.Body.Provider)
	if errors.Is(err, integrations.ErrNotConnected) {
		return nil, huma.Error400BadRequest(in.Body.Provider + " account not connected")
	}
	if err != nil {
		return nil, hErr(err)
	}
	maxBytes, err := a.sourceMaxBytes(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}

	type metadataResult struct {
		meta integrations.ImportFileMetadata
		err  error
	}
	loadMetadata := func(refs []integrations.ImportRef) []metadataResult {
		metadata := make([]metadataResult, len(refs))
		metadataSlots := make(chan struct{}, 4)
		var metadataWait sync.WaitGroup
		for index, ref := range refs {
			metadataWait.Add(1)
			go func() {
				defer metadataWait.Done()
				select {
				case metadataSlots <- struct{}{}:
					defer func() { <-metadataSlots }()
				case <-ctx.Done():
					metadata[index].err = ctx.Err()
					return
				}
				switch in.Body.Provider {
				case integrations.ProviderGoogle:
					metadata[index].meta, metadata[index].err =
						integrations.GetGoogleFileMetadata(ctx, token, ref.ID)
				case integrations.ProviderMicrosoft:
					metadata[index].meta, metadata[index].err =
						integrations.GetMicrosoftFileMetadata(ctx, token, ref.ID, ref.DriveID)
				}
			}()
		}
		metadataWait.Wait()

		return metadata
	}
	metadata := loadMetadata(refs)
	var folders []integrations.ImportRef
	var files []integrations.ImportRef
	var fileMetadata []metadataResult
	for index, ref := range refs {
		if in.Body.Provider == integrations.ProviderMicrosoft && metadata[index].meta.DriveID != "" {
			ref.DriveID = metadata[index].meta.DriveID
			refs[index] = ref
		}
		if errors.Is(metadata[index].err, integrations.ErrImportFolder) {
			folders = append(folders, ref)
		} else {
			files = append(files, ref)
			fileMetadata = append(fileMetadata, metadata[index])
		}
	}
	if len(folders) > 0 {
		var expanded []integrations.ImportRef
		var expandErr error
		if in.Body.Provider == integrations.ProviderGoogle && !integrations.HasGoogleDriveReadScope(scopes) {
			expandErr = integrations.ErrGoogleDriveScopeRequired
		} else {
			workspace, err := a.s.GetWorkspace(ctx, userID(ctx), in.ID, false)
			if err != nil {
				return nil, hErr(err)
			}
			if in.Body.Provider == integrations.ProviderGoogle {
				ids := make([]string, len(folders))
				for i, ref := range folders {
					ids[i] = ref.ID
				}
				expanded, expandErr = integrations.ExpandGoogleFolders(ctx, token, ids, workspace.FilesLimit)
			} else {
				expanded, expandErr = integrations.ExpandMicrosoftFolders(ctx, token, folders, workspace.FilesLimit)
			}
		}
		if expandErr != nil {
			for _, ref := range folders {
				files = append(files, ref)
				fileMetadata = append(fileMetadata, metadataResult{err: expandErr})
			}
		} else {
			seen := map[integrations.ImportRef]bool{}
			for _, ref := range files {
				seen[ref] = true
			}
			unique := make([]integrations.ImportRef, 0, len(expanded))
			for _, ref := range expanded {
				if !seen[ref] {
					unique = append(unique, ref)
					seen[ref] = true
				}
			}
			files = append(files, unique...)
			fileMetadata = append(fileMetadata, loadMetadata(unique)...)
		}
		refs, metadata = files, fileMetadata
	}

	response := inspectSourceImportsResponse{
		Items:    make([]inspectedSourceImport, 0, len(refs)),
		Rejected: make([]inspectSourceImportRejected, 0),
	}
	for index, ref := range refs {
		meta := metadata[index].meta
		if err := metadata[index].err; err != nil {
			if ctx.Err() != nil {
				return nil, hErr(ctx.Err())
			}
			if integrations.IsRetryableImportProviderError(err) ||
				(!errors.Is(err, integrations.ErrImportFileUnavailable) &&
					!errors.Is(err, integrations.ErrUnsupportedImportFile) &&
					!errors.Is(err, integrations.ErrImportFolderTooLarge) &&
					!errors.Is(err, integrations.ErrImportFolderEmpty) &&
					!errors.Is(err, integrations.ErrGoogleDriveScopeRequired)) {
				return nil, huma.Error503ServiceUnavailable(
					"provider metadata is temporarily unavailable",
				)
			}
			code := "provider_file_unavailable"
			switch {
			case errors.Is(err, integrations.ErrImportFolderTooLarge):
				code = "folder_too_large"
			case errors.Is(err, integrations.ErrImportFolderEmpty):
				code = "folder_empty"
			case errors.Is(err, integrations.ErrGoogleDriveScopeRequired):
				code = "google_drive_scope_required"
			case errors.Is(err, integrations.ErrUnsupportedImportFile):
				code = "unsupported_file"
			}
			response.Rejected = append(response.Rejected, inspectSourceImportRejected{
				FileID: ref.ID,
				Code:   code,
			})
			continue
		}

		meta.Name = strings.TrimSpace(meta.Name)
		if meta.Name == "" || utf8.RuneCountInString(meta.Name) > fieldlimits.FileName {
			response.Rejected = append(response.Rejected, inspectSourceImportRejected{
				FileID: ref.ID,
				Code:   "invalid_name",
			})
			continue
		}
		sizeBytes := int64(0)
		sizeEstimate := false
		if meta.Size != nil {
			sizeBytes = *meta.Size
		} else if meta.ExportPDF {
			sizeBytes = min(maxBytes, integrations.GoogleExportMaxBytes())
			sizeEstimate = true
		}
		if sizeBytes < 0 || sizeBytes > maxBytes {
			response.Rejected = append(response.Rejected, inspectSourceImportRejected{
				FileID: ref.ID,
				Code:   "file_too_large",
			})
			continue
		}
		kind := integrations.KindFromName(meta.Name)
		mode := sourceupload.DefaultParseMode(meta.Name, kind)
		if err := sourceupload.Validate(meta.Name, kind, mode, sizeBytes, maxBytes); err != nil {
			response.Rejected = append(response.Rejected, inspectSourceImportRejected{
				FileID: ref.ID,
				Code:   "unsupported_file",
			})
			continue
		}
		contentType := strings.TrimSpace(meta.MIMEType)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		query := url.Values{
			"provider": []string{in.Body.Provider},
			"fileId":   []string{ref.ID},
		}
		if ref.DriveID != "" {
			query.Set("driveId", ref.DriveID)
		}
		response.Items = append(response.Items, inspectedSourceImport{
			FileID:       ref.ID,
			DriveID:      ref.DriveID,
			Name:         meta.Name,
			Kind:         kind,
			ContentType:  contentType,
			SizeBytes:    sizeBytes,
			SizeEstimate: sizeEstimate,
			AnalysisURL: fmt.Sprintf(
				"/api/workspaces/%s/sources/import-content?%s",
				url.PathEscape(in.ID),
				query.Encode(),
			),
		})
	}
	return &inspectSourceImportsOutput{Body: response}, nil
}
