// Package imagecheck reads image sizes from headers only, never decoding
// pixels, for the upload checks of Epo's 2026-10-24 image lines (Q285, Q286,
// Q344, Q348): an editor image at most MaxSide on either side, an image file
// uploaded as a source at most SourceMaxPixels, and an Office file holding
// only PNG, JPEG or GIF pictures within the plan image cap and MaxSide, no
// EMF, WMF or SVG, inside bounded zip packages. The browser compresses to
// these limits first (src/lib/fitImage.ts, src/lib/officeImages.ts) and the
// import worker does the same (pipeline/pipeline/ingest/image_check.py), so a
// refusal is final.
package imagecheck

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"

	_ "golang.org/x/image/webp"
)

// MaxSide bounds both sides of an editor image or a picture inside an Office
// file (Epo 2026-10-24, Q286).
const MaxSide = 2400

// SourceMaxPixels is the area of an image file uploaded as a source (Epo
// 2026-10-24, replacing Q286's 40 megapixels).
const SourceMaxPixels = 5_000_000

// MaxEntries and MaxInflated bound an Office package (Q348), as the browser
// and the import worker do: more entries, or more bytes inflated across its
// parts while the check reads them, refuse it.
const (
	MaxEntries  = 4096
	MaxInflated = 256 << 20
)

// headerBytes bounds what a header read may consume: a JPEG's frame header
// follows its metadata segments, each at most 64 KiB.
const headerBytes = 1 << 20

var (
	// ErrUnknown is a format the check does not measure.
	ErrUnknown = errors.New("image format not measured")
	// ErrUnreadable is a known format whose header gives no size.
	ErrUnreadable = errors.New("image header unreadable")
)

// The formats each check accepts (Q344): editor images as the editor-asset
// reservation takes them, image sources as the browser re-saves them, and
// Office pictures as older Word, PowerPoint and LibreOffice open them.
var (
	editorFormats = []string{"png", "jpeg", "gif", "webp", "avif"}
	sourceFormats = []string{"png", "jpeg", "gif", "webp"}
	officeFormats = []string{"png", "jpeg", "gif"}
)

// Refusal is a final refusal with the code the browser shows.
type Refusal struct {
	Code   string
	Detail string
}

func (r *Refusal) Error() string { return r.Detail }

// Format names an image format by its signature: png, jpeg, gif, webp, avif,
// heic (any other HEIF brand) or "".
func Format(head []byte) string {
	has := func(prefix string) bool { return bytes.HasPrefix(head, []byte(prefix)) }
	switch {
	case has("\x89PNG\r\n\x1a\n"):
		return "png"
	case has("\xff\xd8\xff"):
		return "jpeg"
	case has("GIF87a"), has("GIF89a"):
		return "gif"
	case len(head) >= 12 && has("RIFF") && string(head[8:12]) == "WEBP":
		return "webp"
	case len(head) >= 12 && string(head[4:8]) == "ftyp":
		switch string(head[8:12]) {
		case "avif", "avis":
			return "avif"
		case "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1":
			return "heic"
		}
	}
	return ""
}

// Size reads an image's format, width and height from its header: PNG, JPEG
// and WebP through image.DecodeConfig, GIF from its logical screen and first
// frame (a frame may be larger than the screen it claims), and HEIF/AVIF from
// their largest `ispe` property. err is ErrUnknown for any other format and
// ErrUnreadable for a known one whose header does not parse.
func Size(r io.Reader) (format string, width, height int, err error) {
	reader := bufio.NewReaderSize(io.LimitReader(r, headerBytes), 64<<10)
	head, _ := reader.Peek(32)
	format = Format(head)
	switch format {
	case "":
		return "", 0, 0, ErrUnknown
	case "gif":
		width, height, err = gifSize(reader)
	case "avif", "heic":
		width, height, err = isoSize(reader)
	default:
		config, _, decodeErr := image.DecodeConfig(reader)
		width, height, err = config.Width, config.Height, decodeErr
	}
	if err != nil || width <= 0 || height <= 0 {
		return format, 0, 0, ErrUnreadable
	}
	return format, width, height, nil
}

// gifSize reads a GIF's logical screen and its first image descriptor, and
// returns the larger extent of the two on each side.
func gifSize(r *bufio.Reader) (int, int, error) {
	header := make([]byte, 13)
	if _, err := io.ReadFull(r, header); err != nil {
		return 0, 0, err
	}
	width := int(binary.LittleEndian.Uint16(header[6:]))
	height := int(binary.LittleEndian.Uint16(header[8:]))
	if header[10]&0x80 != 0 {
		if _, err := r.Discard(3 << (header[10]&7 + 1)); err != nil {
			return 0, 0, err
		}
	}
	for {
		kind, err := r.ReadByte()
		if err != nil {
			return 0, 0, err
		}
		switch kind {
		case 0x2c:
			frame := make([]byte, 8)
			if _, err := io.ReadFull(r, frame); err != nil {
				return 0, 0, err
			}
			left, top := int(binary.LittleEndian.Uint16(frame)), int(binary.LittleEndian.Uint16(frame[2:]))
			return max(width, left+int(binary.LittleEndian.Uint16(frame[4:]))),
				max(height, top+int(binary.LittleEndian.Uint16(frame[6:]))), nil
		case 0x21:
			// An extension: its label, then sub-blocks up to an empty one.
			if _, err := r.ReadByte(); err != nil {
				return 0, 0, err
			}
			for {
				size, err := r.ReadByte()
				if err != nil {
					return 0, 0, err
				}
				if size == 0 {
					break
				}
				if _, err := r.Discard(int(size)); err != nil {
					return 0, 0, err
				}
			}
		default:
			return 0, 0, ErrUnreadable
		}
	}
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

// svgRoot finds an <svg> root after an XML declaration, comments or a
// doctype.
var svgRoot = regexp.MustCompile(`^(?:\s|<\?[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*<svg[\s>/]`)

// OtherImage reports an image format a browser may decode that an Office
// picture may not be (Q344), by signature: WebP, AVIF, HEIF, BMP, TIFF, ICO
// or CUR, JPEG XR and JPEG 2000.
func OtherImage(head []byte) bool {
	has := func(prefix string) bool { return bytes.HasPrefix(head, []byte(prefix)) }
	switch Format(head) {
	case "webp", "avif", "heic":
		return true
	}
	// A bitmap's DIB header names its own size.
	bitmap := has("BM") && len(head) >= 18 &&
		slices.Contains([]uint32{12, 40, 52, 56, 64, 108, 124}, binary.LittleEndian.Uint32(head[14:]))
	icon := (has("\x00\x00\x01\x00") || has("\x00\x00\x02\x00")) && len(head) >= 6 &&
		binary.LittleEndian.Uint16(head[4:]) > 0
	return bitmap || icon || has("II*\x00") || has("MM\x00*") || has("II\xbc\x01") ||
		has("\x00\x00\x00\x0cjP  \r\n\x87\n") || has("\xff\x4f\xff\x51")
}

// SVG reports an SVG picture, by name or by its root element.
func SVG(name string, head []byte) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".svg", ".svgz":
		return true
	}
	return svgRoot.Match(bytes.TrimPrefix(head, []byte("\xef\xbb\xbf")))
}

// CheckEditorImage refuses an editor image wider or taller than MaxSide, or
// one whose format the reservation does not take or whose size its header
// does not give.
func CheckEditorImage(r io.Reader) error {
	format, width, height, err := Size(r)
	if err != nil || !slices.Contains(editorFormats, format) {
		return &Refusal{Code: "image_unreadable", Detail: "the image's size could not be read"}
	}
	if width > MaxSide || height > MaxSide {
		return &Refusal{Code: "image_too_large", Detail: fmt.Sprintf(
			"the image is %dx%d; each side may be at most %d px", width, height, MaxSide)}
	}
	return nil
}

// CheckSourceImage refuses an image file uploaded as a source over
// SourceMaxPixels, or anything but a PNG, JPEG, GIF or WebP whose header
// gives its size: the browser re-saves every other format (Q344).
func CheckSourceImage(r io.Reader) error {
	format, width, height, err := Size(r)
	if err != nil || !slices.Contains(sourceFormats, format) {
		return &Refusal{Code: "image_unreadable", Detail: "the image is not a PNG, JPEG, GIF or WebP whose size can be read"}
	}
	if int64(width)*int64(height) > SourceMaxPixels {
		return &Refusal{Code: "source_image_too_large", Detail: fmt.Sprintf(
			"the image is %dx%d; a source image may hold at most %d pixels", width, height, SourceMaxPixels)}
	}
	return nil
}

// CheckOffice reads an Office package part by part, classifying each by its
// content, not its name (Q348). It refuses a package it cannot read whole:
// one that is not a single archive from its first byte to its end record
// (contiguous), over MaxEntries, with a part that does not open, or over
// MaxInflated read in all. In any part it refuses an EMF, WMF or SVG
// picture, any image format but PNG, JPEG or GIF (OtherImage), and a PNG,
// JPEG or GIF over maxBytes (counted as it inflates, never trusting the
// directory) or MaxSide; a picture part (an image relationship's target, or
// a media part nothing else targets) must be one of those three. Other parts
// (XML, embedded objects, fonts, audio and video) pass after their head is
// read. A directory is a name ending in "/", never an attribute, as the
// editors' zip readers see it.
func CheckOffice(r io.ReaderAt, size, maxBytes int64) error {
	end, err := readDirectoryEnd(r, size)
	if err != nil {
		return err
	}
	// From the end record, before the directory is loaded.
	if end.entries > MaxEntries {
		return unreadablePackage(fmt.Sprintf("the package has more than %d entries", MaxEntries))
	}
	archive, err := zip.NewReader(r, size)
	if err != nil {
		return unreadablePackage("the file is not a zip package")
	}
	if err := contiguous(r, archive.File, end); err != nil {
		return err
	}
	check := &officeCheck{maxBytes: maxBytes}
	pictures, err := check.pictureParts(archive.File)
	if err != nil {
		return err
	}
	for _, file := range archive.File {
		if strings.HasSuffix(file.Name, "/") {
			continue
		}
		if err := check.part(file, pictures[file.Name]); err != nil {
			return err
		}
	}
	return nil
}

func unreadablePackage(detail string) error {
	return &Refusal{Code: "office_unreadable", Detail: detail}
}

// directoryEnd is what a package's end-of-central-directory record (its
// ZIP64 record where present) says: its entries, where its central directory
// starts and how long it is, and where that record starts.
type directoryEnd struct {
	entries, dirStart, dirSize, recordStart uint64
}

// endWindow is how far from the end of a file zip 9, the collaboration
// server's reader, looks for end records (64 KiB and 26 bytes); Go and
// CPython look within it too.
const endWindow = 1<<16 + 26

// readDirectoryEnd reads the end record on a layout where every zip reader
// (Go, CPython, zip 9) picks that same record and the same central directory
// (review r3 B1). Each takes the last end record signature, zip 9 falling
// back to earlier ones, so it must be the only one in endWindow (no nested
// or trailing archive offers another) and its comment must end the file.
// zip 9 follows a ZIP64 record only when a classic field is maxed out, Go
// also when the directory is 0xffff bytes long, CPython whenever a locator
// precedes the end record: a locator must be there exactly when a field is
// maxed out.
func readDirectoryEnd(r io.ReaderAt, size int64) (directoryEnd, error) {
	const recordLen = 22
	notZip := unreadablePackage("the file is not a zip package")
	tail := min(size, endWindow)
	buf := make([]byte, tail)
	if _, err := r.ReadAt(buf, size-tail); err != nil && err != io.EOF {
		return directoryEnd{}, notZip
	}
	signature := []byte("PK\x05\x06")
	i := bytes.LastIndex(buf, signature)
	if i < 0 || i+recordLen > len(buf) {
		return directoryEnd{}, notZip
	}
	if bytes.Count(buf, signature) != 1 {
		return directoryEnd{}, notOneArchive
	}
	record := buf[i:]
	if recordLen+int(binary.LittleEndian.Uint16(record[20:])) != len(record) {
		return directoryEnd{}, notOneArchive
	}
	end := directoryEnd{
		entries:     uint64(binary.LittleEndian.Uint16(record[10:])),
		dirSize:     uint64(binary.LittleEndian.Uint32(record[12:])),
		dirStart:    uint64(binary.LittleEndian.Uint32(record[16:])),
		recordStart: uint64(size-tail) + uint64(i),
	}
	locator := make([]byte, 20)
	located := end.recordStart >= 20
	if located {
		_, err := r.ReadAt(locator, int64(end.recordStart-20))
		located = err == nil && string(locator[:4]) == "PK\x06\x07"
	}
	maxed := end.entries == 0xffff || end.dirSize == 0xffffffff || end.dirStart == 0xffffffff
	switch {
	case maxed && located:
		return readZip64End(r, end.recordStart, locator)
	case maxed || located:
		return directoryEnd{}, unreadablePackage("a ZIP64 record without a maxed-out end record field, or the reverse")
	}
	return end, nil
}

// readZip64End reads the ZIP64 end record its locator, just before the end
// record at eocd, names. Go reads it where the locator points and CPython
// 56 bytes before the locator, so it must sit there, hold no extensible
// data, and the locator must name one disk.
func readZip64End(r io.ReaderAt, eocd uint64, locator []byte) (directoryEnd, error) {
	notZip64 := unreadablePackage("the ZIP64 end record is not where every reader looks")
	at := binary.LittleEndian.Uint64(locator[8:])
	if eocd < 20+56 || at != eocd-20-56 ||
		binary.LittleEndian.Uint32(locator[4:]) != 0 || binary.LittleEndian.Uint32(locator[16:]) != 1 {
		return directoryEnd{}, notZip64
	}
	record := make([]byte, 56)
	if _, err := r.ReadAt(record, int64(at)); err != nil || string(record[:4]) != "PK\x06\x06" ||
		binary.LittleEndian.Uint64(record[4:]) != 56-12 {
		return directoryEnd{}, notZip64
	}
	return directoryEnd{
		entries:     binary.LittleEndian.Uint64(record[32:]),
		dirSize:     binary.LittleEndian.Uint64(record[40:]),
		dirStart:    binary.LittleEndian.Uint64(record[48:]),
		recordStart: at,
	}, nil
}

var notOneArchive = &Refusal{Code: "office_unreadable", Detail: "the package is not one contiguous zip archive"}

// contiguous refuses a package that is not one archive laid out as Office
// writers lay it out (Q348): local entries one after another from byte 0,
// each followed only by its data and an optional data descriptor, then the
// central directory, ending where the end record starts, which counts the
// entries the directory holds. A second archive before or after it, data
// between entries, or two directory records for one entry are refused, so
// no zip reader can find other parts than the ones checked here.
func contiguous(r io.ReaderAt, files []*zip.File, end directoryEnd) error {
	if uint64(len(files)) != end.entries || end.dirStart+end.dirSize != end.recordStart {
		return notOneArchive
	}
	byData := make(map[int64]*zip.File, len(files))
	for _, file := range files {
		at, err := file.DataOffset()
		if err != nil {
			return unreadablePackage(fmt.Sprintf("%s cannot be read", file.Name))
		}
		byData[at] = file
	}
	if len(byData) != len(files) {
		return notOneArchive
	}
	var at int64
	header := make([]byte, 30)
	for range files {
		if _, err := r.ReadAt(header, at); err != nil || string(header[:4]) != "PK\x03\x04" {
			return notOneArchive
		}
		data := at + 30 + int64(binary.LittleEndian.Uint16(header[26:])) + int64(binary.LittleEndian.Uint16(header[28:]))
		file := byData[data]
		if file == nil {
			return notOneArchive
		}
		at = data + int64(file.CompressedSize64)
		if file.Flags&0x8 != 0 {
			next, ok := afterDescriptor(r, at, int64(end.dirStart))
			if !ok {
				return notOneArchive
			}
			at = next
		}
	}
	if at != int64(end.dirStart) {
		return notOneArchive
	}
	return nil
}

// afterDescriptor finds the end of the data descriptor at `at`: 12 or 20
// bytes, or 16 or 24 with its signature, whichever the next local entry or
// the central directory follows.
func afterDescriptor(r io.ReaderAt, at, dirStart int64) (int64, bool) {
	signature := make([]byte, 4)
	if _, err := r.ReadAt(signature, at); err != nil {
		return 0, false
	}
	lengths := []int64{12, 20}
	if string(signature) == "PK\x07\x08" {
		lengths = []int64{16, 24}
	}
	for _, length := range lengths {
		next := at + length
		if next == dirStart {
			return next, true
		}
		if _, err := r.ReadAt(signature, next); err == nil && string(signature) == "PK\x03\x04" {
			return next, true
		}
	}
	return 0, false
}

// officeCheck holds one package's limits and what its reads inflated.
type officeCheck struct {
	maxBytes int64
	inflated int64
}

// open opens a part behind a reader that refuses past MaxInflated.
func (c *officeCheck) open(file *zip.File) (io.ReadCloser, error) {
	part, err := file.Open()
	if err != nil {
		return nil, unreadablePackage(fmt.Sprintf("%s cannot be read", file.Name))
	}
	return &inflation{ReadCloser: part, check: c}, nil
}

var errInflated = &Refusal{Code: "office_unreadable", Detail: fmt.Sprintf("the package inflates past %d bytes", MaxInflated)}

type inflation struct {
	io.ReadCloser
	check *officeCheck
}

func (i *inflation) Read(p []byte) (int, error) {
	n, err := i.ReadCloser.Read(p)
	i.check.inflated += int64(n)
	if i.check.inflated > MaxInflated {
		return n, errInflated
	}
	return n, err
}

// The relationship types whose targets are pictures: images (pictures, fills,
// object previews, SVG) and HD Photo originals.
const (
	imageRelationship   = "/image"
	hdPhotoRelationship = "/hdphoto"
)

var mediaFolder = regexp.MustCompile(`^(word|ppt|xl)/media/`)

// pictureParts reads every relationships part and names the picture parts:
// an image relationship's targets, and media parts no other relationship
// targets (audio and video stay media).
func (c *officeCheck) pictureParts(files []*zip.File) (map[string]bool, error) {
	pictures := map[string]bool{}
	other := map[string]bool{}
	for _, file := range files {
		if strings.HasSuffix(file.Name, "/") || !strings.HasSuffix(file.Name, ".rels") {
			continue
		}
		part, err := c.open(file)
		if err != nil {
			return nil, err
		}
		rels, err := relationships(file.Name, part)
		part.Close()
		if err != nil {
			var refusal *Refusal
			if errors.As(err, &refusal) {
				return nil, err
			}
			return nil, unreadablePackage(fmt.Sprintf("%s cannot be read", file.Name))
		}
		for _, rel := range rels {
			if strings.HasSuffix(rel.kind, imageRelationship) || strings.HasSuffix(rel.kind, hdPhotoRelationship) {
				pictures[rel.part] = true
			} else {
				other[rel.part] = true
			}
		}
	}
	for _, file := range files {
		if mediaFolder.MatchString(file.Name) && !other[file.Name] {
			pictures[file.Name] = true
		}
	}
	return pictures, nil
}

type relationship struct{ kind, part string }

// relationships parses a relationships part into its internal targets as
// part names (relative to the part it describes, or from the root).
func relationships(name string, r io.Reader) ([]relationship, error) {
	dir, base := path.Split(name)
	source := path.Join(strings.TrimSuffix(dir, "_rels/"), strings.TrimSuffix(base, ".rels"))
	sourceDir := path.Dir(source)
	var out []relationship
	decoder := xml.NewDecoder(r)
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		element, ok := token.(xml.StartElement)
		if !ok || element.Name.Local != "Relationship" {
			continue
		}
		var kind, target, mode string
		for _, attr := range element.Attr {
			switch attr.Name.Local {
			case "Type":
				kind = attr.Value
			case "Target":
				target = attr.Value
			case "TargetMode":
				mode = attr.Value
			}
		}
		if mode == "External" {
			continue
		}
		if decoded, err := url.PathUnescape(target); err == nil {
			target = decoded
		}
		part := path.Join(sourceDir, target)
		if strings.HasPrefix(target, "/") {
			part = path.Clean(target)
		}
		out = append(out, relationship{kind: kind, part: strings.TrimPrefix(part, "/")})
	}
}

// part checks one part by its content.
func (c *officeCheck) part(file *zip.File, picture bool) error {
	part, err := c.open(file)
	if err != nil {
		return err
	}
	defer part.Close()
	// A small buffer: a part that is neither a picture nor an image is
	// inflated only this far.
	reader := bufio.NewReaderSize(part, 4<<10)
	head, err := reader.Peek(4 << 10)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, bufio.ErrBufferFull) {
		var refusal *Refusal
		if errors.As(err, &refusal) {
			return err
		}
		return unreadablePackage(fmt.Sprintf("%s cannot be read", file.Name))
	}
	unsupported := &Refusal{Code: "office_image_unsupported", Detail: fmt.Sprintf(
		"%s is not a PNG, JPEG or GIF picture", file.Name)}
	switch format := Format(head); {
	case Vector(file.Name, head):
		return &Refusal{Code: "office_vector_image", Detail: fmt.Sprintf(
			"%s is an EMF or WMF picture, which Office files may not hold", file.Name)}
	case SVG(file.Name, head):
		return unsupported
	case slices.Contains(officeFormats, format):
		return c.raster(file.Name, reader)
	case picture, OtherImage(head):
		return unsupported
	}
	return nil
}

// raster checks a PNG, JPEG or GIF picture's size and its inflated bytes.
func (c *officeCheck) raster(name string, reader *bufio.Reader) error {
	counted := &countingReader{r: reader}
	_, width, height, err := Size(counted)
	tooLarge := func(detail string) error {
		return &Refusal{Code: "office_image_too_large", Detail: fmt.Sprintf(
			"%s %s; pictures may be at most %d bytes and %d px on each side",
			name, detail, c.maxBytes, MaxSide)}
	}
	var refusal *Refusal
	if errors.As(err, &refusal) || errors.As(counted.err, &refusal) {
		return refusal
	}
	if err != nil {
		return &Refusal{Code: "office_image_unsupported", Detail: name + " has no readable size"}
	}
	if width > MaxSide || height > MaxSide {
		return tooLarge(fmt.Sprintf("is %dx%d", width, height))
	}
	rest, err := io.Copy(io.Discard, io.LimitReader(reader, c.maxBytes+1-min(counted.n, c.maxBytes+1)))
	if errors.As(err, &refusal) {
		return refusal
	}
	if err != nil {
		return unreadablePackage(name + " cannot be read")
	}
	if counted.n+rest > c.maxBytes {
		return tooLarge("is over the size limit")
	}
	return nil
}

// countingReader counts what the header read consumed from the part, and
// keeps the read error it met (an inflation refusal).
type countingReader struct {
	r   io.Reader
	n   int64
	err error
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	if err != nil && err != io.EOF {
		c.err = err
	}
	return n, err
}
