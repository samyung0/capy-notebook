package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
)

var ErrImportFolderTooLarge = errors.New("folder selection exceeds import limits")
var ErrImportFolderEmpty = errors.New("selected folders contain no files")

// ExpandGoogleFolders flattens selected trees. The workspace file limit also
// bounds folder/list requests, including empty folders and paginated responses.
// Shortcuts stay ordinary unsupported files; following them could leave the tree.
func ExpandGoogleFolders(ctx context.Context, token string, roots []string, limit int) ([]ImportRef, error) {
	pending := []string{}
	seenFolders := map[string]bool{}
	for _, id := range roots {
		if !seenFolders[id] {
			seenFolders[id] = true
			pending = append(pending, id)
		}
	}
	seenFiles := map[string]bool{}
	refs := []ImportRef{}
	requests := 0
	for len(pending) > 0 {
		folderID := pending[0]
		pending = pending[1:]
		if !validGoogleFileID(folderID) {
			return nil, ErrImportFileUnavailable
		}
		pageToken := ""
		for {
			if requests >= limit {
				return nil, ErrImportFolderTooLarge
			}
			requests++
			query := url.Values{
				"q":                         {"'" + folderID + "' in parents and trashed = false"},
				"fields":                    {"nextPageToken,incompleteSearch,files(id,mimeType)"},
				"pageSize":                  {"1000"},
				"orderBy":                   {"name"},
				"includeItemsFromAllDrives": {"true"},
				"supportsAllDrives":         {"true"},
			}
			if pageToken != "" {
				query.Set("pageToken", pageToken)
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.googleapis.com/drive/v3/files?"+query.Encode(), nil)
			if err != nil {
				return nil, err
			}
			req.Header.Set("Authorization", "Bearer "+token)
			resp, err := providerHTTP.Do(req)
			if err != nil {
				return nil, classifyImportRequestError(ctx, err)
			}
			var body struct {
				NextPageToken    string `json:"nextPageToken"`
				IncompleteSearch bool   `json:"incompleteSearch"`
				Files            []struct {
					ID       string `json:"id"`
					MIMEType string `json:"mimeType"`
				} `json:"files"`
			}
			if resp.StatusCode != http.StatusOK {
				data, readErr := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
				resp.Body.Close()
				if readErr != nil {
					return nil, classifyImportRequestError(ctx, readErr)
				}
				return nil, providerMetadataStatusError(ProviderGoogle, resp.StatusCode,
					resp.StatusCode == http.StatusForbidden && googleRateLimitResponse(data))
			}
			err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body)
			resp.Body.Close()
			if err != nil {
				return nil, classifyImportRequestError(ctx, err)
			}
			if body.IncompleteSearch {
				return nil, ErrImportFileUnavailable
			}
			for _, file := range body.Files {
				if !validGoogleFileID(file.ID) {
					return nil, ErrImportFileUnavailable
				}
				if file.MIMEType == "application/vnd.google-apps.folder" {
					if !seenFolders[file.ID] {
						seenFolders[file.ID] = true
						pending = append(pending, file.ID)
						if len(seenFolders) > limit {
							return nil, ErrImportFolderTooLarge
						}
					}
				} else if !seenFiles[file.ID] {
					seenFiles[file.ID] = true
					refs = append(refs, ImportRef{ID: file.ID})
					if len(refs) > limit {
						return nil, ErrImportFolderTooLarge
					}
				}
			}
			pageToken = body.NextPageToken
			if pageToken == "" {
				break
			}
		}
	}
	if len(refs) == 0 {
		return nil, ErrImportFolderEmpty
	}
	return refs, nil
}
