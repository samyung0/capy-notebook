package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// Server-side Office thumbnails after agent edits (openwiki/thumbnails.md,
// "Agent captures"): once per finished agent response, and after a chat
// card's Undo of a source edit, the collaboration server draws page 1 of each
// Office file the edits may have changed, as the browser's capture draws it,
// and Go stores it like a browser capture.

// sourceThumbnailTimeout bounds one capture call: longer than the
// collaboration server's own capture timeout (75 s, its one capture slot and
// the render lane's 60 s call timeout included), so that server answers first.
const sourceThumbnailTimeout = 90 * time.Second

// The XLSX capture area an edited cell must fall in: about the 800 x 550
// sheet px of the browser capture at default sizes, A1:H25 (Epo 2026-10-11).
const (
	agentThumbnailColumns = 8
	agentThumbnailRows    = 25
)

// AgentThumbnail is one Office file whose page 1 committed edits may have
// changed, with what the collaboration server checks against the document:
// the XLSX sheets of the edits' set_cell commands inside the capture area,
// the PPTX stories the edits changed. Any DOCX edit counts.
type AgentThumbnail struct {
	FileID  string   `json:"fileId"`
	Format  string   `json:"-"`
	Sheets  []string `json:"sheets"`
	Stories []string `json:"stories"`
	// Unknown: an edit's targets could not be read (an Undo, a rebase after
	// publication, a compaction or a trash emptied its inverse, or it does
	// not parse), so page 1 counts as changed. Why names the first such edit.
	Unknown bool   `json:"unknown"`
	Why     string `json:"-"`
	// Ready is when the file's capture interval has passed, on this
	// process's clock: a capture claimed before the edits were read is older
	// than they are, and the agent's capture waits it out.
	Ready time.Time `json:"-"`
}

// thumbnailReadyIn is the seconds until a file's capture interval passes
// (negative once it has).
const thumbnailReadyIn = `COALESCE(EXTRACT(EPOCH FROM f.thumbnail_captured_at
	+ make_interval(secs => $2) - now()), 0)::float8`

// TurnThumbnails reads the assistant message's committed edits of Office
// files (refused or failed edits commit nothing) from their stored inverses
// and guards, one entry per file in the order first edited. An XLSX or PPTX
// file without a target and a file trashed since are left out.
func (s *Store) TurnThumbnails(ctx context.Context, messageID string) ([]AgentThumbnail, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT f.id, f.name, f.kind, i.undo_status, i.inverse, i.guards, `+thumbnailReadyIn+`
		  FROM agent_operations o
		  JOIN agent_edit_inverses i ON i.operation_id = o.id AND i.resource_kind = 'source_file'
		  JOIN files f ON f.id = i.resource_id AND f.trashed_at IS NULL
		 WHERE o.message_id = $1 AND o.kind = 'edit_document' AND o.outcome = 'succeeded'
		   AND o.effect->>'operation' = 'edited'
		 ORDER BY o.created_at, o.id`, messageID, ThumbnailCaptureInterval.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	read := time.Now()
	var out []AgentThumbnail
	index := map[string]int{}
	for rows.Next() {
		var id, name, kind, status string
		var inverse, guards []byte
		var readyIn float64
		if err := rows.Scan(&id, &name, &kind, &status, &inverse, &guards, &readyIn); err != nil {
			return nil, err
		}
		t, ok := editThumbnail(id, name, kind, status, inverse, guards)
		if !ok {
			continue
		}
		at, seen := index[id]
		if !seen {
			t.Ready = read.Add(time.Duration(readyIn * float64(time.Second)))
			index[id] = len(out)
			out = append(out, t)
			continue
		}
		file := &out[at]
		file.Sheets = appendNew(file.Sheets, t.Sheets...)
		file.Stories = appendNew(file.Stories, t.Stories...)
		if t.Unknown && !file.Unknown {
			file.Unknown, file.Why = true, t.Why
		}
	}
	return out, rows.Err()
}

// UndoThumbnails is the capture a chat card's Undo of a source edit asks for
// (Epo 2026-10-13): the Undo applies the edit's inverse, so it changes back
// the cells and stories the edit changed, and the edit's inverse and guards,
// read before the Undo released them, are its targets. Nothing when the edit
// cannot change page 1 or the file is trashed.
func (s *Store) UndoThumbnails(ctx context.Context, inv EditInverse) ([]AgentThumbnail, error) {
	var name, kind string
	var readyIn float64
	err := s.pool.QueryRow(ctx, `SELECT f.name, f.kind, `+thumbnailReadyIn+`
		FROM files f WHERE f.id=$1 AND f.trashed_at IS NULL`,
		inv.ResourceID, ThumbnailCaptureInterval.Seconds()).Scan(&name, &kind, &readyIn)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t, ok := editThumbnail(inv.ResourceID, name, kind, string(inv.UndoStatus), inv.Inverse, inv.Guards)
	if !ok {
		return nil, nil
	}
	t.Ready = time.Now().Add(time.Duration(readyIn * float64(time.Second)))
	return []AgentThumbnail{t}, nil
}

// editThumbnail reads one committed edit of a file: false when the file is
// not Office or the edit cannot change page 1 (an XLSX edit outside the
// area, a PPTX one without a story).
func editThumbnail(fileID, name, kind, undoStatus string, inverse, guards []byte) (AgentThumbnail, bool) {
	t := AgentThumbnail{FileID: fileID, Format: SourceEditFormat(name, kind), Sheets: []string{}, Stories: []string{}}
	switch t.Format {
	case "docx":
		return t, true
	case "xlsx", "pptx":
	default:
		return t, false
	}
	if undoStatus != "available" {
		t.Unknown, t.Why = true, "the edit's inverse was released ("+undoStatus+")"
		return t, true
	}
	sheets, stories, err := pageOneTargets(t.Format, inverse, guards)
	if err != nil {
		t.Unknown, t.Why = true, "the edit's inverse does not parse: "+err.Error()
		return t, true
	}
	t.Sheets = appendNew(t.Sheets, sheets...)
	t.Stories = appendNew(t.Stories, stories...)
	return t, len(t.Sheets)+len(t.Stories) > 0
}

// pageOneTargets reads one edit's stored inverse and guards (the
// collaboration server's office_service commands and guard targets): an
// XLSX set_cell names its sheet and address, a PPTX guard the story it
// covers.
func pageOneTargets(format string, inverse, guards []byte) (sheets, stories []string, err error) {
	switch format {
	case "xlsx":
		var payload struct {
			Commands []struct {
				Type  string `json:"type"`
				Sheet string `json:"sheet"`
				Cell  string `json:"cell"`
			} `json:"commands"`
		}
		if err := json.Unmarshal(inverse, &payload); err != nil {
			return nil, nil, err
		}
		for _, c := range payload.Commands {
			if c.Type == "set_cell" && inThumbnailArea(c.Cell) {
				sheets = append(sheets, c.Sheet)
			}
		}
	case "pptx":
		var targets []struct {
			Kind string   `json:"kind"`
			Path []string `json:"path"`
		}
		if err := json.Unmarshal(guards, &targets); err != nil {
			return nil, nil, err
		}
		for _, t := range targets {
			if t.Kind == "office" && len(t.Path) == 2 && t.Path[0] == "pptx:stories" {
				stories = append(stories, t.Path[1])
			}
		}
	}
	return sheets, stories, nil
}

// inThumbnailArea reports whether an A1 address (as the engine normalizes
// it) lies within the XLSX capture area.
func inThumbnailArea(cell string) bool {
	cell = strings.ToUpper(cell)
	if len(cell) < 2 || cell[0] < 'A' || cell[0] >= 'A'+agentThumbnailColumns {
		return false
	}
	row, err := strconv.Atoi(cell[1:])
	return err == nil && row >= 1 && row <= agentThumbnailRows
}

func appendNew(list []string, values ...string) []string {
	for _, v := range values {
		found := false
		for _, have := range list {
			found = found || have == v
		}
		if !found {
			list = append(list, v)
		}
	}
	return list
}

// CaptureSourceThumbnail asks the collaboration server for the file's page 1
// as a list-card WebP, drawn as the browser's capture draws it, when the
// edits may have changed it; nil when they did not.
func (s *Store) CaptureSourceThumbnail(ctx context.Context, t AgentThumbnail) ([]byte, error) {
	if s.collaborationURL == "" || s.collaborationSecret == "" {
		return nil, ErrAuthorityUnavailable
	}
	raw, err := json.Marshal(t)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.collaborationURL+"/internal/source-thumbnails/capture", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	obs.Inject(ctx, req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Collaboration-Secret", s.collaborationSecret)
	client := *s.collaborationHTTP
	client.Timeout = sourceThumbnailTimeout
	response, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrAuthorityUnavailable, err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNoContent:
		return nil, nil
	case http.StatusOK:
		image, err := io.ReadAll(io.LimitReader(response.Body, ThumbnailMaxBytes+1))
		if err != nil {
			return nil, err
		}
		if len(image) > ThumbnailMaxBytes {
			return nil, fmt.Errorf("the capture is larger than %d bytes", ThumbnailMaxBytes)
		}
		return image, nil
	}
	message, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
	return nil, fmt.Errorf("%w: %s %s", ErrAuthorityUnavailable, response.Status, bytes.TrimSpace(message))
}
