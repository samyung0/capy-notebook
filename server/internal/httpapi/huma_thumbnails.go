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
	switch err := a.storeThumbnail(ctx, in.ID, target.Key, in.RawBody); {
	case errors.Is(err, store.ErrThumbnailTooSoon):
		return nil, &huma.ErrorModel{
			Status: http.StatusTooManyRequests,
			Title:  http.StatusText(http.StatusTooManyRequests),
			Detail: err.Error(),
			Errors: []*huma.ErrorDetail{{Message: "thumbnail_too_soon"}},
		}
	case errors.Is(err, errThumbnailStorage):
		return nil, huma.Error503ServiceUnavailable(err.Error())
	case err != nil:
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

// errThumbnailStorage: the bucket is not configured or did not take the put.
var errThumbnailStorage = errors.New("thumbnail storage is unavailable")

// storeThumbnail writes a checked capture (a browser's or an agent turn's) at
// thumbs/{fileID}/{sha256}.webp and points the file at it: the current key
// writes nothing, a capture within store.ThumbnailCaptureInterval of the
// file's last one is store.ErrThumbnailTooSoon, and a put that failed is
// queued for deletion, since it may still have written the object.
func (a *api) storeThumbnail(ctx context.Context, fileID, currentKey string, body []byte) error {
	sum := sha256.Sum256(body)
	key := "thumbs/" + fileID + "/" + hex.EncodeToString(sum[:]) + ".webp"
	if key == currentKey {
		return nil
	}
	if err := a.s.ClaimThumbnailCapture(ctx, fileID); err != nil {
		return err
	}
	if a.blob == nil {
		return errThumbnailStorage
	}
	if err := a.blob.PutObjectOnce(ctx, key, body, "image/webp", thumbnailCacheControl); err != nil {
		obs.Log(ctx).Warn("thumbnail capture upload failed", "file_id", fileID, "error", err)
		if err := a.s.EnqueueBlobDeletion(ctx, key); err != nil {
			obs.Log(ctx).Warn("thumbnail capture not queued for deletion", "file_id", fileID, "key", key, "error", err)
		}
		return errThumbnailStorage
	}
	if err := a.s.SetFileThumbnail(ctx, fileID, key); err != nil {
		obs.Log(ctx).Warn("thumbnail capture not recorded", "file_id", fileID, "key", key, "error", err)
		return err
	}
	return nil
}

// checkThumbnailWebP accepts exactly one RIFF WebP image and nothing else:
// a lone "VP8 " or "VP8L" chunk, or "VP8X" with only its alpha flag, an
// optional "ALPH" and then the image chunk, which ends exactly where the RIFF
// size says the body ends. The image is at most thumbnailMaxWidth x
// thumbnailMaxHeight by its header, checked before the decode (x/image holds
// the frame to it), and must decode in full.
func checkThumbnailWebP(body []byte) error {
	if len(body) < 12 || string(body[:4]) != "RIFF" || string(body[8:12]) != "WEBP" {
		return errors.New("the thumbnail is not a WebP image")
	}
	if uint64(binary.LittleEndian.Uint32(body[4:8]))+8 != uint64(len(body)) {
		return errors.New("the thumbnail's RIFF size does not match its length")
	}
	if err := checkWebPChunks(body[12:]); err != nil {
		return err
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

// vp8xAlpha is the one VP8X flag a capture may set.
const vp8xAlpha = 0x10

// checkWebPChunks walks the chunks after "WEBP": each one's size (padded to
// even) must fit, and together they must be one of the layouts above with
// nothing before, between or after them.
func checkWebPChunks(data []byte) error {
	refuse := errors.New("the thumbnail holds more than one WebP image")
	var ids []string
	var vp8x []byte
	for len(data) > 0 {
		if len(data) < 8 || len(ids) == 3 {
			return refuse
		}
		size := uint64(binary.LittleEndian.Uint32(data[4:8]))
		end := 8 + size + size&1
		if end > uint64(len(data)) {
			return refuse
		}
		id := string(data[:4])
		if id == "VP8X" {
			vp8x = data[8 : 8+size]
		}
		ids = append(ids, id)
		data = data[end:]
	}
	image := func(id string) bool { return id == "VP8 " || id == "VP8L" }
	switch {
	case len(ids) == 1 && image(ids[0]):
		return nil
	case len(ids) >= 2 && ids[0] == "VP8X" && len(vp8x) == 10 && vp8x[0]&^vp8xAlpha == 0 &&
		image(ids[len(ids)-1]) && (len(ids) == 2 || ids[1] == "ALPH"):
		return nil
	}
	return refuse
}
