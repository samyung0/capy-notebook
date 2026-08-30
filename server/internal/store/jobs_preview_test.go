package store

import (
	"context"
	"testing"
)

func TestCreateSourceReadyOnlyAdvertisesPDFPreviewWithSourceBlob(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_preview_url")
	workspace, err := s.CreateWorkspace(
		ctx, ownerID, "Preview URL", ColorGreen, []TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = s.DeleteWorkspace(context.Background(), ownerID, workspace.ID)
	})

	withoutSource, err := s.CreateSourceReady(
		ctx, workspace.ID, ownerID, "missing.pdf", "pdf", nil, "", 1, "",
	)
	if err != nil {
		t.Fatal(err)
	}
	if withoutSource.PreviewURL != nil {
		t.Fatalf("missing-source PDF advertised preview URL %q", *withoutSource.PreviewURL)
	}

	withSource, err := s.CreateSourceReady(
		ctx, workspace.ID, ownerID, "source.pdf", "pdf", nil, "", 1,
		"sources/source.pdf",
	)
	if err != nil {
		t.Fatal(err)
	}
	if withSource.PreviewURL == nil {
		t.Fatal("source-backed PDF did not advertise preview URL")
	}
}
