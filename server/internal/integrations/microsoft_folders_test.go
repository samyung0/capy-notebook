package integrations

import (
	"context"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestMicrosoftFolderExpansion(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	calls := 0
	providerHTTP = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.Host != "graph.microsoft.com" || req.Header.Get("Authorization") != "Bearer token" {
			t.Fatal("unexpected provider request")
		}
		var body string
		switch req.URL.Path {
		case "/v1.0/drives/a/items/root/children":
			if req.URL.Query().Get("$skiptoken") == "next" {
				body = `{"value":[{"id":"second"}]}`
			} else {
				body = `{"value":[{"id":"first"},{"id":"nested","folder":{}}],"@odata.nextLink":"https://graph.microsoft.com/v1.0/drives/a/items/root/children?$skiptoken=next"}`
			}
		case "/v1.0/drives/a/items/nested/children":
			body = `{"value":[{"id":"first"},{"id":"third"},{"id":"root","folder":{}},{"id":"shortcut","folder":{},"remoteItem":{"id":"elsewhere"}}]}`
		case "/v1.0/drives/b/items/root/children":
			body = `{"value":[{"id":"first"}]}`
		default:
			t.Fatalf("unexpected path: %s", req.URL.Path)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	roots := []ImportRef{{ID: "root", DriveID: "a"}, {ID: "nested", DriveID: "a"}, {ID: "root", DriveID: "b"}, {ID: "root", DriveID: "a"}}
	refs, err := ExpandMicrosoftFolders(context.Background(), "token", roots, 5)
	want := []ImportRef{{ID: "first", DriveID: "a"}, {ID: "second", DriveID: "a"}, {ID: "third", DriveID: "a"}, {ID: "shortcut", DriveID: "a"}, {ID: "first", DriveID: "b"}}
	if err != nil || !reflect.DeepEqual(refs, want) || calls != 4 {
		t.Fatalf("refs=%v err=%v calls=%d", refs, err, calls)
	}
}

func TestMicrosoftFolderExpansionBoundsAndFailures(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	for _, tc := range []struct {
		name, body    string
		status, limit int
		want          error
	}{
		{"files", `{"value":[{"id":"a"},{"id":"b"}]}`, 200, 1, ErrImportFolderTooLarge},
		{"folders", `{"value":[{"id":"a","folder":{}},{"id":"b","folder":{}}]}`, 200, 1, ErrImportFolderTooLarge},
		{"pagination", `{"value":[],"@odata.nextLink":"https://graph.microsoft.com/v1.0/me/drive/items/root/children?again=1"}`, 200, 2, ErrImportFolderTooLarge},
		{"external next link", `{"value":[{"id":"a"}],"@odata.nextLink":"https://evil.example/steal"}`, 200, 2, ErrImportFileUnavailable},
		{"different graph path", `{"value":[{"id":"a"}],"@odata.nextLink":"https://graph.microsoft.com/v1.0/me/messages"}`, 200, 2, ErrImportFileUnavailable},
		{"redirect", `{}`, 302, 2, ErrImportFileUnavailable},
		{"missing id", `{"value":[{}]}`, 200, 2, ErrImportFileUnavailable},
		{"empty", `{"value":[]}`, 200, 2, ErrImportFolderEmpty},
		{"permission", `{}`, 403, 2, ErrImportFileUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			providerHTTP = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				calls++
				if req.URL.Host != "graph.microsoft.com" || !strings.HasSuffix(req.URL.Path, "/root/children") {
					t.Fatal("untrusted pagination URL was followed")
				}
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Location": {"https://evil.example/steal"}}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			refs, err := ExpandMicrosoftFolders(context.Background(), "token", []ImportRef{{ID: "root"}}, tc.limit)
			if !errors.Is(err, tc.want) || len(refs) != 0 || calls > tc.limit {
				t.Fatalf("refs=%v err=%v calls=%d", refs, err, calls)
			}
		})
	}
}

func TestMicrosoftFolderMetadata(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	providerHTTP = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if !strings.Contains(req.URL.Query().Get("select"), "folder") {
			t.Fatal("metadata must request the folder facet")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"name":"folder","folder":{},"parentReference":{"driveId":"actual-drive"}}`))}, nil
	})}
	meta, err := GetMicrosoftFileMetadata(context.Background(), "token", "folder", "")
	if !errors.Is(err, ErrImportFolder) || !errors.Is(err, ErrUnsupportedImportFile) || meta.DriveID != "actual-drive" {
		t.Fatalf("meta=%v err=%v", meta, err)
	}
}
