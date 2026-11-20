package bank

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/imagecheck"
)

// AssetMaxBytes is flat: the platform pays for bank figures, not a plan
// (human/question-bank.md 2026-10-09). The browser shrinks larger images.
const AssetMaxBytes = 4 << 20
const ImmutableCache = "public, max-age=31536000, immutable"

type AssetWriter interface {
	PutObject(context.Context, string, io.Reader, string, string) error
}

func UploadAsset(ctx context.Context, writer AssetWriter, base string, data []byte) (string, error) {
	if writer == nil {
		return "", ErrUnavailable
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", ErrUnavailable
	}
	mime, ext, err := ValidateAsset(data)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	key := hex.EncodeToString(sum[:]) + ext
	if err := writer.PutObject(ctx, key, bytes.NewReader(data), mime, ImmutableCache); err != nil {
		return "", fmt.Errorf("%w: asset upload failed", ErrUnavailable)
	}
	return strings.TrimRight(base, "/") + "/" + key, nil
}

func ValidateAsset(data []byte) (string, string, error) {
	if len(data) == 0 || len(data) > AssetMaxBytes {
		return "", "", errors.New("asset must be between 1 byte and 4 MiB")
	}
	mime := http.DetectContentType(data)
	ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[mime]
	// Raster figures only: the browser draws an SVG as a PNG before upload,
	// and graphs keep no file (Epo 2026-11-16).
	if ext == "" {
		return "", "", errors.New("asset must be a PNG, JPEG, GIF or WebP image")
	}
	// The editors' pixel limit too (Q332, Q348): the browser compresses a
	// figure to it first.
	if err := imagecheck.CheckEditorImage(bytes.NewReader(data)); err != nil {
		return "", "", err
	}
	return mime, ext, nil
}
