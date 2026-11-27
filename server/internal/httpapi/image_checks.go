package httpapi

import (
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/cmvfile"
	"github.com/samyung0/capy-notebook/server/internal/imagecheck"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// checkSourceBytes runs the header checks on a source upload's spooled bytes
// (Epo 2026-10-24, Q285, Q286): an Office file's pictures against the
// uploader's image cap and the long side, with no EMF or WMF, and an image
// file's area. The browser compresses to these first, so a refusal is final.
// A film's structure is checked too: the user's exporter wrote it, and the
// server runs nothing of it (Epo 2026-11-26).
func checkSourceBytes(name, kind string, imageMaxBytes int64, spool io.ReaderAt, size int64) error {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".docx", ".pptx", ".xlsx":
		return imageRefusal(imagecheck.CheckOffice(spool, size, imageMaxBytes))
	}
	switch kind {
	case string(store.FileImage):
		return imageRefusal(imagecheck.CheckSourceImage(io.NewSectionReader(spool, 0, size)))
	case string(store.FileFilm):
		return filmRefusal(cmvfile.Check(spool, size))
	}
	return nil
}

// filmRefusal answers a film that is not one as a 400 invalid_film, with the
// reason.
func filmRefusal(_ cmvfile.Meta, err error) error {
	var bad *cmvfile.Invalid
	if !errors.As(err, &bad) {
		return err
	}
	return &huma.ErrorModel{
		Status: http.StatusBadRequest,
		Title:  http.StatusText(http.StatusBadRequest),
		Detail: bad.Error(),
		Errors: []*huma.ErrorDetail{{Message: "invalid_film"}},
	}
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
