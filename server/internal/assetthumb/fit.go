package assetthumb

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"

	"golang.org/x/image/draw"

	"github.com/samyung0/capy-notebook/server/internal/imagecheck"
)

// Fit returns a PNG, JPEG, GIF (its first frame) or WebP image whole as a
// JPEG within edge pixels on its long side (a smaller one keeps its size),
// flattened on white and turned the way a JPEG's EXIF orientation says: a
// question's figure as the grader is sent it (Epo 2026-11-23).
func Fit(data []byte, edge, quality int) ([]byte, error) {
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
	o := jpegOrientation(data)
	long := max(b.Dx(), b.Dy())
	w, h := b.Dx(), b.Dy()
	if long > edge {
		w, h = max(1, b.Dx()*edge/long), max(1, b.Dy()*edge/long)
	}
	dst := onWhite(w, h)
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	if o > 1 {
		dst = orient(dst, o)
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
