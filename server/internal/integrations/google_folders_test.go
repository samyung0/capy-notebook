package integrations

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestGoogleFolderExpansion(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	calls := 0
	providerHTTP = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.Scheme != "https" || req.URL.Host != "www.googleapis.com" || req.Header.Get("Authorization") != "Bearer token" {
			t.Fatalf("unexpected provider request")
		}
		q := req.URL.Query()
		var body string
		switch {
		case q.Get("q") == "'root' in parents and trashed = false" && q.Get("pageToken") == "":
			body = `{"nextPageToken":"page2","files":[{"id":"first","mimeType":"text/plain"},{"id":"nested","mimeType":"application/vnd.google-apps.folder"}]}`
		case q.Get("q") == "'root' in parents and trashed = false" && q.Get("pageToken") == "page2":
			body = `{"files":[{"id":"second","mimeType":"text/plain"}]}`
		case q.Get("q") == "'nested' in parents and trashed = false":
			body = `{"files":[{"id":"first","mimeType":"text/plain"},{"id":"third","mimeType":"text/plain"},{"id":"root","mimeType":"application/vnd.google-apps.folder"}]}`
		default:
			t.Fatalf("unexpected folder request: %s", q.Get("q"))
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	refs, err := ExpandGoogleFolders(context.Background(), "token", []string{"root", "nested", "nested"}, 3)
	if err != nil || len(refs) != 3 || refs[0].ID != "first" || refs[1].ID != "second" || refs[2].ID != "third" || calls != 3 {
		t.Fatalf("refs=%v err=%v calls=%d", refs, err, calls)
	}
}

func TestGoogleFolderExpansionBoundsAndFailures(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	for _, tc := range []struct {
		name, body    string
		status, limit int
		want          error
	}{
		{"file bound", `{"files":[{"id":"a"},{"id":"b"}]}`, 200, 1, ErrImportFolderTooLarge},
		{"pagination bound", `{"files":[],"nextPageToken":"again"}`, 200, 2, ErrImportFolderTooLarge},
		{"incomplete listing", `{"incompleteSearch":true,"files":[{"id":"a"}]}`, 200, 2, ErrImportFileUnavailable},
		{"empty", `{"files":[]}`, 200, 2, ErrImportFolderEmpty},
		{"permission", `{}`, 403, 2, ErrImportFileUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			providerHTTP = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			refs, err := ExpandGoogleFolders(context.Background(), "token", []string{"root"}, tc.limit)
			if !errors.Is(err, tc.want) || len(refs) != 0 || calls > tc.limit {
				t.Fatalf("refs=%v err=%v calls=%d", refs, err, calls)
			}
		})
	}
}

func TestGoogleFolderRequiresReadScopeAndStaysOutOfDownloads(t *testing.T) {
	if HasGoogleDriveReadScope([]string{"https://www.googleapis.com/auth/drive.file"}) || HasGoogleDriveReadScope(nil) {
		t.Fatal("per-file grants cannot authorize a folder's contents")
	}
	if !HasGoogleDriveReadScope([]string{GoogleDriveReadonlyScope}) || !HasGoogleDriveReadScope([]string{"https://www.googleapis.com/auth/drive"}) {
		t.Fatal("read grants should allow folders")
	}
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	providerHTTP = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"name":"folder","mimeType":"application/vnd.google-apps.folder","capabilities":{"canDownload":false}}`))}, nil
	})}
	_, err := GetGoogleFileMetadata(context.Background(), "token", "folder")
	if !errors.Is(err, ErrImportFolder) || !errors.Is(err, ErrUnsupportedImportFile) {
		t.Fatalf("unexpected folder error: %v", err)
	}
}
