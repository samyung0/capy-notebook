package store

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// NotifyParams is one paired in-app notification + optional email. Callers that
// only want the in-app row leave Template empty.
type NotifyParams struct {
	UserID            string
	ToEmail           string
	Locale            string
	Kind              NotificationKind
	Data              json.RawMessage
	Href              string
	WorkspaceID       string
	WorkspaceInviteID string
	Template          string
	Category          string
	IdempotencyKey    string
}

// NotifyResult reports what was written. EmailCreated is false when the
// recipient has no email, disabled the category, when Template is empty, or
// when the idempotency key already exists.
type NotifyResult struct {
	Notification Notification
	EmailCreated bool
}

// NotifyTx creates the in-app notification and, when Template is set, enqueues
// the matching email in the same transaction. Prefer this over hand-pairing
// CreateNotificationTx + EnqueueEmailTx at every call site.
func NotifyTx(ctx context.Context, tx pgx.Tx, params NotifyParams) (NotifyResult, error) {
	n, err := CreateNotificationTx(ctx, tx, NotificationParams{
		UserID:            params.UserID,
		Kind:              params.Kind,
		Data:              params.Data,
		Href:              params.Href,
		WorkspaceID:       params.WorkspaceID,
		WorkspaceInviteID: params.WorkspaceInviteID,
	})
	if err != nil {
		return NotifyResult{}, err
	}
	out := NotifyResult{Notification: n}
	if params.Template == "" || params.ToEmail == "" {
		return out, nil
	}
	key := params.IdempotencyKey
	if key == "" {
		key = string(params.Kind) + ":" + n.ID
	}
	created, err := EnqueueEmailTx(ctx, tx, EmailOutboxParams{
		UserID:         params.UserID,
		ToEmail:        params.ToEmail,
		Template:       params.Template,
		Locale:         params.Locale,
		Payload:        params.Data,
		IdempotencyKey: key,
		Category:       params.Category,
	})
	if err != nil {
		return NotifyResult{}, err
	}
	out.EmailCreated = created
	return out, nil
}
