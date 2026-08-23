// Package pipeline is a thin HTTP client for the Python retrieval/generate
// service. The gateway calls it synchronously for chat and generate. A failed
// handshake is returned to the caller; it must not invent a local answer.
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

const SecretHeader = "X-Pipeline-Secret"

type Client struct {
	base   string
	secret string
	hc     *http.Client
}

func New(base, secret string) *Client {
	return &Client{
		base:   strings.TrimRight(base, "/"),
		secret: secret,
		hc:     &http.Client{Timeout: 90 * time.Second},
	}
}

// Error is a non-2xx pipeline response. Body is the raw JSON, if any.
type Error struct {
	Path   string
	Status int
	Body   []byte
}

func (e *Error) Error() string {
	if e == nil {
		return "pipeline error"
	}
	return fmt.Sprintf("pipeline %s: %s", e.Path, http.StatusText(e.Status))
}

type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Decode() ErrorBody {
	if e == nil || len(e.Body) == 0 {
		return ErrorBody{}
	}
	var raw map[string]any
	if json.Unmarshal(e.Body, &raw) != nil {
		return ErrorBody{}
	}
	if body := errorBodyFrom(raw); body.Code != "" {
		return body
	}
	if detail, ok := raw["detail"].(map[string]any); ok {
		return errorBodyFrom(detail)
	}
	return ErrorBody{}
}

func errorBodyFrom(raw map[string]any) ErrorBody {
	code, _ := raw["code"].(string)
	message, _ := raw["message"].(string)
	return ErrorBody{Code: code, Message: message}
}

func (c *Client) applyHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	if c.secret != "" {
		req.Header.Set(SecretHeader, c.secret)
	}
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
	c.applyHeaders(req)
	req.Header.Set("Accept", "text/event-stream")
	obs.Inject(ctx, req)
	res, err := c.streamHC().Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return nil, &Error{Path: path, Status: res.StatusCode, Body: body}
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
	c.applyHeaders(req)
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
		return nil, &Error{Path: path, Status: res.StatusCode, Body: data}
	}
	return data, nil
}
