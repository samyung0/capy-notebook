package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Server-side Office thumbnails after agent edits (openwiki/thumbnails.md,
// "Agent captures"; Epo 2026-10-11). Once per finished agent response, after
// the message is final and off the edit and save paths: the collaboration
// server exports each Office file whose page 1 the turn's edits may have
// changed, the parser renders page 1 as an upload's parse does, and the WebP
// is stored like a browser capture. Nothing retries: a failure is logged once
// and the card keeps its image.

// agentThumbnailBudget bounds one turn's captures, run one file after the
// other: an export each, and a LibreOffice conversion on the parser host
// (seconds for a small file, about 30 s for a 24 MB deck).
const agentThumbnailBudget = 5 * time.Minute

// captureTurnThumbnails starts the turn's captures and returns at once.
func (a *api) captureTurnThumbnails(ctx context.Context, messageID string) {
	if a.cfg.ParserURL == "" {
		return
	}
	go func() {
		ctx, cancel := obs.Detach(ctx, agentThumbnailBudget)
		defer cancel()
		a.captureAgentThumbnails(ctx, messageID)
	}()
}

// captureAgentThumbnails captures each file of the turn once.
func (a *api) captureAgentThumbnails(ctx context.Context, messageID string) {
	files, err := a.s.TurnThumbnails(ctx, messageID)
	if err != nil {
		obs.Log(ctx).Warn("agent thumbnail capture failed", "message_id", messageID, "error", err)
		return
	}
	for _, file := range files {
		if err := a.captureAgentThumbnail(ctx, file); err != nil {
			obs.Log(ctx).Warn("agent thumbnail capture failed", "file_id", file.FileID, "format", file.Format, "error", err)
		}
	}
}

func (a *api) captureAgentThumbnail(ctx context.Context, file store.AgentThumbnail) error {
	started := time.Now()
	office, err := a.s.ExportSourceThumbnail(ctx, file)
	if err != nil {
		return fmt.Errorf("export: %w", err)
	}
	if office == nil {
		return nil // page 1 is as it was
	}
	exported := time.Now()
	image, err := a.renderPageThumbnail(ctx, file.Format, office)
	if err != nil {
		return fmt.Errorf("render: %w", err)
	}
	if err := checkThumbnailWebP(image); err != nil {
		return fmt.Errorf("render: %w", err)
	}
	target, err := a.s.ThumbnailTarget(ctx, file.FileID)
	if err != nil {
		return err
	}
	switch err := a.storeThumbnail(ctx, file.FileID, target.Key, image); {
	case errors.Is(err, store.ErrThumbnailTooSoon):
		// A browser captured the file meanwhile; its capture stands.
		return nil
	case err != nil:
		return err
	}
	obs.Log(ctx).Info("agent thumbnail captured", "file_id", file.FileID, "format", file.Format,
		"export_ms", exported.Sub(started).Milliseconds(), "render_ms", time.Since(exported).Milliseconds(),
		"office_bytes", len(office), "bytes", len(image))
	return nil
}

// renderPageThumbnail posts the Office bytes to the parser's /page_thumbnail
// (the host and token chat's Office captures use), which converts them and
// renders page 1 in its bounded parse child: 200 px wide, cut at 400, WebP.
func (a *api) renderPageThumbnail(ctx context.Context, format string, office []byte) ([]byte, error) {
	endpoint, err := url.Parse(a.cfg.ParserURL)
	if err != nil {
		return nil, err
	}
	endpoint = &url.URL{Scheme: endpoint.Scheme, Host: endpoint.Host, Path: "/page_thumbnail"}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	name := "source." + format
	part, err := form.CreateFormFile("file", name)
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(office); err != nil {
		return nil, err
	}
	if err := form.WriteField("filename", name); err != nil {
		return nil, err
	}
	if err := form.Close(); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	if a.cfg.ParserToken != "" {
		req.Header.Set("Authorization", "Bearer "+a.cfg.ParserToken)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	image, err := io.ReadAll(io.LimitReader(response.Body, thumbnailMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the parser answered %s: %s", response.Status, bytes.TrimSpace(image))
	}
	if len(image) > thumbnailMaxBytes {
		return nil, errors.New("the page image exceeds the thumbnail limit")
	}
	return image, nil
}
