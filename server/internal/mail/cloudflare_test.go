package mail

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testSender(t *testing.T, handler http.HandlerFunc) *CloudflareSender {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	sender, err := NewCloudflareSender("account", "token", "Capy <notifications@uat.capynotebook.com>", "support@stablestudio.org")
	if err != nil {
		t.Fatal(err)
	}
	sender.endpoint = server.URL
	return sender
}

func TestCloudflareSenderSendsMessage(t *testing.T) {
	var got cloudflareSendRequest
	sender := testSender(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"success":true,"errors":[],"result":{"message_id":"cf-1","delivered":["a@example.com"],"queued":[],"permanent_bounces":[]}}`))
	})
	id, err := sender.Send(context.Background(), Message{
		To:      "a@example.com",
		Subject: "Hello",
		HTML:    "<p>Hi</p>",
		Text:    "Hi",
		Headers: map[string]string{"List-Unsubscribe": "<https://example.com/u>"},
	})
	if err != nil || id != "cf-1" {
		t.Fatalf("id=%q err=%v", id, err)
	}
	// Reply-To travels as reply_to: Cloudflare rejects the whole request when
	// it appears among the custom headers.
	if got.ReplyTo != "support@stablestudio.org" || got.Headers["Reply-To"] != "" {
		t.Fatalf("reply-to = %q, headers = %v", got.ReplyTo, got.Headers)
	}
	if len(got.To) != 1 || got.To[0] != "a@example.com" || got.From != "Capy <notifications@uat.capynotebook.com>" {
		t.Fatalf("request = %+v", got)
	}
}

func TestCloudflareSenderThrottleCarriesRetryDelay(t *testing.T) {
	sender := testSender(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":10004,"message":"email.sending.error.throttled"}]}`))
	})
	_, err := sender.Send(context.Background(), Message{To: "a@example.com", Subject: "s", Text: "t"})
	var retryable interface{ RetryAfter() time.Duration }
	if !errors.As(err, &retryable) || retryable.RetryAfter() != 7*time.Second {
		t.Fatalf("err = %v", err)
	}
}

func TestCloudflareSenderFailsOnBounceOrRejection(t *testing.T) {
	for name, body := range map[string]string{
		"rejected": `{"success":false,"errors":[{"code":10001,"message":"invalid request"}]}`,
		"bounced":  `{"success":true,"errors":[],"result":{"message_id":"cf-2","permanent_bounces":["a@example.com"]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			sender := testSender(t, func(w http.ResponseWriter, _ *http.Request) {
				if name == "rejected" {
					w.WriteHeader(http.StatusBadRequest)
				}
				_, _ = w.Write([]byte(body))
			})
			if _, err := sender.Send(context.Background(), Message{To: "a@example.com", Subject: "s", Text: "t"}); err == nil {
				t.Fatal("send succeeded")
			}
		})
	}
}
