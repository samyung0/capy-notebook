package httpapi_test

import (
	"context"
	"fmt"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// uploadSource lands a file the way a browser upload does: reserve an upload
// session, then complete it (no ingest job unless the format needs one).
func uploadSource(ctx context.Context, st *store.Store, wsID, actorID, name string, size int64, blobPath string) (store.File, error) {
	id := fmt.Sprintf("up_%d", time.Now().UnixNano())
	if _, err := st.CreateUploadSession(ctx, store.NewUploadSession{
		ID: id, WorkspaceID: wsID, CreatedBy: actorID,
		ObjectPath: "incoming/" + id, FinalPath: blobPath,
		Name: name, Kind: sourceupload.KindFromName(name),
		ContentType: "application/octet-stream", DeclaredSize: size,
		ParseMode: sourceupload.ParseModeNone, ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		return store.File{}, err
	}
	return st.FinalizeUploadSession(ctx, id, "etag-"+id, "")
}
