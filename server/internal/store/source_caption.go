package store

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"unicode"
	"unicode/utf16"
)

type SourceCaption struct {
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId"`
	FileID      string `json:"fileId"`
	Epoch       int64  `json:"epoch"`
	Checkpoint  int64  `json:"checkpoint"`
	ChangeID    string `json:"changeId"`
	Caption     string `json:"caption"`
	ImageSHA256 string `json:"imageSHA256"`
}

// sourceEffectTokens matches collaboration/src/sourceDocuments.ts effectTokens:
// 4 UTF-16 units a token, except changed CJK characters, one each. The context
// an Office effect keeps (what before and after share at either end) counts at
// the 4-unit rate in every script. A move counts 0; any other non-text effect 1 more.
func sourceEffectTokens(effects []map[string]json.RawMessage) (int64, error) {
	var total int64
	for _, effect := range effects {
		if raw, ok := effect["operation"]; ok && string(raw) == `"move"` {
			continue
		}
		parts := map[string][]rune{}
		for _, key := range []string{"before", "after", "caption"} {
			if raw, ok := effect[key]; ok {
				var part string
				if err := json.Unmarshal(raw, &part); err != nil {
					return 0, ErrConflict
				}
				parts[key] = []rune(part)
			}
		}
		before, after := parts["before"], parts["after"]
		prefix := 0
		for prefix < len(before) && prefix < len(after) && before[prefix] == after[prefix] {
			prefix++
		}
		suffix := 0
		for suffix < len(before)-prefix && suffix < len(after)-prefix && before[len(before)-1-suffix] == after[len(after)-1-suffix] {
			suffix++
		}
		var units, cjk int64
		for _, text := range [][]rune{before, after, parts["caption"]} {
			for _, r := range text {
				units += int64(utf16.RuneLen(r))
			}
		}
		for _, changed := range [][]rune{before[prefix : len(before)-suffix], after[prefix : len(after)-suffix], parts["caption"]} {
			for _, r := range changed {
				if unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) {
					cjk++
				}
			}
		}
		total += (units-cjk+3)/4 + cjk
		var kind string
		if raw, ok := effect["kind"]; ok {
			if err := json.Unmarshal(raw, &kind); err != nil {
				return 0, ErrConflict
			}
		}
		if kind != "text" {
			total++
		}
	}
	return total, nil
}

// SaveSourceCaption completes a read tool's existing placeholder. It does not
// author a checkpoint or reset the editor's idle timer.
func (s *Store) SaveSourceCaption(ctx context.Context, in SourceCaption) error {
	digest, err := hex.DecodeString(in.ImageSHA256)
	if err != nil || len(digest) != 32 || hex.EncodeToString(digest) != in.ImageSHA256 || in.ChangeID == "" || in.Epoch < 1 || in.Checkpoint < 0 {
		return ErrConflict
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ws, owner, err := s.sourceLockTx(ctx, tx, in.FileID, []string{in.UserID}, false)
	if err != nil {
		return err
	}
	if ws != in.WorkspaceID {
		return ErrNotFound
	}
	var raw json.RawMessage
	err = tx.QueryRow(ctx, `SELECT d.pending_effects FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1 AND d.epoch=$2 AND d.checkpoint=$3 AND d.base_revision=f.revision AND f.trashed_at IS NULL FOR UPDATE OF d,f`, in.FileID, in.Epoch, in.Checkpoint).Scan(&raw)
	if isNoRows(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	var effects []map[string]json.RawMessage
	if json.Unmarshal(raw, &effects) != nil {
		return ErrConflict
	}
	matched := 0
	for _, effect := range effects {
		var id, kind, priorHash string
		if json.Unmarshal(effect["id"], &id) != nil || id != in.ChangeID {
			continue
		}
		if json.Unmarshal(effect["kind"], &kind) != nil || kind == "text" {
			return ErrConflict
		}
		if existing, ok := effect["imageSHA256"]; ok {
			if json.Unmarshal(existing, &priorHash) != nil || priorHash != in.ImageSHA256 {
				return ErrConflict
			}
		}
		matched++
		effect["caption"], _ = json.Marshal(in.Caption)
		effect["imageSHA256"], _ = json.Marshal(in.ImageSHA256)
	}
	if matched != 1 {
		return ErrConflict
	}
	tokens, err := sourceEffectTokens(effects)
	if err != nil {
		return err
	}
	updated, err := json.Marshal(effects)
	if err != nil {
		return err
	}
	var growth int64
	if err = tx.QueryRow(ctx, `SELECT octet_length($1::jsonb::text)-octet_length($2::jsonb::text)`, updated, raw).Scan(&growth); err != nil {
		return err
	}
	if growth > 0 {
		if err = s.gateStorageTx(ctx, tx, owner, growth); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE source_documents SET pending_effects=$2,net_tokens=$3 WHERE file_id=$1`, in.FileID, updated, tokens); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
