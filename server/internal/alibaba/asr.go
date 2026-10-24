// Package alibaba transcribes chat voice input with Alibaba Model Studio's
// synchronous qwen-audio-3.1-asr-flash in the Singapore workspace
// (human/agentic-retrieval.md 2026-10-23). Uploaded audio goes through the
// ingest worker's Filetrans client instead. Errors carry HTTP statuses and
// provider codes only, never audio, transcript text or the key.
package alibaba

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	Model = "qwen-audio-3.1-asr-flash"
	path  = "/api/v1/services/aigc/multimodal-generation/generation"
	// basePath ends the workspace's OpenAI-compatible URL; the native API is
	// the same host without it.
	basePath = "/compatible-mode/v1"
	// A two-minute clip answers in seconds; this only bounds a stuck call.
	requestTimeout = 60 * time.Second
	// A transcript of the sync model's five-minute input cap fits easily.
	responseMaxBytes = 1 << 20
)

// ErrNotConfigured is the nil client New returns when neither setting is set.
var ErrNotConfigured = errors.New("voice transcription is not configured")

// ErrBusy is Alibaba's 429 (Throttling.*). Nothing retries it.
var ErrBusy = errors.New("voice transcription is busy")

// Error is a refused or unreadable answer, named by its HTTP status and the
// provider's error code.
type Error struct {
	Status int
	Code   string
}

func (e *Error) Error() string {
	return fmt.Sprintf("alibaba asr: status %d %s", e.Status, e.Code)
}

func (e *Error) Is(target error) bool {
	return target == ErrBusy && e.Status == http.StatusTooManyRequests
}

type Client struct {
	key      string
	endpoint string
	http     *http.Client
}

// New returns nil when neither is set: voice input then answers "not
// configured". Only one of them, or a url that is not the workspace's
// .../compatible-mode/v1 URL, is an error the API refuses to start on (the
// pipeline's rule for the same settings).
func New(key, url string) (*Client, error) {
	if key == "" && url == "" {
		return nil, nil
	}
	if key == "" || url == "" {
		return nil, errors.New("ALIBABA_MODELSTUDIO_KEY and ALIBABA_MODELSTUDIO_URL must be set together")
	}
	if !strings.HasSuffix(url, basePath) {
		return nil, fmt.Errorf("ALIBABA_MODELSTUDIO_URL must end with %s", basePath)
	}
	endpoint := strings.TrimSuffix(url, basePath) + path
	return &Client{key: key, endpoint: endpoint, http: &http.Client{Timeout: requestTimeout}}, nil
}

// Transcript is one clip's text. EndMs is where the recognised span ends,
// in milliseconds from the clip's start; the text covers the whole clip.
type Transcript struct {
	Text         string
	EndMs        int64
	InputTokens  int64
	OutputTokens int64
}

type content struct {
	Type       string            `json:"type"`
	Text       string            `json:"text,omitempty"`
	InputAudio map[string]string `json:"input_audio,omitempty"`
}

type message struct {
	Role    string    `json:"role"`
	Content []content `json:"content"`
}

type answer struct {
	Sentence *struct {
		Text    string `json:"text"`
		EndTime int64  `json:"end_time"`
	} `json:"sentence"`
	Usage struct {
		InputTokens  int64 `json:"input_tokens"`
		OutputTokens int64 `json:"output_tokens"`
	} `json:"usage"`
	Code string `json:"code"`
}

// Transcribe sends one clip with keep_dialect (Cantonese stays as spoken)
// and contextText, a message ahead of the audio that helps the model spell
// course vocabulary. format names the container for Alibaba (webm, ogg,
// mp4) and mediaType goes in the data URI.
func (c *Client) Transcribe(ctx context.Context, audio []byte, format, mediaType, contextText string) (Transcript, error) {
	if c == nil {
		return Transcript{}, ErrNotConfigured
	}
	messages := []message{}
	if contextText != "" {
		messages = append(messages, message{Role: "user", Content: []content{{Type: "input_text", Text: contextText}}})
	}
	messages = append(messages, message{Role: "user", Content: []content{{
		Type:       "input_audio",
		InputAudio: map[string]string{"data": "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(audio)},
	}}})
	body, err := json.Marshal(map[string]any{
		"model": Model,
		"input": map[string]any{"messages": messages},
		// "16000" worked for 48 kHz Opus too (measured 2026-10-23).
		"parameters": map[string]any{"format": format, "sample_rate": "16000", "keep_dialect": true},
	})
	if err != nil {
		return Transcript{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return Transcript{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-DashScope-SSE", "disable")
	res, err := c.http.Do(req)
	if err != nil {
		// The transport's error names the URL, never the body or the key.
		return Transcript{}, fmt.Errorf("alibaba asr: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, responseMaxBytes))
	if err != nil {
		return Transcript{}, fmt.Errorf("alibaba asr: read: %w", err)
	}
	var out answer
	decodeErr := json.Unmarshal(raw, &out)
	if res.StatusCode != http.StatusOK {
		return Transcript{}, &Error{Status: res.StatusCode, Code: providerCode(out.Code)}
	}
	// Text without where it ends has no length to cap or charge.
	if decodeErr != nil || out.Sentence == nil ||
		strings.TrimSpace(out.Sentence.Text) != "" && out.Sentence.EndTime <= 0 {
		return Transcript{}, &Error{Status: res.StatusCode, Code: "invalid_response"}
	}
	return Transcript{
		Text:         out.Sentence.Text,
		EndMs:        out.Sentence.EndTime,
		InputTokens:  out.Usage.InputTokens,
		OutputTokens: out.Usage.OutputTokens,
	}, nil
}

// providerCode keeps an error code to its own shape (Throttling.RateQuota),
// so nothing else from a body reaches a log line.
func providerCode(code string) string {
	if len(code) > 80 || strings.ContainsFunc(code, func(r rune) bool {
		return !(r == '.' || r == '_' || r == '-' || r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z')
	}) {
		return "unknown"
	}
	return code
}
