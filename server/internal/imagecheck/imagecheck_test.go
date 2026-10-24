package imagecheck

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"testing"

	"golang.org/x/image/tiff"
)

// pngHeader is a PNG signature and an IHDR claiming width x height: all a
// header read sees, with no pixels behind it.
func pngHeader(width, height uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], width)
	binary.BigEndian.PutUint32(ihdr[4:], height)
	ihdr[8], ihdr[9] = 8, 2
	chunk := append([]byte("IHDR"), ihdr...)
	out := []byte("\x89PNG\r\n\x1a\n")
	out = binary.BigEndian.AppendUint32(out, 13)
	out = append(out, chunk...)
	return binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(chunk))
}

func box(kind string, body ...[]byte) []byte {
	payload := bytes.Join(body, nil)
	out := binary.BigEndian.AppendUint32(nil, uint32(8+len(payload)))
	return append(append(out, kind...), payload...)
}

func ispe(width, height uint32) []byte {
	body := make([]byte, 12)
	binary.BigEndian.PutUint32(body[4:], width)
	binary.BigEndian.PutUint32(body[8:], height)
	return box("ispe", body)
}

// heic is an ftyp and a meta box whose property container holds a
// thumbnail's extents and the primary image's.
func heic(width, height uint32) []byte {
	return append(box("ftyp", []byte("heic\x00\x00\x00\x00mif1heic")),
		box("meta", []byte{0, 0, 0, 0}, box("iprp", box("ipco", ispe(320, 240), ispe(width, height))))...)
}

func jp2(width, height uint32) []byte {
	ihdr := make([]byte, 14)
	binary.BigEndian.PutUint32(ihdr[0:], height)
	binary.BigEndian.PutUint32(ihdr[4:], width)
	return append([]byte("\x00\x00\x00\x0cjP  \r\n\x87\n"),
		append(box("ftyp", []byte("jp2 \x00\x00\x00\x00jp2 ")), box("jp2h", box("ihdr", ihdr))...)...)
}

func tiffImage(t *testing.T, width, height int) []byte {
	var out bytes.Buffer
	if err := tiff.Encode(&out, image.NewGray(image.Rect(0, 0, width, height)), nil); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func refusal(t *testing.T, err error) string {
	t.Helper()
	var r *Refusal
	if !errors.As(err, &r) {
		t.Fatalf("err = %v, want a refusal", err)
	}
	return r.Code
}

func TestSizeReadsHeadersOnly(t *testing.T) {
	cases := map[string]struct {
		data          []byte
		width, height int
	}{
		"png":  {pngHeader(2401, 10), 2401, 10},
		"heic": {heic(4032, 3024), 4032, 3024},
		"jp2":  {jp2(3000, 2000), 3000, 2000},
		"tiff": {tiffImage(t, 30, 20), 30, 20},
	}
	for name, c := range cases {
		width, height, ok, err := Size(bytes.NewReader(c.data))
		if err != nil || !ok || width != c.width || height != c.height {
			t.Errorf("%s: Size = %d, %d, %v, %v; want %d, %d", name, width, height, ok, err, c.width, c.height)
		}
	}
	if _, _, ok, _ := Size(bytes.NewReader([]byte("<svg/>"))); ok {
		t.Error("an SVG reads as a raster image")
	}
}

func TestCheckEditorImageRefusesPastTheLongSide(t *testing.T) {
	if err := CheckEditorImage(bytes.NewReader(pngHeader(2400, 2400))); err != nil {
		t.Fatalf("2400 px refused: %v", err)
	}
	if code := refusal(t, CheckEditorImage(bytes.NewReader(pngHeader(2401, 100)))); code != "image_too_large" {
		t.Fatalf("code = %s", code)
	}
	// A decompression bomb is refused from its header, with no pixels read.
	if code := refusal(t, CheckEditorImage(bytes.NewReader(pngHeader(50000, 50000)))); code != "image_too_large" {
		t.Fatalf("code = %s", code)
	}
	if code := refusal(t, CheckEditorImage(bytes.NewReader([]byte("\x89PNG\r\n\x1a\nbroken")))); code != "image_unreadable" {
		t.Fatalf("code = %s", code)
	}
}

func TestCheckSourceImageRefusesPastFiveMegapixels(t *testing.T) {
	for _, data := range [][]byte{pngHeader(2500, 2000), heic(2500, 2000), jp2(2000, 2500), {'<', 's', 'v', 'g'}} {
		if err := CheckSourceImage(bytes.NewReader(data)); err != nil {
			t.Fatalf("5 MP refused: %v", err)
		}
	}
	// 2610 x 1955 is 5.1 MP.
	for _, data := range [][]byte{pngHeader(2610, 1955), heic(2610, 1955), jp2(2610, 1955)} {
		if code := refusal(t, CheckSourceImage(bytes.NewReader(data))); code != "source_image_too_large" {
			t.Fatalf("code = %s", code)
		}
	}
}

func officeFile(t *testing.T, parts map[string][]byte) *bytes.Reader {
	var out bytes.Buffer
	archive := zip.NewWriter(&out)
	for name, data := range parts {
		part, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		part.Write(data)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(out.Bytes())
}

func TestCheckOffice(t *testing.T) {
	const cap = 2 << 20
	small := append(pngHeader(800, 600), make([]byte, 1000)...)
	ok := officeFile(t, map[string][]byte{
		"word/document.xml":     []byte("<w:document/>"),
		"word/media/image1.png": small,
		"word/media/chart.svg":  []byte("<svg/>"),
		"word/embeddings/a.bin": {0xd0, 0xcf, 0x11, 0xe0},
	})
	if err := CheckOffice(ok, ok.Size(), cap); err != nil {
		t.Fatalf("a compressed file refused: %v", err)
	}
	emf := make([]byte, 64)
	copy(emf, []byte{1, 0, 0, 0})
	copy(emf[40:], " EMF")
	cases := map[string]struct {
		parts map[string][]byte
		code  string
	}{
		"a picture over 2 MiB, by its inflated bytes": {
			map[string][]byte{"word/media/image1.png": append(pngHeader(800, 600), make([]byte, cap)...)},
			"office_image_too_large",
		},
		"a picture past 2,400 px under another name": {
			map[string][]byte{"ppt/media/x.bin": pngHeader(2401, 2)}, "office_image_too_large",
		},
		"an EMF picture": {map[string][]byte{"xl/media/image2.bin": emf}, "office_vector_image"},
		"a WMF by name":  {map[string][]byte{"word/media/eq.wmf": {0, 0}}, "office_vector_image"},
	}
	for name, c := range cases {
		file := officeFile(t, c.parts)
		if code := refusal(t, CheckOffice(file, file.Size(), cap)); code != c.code {
			t.Errorf("%s: code = %s, want %s", name, code, c.code)
		}
	}
}
