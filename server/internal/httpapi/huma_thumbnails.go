package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"golang.org/x/image/webp"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Browser captures of edited Office files (openwiki/thumbnails.md, phase 2a;
// human/authorization-permissions-lifecycles.md 2026-10-11): WebP only, small,
// editors only, written to B2 here with no upload session and no quota.
const (
	thumbnailMaxBytes  = 64 << 10
	thumbnailMaxWidth  = 200
	thumbnailMaxHeight = 400
	// As the ingest render stores its thumbnails: a key names its bytes.
	thumbnailCacheControl = "public, max-age=31536000, immutable"
)

type captureThumbnailInput struct {
	ID      string `path:"id"`
	RawBody []byte `contentType:"image/webp"`
}

func (a *api) registerThumbnails(api huma.API) {
	regWithMaxBody(api, http.MethodPost, "/api/files/{id}/thumbnail", "captureFileThumbnail", "Content",
		"Store a browser capture of an edited Office file as its thumbnail", http.StatusNoContent,
		thumbnailMaxBytes, a.captureFileThumbnail)
}

// captureFileThumbnail stores the capture at thumbs/{id}/{sha256}.webp and
// points the file at it. The same bytes as the current thumbnail write
// nothing; a capture within store.ThumbnailCaptureInterval of the file's last
// one is refused. Nothing here retries: the browser drops a failed capture.
func (a *api) captureFileThumbnail(ctx context.Context, in *captureThumbnailInput) (*Empty, error) {
	if err := a.assertFileEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	target, err := a.s.ThumbnailTarget(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	switch store.SourceEditFormat(target.Name, target.Kind) {
	case "docx", "xlsx", "pptx":
	default:
		return nil, huma.Error422UnprocessableEntity("only Office files that open in an editor take captures")
	}
	if err := checkThumbnailWebP(in.RawBody); err != nil {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	sum := sha256.Sum256(in.RawBody)
	key := "thumbs/" + in.ID + "/" + hex.EncodeToString(sum[:]) + ".webp"
	if key == target.Key {
		return &Empty{}, nil
	}
	if err := a.s.ClaimThumbnailCapture(ctx, in.ID); errors.Is(err, store.ErrThumbnailTooSoon) {
		return nil, &huma.ErrorModel{
			Status: http.StatusTooManyRequests,
			Title:  http.StatusText(http.StatusTooManyRequests),
			Detail: err.Error(),
			Errors: []*huma.ErrorDetail{{Message: "thumbnail_too_soon"}},
		}
	} else if err != nil {
		return nil, hErr(err)
	}
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("thumbnail storage is not configured")
	}
	if err := a.blob.PutObject(ctx, key, bytes.NewReader(in.RawBody), "image/webp", thumbnailCacheControl); err != nil {
		obs.Log(ctx).Warn("thumbnail capture upload failed", "file_id", in.ID, "error", err)
		return nil, huma.Error503ServiceUnavailable("thumbnail storage is unavailable")
	}
	if err := a.s.SetFileThumbnail(ctx, in.ID, key); err != nil {
		obs.Log(ctx).Warn("thumbnail capture not recorded", "file_id", in.ID, "key", key, "error", err)
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

// checkThumbnailWebP accepts exactly one RIFF WebP image (nothing after the
// size its header declares) of at most thumbnailMaxWidth x thumbnailMaxHeight
// that decodes in full. The header's dimensions are checked before the
// decode, which x/image holds to them.
func checkThumbnailWebP(body []byte) error {
	if len(body) < 12 || string(body[:4]) != "RIFF" || string(body[8:12]) != "WEBP" {
		return errors.New("the thumbnail is not a WebP image")
	}
	if uint64(binary.LittleEndian.Uint32(body[4:8]))+8 != uint64(len(body)) {
		return errors.New("the thumbnail's RIFF size does not match its length")
	}
	config, err := webp.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		return errors.New("the thumbnail is not a WebP image")
	}
	if config.Width < 1 || config.Width > thumbnailMaxWidth || config.Height < 1 || config.Height > thumbnailMaxHeight {
		return fmt.Errorf("the thumbnail is %dx%d, larger than %dx%d",
			config.Width, config.Height, thumbnailMaxWidth, thumbnailMaxHeight)
	}
	if _, err := webp.Decode(bytes.NewReader(body)); err != nil {
		return errors.New("the thumbnail does not decode")
	}
	return nil
}
