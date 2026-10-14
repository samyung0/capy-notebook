package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/url"
	"strings"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/mail"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func newEmailSender(appEnv, backend, accountID, token, from, replyTo string) (mail.Sender, error) {
	if backend == "" {
		if token == "" {
			backend = "log"
		} else {
			backend = "cloudflare"
		}
	}
	switch backend {
	case "log":
		if appEnv == "production" {
			return nil, errors.New("EMAIL_BACKEND=log is not allowed when APP_ENV=production")
		}
		return &mail.LogSender{}, nil
	case "cloudflare":
		if appEnv == "e2e" {
			return nil, errors.New("EMAIL_BACKEND=cloudflare is not allowed when APP_ENV=e2e")
		}
		return mail.NewCloudflareSender(accountID, token, from, replyTo)
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

	var payload map[string]any
	if err := json.Unmarshal(item.Payload, &payload); err != nil {
		_ = guard.MarkFailed(ctx, fmt.Errorf("decode payload: %w", err))
		return err
	}
	locale := item.Locale
	if locale != "zh" {
		locale = "en"
	}
	category := emailCategory(item.Template)
	token := ""
	if category != "" {
		token = mail.UnsubscribeToken(unsubscribeSecret, item.UserID, category)
	}
	data := emailTemplateData(item.Template, locale, payload, appURL, token)

	subject, html, text, err := mail.Render(item.Template, locale, data)
	if err != nil {
		_ = guard.MarkFailed(ctx, err)
		return err
	}
	headers := map[string]string{}
	if token != "" {
		listURL := appURL + "/api/email/unsubscribe?token=" + url.QueryEscape(token)
		headers["List-Unsubscribe"] = "<" + listURL + ">"
		headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
	}

	sendCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	providerID, err := sender.Send(sendCtx, mail.Message{
		To:      item.ToEmail,
		Subject: subject,
		HTML:    html,
		Text:    text,
		Headers: headers,
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

// emailCategory is the opt-out category a template sends under. Lifecycle and
// service mail has none, so it carries no unsubscribe token.
func emailCategory(template string) string {
	switch template {
	case "workspace-invite", "workspace-invite-accepted":
		return "workspace_invite"
	case "subscription-over-quota", "subscription-frozen",
		"subscription-started", "subscription-cancelled":
		return "billing"
	}
	return ""
}

// emailTemplateData turns an outbox payload (camelCase JSON) into the
// PascalCase fields the Go templates read, formatting dates, sizes and roles
// for the recipient's locale.
func emailTemplateData(template, locale string, payload map[string]any, appURL, unsubscribeToken string) map[string]any {
	data := map[string]any{}
	for key, field := range map[string]string{
		"workspaceName": "WorkspaceName",
		"inviterName":   "InviterName",
		"memberName":    "MemberName",
	} {
		if v := stringValue(payload, key); v != "" {
			data[field] = v
		}
	}
	for key, field := range map[string]string{"graceDays": "GraceDays", "hours": "Hours"} {
		if v := payload[key]; v != nil {
			data[field] = v
		}
	}
	for key, field := range map[string]string{
		"purgeAfter":  "DeletionDate",
		"graceEndsAt": "GraceEndsAt",
	} {
		if t, err := time.Parse(time.RFC3339Nano, stringValue(payload, key)); err == nil {
			data[field] = emailDate(t, locale)
		}
	}
	// One period end reads "renews on" or "ends on" depending on the template.
	if t, err := time.Parse(time.RFC3339Nano, stringValue(payload, "periodEnd")); err == nil {
		data["RenewsOn"] = emailDate(t, locale)
		data["EndsOn"] = emailDate(t, locale)
	}
	for key, field := range map[string]string{
		"storageUsedBytes":  "StorageUsed",
		"storageLimitBytes": "StorageLimit",
	} {
		if v, ok := payload[key].(float64); ok {
			data[field] = emailMegabytes(v)
		}
	}
	if role := stringValue(payload, "role"); role != "" {
		data["Access"] = emailAccess(role, locale)
	}
	if startsAt, err := time.Parse(time.RFC3339, stringValue(payload, "startsAt")); err == nil {
		data["StartsAt"] = maintenanceTime(startsAt, locale)
	}

	data["InviteURL"] = appURL + stringValue(payload, "invitePath")
	data["OpenURL"] = appURL + "/workspaces"
	switch template {
	case "account-deletion-requested":
		// Account is locked; Settings is unreachable. Point at the marketing
		// site / app root where support contact lives.
		data["OpenURL"] = appURL
	case "subscription-over-quota", "subscription-frozen",
		"subscription-started", "subscription-cancelled":
		data["OpenURL"] = appURL + "/billing?tab=subscription"
	default:
		if workspaceID := stringValue(payload, "workspaceId"); workspaceID != "" {
			data["OpenURL"] = appURL + "/workspaces/" + url.PathEscape(workspaceID)
		}
	}

	data["UnsubscribeURL"] = appURL + "/settings?tab=notifications"
	if unsubscribeToken != "" {
		data["UnsubscribeURL"] = appURL + "/api/email/unsubscribe?token=" + url.QueryEscape(unsubscribeToken)
	}
	return data
}

func emailDate(t time.Time, locale string) string {
	t = t.UTC()
	if locale == "zh" {
		return t.Format("2006年1月2日")
	}
	return t.Format("2 Jan 2006")
}

// emailMegabytes writes whole decimal megabytes like the dashboard meter,
// rounding usage up so an account just over a limit never reads as at it.
func emailMegabytes(bytes float64) string {
	return fmt.Sprintf("%d MB", int64(math.Ceil(bytes/1e6)))
}

func emailAccess(role, locale string) string {
	edit := role == "editor" || role == "owner"
	switch {
	case locale == "zh" && edit:
		return "可编辑"
	case locale == "zh":
		return "可查看"
	case edit:
		return "Can edit"
	default:
		return "Can view"
	}
}

func stringValue(data map[string]any, key string) string {
	value, _ := data[key].(string)
	return value
}

func normalizeAppURL(appURL string) string {
	return strings.TrimRight(appURL, "/")
}

// maintenanceTime writes a maintenance start in UTC, which every recipient can
// convert; the in-app notice shows it in the reader's own time zone.
func maintenanceTime(t time.Time, locale string) string {
	t = t.UTC()
	if locale == "zh" {
		return t.Format("2006年1月2日 15:04") + " (UTC)"
	}
	return t.Format("2 Jan 2006, 15:04") + " UTC"
}
