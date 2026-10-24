package imagecheck

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"strings"
	"testing"
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

// gifHeader is a GIF whose logical screen and first frame claim their own
// sizes, the frame placed at (left, top).
func gifHeader(screenW, screenH, left, top, frameW, frameH uint16) []byte {
	out := []byte("GIF89a")
	out = binary.LittleEndian.AppendUint16(out, screenW)
	out = binary.LittleEndian.AppendUint16(out, screenH)
	out = append(out, 0x80, 0, 0)             // a two-colour global table
	out = append(out, 0, 0, 0, 255, 255, 255) // the table
	out = append(out, 0x21, 0xf9, 4, 0, 0, 0, 0, 0)
	out = append(out, 0x2c)
	for _, v := range []uint16{left, top, frameW, frameH} {
		out = binary.LittleEndian.AppendUint16(out, v)
	}
	return append(out, 0, 2, 2, 0x44, 1, 0, 0x3b)
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

// heif is an ftyp of brand and a meta box whose property container holds a
// thumbnail's extents and the primary image's.
func heif(brand string, width, height uint32) []byte {
	return append(box("ftyp", []byte(brand+"\x00\x00\x00\x00mif1"+brand)),
		box("meta", []byte{0, 0, 0, 0}, box("iprp", box("ipco", ispe(320, 240), ispe(width, height))))...)
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
		"avif": {heif("avif", 4032, 3024), 4032, 3024},
		// Security regression (Q348, review S9): a frame larger than the
		// screen it claims gives the size.
		"gif frame past its screen": {gifHeader(1, 1, 10, 20, 60000, 50000), 60010, 50020},
		"gif within its screen":     {gifHeader(300, 200, 0, 0, 100, 100), 300, 200},
	}
	for name, c := range cases {
		_, width, height, err := Size(bytes.NewReader(c.data))
		if err != nil || width != c.width || height != c.height {
			t.Errorf("%s: Size = %d, %d, %v; want %d, %d", name, width, height, err, c.width, c.height)
		}
	}
	for name, data := range map[string][]byte{
		"svg": []byte("<svg/>"), "tiff": []byte("II*\x00\x08\x00\x00\x00"), "bmp": []byte("BM\x00\x00"),
		"jp2": []byte("\x00\x00\x00\x0cjP  \r\n\x87\n"),
	} {
		if _, _, _, err := Size(bytes.NewReader(data)); !errors.Is(err, ErrUnknown) {
			t.Errorf("%s: err = %v, want ErrUnknown", name, err)
		}
	}
}

func TestCheckEditorImageRefusesPastEitherSide(t *testing.T) {
	for _, data := range [][]byte{pngHeader(2400, 2400), heif("avif", 2400, 1600), gifHeader(2400, 10, 0, 0, 2400, 10)} {
		if err := CheckEditorImage(bytes.NewReader(data)); err != nil {
			t.Fatalf("within 2400 px refused: %v", err)
		}
	}
	for _, data := range [][]byte{
		pngHeader(2401, 100), pngHeader(10, 2401),
		// A decompression bomb is refused from its header, with no pixels read.
		pngHeader(50000, 50000),
		gifHeader(10, 10, 0, 0, 3000, 10),
	} {
		if code := refusal(t, CheckEditorImage(bytes.NewReader(data))); code != "image_too_large" {
			t.Fatalf("code = %s", code)
		}
	}
	for _, data := range [][]byte{[]byte("\x89PNG\r\n\x1a\nbroken"), []byte("BM\x00\x00"), heif("heic", 100, 100)} {
		if code := refusal(t, CheckEditorImage(bytes.NewReader(data))); code != "image_unreadable" {
			t.Fatalf("code = %s", code)
		}
	}
}

// Security regression (Q344, review S4): an image source is a PNG, JPEG, GIF
// or WebP within 5 MP; every other format is refused by its content.
func TestCheckSourceImageRefusesPastFiveMegapixelsAndOtherFormats(t *testing.T) {
	for _, data := range [][]byte{pngHeader(2500, 2000), gifHeader(2500, 2000, 0, 0, 10, 10)} {
		if err := CheckSourceImage(bytes.NewReader(data)); err != nil {
			t.Fatalf("5 MP refused: %v", err)
		}
	}
	// 2610 x 1955 is 5.1 MP.
	for _, data := range [][]byte{pngHeader(2610, 1955), gifHeader(1, 1, 0, 0, 2610, 1955)} {
		if code := refusal(t, CheckSourceImage(bytes.NewReader(data))); code != "source_image_too_large" {
			t.Fatalf("code = %s", code)
		}
	}
	for name, data := range map[string][]byte{
		"heic": heif("heic", 100, 100), "avif": heif("avif", 100, 100), "svg": []byte("<svg/>"),
		"tiff": []byte("II*\x00\x08\x00\x00\x00"), "psd": []byte("8BPS\x00\x01"), "ico": {0, 0, 1, 0, 1, 0},
	} {
		if code := refusal(t, CheckSourceImage(bytes.NewReader(data))); code != "image_unreadable" {
			t.Fatalf("%s: code = %s", name, code)
		}
	}
}

type part struct {
	name string
	data []byte
}

func officeFile(t *testing.T, parts ...part) *bytes.Reader {
	t.Helper()
	var out bytes.Buffer
	archive := zip.NewWriter(&out)
	for _, p := range parts {
		writer, err := archive.Create(p.name)
		if err != nil {
			t.Fatal(err)
		}
		writer.Write(p.data)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(out.Bytes())
}

func rels(targets ...string) part {
	var body strings.Builder
	body.WriteString(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for i, target := range targets {
		kind, target, _ := strings.Cut(target, " ")
		fmt.Fprintf(&body, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/%s" Target="%s"/>`, i+1, kind, target)
	}
	body.WriteString(`</Relationships>`)
	return part{"word/_rels/document.xml.rels", []byte(body.String())}
}

const testCap = 2 << 20

func TestCheckOfficePassesACompressedFile(t *testing.T) {
	file := officeFile(t,
		part{"word/document.xml", []byte("<w:document/>")},
		rels("image media/image1.png", "video media/clip.mp4", "oleObject embeddings/a.bin"),
		part{"word/media/image1.png", append(pngHeader(800, 600), make([]byte, 1000)...)},
		part{"word/media/clip.mp4", []byte("\x00\x00\x00\x18ftypmp42")},
		part{"word/embeddings/a.bin", []byte{0xd0, 0xcf, 0x11, 0xe0}},
	)
	if err := CheckOffice(file, file.Size(), testCap); err != nil {
		t.Fatalf("a compressed file refused: %v", err)
	}
}

// Security regression (Q344, Q337, Q348; review S2): parts are checked by
// their content, a picture part holds only PNG, JPEG or GIF, and EMF, WMF
// and SVG are refused.
func TestCheckOfficeRefusesPicturesByContent(t *testing.T) {
	emf := make([]byte, 64)
	copy(emf, []byte{1, 0, 0, 0})
	copy(emf[40:], " EMF")
	cases := map[string]struct {
		parts []part
		code  string
	}{
		"a picture over 2 MiB, by its inflated bytes": {
			[]part{{"word/media/image1.png", append(pngHeader(800, 600), make([]byte, testCap)...)}},
			"office_image_too_large",
		},
		"a picture past 2,400 px on its short side": {
			[]part{{"ppt/media/image1.png", pngHeader(10, 2401)}}, "office_image_too_large",
		},
		"a large picture named as XML, with an image relationship": {
			[]part{rels("image media/image1.xml"), {"word/media/image1.xml", pngHeader(6000, 4000)}},
			"office_image_too_large",
		},
		"a GIF whose first frame is past its screen": {
			[]part{{"word/media/image1.gif", gifHeader(1, 1, 0, 0, 60000, 60000)}}, "office_image_too_large",
		},
		"an EMF under another name":        {[]part{{"xl/media/image2.bin", emf}}, "office_vector_image"},
		"an EMF outside the media folders": {[]part{{"word/embeddings/x.dat", emf}}, "office_vector_image"},
		"a WMF by name":                    {[]part{{"word/media/eq.wmf", []byte{0, 0}}}, "office_vector_image"},
		"an SVG picture": {
			[]part{{"word/media/image1.svg", []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`)}},
			"office_image_unsupported",
		},
		"an SVG outside the picture parts": {
			[]part{{"word/embeddings/icon.svg", []byte("<svg/>")}}, "office_image_unsupported",
		},
		"an SVG under an image name": {
			[]part{rels("image media/image1.png"), {"word/media/image1.png", []byte("<svg width='9'/>")}},
			"office_image_unsupported",
		},
		"a BMP picture": {[]part{{"word/media/image1.bmp", []byte("BM\x00\x00\x00\x00")}}, "office_image_unsupported"},
		"a WebP reached through a backslash target": {
			[]part{rels(`image pics\a.webp`), {"word/pics/a.webp", []byte("RIFF\x00\x00\x00\x00WEBPVP8L\x00\x00\x00\x00")}},
			"office_image_unsupported",
		},
		"a BMP outside the picture parts": {
			[]part{{"word/embeddings/x.bin", append([]byte("BM\x00\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00"), 40, 0, 0, 0)}},
			"office_image_unsupported",
		},
		"a TIFF outside the picture parts": {[]part{{"word/x.dat", []byte("II*\x00\x08\x00\x00\x00")}}, "office_image_unsupported"},
		"an ICO outside the picture parts": {[]part{{"word/x.dat", []byte("\x00\x00\x01\x00\x01\x00")}}, "office_image_unsupported"},
		"a JPEG 2000 outside the picture parts": {
			[]part{{"word/x.dat", []byte("\x00\x00\x00\x0cjP  \r\n\x87\n")}}, "office_image_unsupported",
		},
		"an SVG named as relationships": {
			[]part{rels("image media/a.rels"), {"word/media/a.rels", []byte("<svg/>")}}, "office_image_unsupported",
		},
		"a JPEG XR picture": {
			[]part{rels("image media/hdphoto1.wdp"), {"word/media/hdphoto1.wdp", []byte("II\xbc\x01\x08\x00\x00\x00")}},
			"office_image_unsupported",
		},
	}
	for name, c := range cases {
		file := officeFile(t, c.parts...)
		if code := refusal(t, CheckOffice(file, file.Size(), testCap)); code != c.code {
			t.Errorf("%s: code = %s, want %s", name, code, c.code)
		}
	}
}

// Security regression (Q348, review B1, S2): a package the check cannot read
// whole is refused: not a zip, over 4,096 entries, overlapping entries, or
// over 256 MiB inflated in all.
func TestCheckOfficeRefusesPackagesItCannotReadWhole(t *testing.T) {
	notZip := bytes.NewReader([]byte("PK\x03\x04 not really"))
	if code := refusal(t, CheckOffice(notZip, notZip.Size(), testCap)); code != "office_unreadable" {
		t.Fatalf("not a zip: code = %s", code)
	}

	many := make([]part, MaxEntries+1)
	for i := range many {
		many[i] = part{fmt.Sprintf("word/p%d.xml", i), []byte("<p/>")}
	}
	file := officeFile(t, many...)
	if code := refusal(t, CheckOffice(file, file.Size(), testCap)); code != "office_unreadable" {
		t.Fatalf("4,097 entries: code = %s", code)
	}

	// Each picture is under the cap; together they inflate past 256 MiB.
	under := append(pngHeader(800, 600), make([]byte, testCap-100)...)
	big := make([]part, MaxInflated/testCap+2)
	for i := range big {
		big[i] = part{fmt.Sprintf("word/media/image%d.png", i), under}
	}
	file = officeFile(t, big...)
	if code := refusal(t, CheckOffice(file, file.Size(), testCap)); code != "office_unreadable" {
		t.Fatalf("over 256 MiB inflated: code = %s", code)
	}

	overlapped := overlappedZip(t)
	if code := refusal(t, CheckOffice(overlapped, overlapped.Size(), testCap)); code != "office_unreadable" {
		t.Fatalf("overlapping entries: code = %s", code)
	}
}

// Security regression (Q348, review r2 B1): an entry whose attributes call it
// a directory is still a part (the editors' zip readers go by its name), so
// an EMF or a decompression-bomb PNG marked as one is refused.
func TestCheckOfficeReadsEntriesMarkedAsDirectories(t *testing.T) {
	emf := make([]byte, 64)
	copy(emf, []byte{1, 0, 0, 0})
	copy(emf[40:], " EMF")
	for data, code := range map[string]string{
		string(emf):                     "office_vector_image",
		string(pngHeader(60000, 60000)): "office_image_too_large",
	} {
		var out bytes.Buffer
		archive := zip.NewWriter(&out)
		// MS-DOS attributes (creator 0) with the directory bit.
		writer, err := archive.CreateHeader(&zip.FileHeader{Name: "word/media/image1.png", Method: zip.Deflate, ExternalAttrs: 0x10})
		if err != nil {
			t.Fatal(err)
		}
		writer.Write([]byte(data))
		if err := archive.Close(); err != nil {
			t.Fatal(err)
		}
		file := bytes.NewReader(out.Bytes())
		reader, err := zip.NewReader(file, file.Size())
		if err != nil || !reader.File[0].FileInfo().IsDir() {
			t.Fatalf("the entry is not marked as a directory: %v", err)
		}
		if got := refusal(t, CheckOffice(file, file.Size(), testCap)); got != code {
			t.Errorf("code = %s, want %s", got, code)
		}
	}
}

// Security regression (Q348, review r2 B2): a package holding two archives,
// whichever comes last, is refused, so no zip reader that falls back to the
// other one finds parts the check never read.
func TestCheckOfficeRefusesAnythingButOneArchive(t *testing.T) {
	emf := make([]byte, 64)
	copy(emf, []byte{1, 0, 0, 0})
	copy(emf[40:], " EMF")
	raw := func(file *bytes.Reader) []byte {
		out := make([]byte, file.Size())
		file.ReadAt(out, 0)
		return out
	}
	clean := raw(officeFile(t, part{"word/document.xml", []byte("<w:document/>")}))
	hidden := raw(officeFile(t, part{"word/media/image1.emf", emf}))
	for name, data := range map[string][]byte{
		"a clean package after another":  append(append([]byte(nil), hidden...), clean...),
		"a clean package before another": append(append([]byte(nil), clean...), hidden...),
		"bytes before the archive":       append([]byte("MZ\x90\x00"), clean...),
	} {
		file := bytes.NewReader(data)
		if got := refusal(t, CheckOffice(file, file.Size(), testCap)); got != "office_unreadable" {
			t.Errorf("%s: code = %s", name, got)
		}
	}
	// The end record's count is the directory's.
	miscounted := append([]byte(nil), clean...)
	end := bytes.LastIndex(miscounted, []byte("PK\x05\x06"))
	binary.LittleEndian.PutUint16(miscounted[end+8:], 2)
	binary.LittleEndian.PutUint16(miscounted[end+10:], 2)
	file := bytes.NewReader(miscounted)
	if got := refusal(t, CheckOffice(file, file.Size(), testCap)); got != "office_unreadable" {
		t.Errorf("a miscounted end record: code = %s", got)
	}
	file = bytes.NewReader(clean)
	if err := CheckOffice(file, file.Size(), testCap); err != nil {
		t.Fatalf("the clean package alone refused: %v", err)
	}
}

// overlappedZip is one deflated picture under two directory records, both
// pointing at its single local header.
func overlappedZip(t *testing.T) *bytes.Reader {
	t.Helper()
	whole := officeFile(t, part{"word/media/image1.png", pngHeader(10, 10)})
	raw := make([]byte, whole.Size())
	whole.ReadAt(raw, 0)
	cd := bytes.Index(raw, []byte("PK\x01\x02"))
	end := bytes.Index(raw, []byte("PK\x05\x06"))
	if cd < 0 || end < 0 {
		t.Fatal("zip records not found")
	}
	record := raw[cd:end]
	second := append([]byte(nil), record...)
	copy(second[46:], "word/media/image2.png")
	eocd := append([]byte(nil), raw[end:]...)
	binary.LittleEndian.PutUint16(eocd[8:], 2)
	binary.LittleEndian.PutUint16(eocd[10:], 2)
	binary.LittleEndian.PutUint32(eocd[12:], uint32(2*len(record)))
	out := append(append(append(append([]byte(nil), raw[:cd]...), record...), second...), eocd...)
	return bytes.NewReader(out)
}

// The shared fixtures the browser and the import worker compress
// (e2e/fixtures/files/images): a 6 MP JPEG is refused as a source, and the
// formats the browser re-saves first are refused as they are.
func TestCheckSourceImageOnTheSharedFixtures(t *testing.T) {
	for name, code := range map[string]string{
		"photo.jpg": "source_image_too_large", "photo.heic": "image_unreadable",
		"photo.jp2": "image_unreadable", "photo.tif": "image_unreadable",
	} {
		data, err := os.ReadFile("../../../e2e/fixtures/files/images/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if got := refusal(t, CheckSourceImage(bytes.NewReader(data))); got != code {
			t.Errorf("%s: code = %s, want %s", name, got, code)
		}
	}
}
