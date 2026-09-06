package store

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

type SourceSession struct {
	FileID            string          `json:"fileId"`
	WorkspaceID       string          `json:"workspaceId"`
	Format            string          `json:"format" enum:"docx,xlsx,pptx,text"`
	Room              string          `json:"room"`
	Epoch             int64           `json:"epoch"`
	Checkpoint        int64           `json:"checkpoint"`
	IndexedCheckpoint int64           `json:"indexedCheckpoint"`
	BaseRevision      int64           `json:"baseRevision"`
	SourceIdentity    string          `json:"sourceIdentity"`
	BaseSourceSHA256  string          `json:"baseSourceSHA256"`
	SourceURL         string          `json:"sourceURL"`
	State             []byte          `json:"state"`
	IndexedState      []byte          `json:"indexedState"`
	PendingEffects    json.RawMessage `json:"pendingEffects"`
	NetTokens         int64           `json:"netTokens"`
	BaseBlobPath      string          `json:"-"`
	Access            string          `json:"access" enum:"write,read"`
}

type SourceCheckpoint struct {
	ActorIDs           []string        `json:"actorIds" minItems:"1"`
	Epoch              int64           `json:"epoch" minimum:"1"`
	ExpectedCheckpoint int64           `json:"expectedCheckpoint" minimum:"0"`
	State              []byte          `json:"state"`
	PendingEffects     json.RawMessage `json:"pendingEffects"`
	NetTokens          int64           `json:"netTokens" minimum:"0"`
	// Only a trusted initial seed may bind the SHA computed from source bytes.
	BaseSourceSHA256 string `json:"baseSourceSHA256"`
	Initialize       bool   `json:"initialize"`
}

func editableSourceFormat(name, kind string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".docx":
		return "docx"
	case ".xlsx":
		return "xlsx"
	case ".pptx":
		return "pptx"
	}
	plan, err := sourceupload.BuildProcessingPlan(name, kind, "fast", false)
	if err == nil && (plan.Route == sourceupload.RouteRawText || plan.Route == sourceupload.RouteDelimitedText) {
		return "text"
	}
	return ""
}

// sourceLockTx uses the same lock order as material rooms and workspace writes.
func (s *Store) sourceLockTx(ctx context.Context, tx pgx.Tx, fileID string, actors []string, edit bool) (string, string, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fileID); err != nil {
		return "", "", err
	}
	var ws string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1`, fileID).Scan(&ws); err != nil {
		if isNoRows(err) {
			err = ErrNotFound
		}
		return "", "", err
	}
	owner, err := s.storageOwnerTx(ctx, tx, ws)
	if err != nil {
		return "", "", err
	}
	if len(actors) == 0 {
		return "", "", ErrForbidden
	}
	if err = s.lockAccountSessionsTx(ctx, tx, append([]string{owner}, actors...)...); err != nil {
		return "", "", err
	}
	for _, actor := range actors {
		if actor == "" {
			return "", "", ErrForbidden
		}
		var allowed bool
		err = tx.QueryRow(ctx, `SELECT w.user_id=$2 OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$2 AND (NOT $3 OR m.role IN ('owner','editor'))) OR (w.privacy IN ('link','public') AND (NOT $3 OR w.share_role='editor')) FROM workspaces w WHERE w.id=$1`, ws, actor, edit).Scan(&allowed)
		if err != nil {
			return "", "", err
		}
		if !allowed {
			return "", "", ErrNotFound
		}
	}
	if edit {
		status, e := s.accountAccess(ctx, tx, owner)
		if e != nil {
			return "", "", e
		}
		if e = status.Err(); e != nil {
			return "", "", e
		}
	}
	return ws, owner, nil
}

func (s *Store) SourceSession(ctx context.Context, actor, fileID string) (SourceSession, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceSession{}, err
	}
	defer tx.Rollback(ctx)
	ws, owner, err := s.sourceLockTx(ctx, tx, fileID, []string{actor}, false)
	if err != nil {
		return SourceSession{}, err
	}
	var name, kind, path, sha string
	var revision int64
	err = tx.QueryRow(ctx, `SELECT name,kind,COALESCE(blob_path,''),COALESCE(source_sha256,''),revision FROM files WHERE id=$1 FOR UPDATE`, fileID).Scan(&name, &kind, &path, &sha, &revision)
	if err != nil {
		return SourceSession{}, err
	}
	format := editableSourceFormat(name, kind)
	if format == "" || path == "" {
		return SourceSession{}, ErrForbidden
	}
	if _, err = tx.Exec(ctx, `INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,base_source_sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, fileID, format, revision, path, sha); err != nil {
		return SourceSession{}, err
	}
	out, err := readSourceSession(ctx, tx, fileID, ws)
	if err != nil {
		return out, err
	}
	var canEdit bool
	err = tx.QueryRow(ctx, `SELECT w.user_id=$2 OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$2 AND m.role IN ('owner','editor')) OR(w.privacy IN ('link','public') AND w.share_role='editor') FROM workspaces w WHERE id=$1`, ws, actor).Scan(&canEdit)
	if err != nil {
		return out, err
	}
	ownerStatus, err := s.accountAccess(ctx, tx, owner)
	if err != nil {
		return out, err
	}
	out.Access = "read"
	if canEdit && ownerStatus.CanEdit() {
		out.Access = "write"
	}
	return out, tx.Commit(ctx)
}

// CheckSourceAccess revalidates each incoming edit without loading or encoding
// the complete current and indexed document states.
func (s *Store) CheckSourceAccess(ctx context.Context, actor, fileID string, epoch int64, edit bool) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, _, err = s.sourceLockTx(ctx, tx, fileID, []string{actor}, edit); err != nil {
		return err
	}
	var current bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1 AND d.epoch=$2 AND d.base_revision=f.revision)`, fileID, epoch).Scan(&current); err != nil {
		return err
	}
	if !current {
		return ErrConflict
	}
	return tx.Commit(ctx)
}

func readSourceSession(ctx context.Context, tx pgx.Tx, fileID, ws string) (SourceSession, error) {
	out := SourceSession{FileID: fileID, WorkspaceID: ws, Access: "read"}
	err := tx.QueryRow(ctx, `SELECT format,epoch,checkpoint,indexed_checkpoint,base_revision,base_blob_path,base_source_sha256,state,indexed_state,pending_effects,net_tokens FROM source_documents WHERE file_id=$1`, fileID).Scan(&out.Format, &out.Epoch, &out.Checkpoint, &out.IndexedCheckpoint, &out.BaseRevision, &out.BaseBlobPath, &out.BaseSourceSHA256, &out.State, &out.IndexedState, &out.PendingEffects, &out.NetTokens)
	out.Room = fmt.Sprintf("source:%s:epoch:%d", fileID, out.Epoch)
	out.SourceIdentity = fmt.Sprintf("revision:%d", out.BaseRevision)
	return out, err
}

func (s *Store) SaveSourceCheckpoint(ctx context.Context, fileID string, in SourceCheckpoint) (SourceSession, error) {
	var effects []json.RawMessage
	if len(in.State) == 0 || len(in.State) > 100<<20 || in.NetTokens < 0 || json.Unmarshal(in.PendingEffects, &effects) != nil || effects == nil {
		return SourceSession{}, ErrConflict
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceSession{}, err
	}
	defer tx.Rollback(ctx)
	ws, owner, err := s.sourceLockTx(ctx, tx, fileID, in.ActorIDs, !in.Initialize)
	if err != nil {
		return SourceSession{}, err
	}
	old, err := readSourceSession(ctx, tx, fileID, ws)
	if err != nil {
		return old, err
	}
	if old.Epoch != in.Epoch || old.Checkpoint != in.ExpectedCheckpoint {
		return old, ErrConflict
	}
	var revision int64
	if err = tx.QueryRow(ctx, `SELECT revision FROM files WHERE id=$1 FOR UPDATE`, fileID).Scan(&revision); err != nil {
		return old, err
	}
	if revision != old.BaseRevision {
		return old, ErrConflict
	}
	if in.Initialize && (old.Checkpoint != 0 || len(old.State) != 0 || len(effects) != 0 || (len(in.BaseSourceSHA256) != 64 || (old.BaseSourceSHA256 != "" && old.BaseSourceSHA256 != in.BaseSourceSHA256))) {
		return old, ErrConflict
	}
	var effectsBytes int64
	if err = tx.QueryRow(ctx, `SELECT octet_length($1::jsonb::text)`, in.PendingEffects).Scan(&effectsBytes); err != nil {
		return old, err
	}
	growth := int64(len(in.State)-len(old.State)-len(old.PendingEffects)) + effectsBytes
	if in.Initialize {
		growth += int64(len(in.State))
	}
	if growth > 0 {
		if err = s.gateStorageTx(ctx, tx, owner, growth); err != nil {
			return old, err
		}
	}
	if in.Initialize {
		if _, err = tx.Exec(ctx, `UPDATE files SET source_sha256=$2 WHERE id=$1 AND source_sha256 IS NULL`, fileID, in.BaseSourceSHA256); err != nil {
			return old, err
		}
		_, err = tx.Exec(ctx, `UPDATE source_documents SET state=$2,indexed_state=$2,base_source_sha256=$3,updated_at=now() WHERE file_id=$1`, fileID, in.State, in.BaseSourceSHA256)
	} else {
		_, err = tx.Exec(ctx, `UPDATE source_documents SET state=$2,pending_effects=$3,net_tokens=$4,checkpoint=checkpoint+1,last_edited_at=now(),updated_at=now(),desired_checkpoint=CASE WHEN desired_manual THEN checkpoint+1 ELSE NULL END,refresh_error=NULL WHERE file_id=$1`, fileID, in.State, in.PendingEffects, in.NetTokens)
	}
	if err != nil {
		return old, err
	}
	out, err := readSourceSession(ctx, tx, fileID, ws)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

type SourceProcessResult struct {
	FileID     string `json:"fileId"`
	Checkpoint int64  `json:"checkpoint"`
	Status     string `json:"status"`
	JobID      string `json:"jobId"`
}

// RequestSourceRefresh captures exactly one durable checkpoint. Credit admission
// happens here, never while saving edits. Automatic work is funded by the owner.
func (s *Store) RequestSourceRefresh(ctx context.Context, actor, fileID string, automatic bool) (SourceProcessResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceProcessResult{}, err
	}
	defer tx.Rollback(ctx)
	ws, owner, err := s.sourceLockTx(ctx, tx, fileID, []string{actor}, true)
	if err != nil {
		return SourceProcessResult{}, err
	}
	doc, err := readSourceSession(ctx, tx, fileID, ws)
	if err != nil {
		return SourceProcessResult{}, err
	}
	var name, kind, mode string
	var captions, ever, autoParse, autoIndex, manual bool
	var edited, lastRequested time.Time
	var running, refreshError *string
	err = tx.QueryRow(ctx, `SELECT f.name,f.kind,f.parse_mode,f.caption_images,f.ever_parsed_successfully,w.auto_reparse,w.auto_reindex,d.last_edited_at,d.last_refresh_requested_at,d.running_job_id,d.desired_manual,d.refresh_error FROM files f JOIN workspaces w ON w.id=f.workspace_id JOIN source_documents d ON d.file_id=f.id WHERE f.id=$1 FOR UPDATE OF f,d`, fileID).Scan(&name, &kind, &mode, &captions, &ever, &autoParse, &autoIndex, &edited, &lastRequested, &running, &manual, &refreshError)
	if err != nil {
		return SourceProcessResult{}, err
	}
	result := SourceProcessResult{FileID: fileID, Checkpoint: doc.Checkpoint, Status: "pending"}
	if automatic {
		if refreshError != nil {
			return result, ErrConflict
		}
		if actor != owner {
			return result, ErrForbidden
		}
		if doc.Checkpoint <= doc.IndexedCheckpoint || doc.NetTokens == 0 {
			return result, ErrConflict
		}
		if doc.Format == "text" {
			if (!autoIndex && !manual) || time.Since(lastRequested) < 15*time.Second {
				return result, ErrConflict
			}
		} else if ((!autoParse || !ever || doc.NetTokens < 5000) && !manual) || time.Since(edited) < 60*time.Second {
			return result, ErrConflict
		}
	}
	if running != nil {
		result.JobID = *running
		_, err = tx.Exec(ctx, `UPDATE source_documents SET desired_checkpoint=checkpoint,desired_manual=desired_manual OR $2 WHERE file_id=$1`, fileID, !automatic)
		if err != nil {
			return result, err
		}
		return result, tx.Commit(ctx)
	}
	payer := actor
	if automatic {
		payer = owner
	}
	reservation, err := s.beginIngestSpendTx(ctx, tx, payer, ws)
	if err != nil {
		return result, err
	}
	// Manual processing explicitly permits the first parse of a store-only upload.
	if mode == "none" {
		mode = "fast"
	}
	plan, err := sourceupload.BuildProcessingPlan(name, kind, mode, captions)
	if err != nil {
		return result, err
	}
	if err = s.gateStorageTx(ctx, tx, owner, int64(len(doc.State))); err != nil {
		return result, err
	}
	jobID := uid("job")
	lease := uid("srclease")
	payload, err := s.ingestJobPayload(ctx, payer, map[string]any{"fileId": fileID, "workspaceId": ws, "sourceRefresh": true, "sourceEpoch": doc.Epoch, "sourceCheckpoint": doc.Checkpoint, "sourceLeaseToken": lease, "sourceRevision": doc.BaseRevision, "sourceETag": "", "blobPath": doc.BaseBlobPath, "kind": kind, "format": doc.Format, "parseMode": mode, "captionImages": captions, "processingPlan": plan, "reservationId": reservation, "requestedBy": actor, "automatic": automatic})
	if err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO jobs(id,type,payload) VALUES($1,'source_refresh',$2)`, jobID, payload); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO source_refresh_candidates(file_id,job_id,epoch,checkpoint,lease_token,state) VALUES($1,$2,$3,$4,$5,$6)`, fileID, jobID, doc.Epoch, doc.Checkpoint, lease, doc.State); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `UPDATE source_documents SET running_job_id=$2,desired_checkpoint=$3,desired_manual=desired_manual OR $4,refresh_error=NULL,last_refresh_requested_at=now() WHERE file_id=$1`, fileID, jobID, doc.Checkpoint, !automatic); err != nil {
		return result, err
	}
	result.JobID = jobID
	return result, tx.Commit(ctx)
}
