package blob

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// A thumbnail capture's put is one request: a bucket error is not retried by
// the SDK, while the shared client keeps its retries for every other call.
func TestPutObjectOnceSendsOneRequest(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	store, err := NewB2(B2Config{
		Endpoint: "https://s3.us-west-004.backblazeb2.com",
		Region:   "us-west-004",
		Bucket:   "capy-notebook",
		KeyID:    "test-key-id",
		AppKey:   "test-app-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	// The shared client's own settings, retryer included, aimed at the stub.
	store.client = s3.New(store.client.Options(), func(o *s3.Options) {
		o.BaseEndpoint = aws.String(srv.URL)
		o.UsePathStyle = true
	})
	if _, err := store.PutObjectOnce(context.Background(), "thumbs/f/a.webp", bytes.NewReader([]byte("RIFF")), "image/webp", "immutable"); err == nil {
		t.Fatal("a 503 put succeeded")
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("the put sent %d requests, want 1", got)
	}
}
