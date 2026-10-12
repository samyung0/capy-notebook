package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const cloudflareAPI = "https://api.cloudflare.com/client/v4"

type retryAfterError struct {
	err   error
	delay time.Duration
}

func (e *retryAfterError) Error() string             { return e.err.Error() }
func (e *retryAfterError) Unwrap() error             { return e.err }
func (e *retryAfterError) RetryAfter() time.Duration { return e.delay }

// CloudflareSender sends through Cloudflare Email Service's REST API. The API
// takes no idempotency key, so a crash between a successful send and the
// outbox marking it sent can deliver that email twice.
type CloudflareSender struct {
	client   *http.Client
	endpoint string
	token    string
	from     string
	replyTo  string
}

func NewCloudflareSender(accountID, token, from, replyTo string) (*CloudflareSender, error) {
	if strings.TrimSpace(accountID) == "" {
		return nil, errors.New("cloudflare account ID is required")
	}
	if strings.TrimSpace(token) == "" {
		return nil, errors.New("cloudflare email token is required")
	}
	if strings.TrimSpace(from) == "" {
		return nil, errors.New("email from address is required")
	}
	return &CloudflareSender{
		client:   &http.Client{},
		endpoint: cloudflareAPI + "/accounts/" + url.PathEscape(accountID) + "/email/sending/send",
		token:    token,
		from:     from,
		replyTo:  replyTo,
	}, nil
}

type cloudflareSendRequest struct {
	From    string            `json:"from"`
	To      []string          `json:"to"`
	ReplyTo string            `json:"reply_to,omitempty"`
	Subject string            `json:"subject"`
	HTML    string            `json:"html,omitempty"`
	Text    string            `json:"text,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

type cloudflareSendResponse struct {
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
	Result struct {
		MessageID            string   `json:"message_id"`
		PermanentBounces     []string `json:"permanent_bounces"`
		SuppressedRecipients []string `json:"suppressed_recipients"`
	} `json:"result"`
}

func (s *CloudflareSender) Send(ctx context.Context, message Message) (string, error) {
	body, err := json.Marshal(cloudflareSendRequest{
		From:    s.from,
		To:      []string{message.To},
		ReplyTo: s.replyTo,
		Subject: message.Subject,
		HTML:    message.HTML,
		Text:    message.Text,
		Headers: message.Headers,
	})
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+s.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	var decoded cloudflareSendResponse
	decodeErr := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&decoded)
	if response.StatusCode >= 300 || !decoded.Success {
		messages := make([]string, 0, len(decoded.Errors))
		for _, e := range decoded.Errors {
			messages = append(messages, fmt.Sprintf("%d %s", e.Code, e.Message))
		}
		err := fmt.Errorf("cloudflare email send: status %d: %s", response.StatusCode, strings.Join(messages, "; "))
		if response.StatusCode == http.StatusTooManyRequests {
			// No documented Retry-After; a minute matches the outbox's own pacing.
			delay := time.Minute
			if seconds, parseErr := strconv.Atoi(response.Header.Get("Retry-After")); parseErr == nil && seconds > 0 {
				delay = time.Duration(seconds) * time.Second
			}
			return "", &retryAfterError{err: err, delay: delay}
		}
		return "", err
	}
	if decodeErr != nil {
		return "", fmt.Errorf("decode cloudflare email response: %w", decodeErr)
	}
	if len(decoded.Result.PermanentBounces) > 0 || len(decoded.Result.SuppressedRecipients) > 0 {
		return "", errors.New("cloudflare email send: recipient bounced or is suppressed")
	}
	if decoded.Result.MessageID == "" {
		return "", errors.New("cloudflare returned an empty message id")
	}
	return decoded.Result.MessageID, nil
}
