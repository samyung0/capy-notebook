// Package pipeline is a thin HTTP client for the Python retrieval/generate
// service. The gateway calls it synchronously for chat and generate; on any
// error the caller falls back to a local placeholder so the app keeps working
// even when the pipeline is down.
package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/evonotes/server/internal/obs"
)

type Client struct {
	base string
	hc   *http.Client
}

func New(base string) *Client {
	return &Client{base: strings.TrimRight(base, "/"), hc: &http.Client{Timeout: 90 * time.Second}}
}

// PostStream posts body as JSON and returns the live response body for the
// caller to stream. The caller MUST Close the returned ReadCloser. Unlike
// PostRaw this uses a client without a read timeout so long token streams aren't
// cut off; cancellation is driven by ctx (the browser disconnecting).
func (c *Client) PostStream(ctx context.Context, path string, body any) (io.ReadCloser, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	obs.Inject(ctx, req)
	res, err := c.streamHC().Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return nil, fmt.Errorf("pipeline %s: %s: %s", path, res.Status, string(body))
	}
	return res.Body, nil
}

// streamHC returns a client with no overall timeout (streaming responses can run
// far longer than the 90s sync budget); the request context governs its life.
func (c *Client) streamHC() *http.Client { return &http.Client{} }

// PostRaw posts body as JSON and returns the raw JSON response.
func (c *Client) PostRaw(ctx context.Context, path string, body any) (json.RawMessage, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	obs.Inject(ctx, req)
	res, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		return nil, fmt.Errorf("pipeline %s: %s", path, res.Status)
	}
	return data, nil
}
