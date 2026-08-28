package integrations

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestMicrosoftItemURL(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		driveID string
		itemID  string
		want    string
	}{
		{
			name:   "own drive",
			itemID: "item1",
			want:   "https://graph.microsoft.com/v1.0/me/drive/items/item1",
		},
		{
			name:    "blank drive stays on me",
			driveID: "   ",
			itemID:  "item1",
			want:    "https://graph.microsoft.com/v1.0/me/drive/items/item1",
		},
		{
			name:    "other drive",
			driveID: "b!abc",
			itemID:  "item1",
			want:    "https://graph.microsoft.com/v1.0/drives/b%21abc/items/item1",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := MicrosoftItemURL(tc.driveID, tc.itemID)
			if got != tc.want {
				t.Fatalf("MicrosoftItemURL(%q, %q) = %q, want %q", tc.driveID, tc.itemID, got, tc.want)
			}
		})
	}
}

func TestZipImportDriveIDs(t *testing.T) {
	t.Parallel()
	refs, err := ZipImportDriveIDs([]string{"a", "b"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if refs[0].DriveID != "" || refs[1].ID != "b" {
		t.Fatalf("nil driveIds: %#v", refs)
	}

	refs, err = ZipImportDriveIDs([]string{"a", "b"}, []string{"d1", ""})
	if err != nil {
		t.Fatal(err)
	}
	if refs[0].DriveID != "d1" || refs[1].DriveID != "" {
		t.Fatalf("zipped: %#v", refs)
	}

	if _, err := ZipImportDriveIDs([]string{"a"}, []string{"d1", "d2"}); err == nil {
		t.Fatal("expected length mismatch")
	}
}

func TestGoogleNativeMetadataExportsEverySupportedTypeToPDF(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	providerHTTP = &http.Client{Transport: roundTripFunc(
		func(req *http.Request) (*http.Response, error) {
			if req.Header.Get("Authorization") != "Bearer token" {
				t.Fatalf("authorization = %q", req.Header.Get("Authorization"))
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(
					`{"name":"Budget","mimeType":"application/vnd.google-apps.spreadsheet","capabilities":{"canDownload":true}}`,
				)),
			}, nil
		},
	)}

	meta, err := GetGoogleFileMetadata(context.Background(), "token", "file_1")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "Budget.pdf" || meta.MIMEType != "application/pdf" ||
		meta.Size != nil || !meta.ExportPDF {
		t.Fatalf("metadata = %+v", meta)
	}
	if got := GoogleDownloadURL("file_1", true); !strings.Contains(
		got, "/export?mimeType=application/pdf",
	) {
		t.Fatalf("export URL = %q", got)
	}
}

func TestMicrosoftMetadataRejectsNonHTTPSDownloadURL(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	providerHTTP = &http.Client{Transport: roundTripFunc(
		func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(
					`{"name":"file.pdf","size":12,"file":{"mimeType":"application/pdf"},"@microsoft.graph.downloadUrl":"http://internal.example/file"}`,
				)),
			}, nil
		},
	)}

	if _, err := GetMicrosoftFileMetadata(
		context.Background(), "token", "item", "",
	); err == nil {
		t.Fatal("non-HTTPS preauthenticated URL accepted")
	}
}

func TestProviderMetadataKeepsTransientStatusRetryable(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{name: "service unavailable", status: http.StatusServiceUnavailable},
		{name: "expired token", status: http.StatusUnauthorized},
		{
			name:   "Google user rate limit",
			status: http.StatusForbidden,
			body:   `{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			providerHTTP = &http.Client{Transport: roundTripFunc(
				func(*http.Request) (*http.Response, error) {
					return &http.Response{
						StatusCode: tc.status,
						Header:     make(http.Header),
						Body:       io.NopCloser(strings.NewReader(tc.body)),
					}, nil
				},
			)}

			_, err := GetGoogleFileMetadata(
				context.Background(), "token", "file_1",
			)
			if err == nil {
				t.Fatal("expected transient provider error")
			}
			if errors.Is(err, ErrImportFileUnavailable) {
				t.Fatalf("transient provider status was classified terminal: %v", err)
			}
		})
	}
}
