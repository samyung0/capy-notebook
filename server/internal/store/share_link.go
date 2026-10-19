package store

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

// shareTokenPattern matches `{id}.{signature}` for a prefixed workspace or
// material id; callers check the id resolves to the kind they serve.
var shareTokenPattern = regexp.MustCompile(`^([a-z]+_[A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{16})$`)

// ShareToken signs a workspace or standalone material id as `{id}.{signature}`.
// The signature only proves the link came from us; privacy is still read live.
// src/lib/shareLink.ts signs and verifies the same format in the Worker.
func ShareToken(secret []byte, id string) string {
	return id + "." + base64.RawURLEncoding.EncodeToString(shareMAC(secret, id))
}

func shareMAC(secret []byte, id string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("share:v1:" + id))
	return mac.Sum(nil)[:12]
}

// VerifyShareToken returns the id a token signs, or false when it is forged.
func VerifyShareToken(secret []byte, token string) (string, bool) {
	match := shareTokenPattern.FindStringSubmatch(token)
	if match == nil {
		return "", false
	}
	given, err := base64.RawURLEncoding.DecodeString(match[2])
	if err != nil || !hmac.Equal(given, shareMAC(secret, match[1])) {
		return "", false
	}
	return match[1], true
}

// SharePath is a workspace's signed public summary path, /w/{id}.{signature}.
func SharePath(secret []byte, workspaceID string) string {
	return "/w/" + ShareToken(secret, workspaceID)
}

// MaterialSharePath is m's signed share link, empty in a workspace or
// embedded in a note.
func (s *Store) MaterialSharePath(m Material) string {
	return materialSharePath(s.shareLinkSecret, string(m.Kind), m.ID, m.WorkspaceID, m.ParentMaterialID)
}

// materialSharePath is the signed link of a standalone quiz, flashcard set or
// note; workspace and embedded materials have no sharing of their own.
func materialSharePath(secret []byte, kind, id, workspaceID, parentID string) string {
	if workspaceID != "" || parentID != "" {
		return ""
	}
	switch kind {
	case "quiz":
		return "/share/quizzes/" + ShareToken(secret, id)
	case "flashcards":
		return "/share/flashcards/" + ShareToken(secret, id)
	case "note":
		return "/share/notes/" + ShareToken(secret, id)
	}
	return ""
}

// VerifyShareToken checks a token against this store's link secret.
func (s *Store) VerifyShareToken(token string) (string, bool) {
	return VerifyShareToken(s.shareLinkSecret, token)
}

// ShareRedemption is what a redeemed share token opens.
type ShareRedemption struct {
	Kind         string       `json:"kind" enum:"workspace,material"`
	ID           string       `json:"id"`
	MaterialKind MaterialKind `json:"materialKind,omitempty"`
}

// RedeemShareToken lets a signed-in user in through a signed share link once,
// as Google's resource key (Sam 2026-10-18): it verifies the token, checks the
// workspace or standalone material is link or public now, and remembers the
// grant so later calls by bare id pass (workspaceRoles,
// materialEffectiveAccess). Making the resource private clears the grants
// (migration 0096). A forged token, or a private, trashed, embedded or
// workspace-filed material, is ErrNotFound.
func (s *Store) RedeemShareToken(ctx context.Context, userID, token string) (ShareRedemption, error) {
	id, ok := s.VerifyShareToken(token)
	if !ok || userID == "" {
		return ShareRedemption{}, ErrNotFound
	}
	out := ShareRedemption{ID: id}
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var privacy Privacy
		var direct bool // owner or member: direct access needs no link
		var err error
		if strings.HasPrefix(id, "ws_") {
			out.Kind = "workspace"
			// Locked so a concurrent switch to private, which clears grants,
			// orders before or after this one.
			err = tx.QueryRow(ctx, `SELECT w.privacy, w.user_id=$2
					OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.user_id=$2)
				FROM workspaces w
				JOIN users owner ON owner.id=w.user_id
				WHERE w.id=$1 AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
					AND (owner.suspended_at IS NULL OR owner.id=$2)
				FOR SHARE OF w`, id, userID).Scan(&privacy, &direct)
		} else {
			out.Kind = "material"
			err = tx.QueryRow(ctx, `SELECT m.privacy, m.kind, m.owner_user_id=$2 FROM materials m
				JOIN users owner ON owner.id=m.owner_user_id
				WHERE m.id=$1 AND m.workspace_id IS NULL AND m.parent_material_id IS NULL
					AND m.trashed_at IS NULL AND owner.deleted_at IS NULL
					AND owner.deletion_requested_at IS NULL
					AND (owner.suspended_at IS NULL OR owner.id=$2)
				FOR SHARE OF m`, id, userID).Scan(&privacy, &out.MaterialKind, &direct)
		}
		if isNoRows(err) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		switch {
		case direct:
			return nil
		case privacy == PrivacyPrivate:
			return ErrNotFound
		case privacy == PrivacyPublic:
			return nil // open to every signed-in user; nothing to remember
		case out.Kind == "workspace":
			_, err = tx.Exec(ctx, `INSERT INTO workspace_link_grants (workspace_id, user_id)
				VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, userID)
		default:
			_, err = tx.Exec(ctx, `INSERT INTO material_link_grants (material_id, user_id)
				VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, userID)
		}
		return err
	})
	return out, err
}
