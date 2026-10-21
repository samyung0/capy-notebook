package httpapi

import (
	"bytes"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/samyung0/capy-notebook/server/internal/blob"
)

// e2eBlobs serves a served memory store's objects under blob.ServedPath: the
// e2e stack's browser reads and uploads them, and the collaboration server
// reads source bases, as they use signed bucket URLs in production. New
// registers it only for that store, which APP_ENV=e2e alone opens.
func e2eBlobs(store *blob.Memory) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := chi.URLParam(r, "*")
		if r.Method == http.MethodPut {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "unreadable body", http.StatusBadRequest)
				return
			}
			if _, err := store.PutObjectOnce(r.Context(), path, bytes.NewReader(body), r.Header.Get("Content-Type"), ""); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		data, _, ok := store.Object(path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		// As the bucket answers a read link: typed by the key's extension.
		contentType, disposition := blob.ReadHeaders(path)
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Disposition", disposition)
		_, _ = w.Write(data)
	}
}
