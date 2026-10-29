package assetthumb

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
)

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func decodeThumb(t *testing.T, data []byte) image.Image {
	t.Helper()
	thumb, err := Make(data)
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(thumb))
	if err != nil {
		t.Fatalf("thumbnail is not a JPEG: %v", err)
	}
	return img
}

// 200 px wide, cut at 400 from the top, narrower images kept at their size,
// and transparency flattened on white.
func TestMakeScalesCutsAndFlattens(t *testing.T) {
	for _, tc := range []struct {
		name         string
		w, h         int
		wantW, wantH int
	}{
		{"landscape", 2400, 1350, 200, 113},
		{"tall", 600, 2400, 200, 400},
		{"narrow", 120, 80, 120, 80},
	} {
		t.Run(tc.name, func(t *testing.T) {
			img := decodeThumb(t, encodePNG(t, image.NewNRGBA(image.Rect(0, 0, tc.w, tc.h))))
			if got := img.Bounds().Size(); got != image.Pt(tc.wantW, tc.wantH) {
				t.Fatalf("size %v, want %dx%d", got, tc.wantW, tc.wantH)
			}
			// Fully transparent in, white out (JPEG keeps it near 255).
			if r, g, b, _ := img.At(tc.wantW/2, tc.wantH/2).RGBA(); r>>8 < 245 || g>>8 < 245 || b>>8 < 245 {
				t.Fatalf("transparent pixel is %d,%d,%d, want white", r>>8, g>>8, b>>8)
			}
		})
	}
}

// The cut keeps the top: a tall image black above and white below shows
// only black.
func TestMakeKeepsTheTop(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 200, 1000))
	for y := 0; y < 1000; y++ {
		for x := 0; x < 200; x++ {
			c := color.RGBA{A: 255}
			if y >= 500 {
				c = color.RGBA{255, 255, 255, 255}
			}
			src.Set(x, y, c)
		}
	}
	img := decodeThumb(t, encodePNG(t, src))
	if r, _, _, _ := img.At(100, 390).RGBA(); r>>8 > 30 {
		t.Fatalf("row 390 is %d, want black (the white half was cut)", r>>8)
	}
}

func TestMakeRefusesWhatItCannotRead(t *testing.T) {
	if _, err := Make([]byte("not an image")); err == nil {
		t.Fatal("garbage made a thumbnail")
	}
	if _, err := Make(encodePNG(t, image.NewNRGBA(image.Rect(0, 0, 2401, 10)))); err == nil {
		t.Fatal("an image over the editors' side limit made a thumbnail")
	}
}

// withOrientation puts an EXIF APP1 segment with orientation o right after
// the JPEG's SOI marker.
func withOrientation(jpg []byte, o byte) []byte {
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0}
	payload := append([]byte("Exif\x00\x00"), tiff...)
	size := len(payload) + 2
	app1 := append([]byte{0xff, 0xe1, byte(size >> 8), byte(size)}, payload...)
	return append(append(append([]byte{}, jpg[:2]...), app1...), jpg[2:]...)
}

// A phone photo stored as taken and tagged to turn (orientation 6, a
// quarter turn clockwise) comes out the way up it is shown (review r1).
func TestMakeTurnsAPhotoByItsOrientation(t *testing.T) {
	// Stored 40x20: black left half, white right half.
	src := image.NewRGBA(image.Rect(0, 0, 40, 20))
	for y := range 20 {
		for x := range 40 {
			c := color.RGBA{A: 255}
			if x >= 20 {
				c = color.RGBA{255, 255, 255, 255}
			}
			src.Set(x, y, c)
		}
	}
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, src, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	img := decodeThumb(t, withOrientation(jpg.Bytes(), 6))
	if got := img.Bounds().Size(); got != image.Pt(20, 40) {
		t.Fatalf("size %v, want 20x40 (turned)", got)
	}
	// Turned clockwise, the stored left half is the shown top half.
	top, _, _, _ := img.At(10, 5).RGBA()
	bottom, _, _, _ := img.At(10, 35).RGBA()
	if top>>8 > 40 || bottom>>8 < 215 {
		t.Fatalf("top %d, bottom %d; want black above white", top>>8, bottom>>8)
	}
}

type failingPut struct{ *blob.Memory }

func (failingPut) PutObjectOnce(context.Context, string, io.ReadSeeker, string, string) (string, error) {
	return "", errors.New("put timed out")
}

type recorder struct {
	failSet bool
	set     string
	queued  []string
}

func (r *recorder) SetEditorAssetThumbnail(_ context.Context, _, key string) error {
	if r.failSet {
		return errors.New("record failed")
	}
	r.set = key
	return nil
}

func (r *recorder) EnqueueBlobDeletion(ctx context.Context, path string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	r.queued = append(r.queued, path)
	return nil
}

// A key no row takes is queued, whether the put failed (it may still have
// written the object) or the record did, and a cancelled caller does not
// stop that (review r1).
func TestStoreQueuesAKeyNoRowTakes(t *testing.T) {
	picture := encodePNG(t, image.NewNRGBA(image.Rect(0, 0, 50, 50)))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tc := range []struct {
		name    string
		objects blob.Store
		rec     *recorder
	}{
		{"failed put", failingPut{blob.NewMemory()}, &recorder{}},
		{"failed record", blob.NewMemory(), &recorder{failSet: true}},
	} {
		if err := Store(ctx, tc.objects, tc.rec, "asset_x", picture); err == nil {
			t.Fatalf("%s: no error", tc.name)
		}
		if len(tc.rec.queued) != 1 || tc.rec.set != "" {
			t.Fatalf("%s: queued %q, recorded %q; want the key queued", tc.name, tc.rec.queued, tc.rec.set)
		}
	}
	rec := &recorder{}
	if err := Store(context.Background(), blob.NewMemory(), rec, "asset_x", picture); err != nil || rec.set == "" || len(rec.queued) != 0 {
		t.Fatalf("a stored thumbnail: %v, recorded %q, queued %q", err, rec.set, rec.queued)
	}
}
