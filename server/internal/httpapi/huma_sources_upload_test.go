package httpapi

import (
	"context"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
)

func TestPromoteMatchingObjectAcceptsConcurrentMatchingPromotion(t *testing.T) {
	objects := blob.NewMemory()
	if _, _, err := objects.Put("incoming", strings.NewReader("data")); err != nil {
		t.Fatal(err)
	}
	incoming, err := objects.Head(context.Background(), "incoming")
	if err != nil {
		t.Fatal(err)
	}

	type result struct {
		info blob.ObjectInfo
		err  error
	}
	results := make(chan result, 2)
	for range 2 {
		go func() {
			info, err := promoteMatchingObject(
				context.Background(), objects, "incoming", "stable",
				4, "application/octet-stream", incoming,
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
