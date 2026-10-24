// Package imagecheck reads image sizes from headers only, never decoding
// pixels, for the upload checks of Epo's 2026-10-24 image lines (Q285,
// Q286): an editor image or a picture inside an Office file at most the
// plan image cap and MaxSide on its long side, an image file uploaded as a
// source at most SourceMaxPixels, and no EMF or WMF picture in an Office
// file. The browser compresses to these limits first (src/lib/fitImage.ts),
// so a refusal is final.
package imagecheck

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"path"
	"strings"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

// MaxSide is the long side of an editor image or a picture inside an Office
// file (Epo 2026-10-24, Q286).
const MaxSide = 2400

// SourceMaxPixels is the area of an image file uploaded as a source (Epo
// 2026-10-24, replacing Q286's 40 megapixels).
const SourceMaxPixels = 5_000_000

// headerBytes bounds what a header read may consume: a JPEG's frame header
// follows its metadata segments, each at most 64 KiB.
const headerBytes = 1 << 20

// ErrUnreadable is a raster image whose size its header does not give.
var ErrUnreadable = errors.New("image header unreadable")

// Refusal is a final refusal with the code the browser shows.
type Refusal struct {
	Code   string
	Detail string
}

func (r *Refusal) Error() string { return r.Detail }

// Size reads an image's width and height from its header: PNG, JPEG, GIF,
// WebP, BMP and TIFF through image.DecodeConfig, HEIF, HEIC and AVIF from
// their largest `ispe` property, JPEG 2000 from its `ihdr` box or SIZ
// marker, and ICO from its directory. ok is false for a format it does not
// know (SVG, anything else); err is ErrUnreadable for a known one whose
// header does not parse.
func Size(r io.Reader) (width, height int, ok bool, err error) {
	reader := bufio.NewReaderSize(io.LimitReader(r, headerBytes), 64<<10)
	head, _ := reader.Peek(32)
	switch {
	case isISOBMFF(head):
		width, height, err = isoSize(reader)
	case bytes.HasPrefix(head, []byte("\x00\x00\x00\x0cjP  \r\n\x87\n")):
		width, height, err = jp2Size(reader)
	case bytes.HasPrefix(head, []byte{0xff, 0x4f, 0xff, 0x51}):
		width, height, err = sizMarker(head[4:])
	case bytes.HasPrefix(head, []byte{0, 0, 1, 0}) && len(head) >= 8:
		// ICO: each directory entry's side is one byte, 0 meaning 256.
		width, height = 256, 256
	default:
		if Raster(head) == "" {
			return 0, 0, false, nil
		}
		config, _, decodeErr := image.DecodeConfig(reader)
		if decodeErr != nil {
			return 0, 0, true, ErrUnreadable
		}
		width, height = config.Width, config.Height
	}
	if err != nil || width <= 0 || height <= 0 {
		return 0, 0, true, ErrUnreadable
	}
	return width, height, true, nil
}

// Raster names a raster format by its signature, or "".
func Raster(head []byte) string {
	has := func(prefix string) bool { return bytes.HasPrefix(head, []byte(prefix)) }
	switch {
	case has("\x89PNG\r\n\x1a\n"):
		return "png"
	case has("\xff\xd8\xff"):
		return "jpeg"
	case has("GIF87a"), has("GIF89a"):
		return "gif"
	case has("BM"):
		return "bmp"
	case has("II*\x00"), has("MM\x00*"):
		return "tiff"
	case len(head) >= 12 && has("RIFF") && string(head[8:12]) == "WEBP":
		return "webp"
	case isISOBMFF(head):
		return "heif"
	case has("\x00\x00\x00\x0cjP  \r\n\x87\n"), has("\xff\x4f\xff\x51"):
		return "jp2"
	}
	return ""
}

// Vector reports an EMF or WMF picture, by name or signature (EMF's record 1
// with " EMF" at byte 40; WMF's placeable or standard header).
func Vector(name string, head []byte) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".emf", ".wmf", ".emz", ".wmz":
		return true
	}
	return (bytes.HasPrefix(head, []byte{1, 0, 0, 0}) && len(head) >= 44 && string(head[40:44]) == " EMF") ||
		bytes.HasPrefix(head, []byte{0xd7, 0xcd, 0xc6, 0x9a}) ||
		(len(head) >= 4 && (head[0] == 1 || head[0] == 2) && head[1] == 0 && head[2] == 9 && head[3] == 0)
}

func isISOBMFF(head []byte) bool {
	if len(head) < 12 || string(head[4:8]) != "ftyp" {
		return false
	}
	switch string(head[8:12]) {
	case "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis":
		return true
	}
	return false
}

// isoSize reads the largest `ispe` (image spatial extents) property of a
// HEIF file's meta box: the primary image's, which no thumbnail or grid
// tile exceeds.
func isoSize(r io.Reader) (int, int, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return 0, 0, err
	}
	var width, height uint32
	var walk func(body []byte, depth int)
	walk = func(body []byte, depth int) {
		for len(body) >= 8 && depth < 8 {
			size := uint64(binary.BigEndian.Uint32(body))
			kind := string(body[4:8])
			header := uint64(8)
			if size == 1 && len(body) >= 16 {
				size, header = binary.BigEndian.Uint64(body[8:16]), 16
			} else if size == 0 {
				size = uint64(len(body))
			}
			if size < header || size > uint64(len(body)) {
				return
			}
			box := body[header:size]
			switch kind {
			case "meta":
				if len(box) >= 4 {
					walk(box[4:], depth+1)
				}
			case "iprp", "ipco":
				walk(box, depth+1)
			case "ispe":
				if len(box) >= 12 {
					w, h := binary.BigEndian.Uint32(box[4:8]), binary.BigEndian.Uint32(box[8:12])
					if uint64(w)*uint64(h) > uint64(width)*uint64(height) {
						width, height = w, h
					}
				}
			}
			body = body[size:]
		}
	}
	walk(data, 0)
	if width == 0 || height == 0 || width > 1<<30 || height > 1<<30 {
		return 0, 0, ErrUnreadable
	}
	return int(width), int(height), nil
}

// jp2Size reads a JP2 file's `ihdr` box inside `jp2h` (height, then width).
func jp2Size(r io.Reader) (int, int, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return 0, 0, err
	}
	at := bytes.Index(data, []byte("ihdr"))
	if at < 4 || len(data) < at+12 {
		// A codestream box holds the SIZ marker instead.
		if c := bytes.Index(data, []byte{0xff, 0x4f, 0xff, 0x51}); c >= 0 {
			return sizMarker(data[c+4:])
		}
		return 0, 0, ErrUnreadable
	}
	height := binary.BigEndian.Uint32(data[at+4:])
	width := binary.BigEndian.Uint32(data[at+8:])
	if width == 0 || height == 0 || width > 1<<30 || height > 1<<30 {
		return 0, 0, ErrUnreadable
	}
	return int(width), int(height), nil
}

// sizMarker reads a JPEG 2000 SIZ marker segment after its FF51 code:
// length, capabilities, then the grid size and its offset.
func sizMarker(body []byte) (int, int, error) {
	if len(body) < 18 {
		return 0, 0, ErrUnreadable
	}
	xsiz, ysiz := binary.BigEndian.Uint32(body[4:8]), binary.BigEndian.Uint32(body[8:12])
	xoff, yoff := binary.BigEndian.Uint32(body[12:16]), binary.BigEndian.Uint32(body[16:20])
	if xsiz <= xoff || ysiz <= yoff || xsiz-xoff > 1<<30 || ysiz-yoff > 1<<30 {
		return 0, 0, ErrUnreadable
	}
	return int(xsiz - xoff), int(ysiz - yoff), nil
}

// CheckEditorImage refuses an editor image wider or taller than MaxSide, or
// one whose size its header does not give.
func CheckEditorImage(r io.Reader) error {
	width, height, ok, err := Size(r)
	if err != nil || !ok {
		return &Refusal{Code: "image_unreadable", Detail: "the image's size could not be read"}
	}
	if max(width, height) > MaxSide {
		return &Refusal{Code: "image_too_large", Detail: fmt.Sprintf(
			"the image is %dx%d; its long side may be at most %d px", width, height, MaxSide)}
	}
	return nil
}

// CheckSourceImage refuses an image file uploaded as a source over
// SourceMaxPixels, or a raster one whose size its header does not give.
// A format it does not know (SVG) passes.
func CheckSourceImage(r io.Reader) error {
	width, height, ok, err := Size(r)
	if !ok {
		return nil
	}
	if err != nil {
		return &Refusal{Code: "image_unreadable", Detail: "the image's size could not be read"}
	}
	if int64(width)*int64(height) > SourceMaxPixels {
		return &Refusal{Code: "source_image_too_large", Detail: fmt.Sprintf(
			"the image is %dx%d; a source image may hold at most %d pixels", width, height, SourceMaxPixels)}
	}
	return nil
}

// CheckOffice reads an Office package's zip directory and the head of each
// part that is not XML: an EMF or WMF picture is refused, and so is a raster
// one over maxBytes (counted as it inflates, never trusting the directory)
// or MaxSide, or whose size its header does not give. Other parts pass.
func CheckOffice(r io.ReaderAt, size, maxBytes int64) error {
	archive, err := zip.NewReader(r, size)
	if err != nil {
		// Not a package the check can read: the parser decides.
		return nil
	}
	for _, file := range archive.File {
		switch strings.ToLower(path.Ext(file.Name)) {
		case ".xml", ".rels", ".vml":
			continue
		}
		if file.FileInfo().IsDir() {
			continue
		}
		if err := checkPart(file, maxBytes); err != nil {
			return err
		}
	}
	return nil
}

func checkPart(file *zip.File, maxBytes int64) error {
	part, err := file.Open()
	if err != nil {
		return nil
	}
	defer part.Close()
	reader := bufio.NewReaderSize(part, 64<<10)
	head, _ := reader.Peek(64)
	if Vector(file.Name, head) {
		return &Refusal{Code: "office_vector_image", Detail: fmt.Sprintf(
			"%s is an EMF or WMF picture, which Office files may not hold", file.Name)}
	}
	if Raster(head) == "" {
		return nil
	}
	counted := &countingReader{r: reader}
	width, height, _, err := Size(counted)
	tooLarge := func(detail string) error {
		return &Refusal{Code: "office_image_too_large", Detail: fmt.Sprintf(
			"%s %s; pictures may be at most %d MB and %d px on their long side",
			file.Name, detail, maxBytes>>20, MaxSide)}
	}
	if err != nil {
		return tooLarge("has no readable size")
	}
	if max(width, height) > MaxSide {
		return tooLarge(fmt.Sprintf("is %dx%d", width, height))
	}
	rest, _ := io.Copy(io.Discard, io.LimitReader(reader, maxBytes+1-min(counted.n, maxBytes+1)))
	if counted.n+rest > maxBytes {
		return tooLarge("is over the size limit")
	}
	return nil
}

// countingReader counts what the header read consumed from the part.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}
