package blob

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
)

func TestNewB2RequiresB2Configuration(t *testing.T) {
	if _, err := NewB2(B2Config{}); err == nil {
		t.Fatal("NewB2 accepted missing B2 configuration")
	}
}

func TestNewB2RejectsNonB2Endpoint(t *testing.T) {
	_, err := NewB2(B2Config{
		Endpoint: "https://s3.amazonaws.com",
		Region:   "us-east-1",
		Bucket:   "capy-notebook",
		KeyID:    "test-key-id",
		AppKey:   "test-app-key",
	})
	if err == nil {
		t.Fatal("NewB2 accepted a non-B2 endpoint")
	}
}

func TestNewB2BuildsB2Client(t *testing.T) {
	store, err := NewB2(B2Config{
		Endpoint: "https://s3.us-west-004.backblazeb2.com",
		Region:   "us-west-004",
		Bucket:   "capy-notebook",
		KeyID:    "test-key-id",
		AppKey:   "test-app-key",
	})
	if err != nil {
		t.Fatalf("NewB2: %v", err)
	}
	if store.bucket != "capy-notebook" {
		t.Errorf("bucket = %q, want %q", store.bucket, "capy-notebook")
	}
	if store.presignTTL != defaultPresignTTL {
		t.Errorf("presignTTL = %s, want %s", store.presignTTL, defaultPresignTTL)
	}
	if store.linkTTL != defaultLinkTTL {
		t.Errorf("linkTTL = %s, want %s", store.linkTTL, defaultLinkTTL)
	}
	if got := aws.ToString(store.client.Options().BaseEndpoint); got != "https://s3.us-west-004.backblazeb2.com" {
		t.Errorf("BaseEndpoint = %q", got)
	}
}

func TestReadPrefixRejectsNonPositiveLimit(t *testing.T) {
	store := &B2{}
	if _, err := store.ReadPrefix(t.Context(), "editor-assets/asset_1/blob_1.png", 0); err == nil {
		t.Fatal("ReadPrefix accepted a zero byte limit")
	}
}

func TestPresignPutSignsDeclaredSize(t *testing.T) {
	store, err := NewB2(B2Config{
		Endpoint: "https://s3.us-west-004.backblazeb2.com",
		Region:   "us-west-004",
		Bucket:   "capy-notebook",
		KeyID:    "test-key-id",
		AppKey:   "test-app-key",
	})
	if err != nil {
		t.Fatalf("NewB2: %v", err)
	}
	signed, err := store.PresignPut(context.Background(), "incoming/up/blob.pdf", "application/pdf", 1234)
	if err != nil {
		t.Fatalf("PresignPut: %v", err)
	}
	u, err := url.Parse(signed.URL)
	if err != nil {
		t.Fatal(err)
	}
	if got := u.Query().Get("X-Amz-SignedHeaders"); !strings.Contains(got, "content-length") {
		t.Errorf("signed headers = %q, want content-length", got)
	}
	// The browser sets Content-Length itself and may not send it by hand.
	if _, ok := signed.Headers["Content-Length"]; ok {
		t.Error("headers for the browser carry Content-Length")
	}
}

func testB2(t *testing.T, pathStyle bool) *B2 {
	t.Helper()
	store, err := NewB2(B2Config{
		Endpoint:     "https://s3.us-west-004.backblazeb2.com",
		Region:       "us-west-004",
		Bucket:       "capy-notebook",
		KeyID:        "test-key-id",
		AppKey:       "test-app-key",
		UsePathStyle: pathStyle,
	})
	if err != nil {
		t.Fatalf("NewB2: %v", err)
	}
	return store
}

// Security regression (human authorization 2026-10-14 read link headers): a
// read link's type and disposition come from the key's extension, not the
// uploader: only PDF, raster images and audio open in place; HTML, SVG and
// anything unknown download.
func TestPresignGetTypesAndDispositionFollowTheExtension(t *testing.T) {
	store := testB2(t, false)
	for _, tc := range []struct{ key, contentType, disposition string }{
		{"sources/blob_1.html", "application/octet-stream", "attachment"},
		{"sources/blob_1.HTM", "application/octet-stream", "attachment"},
		{"sources/blob_1.svg", "image/svg+xml", "attachment"},
		{"sources/blob_1.xml", "application/octet-stream", "attachment"},
		{"sources/blob_1", "application/octet-stream", "attachment"},
		{"sources/blob_1.pdf", "application/pdf", "inline"},
		{"editor-assets/asset_1/blob_1.PNG", "image/png", "inline"},
		{"editor-assets/asset_1/blob_1.m4a", "audio/mp4", "inline"},
	} {
		for _, sign := range []func(string) (string, error){
			func(key string) (string, error) { return store.PresignGet(t.Context(), key) },
			func(key string) (string, error) {
				signed, err := store.PresignGetWithExpiry(t.Context(), key)
				return signed.URL, err
			},
		} {
			signed, err := sign(tc.key)
			if err != nil {
				t.Fatalf("%s: %v", tc.key, err)
			}
			u, err := url.Parse(signed)
			if err != nil {
				t.Fatal(err)
			}
			q := u.Query()
			if got := q.Get("response-content-type"); got != tc.contentType {
				t.Errorf("%s: response-content-type = %q, want %q", tc.key, got, tc.contentType)
			}
			if got := q.Get("response-content-disposition"); got != tc.disposition {
				t.Errorf("%s: response-content-disposition = %q, want %q", tc.key, got, tc.disposition)
			}
		}
	}
	// The hour-stable thumbnail link stays as it was: no overrides.
	stable, err := store.PresignStableGet(t.Context(), "thumbs/f_1/abc.webp")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stable, "response-") {
		t.Errorf("stable link carries response overrides: %s", stable)
	}
}

// Thumbnail links are signed per list row; the browser caches them only while
// the URL stays byte-identical, so it must not change within an hour.
func TestPresignStableGetIsStableWithinTheHour(t *testing.T) {
	store := testB2(t, false)
	sign := func(at string) string {
		t.Helper()
		now, err := time.Parse(time.RFC3339, at)
		if err != nil {
			t.Fatal(err)
		}
		store.now = func() time.Time { return now }
		signed, err := store.PresignStableGet(context.Background(), "thumbs/f_1/abc.webp")
		if err != nil {
			t.Fatalf("PresignStableGet: %v", err)
		}
		return signed
	}
	first := sign("2026-10-11T09:00:05Z")
	if again := sign("2026-10-11T09:59:59Z"); again != first {
		t.Fatalf("URL changed within the hour:\n%s\n%s", first, again)
	}
	if next := sign("2026-10-11T10:00:00Z"); next == first {
		t.Fatal("URL did not change in the next hour")
	}
	q, err := url.ParseQuery(first[strings.Index(first, "?")+1:])
	if err != nil {
		t.Fatal(err)
	}
	if got := q.Get("X-Amz-Date"); got != "20261011T090000Z" {
		t.Errorf("X-Amz-Date = %q, want the truncated hour", got)
	}
	if got := q.Get("X-Amz-Expires"); got != "7200" {
		t.Errorf("X-Amz-Expires = %q, want 7200", got)
	}
}

// The hand-built request must name the same object, host and credential scope
// as the SDK's own presign, in both addressing styles.
func TestPresignStableGetAddressesTheSDKObject(t *testing.T) {
	for _, pathStyle := range []bool{false, true} {
		store := testB2(t, pathStyle)
		key := "thumbs/f_1/a b+c.webp"
		stable, err := store.PresignStableGet(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		sdk, err := store.PresignGet(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		mine, err := url.Parse(stable)
		if err != nil {
			t.Fatal(err)
		}
		theirs, err := url.Parse(sdk)
		if err != nil {
			t.Fatal(err)
		}
		if mine.Host != theirs.Host || mine.EscapedPath() != theirs.EscapedPath() {
			t.Errorf("pathStyle=%v: %s%s, SDK %s%s", pathStyle,
				mine.Host, mine.EscapedPath(), theirs.Host, theirs.EscapedPath())
		}
		scope := func(u *url.URL) string {
			credential := u.Query().Get("X-Amz-Credential")
			parts := strings.SplitN(credential, "/", 3)
			return parts[0] + "/" + parts[2]
		}
		if scope(mine) != scope(theirs) {
			t.Errorf("credential scope %q, SDK %q", scope(mine), scope(theirs))
		}
	}
}
