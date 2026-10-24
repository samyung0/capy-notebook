package httpapi_test

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"net/http"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
)

// pngSized is a PNG signature and an IHDR claiming width x height: what the
// gateway's header check reads, with no pixels behind it.
func pngSized(width, height uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], width)
	binary.BigEndian.PutUint32(ihdr[4:], height)
	ihdr[8], ihdr[9] = 8, 2
	chunk := append([]byte("IHDR"), ihdr...)
	out := binary.BigEndian.AppendUint32([]byte("\x89PNG\r\n\x1a\n"), 13)
	out = append(out, chunk...)
	return binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(chunk))
}

func docxHolding(t *testing.T, name string, part []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	archive := zip.NewWriter(&out)
	for entry, data := range map[string][]byte{"word/document.xml": []byte("<w:document/>"), name: part} {
		writer, err := archive.Create(entry)
		if err != nil {
			t.Fatal(err)
		}
		writer.Write(data)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// The upload routes run the image header checks (Epo 2026-10-24, Q285,
// Q286) before anything is stored, each refusal final with its code: a source
// image over 5 megapixels, an Office file with a picture past 2,400 px or an
// EMF picture, and an editor image past 2,400 px.
func TestUploadsRefuseImagesPastTheirLimitsFromTheirHeaders(t *testing.T) {
	bucket := blob.NewMemory()
	th := openThumbnailHarnessWith(t, bucket)
	ws := uploadWorkspace(t, th)
	emf := make([]byte, 64)
	copy(emf, []byte{1, 0, 0, 0})
	copy(emf[40:], " EMF")
	const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	for _, tc := range []struct {
		name, contentType string
		body              []byte
		code              string
	}{
		// 2,610 x 1,955 is 5.1 megapixels.
		{"photo.png", "image/png", pngSized(2610, 1955), "source_image_too_large"},
		{"plan.docx", docx, docxHolding(t, "word/media/image1.png", pngSized(2401, 10)), "office_image_too_large"},
		{"visio.docx", docx, docxHolding(t, "word/media/image2.emf", emf), "office_vector_image"},
		// Q344, Q348: other formats are refused by their content.
		{"photo.png", "image/png", []byte("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic"), "image_unreadable"},
		{"logo.docx", docx, docxHolding(t, "word/media/image3.png", []byte("<svg/>")), "office_image_unsupported"},
		{"broken.docx", docx, []byte("PK\x03\x04 not a package"), "office_unreadable"},
	} {
		rec := postUpload(t, th.h, sourceUploads(ws), "u_owner",
			sourceMeta(tc.name, tc.contentType, len(tc.body)), tc.contentType, tc.body)
		expectStatus(t, rec, http.StatusBadRequest, "upload "+tc.name)
		if code := errorCode(t, rec); code != tc.code {
			t.Fatalf("%s refused as %q, want %q", tc.name, code, tc.code)
		}
	}
	if held, keys := leftovers(t, th, bucket, ws); held != 0 || len(keys) != 0 {
		t.Fatalf("refused uploads left %d held sessions and objects %q", held, keys)
	}
	for _, tc := range []struct {
		name, contentType string
		body              []byte
	}{
		{"photo.png", "image/png", pngSized(2500, 2000)},
		{"plan.docx", docx, docxHolding(t, "word/media/image1.png", pngSized(2400, 10))},
	} {
		rec := postUpload(t, th.h, sourceUploads(ws), "u_owner",
			sourceMeta(tc.name, tc.contentType, len(tc.body)), tc.contentType, tc.body)
		expectStatus(t, rec, http.StatusCreated, "upload "+tc.name+" within the limits")
	}

	note := uploadNote(t, th, ws)
	path := "/api/materials/" + note + "/editor-assets/uploads"
	for _, tc := range []struct {
		body   []byte
		status int
	}{
		{pngSized(2401, 100), http.StatusBadRequest},
		{pngSized(2400, 100), http.StatusCreated},
	} {
		meta := map[string]any{"name": "figure.png", "purpose": "image", "sizeBytes": len(tc.body), "contentType": "image/png"}
		rec := postUpload(t, th.h, path, "u_owner", meta, "image/png", tc.body)
		expectStatus(t, rec, tc.status, "an editor image")
		if tc.status == http.StatusBadRequest && errorCode(t, rec) != "image_too_large" {
			t.Fatalf("editor image refused as %q", errorCode(t, rec))
		}
	}
}

// Security regression (Epo 2026-10-24, Q346; review S1): a file name holds no
// control, bidi or path separator character, on upload and rename, and a
// rename keeps the extension its upload checks were chosen by.
func TestFileNamesRefuseUnsafeCharactersAndRenamesKeepTheirExtension(t *testing.T) {
	th := openThumbnailHarnessWith(t, blob.NewMemory())
	ws := uploadWorkspace(t, th)
	pdf := []byte("%PDF-1.7 stand-in")
	for _, name := range []string{"report\u202egnp.pdf", "a/b.pdf", "tab\there.pdf"} {
		rec := postUpload(t, th.h, sourceUploads(ws), "u_owner",
			sourceMeta(name, "application/pdf", len(pdf)), "application/pdf", pdf)
		expectStatus(t, rec, http.StatusUnprocessableEntity, "upload "+name)
		if code := errorCode(t, rec); code != "invalid_name" {
			t.Fatalf("%q refused as %q", name, code)
		}
	}
	rec := postUpload(t, th.h, sourceUploads(ws), "u_owner",
		sourceMeta("deck", "application/octet-stream", len(pdf)), "application/octet-stream", pdf)
	expectStatus(t, rec, http.StatusCreated, "upload a file with no extension")
	var file struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &file); err != nil || file.ID == "" {
		t.Fatalf("upload answered %s", rec.Body.String())
	}
	for name, code := range map[string]string{
		"deck.pptx": "file_extension_changed", "deck\u2066": "invalid_name", "../deck": "invalid_name",
	} {
		rec := doReq(t, th.h, http.MethodPatch, "/api/files/"+file.ID, "u_owner", map[string]any{"name": name})
		expectStatus(t, rec, http.StatusUnprocessableEntity, "rename to "+name)
		if got := errorCode(t, rec); got != code {
			t.Fatalf("rename to %q refused as %q, want %q", name, got, code)
		}
	}
	rec = doReq(t, th.h, http.MethodPatch, "/api/files/"+file.ID, "u_owner", map[string]any{"name": "Deck notes"})
	expectStatus(t, rec, http.StatusOK, "a rename keeping no extension")
}
