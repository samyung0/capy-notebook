package integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/evonotes/server/internal/sourceupload"
)

// Providers supported for file import. OAuth token management lives in Clerk
// (see clerk.go); this file only talks to the providers' file APIs.
const (
	ProviderGoogle    = "google"
	ProviderMicrosoft = "microsoft"
	ProviderNotion    = "notion"
)

func DownloadGoogleFile(accessToken, fileID string) ([]byte, string, error) {
	metaReq, _ := http.NewRequest("GET", "https://www.googleapis.com/drive/v3/files/"+fileID+"?fields=name,mimeType", nil)
	metaReq.Header.Set("Authorization", "Bearer "+accessToken)
	metaResp, err := http.DefaultClient.Do(metaReq)
	if err != nil {
		return nil, "", err
	}
	defer metaResp.Body.Close()
	var meta struct {
		Name     string `json:"name"`
		MimeType string `json:"mimeType"`
	}
	_ = json.NewDecoder(metaResp.Body).Decode(&meta)

	dlURL := "https://www.googleapis.com/drive/v3/files/" + fileID + "?alt=media"
	if strings.HasPrefix(meta.MimeType, "application/vnd.google-apps.") {
		dlURL = "https://www.googleapis.com/drive/v3/files/" + fileID + "/export?mimeType=application/pdf"
		if meta.MimeType == "application/vnd.google-apps.document" {
			meta.Name = strings.TrimSuffix(meta.Name, ".gdoc") + ".pdf"
		}
	}
	req, _ := http.NewRequest("GET", dlURL, nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode >= 400 {
		return nil, "", fmt.Errorf("drive download: %s", string(data))
	}
	return data, meta.Name, nil
}

// MicrosoftDrive is the Graph /me/drive payload the picker host needs.
type MicrosoftDrive struct {
	ID        string `json:"id"`
	DriveType string `json:"driveType"`
	WebURL    string `json:"webUrl"`
}

// MicrosoftItemURL is the Graph item path. Shared or other-drive picks must
// use /drives/{id}/items/{id}; /me/drive/items/{id} only sees the user's drive.
func MicrosoftItemURL(driveID, itemID string) string {
	item := url.PathEscape(itemID)
	if strings.TrimSpace(driveID) == "" {
		return "https://graph.microsoft.com/v1.0/me/drive/items/" + item
	}
	return "https://graph.microsoft.com/v1.0/drives/" + url.PathEscape(driveID) + "/items/" + item
}

func DownloadMicrosoftFile(accessToken, itemID, driveID string) ([]byte, string, error) {
	base := MicrosoftItemURL(driveID, itemID)
	metaReq, err := http.NewRequest(http.MethodGet, base+"?select=name", nil)
	if err != nil {
		return nil, "", err
	}
	metaReq.Header.Set("Authorization", "Bearer "+accessToken)
	metaResp, err := http.DefaultClient.Do(metaReq)
	if err != nil {
		return nil, "", err
	}
	defer metaResp.Body.Close()
	if metaResp.StatusCode >= 400 {
		body, _ := io.ReadAll(metaResp.Body)
		return nil, "", fmt.Errorf("onedrive metadata: %s", string(body))
	}
	var meta struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(metaResp.Body).Decode(&meta); err != nil {
		return nil, "", err
	}

	req, err := http.NewRequest(http.MethodGet, base+"/content", nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode >= 400 {
		return nil, "", fmt.Errorf("onedrive download: %s", string(data))
	}
	return data, meta.Name, nil
}

func GetMicrosoftDrive(ctx context.Context, accessToken string) (MicrosoftDrive, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://graph.microsoft.com/v1.0/me/drive?select=id,driveType,webUrl", nil)
	if err != nil {
		return MicrosoftDrive{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return MicrosoftDrive{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return MicrosoftDrive{}, err
	}
	if resp.StatusCode >= 400 {
		return MicrosoftDrive{}, fmt.Errorf("onedrive drive: %s", string(body))
	}
	var drive MicrosoftDrive
	if err := json.Unmarshal(body, &drive); err != nil {
		return MicrosoftDrive{}, err
	}
	if strings.TrimSpace(drive.DriveType) == "" || strings.TrimSpace(drive.WebURL) == "" {
		return MicrosoftDrive{}, fmt.Errorf("onedrive drive: missing driveType or webUrl")
	}
	return drive, nil
}

// ImportRef is one picked file. DriveID is empty for Google and for a
// Microsoft item that still lives on /me/drive.
type ImportRef struct {
	ID      string
	DriveID string
}

func ZipImportDriveIDs(fileIDs, driveIDs []string) ([]ImportRef, error) {
	if len(driveIDs) > 0 && len(driveIDs) != len(fileIDs) {
		return nil, fmt.Errorf("driveIds must match fileIds")
	}
	out := make([]ImportRef, len(fileIDs))
	for i, id := range fileIDs {
		ref := ImportRef{ID: id}
		if i < len(driveIDs) {
			ref.DriveID = strings.TrimSpace(driveIDs[i])
		}
		out[i] = ref
	}
	return out, nil
}

func KindFromName(name string) string {
	return sourceupload.KindFromName(name)
}
