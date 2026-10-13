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

	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// Server-side Office thumbnails after agent edits (openwiki/thumbnails.md,
// "Agent captures"): once per finished agent response, the collaboration
// server draws page 1 of each Office file the turn's committed edits may have
// changed, as the browser's capture draws it, and Go stores it like a browser
// capture.

// thumbnailCaptureMaxBytes is the most a capture may hold (the browser
// endpoint's 64 KiB limit).
const thumbnailCaptureMaxBytes = 64 << 10

// The XLSX capture area an edited cell must fall in: about the 800 x 550
// sheet px of the browser capture at default sizes, A1:H25 (Epo 2026-10-11).
const (
	agentThumbnailColumns = 8
	agentThumbnailRows    = 25
)

// AgentThumbnail is one Office file of a finished turn whose page 1 the
// turn's edits may have changed, with what the collaboration server checks
// against the document: the XLSX sheets of the turn's set_cell commands
// inside the capture area, the PPTX stories the edits changed. Any DOCX edit
// counts.
type AgentThumbnail struct {
	FileID  string   `json:"fileId"`
	Format  string   `json:"-"`
	Sheets  []string `json:"sheets"`
	Stories []string `json:"stories"`
}

// TurnThumbnails reads the assistant message's committed edits of Office
// files (refused or failed edits commit nothing) from their stored inverses
// and guards, one entry per file in the order first edited. An XLSX or PPTX
// file without a target, a file trashed since, or one captured within
// ThumbnailCaptureInterval is left out.
func (s *Store) TurnThumbnails(ctx context.Context, messageID string) ([]AgentThumbnail, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT f.id, f.name, f.kind, i.inverse, i.guards
		  FROM agent_operations o
		  JOIN agent_edit_inverses i ON i.operation_id = o.id AND i.resource_kind = 'source_file'
		  JOIN files f ON f.id = i.resource_id AND f.trashed_at IS NULL
		 WHERE o.message_id = $1 AND o.kind = 'edit_document' AND o.outcome = 'succeeded'
		   AND o.effect->>'operation' = 'edited'
		   AND (f.thumbnail_captured_at IS NULL
		        OR f.thumbnail_captured_at <= now() - make_interval(secs => $2))
		 ORDER BY o.created_at, o.id`, messageID, ThumbnailCaptureInterval.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentThumbnail
	index := map[string]int{}
	for rows.Next() {
		var id, name, kind string
		var inverse, guards []byte
		if err := rows.Scan(&id, &name, &kind, &inverse, &guards); err != nil {
			return nil, err
		}
		format := SourceEditFormat(name, kind)
		if format != "docx" && format != "xlsx" && format != "pptx" {
			continue
		}
		sheets, stories, err := pageOneTargets(format, inverse, guards)
		if err != nil {
			return nil, fmt.Errorf("edit of %s: %w", id, err)
		}
		if (format == "xlsx" && len(sheets) == 0) || (format == "pptx" && len(stories) == 0) {
			continue
		}
		at, seen := index[id]
		if !seen {
			at = len(out)
			index[id] = at
			out = append(out, AgentThumbnail{FileID: id, Format: format, Sheets: []string{}, Stories: []string{}})
		}
		out[at].Sheets = appendNew(out[at].Sheets, sheets...)
		out[at].Stories = appendNew(out[at].Stories, stories...)
	}
	return out, rows.Err()
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
// turn's edits may have changed it; nil when they did not.
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
	response, err := s.collaborationHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrAuthorityUnavailable, err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNoContent:
		return nil, nil
	case http.StatusOK:
		// Past the capture limit the caller's check refuses it.
		return io.ReadAll(io.LimitReader(response.Body, thumbnailCaptureMaxBytes+1))
	}
	message, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
	return nil, fmt.Errorf("%w: %s %s", ErrAuthorityUnavailable, response.Status, bytes.TrimSpace(message))
}
