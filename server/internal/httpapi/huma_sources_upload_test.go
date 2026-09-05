package httpapi

import (
	"context"
	"strings"
	"testing"

	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/store"
)

func TestPromoteUploadObjectAcceptsConcurrentMatchingPromotion(t *testing.T) {
	objects := blob.NewMemory()
	if _, _, err := objects.Put("incoming", strings.NewReader("data")); err != nil {
		t.Fatal(err)
	}
	incoming, err := objects.Head(context.Background(), "incoming")
	if err != nil {
		t.Fatal(err)
	}

	session := store.UploadSession{
		ObjectPath:   "incoming",
		FinalPath:    "stable",
		DeclaredSize: 4,
		ContentType:  "application/octet-stream",
	}
	type result struct {
		info blob.ObjectInfo
		err  error
	}
	results := make(chan result, 2)
	for range 2 {
		go func() {
			info, err := promoteUploadObject(
				context.Background(), objects, session, incoming,
			)
			results <- result{info: info, err: err}
		}()
	}
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.info.Size != 4 || result.info.ContentType != "application/octet-stream" {
			t.Fatalf("promoted info = %+v", result.info)
		}
	}
}
