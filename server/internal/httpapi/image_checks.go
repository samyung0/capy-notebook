package httpapi

import (
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/imagecheck"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// checkSourceImages runs the header checks on a source upload's spooled
// bytes (Epo 2026-10-24, Q285, Q286): an Office file's pictures against the
// uploader's image cap and the long side, with no EMF or WMF, and an image
// file's area. The browser compresses to these first, so a refusal is final.
func checkSourceImages(name, kind string, imageMaxBytes int64, spool io.ReaderAt, size int64) error {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".docx", ".pptx", ".xlsx":
		return imageRefusal(imagecheck.CheckOffice(spool, size, imageMaxBytes))
	}
	if kind == string(store.FileImage) {
		return imageRefusal(imagecheck.CheckSourceImage(io.NewSectionReader(spool, 0, size)))
	}
	return nil
}

// invalidFileName answers a name with a control, bidi or path separator
// character, or past the length (Q346).
func invalidFileName() error {
	return &huma.ErrorModel{
		Status: http.StatusUnprocessableEntity, Title: http.StatusText(http.StatusUnprocessableEntity),
		Detail: "file names may not hold control, bidi or path separator characters",
		Errors: []*huma.ErrorDetail{{Message: "invalid_name"}},
	}
}

// imageRefusal answers an image check's refusal as a 400 with its code.
func imageRefusal(err error) error {
	var refusal *imagecheck.Refusal
	if !errors.As(err, &refusal) {
		return err
	}
	return &huma.ErrorModel{
		Status: http.StatusBadRequest,
		Title:  http.StatusText(http.StatusBadRequest),
		Detail: refusal.Detail,
		Errors: []*huma.ErrorDetail{{Message: refusal.Code}},
	}
}
