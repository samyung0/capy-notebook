package mail

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/resend/resend-go/v3"
)

type retryAfterError struct {
	err   error
	delay time.Duration
}

func (e *retryAfterError) Error() string             { return e.err.Error() }
func (e *retryAfterError) Unwrap() error             { return e.err }
func (e *retryAfterError) RetryAfter() time.Duration { return e.delay }

type ResendSender struct {
	client  *resend.Client
	from    string
	replyTo string
}

func NewResendSender(apiKey, from, replyTo string) (*ResendSender, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("resend API key is required")
	}
	if strings.TrimSpace(from) == "" {
		return nil, errors.New("email from address is required")
	}
	return &ResendSender{
		client:  resend.NewClient(apiKey),
		from:    from,
		replyTo: replyTo,
	}, nil
}

func (s *ResendSender) Send(ctx context.Context, message Message) (string, error) {
	params := &resend.SendEmailRequest{
		From:    s.from,
		To:      []string{message.To},
		Subject: message.Subject,
		Html:    message.HTML,
		Text:    message.Text,
		Headers: message.Headers,
	}
	if s.replyTo != "" {
		params.ReplyTo = s.replyTo
	}
	response, err := s.client.Emails.SendWithOptions(ctx, params, &resend.SendEmailOptions{
		IdempotencyKey: message.IdempotencyKey,
	})
	if err != nil {
		var rateLimitErr *resend.RateLimitError
		if errors.As(err, &rateLimitErr) {
			if seconds, parseErr := strconv.Atoi(rateLimitErr.RetryAfter); parseErr == nil && seconds > 0 {
				return "", &retryAfterError{
					err:   err,
					delay: time.Duration(seconds) * time.Second,
				}
			}
		}
		return "", err
	}
	if response == nil || response.Id == "" {
		return "", errors.New("resend returned an empty message id")
	}
	return response.Id, nil
}
