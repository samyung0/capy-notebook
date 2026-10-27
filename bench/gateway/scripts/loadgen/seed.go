package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Files, embeds, trash and review history, added the way the browser adds
// them: uploads through the gateway's ticketed line (src/api/uploadTurn.ts),
// Office thumbnails as the editors capture them, images through a note's
// editor, deletes into the trash and finished review sessions. PDF thumbnails
// come from ingest, which the bench does not run: thumbs.sql sets them as the
// ingest worker does.

type fixtures struct{ pdf, docx, webp, png []byte }

func loadFixtures() fixtures {
	read := func(name string) []byte {
		raw, err := os.ReadFile(filepath.Join("/fixtures", name))
		if err != nil {
			log.Fatal(err)
		}
		return raw
	}
	return fixtures{read("lecture.pdf"), read("report.docx"), read("thumbnail.webp"), read("figure.png")}
}

// isHeavy marks one user in a hundred as the kind who fills the lists past
// several pages.
func isHeavy(i int) bool { return i%100 == 0 }

type ticketTurn struct {
	Position int    `json:"position"`
	TicketID string `json:"ticketId"`
}

// upload sends one file: a ticket carrying its metadata, a wait while the
// ticket is in line, then the multipart upload with the metadata part first.
func (u *user) upload(ctx context.Context, base, label string, metadata map[string]any, name, contentType string, data []byte, out any) error {
	var turn ticketTurn
	if err := u.call(ctx, http.MethodPost, base+"/tickets", label+"/tickets", metadata, &turn, http.StatusOK, http.StatusCreated); err != nil {
		return err
	}
	for turn.Position > 0 {
		path := "/api/uploads/tickets/" + url.PathEscape(turn.TicketID) + "?position=" + strconv.Itoa(turn.Position)
		if err := u.call(ctx, http.MethodGet, path, "/api/uploads/tickets/{id}", nil, &turn); err != nil {
			return err
		}
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	meta, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	if err := form.WriteField("metadata", string(meta)); err != nil {
		return err
	}
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, name))
	header.Set("Content-Type", contentType)
	part, err := form.CreatePart(header)
	if err != nil {
		return err
	}
	if _, err := part.Write(data); err != nil {
		return err
	}
	if err := form.Close(); err != nil {
		return err
	}
	return u.callRaw(ctx, http.MethodPost, base+"?ticket="+url.QueryEscape(turn.TicketID), label,
		form.FormDataContentType(), body.Bytes(), out, http.StatusOK, http.StatusCreated)
}

type source struct {
	name, kind, contentType string
	data                    []byte
	office                  bool
}

// source n is a PDF, or every third one a DOCX.
func (f fixtures) source(n int) source {
	if n%3 == 2 {
		return source{fmt.Sprintf("Handout %03d.docx", n), "doc",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document", f.docx, true}
	}
	return source{fmt.Sprintf("Lecture %03d.pdf", n), "pdf", "application/pdf", f.pdf, false}
}

// addSources uploads count store-only files numbered from first, in
// submissions of at most 20 (the plan's files per upload), and captures each
// Office file's thumbnail as its editor would.
func (u *user) addSources(ctx context.Context, f fixtures, ws string, first, count int) error {
	for start := 0; start < count; start += 20 {
		n := min(20, count-start)
		batch := randomID()
		for k := range n {
			src := f.source(first + start + k)
			meta := map[string]any{
				"batchId": batch, "batchTotal": n, "chapterId": nil, "chapterName": nil,
				"contentType": src.contentType, "kind": src.kind, "name": src.name,
				"parseMode": "none", "sizeBytes": len(src.data),
			}
			var file struct {
				ID string `json:"id"`
			}
			if err := u.upload(ctx, "/api/workspaces/"+ws+"/sources/uploads", "/api/workspaces/{id}/sources/uploads",
				meta, src.name, src.contentType, src.data, &file); err != nil {
				return err
			}
			if src.office {
				if err := u.callRaw(ctx, http.MethodPost, "/api/files/"+file.ID+"/thumbnail", "/api/files/{id}/thumbnail",
					"image/webp", f.webp, nil, http.StatusNoContent); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (u *user) workspaceIDs(ctx context.Context) ([]string, error) {
	var list []struct {
		ID string `json:"id"`
	}
	if err := u.call(ctx, http.MethodGet, workspaceList, "/api/workspaces", nil, &list); err != nil {
		return nil, err
	}
	ids := make([]string, len(list))
	for i, w := range list {
		ids[i] = w.ID
	}
	return ids, nil
}

type workspaceFile struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

func (u *user) workspaceFiles(ctx context.Context, ws string) ([]workspaceFile, error) {
	var files []workspaceFile
	err := u.call(ctx, http.MethodGet, "/api/workspaces/"+ws+"/files", "/api/workspaces/{id}/files", nil, &files)
	return files, err
}

func (u *user) workspaceMaterials(ctx context.Context, ws string) ([]material, error) {
	var items []material
	err := u.call(ctx, http.MethodGet, "/api/workspaces/"+ws+"/materials", "/api/workspaces/{id}/materials", nil, &items)
	return items, err
}

// seedFiles gives every user three files in each workspace, and a heavy user
// the rest of seedHeavy.
func (u *user) seedFiles(ctx context.Context, f fixtures, heavy bool) error {
	spaces, err := u.workspaceIDs(ctx)
	if err != nil {
		return err
	}
	for _, ws := range spaces {
		if err := u.addSources(ctx, f, ws, 0, 3); err != nil {
			return err
		}
	}
	if heavy {
		return u.seedHeavy(ctx, f)
	}
	return nil
}

// seedHeavy fills a user's lists past several pages within the Free plan's
// caps: seven workspaces of 100 files and 50 more notes each, 150 quiz
// attempts, 40 finished review sessions, 150 images in one note, and 60 files
// and 60 notes in the trash.
func (u *user) seedHeavy(ctx context.Context, f fixtures) error {
	for i := range 5 {
		if err := u.call(ctx, http.MethodPost, "/api/workspaces", "/api/workspaces",
			map[string]string{"name": fmt.Sprintf("Course %d", i+1)}, nil, http.StatusCreated); err != nil {
			return err
		}
	}
	spaces, err := u.workspaceIDs(ctx)
	if err != nil {
		return err
	}
	for _, ws := range spaces {
		files, err := u.workspaceFiles(ctx, ws)
		if err != nil {
			return err
		}
		if err := u.addSources(ctx, f, ws, len(files), 100-len(files)); err != nil {
			return err
		}
		for k := range 50 {
			if err := u.call(ctx, http.MethodPost, "/api/workspaces/"+ws+"/materials", "/api/workspaces/{id}/materials",
				noteBody(fmt.Sprintf("Week %02d %s", k+1, randomID()[:6])), nil, http.StatusCreated); err != nil {
				return err
			}
		}
	}
	return u.seedHistory(ctx, f)
}

// seedHistory tops a heavy user's history up to its seeded size: 150 quiz
// attempts, 150 images in one note, 40 finished review sessions, and 60 files
// and 60 notes of the last workspace in the trash. It counts what is there
// first, so a run that stopped part way can be repeated.
func (u *user) seedHistory(ctx context.Context, f fixtures) error {
	spaces, err := u.workspaceIDs(ctx)
	if err != nil {
		return err
	}
	var quizID, noteID string
	var decks []string
	for _, ws := range spaces {
		all, err := u.workspaceMaterials(ctx, ws)
		if err != nil {
			return err
		}
		for _, m := range all {
			switch {
			case m.Kind == "quiz" && quizID == "":
				quizID = m.ID
			case m.Kind == "note" && noteID == "":
				noteID = m.ID
			case m.Kind == "flashcards":
				decks = append(decks, ws)
			}
		}
	}
	attempts, err := u.countOffset(ctx, "/api/attempts")
	if err != nil {
		return err
	}
	if quizID != "" && attempts < 150 {
		var quiz quizBody
		if err := u.call(ctx, http.MethodGet, "/api/quizzes/"+quizID, "/api/quizzes/{id}", nil, &quiz); err != nil {
			return err
		}
		for range 150 - attempts {
			if err := quiz.check(ctx, u, quizID, time.Now().UTC(), nil); err != nil {
				return err
			}
		}
	}
	var embeds struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := u.call(ctx, http.MethodGet, "/api/editor-assets?limit=100", "/api/editor-assets", nil, &embeds); err != nil {
		return err
	}
	if len(embeds.Items) == 0 {
		for k := range 150 {
			name := fmt.Sprintf("figure-%03d.png", k)
			meta := map[string]any{"contentType": "image/png", "name": name, "purpose": "image", "sizeBytes": len(f.png)}
			if err := u.upload(ctx, "/api/materials/"+noteID+"/editor-assets/uploads", "/api/materials/{id}/editor-assets/uploads",
				meta, name, "image/png", f.png, nil); err != nil {
				return err
			}
		}
	}
	reviews, err := u.countOffset(ctx, "/api/review/sessions")
	if err != nil {
		return err
	}
	for k := range max(0, 40-reviews) {
		if err := u.finishReview(ctx, decks[k%len(decks)]); err != nil {
			return err
		}
	}
	var trash struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := u.call(ctx, http.MethodGet, "/api/trash", "/api/trash", nil, &trash); err != nil {
		return err
	}
	if len(trash.Items) > 0 {
		return nil
	}
	last := spaces[len(spaces)-1]
	files, err := u.workspaceFiles(ctx, last)
	if err != nil {
		return err
	}
	for _, file := range files[:min(60, len(files))] {
		if err := u.call(ctx, http.MethodDelete, "/api/files/"+file.ID, "/api/files/{id}", nil, nil, http.StatusNoContent); err != nil {
			return err
		}
	}
	items, err := u.workspaceMaterials(ctx, last)
	if err != nil {
		return err
	}
	trashed := 0
	for _, m := range items {
		if m.Kind != "note" || trashed == 60 {
			continue
		}
		if err := u.call(ctx, http.MethodDelete, "/api/materials/"+m.ID, "/api/materials/{id}", nil, nil, http.StatusNoContent); err != nil {
			return err
		}
		trashed++
	}
	return nil
}

// countOffset counts the rows of one of Learning's offset-paged lists.
func (u *user) countOffset(ctx context.Context, path string) (int, error) {
	total := 0
	for {
		var page struct {
			Items []json.RawMessage `json:"items"`
			More  bool              `json:"more"`
		}
		if err := u.call(ctx, http.MethodGet, path+"?limit=100&offset="+strconv.Itoa(total), path, nil, &page); err != nil {
			return 0, err
		}
		total += len(page.Items)
		if !page.More {
			return total, nil
		}
	}
}

// finishReview runs one review session of the workspace as Learning does
// (src/routes/ReviewSession.tsx): the batch the gateway hands out, answers to
// up to five of its items under the browser's session reference (a rating
// per card, a graded check per question), then finish.
func (u *user) finishReview(ctx context.Context, ws string) error {
	var session struct {
		ChapterID string          `json:"chapterId"`
		Evidence  json.RawMessage `json:"evidence"`
		Group     string          `json:"group"`
		Mode      string          `json:"mode"`
		Items     []struct {
			ItemID     string `json:"itemId"`
			MaterialID string `json:"materialId"`
			Kind       string `json:"kind"`
			Question   struct {
				Parts []struct {
					ID string `json:"id"`
				} `json:"parts"`
			} `json:"question"`
		} `json:"items"`
	}
	if err := u.call(ctx, http.MethodGet, "/api/workspaces/"+ws+"/review?group=workspace", "/api/workspaces/{id}/review", nil, &session); err != nil {
		return err
	}
	if len(session.Items) == 0 {
		return fmt.Errorf("review of %s handed out nothing", ws)
	}
	refItems := make([]map[string]string, len(session.Items))
	for i, it := range session.Items {
		refItems[i] = map[string]string{"itemId": it.ItemID, "materialId": it.MaterialID}
	}
	ref := map[string]any{"id": randomID(), "group": session.Group, "items": refItems, "workspaceId": ws}
	if session.Mode != "" {
		ref["mode"] = session.Mode
	}
	if session.ChapterID != "" {
		ref["chapterId"] = session.ChapterID
	}
	if len(session.Evidence) > 0 && string(session.Evidence) != "null" {
		ref["evidence"] = session.Evidence
	}
	for _, it := range session.Items[:min(5, len(session.Items))] {
		if it.Kind == "card" {
			if err := u.call(ctx, http.MethodPost, "/api/review/ratings", "/api/review/ratings", map[string]any{
				"itemId": it.ItemID, "materialId": it.MaterialID, "rating": 1 + u.rng.IntN(4), "session": ref,
			}, nil, http.StatusNoContent); err != nil {
				return err
			}
			continue
		}
		answers := map[string]any{}
		for _, part := range it.Question.Parts {
			answers[part.ID] = u.rng.IntN(2) == 0
		}
		if err := u.call(ctx, http.MethodPost, "/api/review/check", "/api/review/check", map[string]any{
			"answers": answers, "itemId": it.ItemID, "materialId": it.MaterialID, "session": ref,
		}, nil); err != nil {
			return err
		}
	}
	return u.call(ctx, http.MethodPost, "/api/review/sessions/"+ref["id"].(string)+"/finish", "/api/review/sessions/{id}/finish", nil, nil, http.StatusNoContent)
}
