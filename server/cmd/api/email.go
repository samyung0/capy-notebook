package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/evonotes/server/internal/mail"
	"github.com/evonotes/server/internal/store"
)

func newEmailSender(appEnv, backend, apiKey, from, replyTo string) (mail.Sender, error) {
	if backend == "" {
		if apiKey == "" {
			backend = "log"
		} else {
			backend = "resend"
		}
	}
	switch backend {
	case "log":
		if appEnv == "production" {
			return nil, errors.New("EMAIL_BACKEND=log is not allowed when APP_ENV=production")
		}
		return &mail.LogSender{}, nil
	case "resend":
		if appEnv == "e2e" {
			return nil, errors.New("EMAIL_BACKEND=resend is not allowed when APP_ENV=e2e")
		}
		return mail.NewResendSender(apiKey, from, replyTo)
	default:
		return nil, fmt.Errorf("unknown EMAIL_BACKEND %q", backend)
	}
}

func runEmailDispatcher(
	ctx context.Context,
	st *store.Store,
	sender mail.Sender,
	appURL,
	unsubscribeSecret string,
) {
	for {
		lock, acquired, err := st.TryAcquireEmailDispatcherLock(ctx)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("acquire email dispatcher leadership: %v", err)
			}
		} else if acquired {
			runEmailDispatcherLeader(ctx, st, lock, sender, appURL, unsubscribeSecret)
			if err := lock.Release(context.Background()); err != nil && ctx.Err() == nil {
				log.Printf("release email dispatcher leadership: %v", err)
			}
			if ctx.Err() != nil {
				return
			}
			continue
		}

		timer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func runEmailDispatcherLeader(
	ctx context.Context,
	st *store.Store,
	lock *store.EmailDispatcherLock,
	sender mail.Sender,
	appURL,
	unsubscribeSecret string,
) {
	process := func() {
		if err := lock.Alive(ctx); err != nil {
			if ctx.Err() == nil {
				log.Printf("email dispatcher leadership lost: %v", err)
			}
			return
		}
		items, err := st.ClaimEmails(ctx, 5)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("claim email outbox: %v", err)
			}
			return
		}
		for i, item := range items {
			if err := sendOutboxEmail(ctx, st, sender, item, appURL, unsubscribeSecret); err != nil {
				if !errors.Is(err, store.ErrEmailLeaseLost) && ctx.Err() == nil {
					log.Printf("send email %s: %v", item.ID, err)
				}
			}
			select {
			case <-ctx.Done():
				releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = st.ReleaseEmailClaims(releaseCtx, items[i:])
				cancel()
				return
			case <-time.After(500 * time.Millisecond):
			}
		}
	}

	process()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := lock.Alive(ctx); err != nil {
				return
			}
			process()
		case <-ctx.Done():
			return
		}
	}
}

func sendOutboxEmail(
	ctx context.Context,
	st *store.Store,
	sender mail.Sender,
	item store.EmailOutbox,
	appURL,
	unsubscribeSecret string,
) error {
	guard, active, err := st.BeginEmailSend(ctx, item)
	if err != nil {
		return err
	}
	if !active {
		return st.CancelEmailClaim(ctx, item)
	}
	defer guard.Rollback()

	var data map[string]any
	if err := json.Unmarshal(item.Payload, &data); err != nil {
		_ = guard.MarkFailed(ctx, fmt.Errorf("decode payload: %w", err))
		return err
	}
	if data == nil {
		data = map[string]any{}
	}

	locale := item.Locale
	if locale != "zh" {
		locale = "en"
	}
	data["InviteURL"] = appURL + stringValue(data, "invitePath")
	data["OpenURL"] = appURL + "/workspaces"
	if item.Template != "workspace-member-removed" {
		if workspaceID := stringValue(data, "workspaceId"); workspaceID != "" {
			data["OpenURL"] = appURL + "/workspaces/" + url.PathEscape(workspaceID)
		}
	}
	data["RoleName"] = mail.RoleLabel(stringValue(data, "role"), locale)

	category := "membership"
	if item.Template == "workspace-invite" {
		category = "workspace_invite"
	}
	unsubscribeURL := appURL + "/settings"
	if token := mail.UnsubscribeToken(unsubscribeSecret, item.UserID, category); token != "" {
		unsubscribeURL += "?unsubscribe=" + url.QueryEscape(token)
		data["UnsubscribeURL"] = appURL + "/api/email/unsubscribe?token=" + url.QueryEscape(token)
	} else {
		data["UnsubscribeURL"] = unsubscribeURL
	}

	subject, html, text, err := mail.Render(item.Template, locale, data)
	if err != nil {
		_ = guard.MarkFailed(ctx, err)
		return err
	}
	headers := map[string]string{}
	if token := mail.UnsubscribeToken(unsubscribeSecret, item.UserID, category); token != "" {
		listURL := appURL + "/api/email/unsubscribe?token=" + url.QueryEscape(token)
		headers["List-Unsubscribe"] = "<" + listURL + ">"
		headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
	}

	sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	providerID, err := sender.Send(sendCtx, mail.Message{
		To:             item.ToEmail,
		Subject:        subject,
		HTML:           html,
		Text:           text,
		Headers:        headers,
		IdempotencyKey: item.IdempotencyKey,
	})
	if err != nil {
		_ = guard.MarkFailed(ctx, err, retryAfterForEmail(err))
		return err
	}
	if err := guard.MarkSent(ctx, providerID); err != nil {
		return err
	}
	return nil
}

func retryAfterForEmail(err error) time.Duration {
	if err == nil {
		return 0
	}
	var retryable interface{ RetryAfter() time.Duration }
	if errors.As(err, &retryable) {
		return retryable.RetryAfter()
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "429") ||
		strings.Contains(message, "rate limit") ||
		strings.Contains(message, "too many requests") {
		return time.Minute
	}
	return 0
}

func stringValue(data map[string]any, key string) string {
	value, _ := data[key].(string)
	return value
}

func normalizeAppURL(appURL string) string {
	return strings.TrimRight(appURL, "/")
}
