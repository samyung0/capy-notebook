// Package assetthumb makes the list-card thumbnail of an editor image, the
// Embeds tab's picture of it (openwiki/thumbnails.md, Sam 2026-10-29): 200 px
// wide (narrower images are not enlarged), cut at 400 px tall from the top,
// flattened on white, JPEG. One attempt per image: a failure leaves the card
// with its icon and nothing retries.
package assetthumb

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"

	// The editor image formats Go decodes; an AVIF image gets no thumbnail.
	_ "image/gif"
	_ "image/png"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/imagecheck"
)

const (
	Width     = 200
	MaxHeight = 400
	quality   = 70
	// As every thumbnail is stored: a key names its bytes.
	cacheControl = "public, max-age=31536000, immutable"
)

// Make returns the thumbnail of a PNG, JPEG, GIF (its first frame) or WebP
// image whose sides are within the editors' limit (imagecheck.MaxSide).
func Make(data []byte) ([]byte, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if config.Width < 1 || config.Height < 1 || config.Width > imagecheck.MaxSide || config.Height > imagecheck.MaxSide {
		return nil, fmt.Errorf("image is %dx%d", config.Width, config.Height)
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	w := min(Width, b.Dx())
	h := min(MaxHeight, (b.Dy()*w+b.Dx()-1)/b.Dx())
	// The source rows that scale to the kept h rows.
	from := image.Rect(b.Min.X, b.Min.Y, b.Max.X, b.Min.Y+min(b.Dy(), (h*b.Dx()+w-1)/w))
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, from, draw.Over, nil)
	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// Key is where an asset's thumbnail is stored, content-addressed like the
// file thumbnails beside it (thumbs/{file id}/...).
func Key(assetID string, thumb []byte) string {
	sum := sha256.Sum256(thumb)
	return "thumbs/" + assetID + "/" + hex.EncodeToString(sum[:]) + ".jpg"
}

// Recorder points an asset at its thumbnail and queues an object no row
// takes for the reaper (store.Store).
type Recorder interface {
	SetEditorAssetThumbnail(ctx context.Context, assetID, key string) error
	EnqueueBlobDeletion(ctx context.Context, path string) error
}

// Store makes the image's thumbnail, writes it in one put and records it.
func Store(ctx context.Context, objects blob.Store, rec Recorder, assetID string, data []byte) error {
	if objects == nil {
		return errors.New("blob store not configured")
	}
	thumb, err := Make(data)
	if err != nil {
		return err
	}
	key := Key(assetID, thumb)
	if _, err := objects.PutObjectOnce(ctx, key, bytes.NewReader(thumb), "image/jpeg", cacheControl); err != nil {
		// A failed put may still have written the object.
		return errors.Join(err, rec.EnqueueBlobDeletion(ctx, key))
	}
	return rec.SetEditorAssetThumbnail(ctx, assetID, key)
}
