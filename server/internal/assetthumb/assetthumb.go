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
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"time"

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
	// The one put gets this long; recording it or queueing a failed put's
	// key never runs out of time, or the object would be left behind.
	PutWindow = 3 * time.Second
	// As every thumbnail is stored: a key names its bytes.
	cacheControl = "public, max-age=31536000, immutable"
)

// Make returns the thumbnail of a PNG, JPEG, GIF (its first frame) or WebP
// image whose sides are within the editors' limit (imagecheck.MaxSide), the
// way up a JPEG's EXIF orientation says.
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
	var dst *image.RGBA
	if o := jpegOrientation(data); o > 1 {
		// Turned: scale it whole, small, then turn it and cut its top.
		dw, dh := b.Dx(), b.Dy()
		if o >= 5 {
			dw, dh = dh, dw
		}
		w := min(Width, dw)
		h := max(1, (dh*w+dw-1)/dw)
		sw, sh := w, h
		if o >= 5 {
			sw, sh = h, w
		}
		small := onWhite(sw, sh)
		draw.CatmullRom.Scale(small, small.Bounds(), src, b, draw.Over, nil)
		dst = orient(small, o)
		dst = dst.SubImage(image.Rect(0, 0, w, min(MaxHeight, h))).(*image.RGBA)
	} else {
		w := min(Width, b.Dx())
		h := min(MaxHeight, (b.Dy()*w+b.Dx()-1)/b.Dx())
		// The source rows that scale to the kept h rows.
		from := image.Rect(b.Min.X, b.Min.Y, b.Max.X, b.Min.Y+min(b.Dy(), (h*b.Dx()+w-1)/w))
		dst = onWhite(w, h)
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, from, draw.Over, nil)
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func onWhite(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	return img
}

// orient turns a stored image the way EXIF orientation o (2-8) says it is
// shown: each shown pixel reads the stored one it comes from.
func orient(src *image.RGBA, o int) *image.RGBA {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := sw, sh
	if o >= 5 {
		dw, dh = sh, sw
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := range dh {
		for x := range dw {
			sx, sy := x, y
			switch o {
			case 2:
				sx = sw - 1 - x
			case 3:
				sx, sy = sw-1-x, sh-1-y
			case 4:
				sy = sh - 1 - y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, sh-1-x
			case 7:
				sx, sy = sw-1-y, sh-1-x
			case 8:
				sx, sy = sw-1-y, x
			}
			dst.SetRGBA(x, y, src.RGBAAt(sx, sy))
		}
	}
	return dst
}

// jpegOrientation reads a JPEG's EXIF orientation (1-8) from its APP1
// segment; 1 when there is none or it cannot be read. Phones store photos
// as taken and tag how to turn them, which Go's decoder ignores.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xff || data[1] != 0xd8 {
		return 1
	}
	for i := 2; i+4 <= len(data); {
		marker := data[i+1]
		if data[i] != 0xff || marker == 0xda || marker == 0xd9 {
			return 1
		}
		end := i + 2 + int(binary.BigEndian.Uint16(data[i+2:]))
		if end < i+4 || end > len(data) {
			return 1
		}
		if seg := data[i+4 : end]; marker == 0xe1 && len(seg) > 6 && string(seg[:6]) == "Exif\x00\x00" {
			return tiffOrientation(seg[6:])
		}
		i = end
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	ifd := int(order.Uint32(t[4:]))
	if ifd < 8 || ifd+2 > len(t) {
		return 1
	}
	for k := range int(order.Uint16(t[ifd:])) {
		e := ifd + 2 + 12*k
		if e+12 > len(t) {
			return 1
		}
		if order.Uint16(t[e:]) == 0x0112 {
			if v := int(order.Uint16(t[e+8:])); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
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

// Store makes the image's thumbnail, writes it in one put within PutWindow
// and records it. A key no row takes is queued for deletion: a failed put
// may still have written it, and a failed record leaves it unnamed (a key
// still referenced is not queued).
func Store(ctx context.Context, objects blob.Store, rec Recorder, assetID string, data []byte) error {
	if objects == nil {
		return errors.New("blob store not configured")
	}
	thumb, err := Make(data)
	if err != nil {
		return err
	}
	key := Key(assetID, thumb)
	ctx = context.WithoutCancel(ctx)
	putCtx, cancel := context.WithTimeout(ctx, PutWindow)
	_, err = objects.PutObjectOnce(putCtx, key, bytes.NewReader(thumb), "image/jpeg", cacheControl)
	cancel()
	if err == nil {
		err = rec.SetEditorAssetThumbnail(ctx, assetID, key)
	}
	if err != nil {
		return errors.Join(err, rec.EnqueueBlobDeletion(ctx, key))
	}
	return nil
}
