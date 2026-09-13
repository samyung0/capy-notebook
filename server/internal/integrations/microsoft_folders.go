package integrations

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
)

// ExpandMicrosoftFolders flattens native folders, preserving drive identity.
// As for Google, the workspace file limit also bounds folders and list requests.
// Remote-item shortcuts are left for metadata inspection to reject.
func ExpandMicrosoftFolders(ctx context.Context, token string, roots []ImportRef, limit int) ([]ImportRef, error) {
	pending := []ImportRef{}
	seenFolders := map[ImportRef]bool{}
	for _, ref := range roots {
		if !seenFolders[ref] {
			seenFolders[ref] = true
			pending = append(pending, ref)
		}
	}
	if len(pending) > limit {
		return nil, ErrImportFolderTooLarge
	}
	seenFiles := map[ImportRef]bool{}
	refs := []ImportRef{}
	requests := 0
	// Pagination URLs are provider data. Keep tokens on Graph and refuse redirects.
	client := *providerHTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for len(pending) > 0 {
		folder := pending[0]
		pending = pending[1:]
		if folder.ID == "" {
			return nil, ErrImportFileUnavailable
		}
		childrenURL := MicrosoftItemURL(folder.DriveID, folder.ID) + "/children"
		pageURL := childrenURL + "?$select=id,folder,remoteItem&$top=200"
		for pageURL != "" {
			parsed, err := url.Parse(pageURL)
			children, _ := url.Parse(childrenURL)
			if err != nil || parsed.Scheme != "https" || parsed.Host != "graph.microsoft.com" ||
				parsed.User != nil || parsed.Fragment != "" || parsed.Path != children.Path {
				return nil, ErrImportFileUnavailable
			}
			if requests >= limit {
				return nil, ErrImportFolderTooLarge
			}
			requests++
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
			if err != nil {
				return nil, err
			}
			req.Header.Set("Authorization", "Bearer "+token)
			resp, err := client.Do(req)
			if err != nil {
				return nil, classifyImportRequestError(ctx, err)
			}
			if resp.StatusCode != http.StatusOK {
				_, readErr := io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
				resp.Body.Close()
				if readErr != nil {
					return nil, classifyImportRequestError(ctx, readErr)
				}
				return nil, providerMetadataStatusError(ProviderMicrosoft, resp.StatusCode, false)
			}
			var body struct {
				NextLink string `json:"@odata.nextLink"`
				Value    []struct {
					ID         string    `json:"id"`
					Folder     *struct{} `json:"folder"`
					RemoteItem *struct{} `json:"remoteItem"`
				} `json:"value"`
			}
			err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body)
			resp.Body.Close()
			if err != nil {
				return nil, classifyImportRequestError(ctx, err)
			}
			for _, item := range body.Value {
				if item.ID == "" {
					return nil, ErrImportFileUnavailable
				}
				ref := ImportRef{ID: item.ID, DriveID: folder.DriveID}
				if item.Folder != nil && item.RemoteItem == nil {
					if !seenFolders[ref] {
						seenFolders[ref] = true
						pending = append(pending, ref)
						if len(seenFolders) > limit {
							return nil, ErrImportFolderTooLarge
						}
					}
				} else if !seenFiles[ref] {
					seenFiles[ref] = true
					refs = append(refs, ref)
					if len(refs) > limit {
						return nil, ErrImportFolderTooLarge
					}
				}
			}
			pageURL = body.NextLink
		}
	}
	if len(refs) == 0 {
		return nil, ErrImportFolderEmpty
	}
	return refs, nil
}
