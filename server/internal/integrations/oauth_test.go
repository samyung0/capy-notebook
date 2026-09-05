package integrations

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"syscall"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type importErrorBody struct{ err error }

func (b importErrorBody) Read([]byte) (int, error) { return 0, b.err }
func (importErrorBody) Close() error               { return nil }

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

func TestDownloadImportFileBoundsGoogleExport(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	usePublicImportHostResolver(t)
	call := 0
	providerHTTP = &http.Client{Transport: roundTripFunc(
		func(req *http.Request) (*http.Response, error) {
			call++
			if req.Header.Get("Authorization") != "Bearer token" {
				t.Fatalf("authorization = %q", req.Header.Get("Authorization"))
			}
			if call == 1 {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body: io.NopCloser(strings.NewReader(
						`{"name":"Notes","mimeType":"application/vnd.google-apps.document","capabilities":{"canDownload":true}}`,
					)),
				}, nil
			}
			if !strings.Contains(req.URL.Path, "/export") {
				t.Fatalf("download URL = %q", req.URL.String())
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/pdf"}},
				Body:       io.NopCloser(strings.NewReader("12345")),
			}, nil
		},
	)}

	_, _, err := DownloadImportFile(
		context.Background(),
		ProviderGoogle,
		"token",
		ImportRef{ID: "file_1"},
		4,
	)
	if !errors.Is(err, ErrImportFileTooLarge) {
		t.Fatalf("error = %v, want ErrImportFileTooLarge", err)
	}
}

func TestDownloadImportFileUsesMicrosoftPreauthenticatedURL(t *testing.T) {
	previous := providerHTTP
	t.Cleanup(func() { providerHTTP = previous })
	usePublicImportHostResolver(t)
	call := 0
	providerHTTP = &http.Client{Transport: roundTripFunc(
		func(req *http.Request) (*http.Response, error) {
			call++
			if call == 1 {
				if req.Header.Get("Authorization") != "Bearer token" {
					t.Fatalf("metadata authorization = %q", req.Header.Get("Authorization"))
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body: io.NopCloser(strings.NewReader(
						`{"name":"deck.pptx","size":4,"file":{"mimeType":"application/vnd.openxmlformats-officedocument.presentationml.presentation"},"@microsoft.graph.downloadUrl":"https://download.example/deck"}`,
					)),
				}, nil
			}
			if req.URL.Host != "download.example" {
				t.Fatalf("download host = %q", req.URL.Host)
			}
			if req.Header.Get("Authorization") != "" {
				t.Fatal("provider bearer token leaked to preauthenticated URL")
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("pptx")),
			}, nil
		},
	)}

	data, contentType, err := DownloadImportFile(
		context.Background(),
		ProviderMicrosoft,
		"token",
		ImportRef{ID: "item", DriveID: "drive"},
		4,
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "pptx" || !strings.Contains(contentType, "presentationml") {
		t.Fatalf("data=%q contentType=%q", data, contentType)
	}
}

func TestMicrosoftMetadataRejectsUnsafeDownloadDestinations(t *testing.T) {
	cases := []struct {
		name string
		url  string
	}{
		{name: "loopback", url: "https://127.0.0.1/file"},
		{name: "private", url: "https://10.0.0.8/file"},
		{name: "link local", url: "https://169.254.169.254/file"},
		{name: "reserved", url: "https://203.0.113.8/file"},
		{name: "userinfo", url: "https://user:pass@example.com/file"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			previous := providerHTTP
			t.Cleanup(func() { providerHTTP = previous })
			providerHTTP = &http.Client{Transport: roundTripFunc(
				func(*http.Request) (*http.Response, error) {
					return &http.Response{
						StatusCode: http.StatusOK,
						Header:     make(http.Header),
						Body: io.NopCloser(strings.NewReader(
							`{"name":"file.pdf","size":12,"file":{"mimeType":"application/pdf"},"@microsoft.graph.downloadUrl":"` + tc.url + `"}`,
						)),
					}, nil
				},
			)}

			if _, err := GetMicrosoftFileMetadata(
				context.Background(), "token", "item", "",
			); !errors.Is(err, ErrImportFileUnavailable) {
				t.Fatalf("error = %v, want ErrImportFileUnavailable", err)
			}
		})
	}
}

func TestMicrosoftMetadataRejectsPrivateDNSResolution(t *testing.T) {
	previousHTTP := providerHTTP
	previousResolver := importHostResolver
	t.Cleanup(func() {
		providerHTTP = previousHTTP
		importHostResolver = previousResolver
	})
	providerHTTP = &http.Client{Transport: roundTripFunc(
		func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(
					`{"name":"file.pdf","size":12,"file":{"mimeType":"application/pdf"},"@microsoft.graph.downloadUrl":"https://download.example/file"}`,
				)),
			}, nil
		},
	)}
	importHostResolver = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("192.168.1.5")}, nil
	}

	if _, err := GetMicrosoftFileMetadata(
		context.Background(), "token", "item", "",
	); !errors.Is(err, ErrImportFileUnavailable) {
		t.Fatalf("error = %v, want ErrImportFileUnavailable", err)
	}
}

func TestMicrosoftMetadataKeepsDNSFailureRetryable(t *testing.T) {
	previousHTTP := providerHTTP
	previousResolver := importHostResolver
	t.Cleanup(func() {
		providerHTTP = previousHTTP
		importHostResolver = previousResolver
	})
	providerHTTP = &http.Client{Transport: roundTripFunc(
		func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body: io.NopCloser(strings.NewReader(
					`{"name":"file.pdf","size":12,"file":{"mimeType":"application/pdf"},"@microsoft.graph.downloadUrl":"https://download.example/file"}`,
				)),
			}, nil
		},
	)}
	importHostResolver = func(context.Context, string) ([]netip.Addr, error) {
		return nil, &net.DNSError{Err: "temporary resolver failure", IsTemporary: true}
	}

	_, err := GetMicrosoftFileMetadata(
		context.Background(), "token", "item", "",
	)
	if err == nil || !IsRetryableImportProviderError(err) {
		t.Fatalf("error = %v, want retryable provider error", err)
	}
	if errors.Is(err, ErrImportFileUnavailable) {
		t.Fatalf("DNS failure was classified terminal: %v", err)
	}
}

func TestImportDialFailuresAreRetryableUnlessRequestCanceled(t *testing.T) {
	for _, dialErr := range []error{
		&net.OpError{Op: "dial", Net: "tcp", Err: context.DeadlineExceeded},
		&net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNRESET},
	} {
		err := classifyImportDialError(context.Background(), dialErr)
		if !IsRetryableImportProviderError(err) {
			t.Fatalf("dial error %v classified non-retryable: %v", dialErr, err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := classifyImportDialError(ctx, &net.OpError{
		Op: "dial", Net: "tcp", Err: syscall.ECONNRESET,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled dial error = %v, want context.Canceled", err)
	}
	if IsRetryableImportProviderError(err) {
		t.Fatalf("request cancellation classified as provider retry: %v", err)
	}
}

func TestProviderRequestTransportAndBodyFailuresAreRetryable(t *testing.T) {
	previousHTTP := providerHTTP
	t.Cleanup(func() { providerHTTP = previousHTTP })

	for _, tc := range []struct {
		name string
		err  error
	}{
		{name: "connect reset", err: &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNRESET}},
		{name: "TLS handshake", err: &net.OpError{Op: "remote error: tls", Net: "tcp", Err: errors.New("handshake failed")}},
		{name: "client timeout", err: &net.OpError{Op: "read", Net: "tcp", Err: context.DeadlineExceeded}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			providerHTTP = &http.Client{Transport: roundTripFunc(
				func(*http.Request) (*http.Response, error) { return nil, tc.err },
			)}
			_, err := GetGoogleFileMetadata(
				context.Background(), "token", "file_1",
			)
			if !IsRetryableImportProviderError(err) {
				t.Fatalf("error=%v, want retryable provider error", err)
			}
		})
	}

	providerHTTP = &http.Client{Transport: roundTripFunc(
		func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       importErrorBody{err: syscall.ECONNRESET},
			}, nil
		},
	)}
	_, err := GetGoogleFileMetadata(context.Background(), "token", "file_1")
	if !IsRetryableImportProviderError(err) {
		t.Fatalf("metadata body reset=%v, want retryable provider error", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	providerHTTP = &http.Client{Transport: roundTripFunc(
		func(*http.Request) (*http.Response, error) {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNRESET}
		},
	)}
	_, err = GetGoogleFileMetadata(ctx, "token", "file_1")
	if !errors.Is(err, context.Canceled) || IsRetryableImportProviderError(err) {
		t.Fatalf("canceled metadata error=%v, want context.Canceled", err)
	}
}

func TestDownloadRequestAndBodyFailuresAreRetryable(t *testing.T) {
	previousHTTP := providerHTTP
	t.Cleanup(func() { providerHTTP = previousHTTP })
	usePublicImportHostResolver(t)

	for _, tc := range []struct {
		name string
		body io.ReadCloser
		err  error
	}{
		{name: "request reset", err: &net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}},
		{name: "response body reset", body: importErrorBody{err: syscall.ECONNRESET}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			providerHTTP = &http.Client{Transport: roundTripFunc(
				func(*http.Request) (*http.Response, error) {
					calls++
					if calls == 1 {
						return &http.Response{
							StatusCode: http.StatusOK,
							Header:     make(http.Header),
							Body: io.NopCloser(strings.NewReader(
								`{"name":"file.txt","mimeType":"text/plain","size":"4","capabilities":{"canDownload":true}}`,
							)),
						}, nil
					}
					if tc.err != nil {
						return nil, tc.err
					}
					return &http.Response{
						StatusCode: http.StatusOK,
						Header:     make(http.Header),
						Body:       tc.body,
					}, nil
				},
			)}
			_, _, err := DownloadImportFile(
				context.Background(), ProviderGoogle, "token",
				ImportRef{ID: "file_1"}, 4,
			)
			if !IsRetryableImportProviderError(err) {
				t.Fatalf("error=%v, want retryable provider error", err)
			}
		})
	}
}

func TestDownloadImportFileRejectsUnsafeRedirect(t *testing.T) {
	previousHTTP := providerHTTP
	t.Cleanup(func() { providerHTTP = previousHTTP })
	usePublicImportHostResolver(t)
	call := 0
	providerHTTP = &http.Client{Transport: roundTripFunc(
		func(req *http.Request) (*http.Response, error) {
			call++
			switch call {
			case 1:
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body: io.NopCloser(strings.NewReader(
						`{"name":"deck.pptx","size":4,"file":{"mimeType":"application/vnd.openxmlformats-officedocument.presentationml.presentation"},"@microsoft.graph.downloadUrl":"https://download.example/deck"}`,
					)),
				}, nil
			case 2:
				return &http.Response{
					StatusCode: http.StatusFound,
					Header: http.Header{
						"Location": []string{"https://127.0.0.1/internal"},
					},
					Body:    io.NopCloser(strings.NewReader("")),
					Request: req,
				}, nil
			default:
				t.Fatalf("unexpected provider request %d: %s", call, req.URL)
				return nil, nil
			}
		},
	)}

	if _, _, err := DownloadImportFile(
		context.Background(), ProviderMicrosoft, "token",
		ImportRef{ID: "item"}, 4,
	); !errors.Is(err, ErrImportFileUnavailable) {
		t.Fatalf("error = %v, want ErrImportFileUnavailable", err)
	}
	if call != 2 {
		t.Fatalf("provider calls = %d, want 2", call)
	}
}

func TestDownloadImportFileStripsGoogleBearerOnCrossOriginRedirect(t *testing.T) {
	previousHTTP := providerHTTP
	t.Cleanup(func() { providerHTTP = previousHTTP })
	usePublicImportHostResolver(t)
	call := 0
	providerHTTP = &http.Client{Transport: roundTripFunc(
		func(req *http.Request) (*http.Response, error) {
			call++
			switch call {
			case 1:
				if req.Header.Get("Authorization") != "Bearer token" {
					t.Fatalf("metadata authorization = %q", req.Header.Get("Authorization"))
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body: io.NopCloser(strings.NewReader(
						`{"name":"Notes.txt","mimeType":"text/plain","size":"4","capabilities":{"canDownload":true}}`,
					)),
				}, nil
			case 2:
				if req.Header.Get("Authorization") != "Bearer token" {
					t.Fatalf("download authorization = %q", req.Header.Get("Authorization"))
				}
				return &http.Response{
					StatusCode: http.StatusFound,
					Header: http.Header{
						"Location": []string{"https://cdn.example/file"},
					},
					Body:    io.NopCloser(strings.NewReader("")),
					Request: req,
				}, nil
			case 3:
				if req.Header.Get("Authorization") != "" {
					t.Fatalf("cross-origin authorization leaked: %q", req.Header.Get("Authorization"))
				}
				if req.Header.Get("Referer") != "" {
					t.Fatalf("cross-origin referer leaked: %q", req.Header.Get("Referer"))
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"text/plain"}},
					Body:       io.NopCloser(strings.NewReader("text")),
					Request:    req,
				}, nil
			default:
				t.Fatalf("unexpected provider request %d: %s", call, req.URL)
				return nil, nil
			}
		},
	)}

	data, contentType, err := DownloadImportFile(
		context.Background(), ProviderGoogle, "token", ImportRef{ID: "file_1"}, 4,
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "text" || contentType != "text/plain" {
		t.Fatalf("data=%q contentType=%q", data, contentType)
	}
}

func usePublicImportHostResolver(t *testing.T) {
	t.Helper()
	previous := importHostResolver
	t.Cleanup(func() { importHostResolver = previous })
	importHostResolver = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	}
}
