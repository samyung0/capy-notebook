package store

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

// SourceSession: browser reads send null indexedBaseline and pendingEffects
// (server-side only), and the viewer read sends null state unless a checkpoint
// is ahead of the indexed one.
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
	State             []byte          `json:"state" nullable:"true"`
	IndexedBaseline   []byte          `json:"indexedBaseline" nullable:"true"`
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
	BaseSourceSHA256 string `json:"baseSourceSHA256,omitempty"`
	Initialize       bool   `json:"initialize,omitempty"`
	IndexedBaseline  []byte `json:"indexedBaseline,omitempty"`
	// A direct AI edit or its Undo commits its receipt (and inverse) with the
	// checkpoint so the saved state and the durable effect cannot diverge.
	Operation *SourceCheckpointOperation `json:"operation,omitempty"`
}

// SourceCheckpointOperation is the receipt side of a source edit checkpoint.
// Inverse and Guards are present for an edit; UndoOf for an Undo.
type SourceCheckpointOperation struct {
	Receipt SourceCheckpointReceipt `json:"receipt"`
	Inverse json.RawMessage         `json:"inverse,omitempty"`
	Guards  json.RawMessage         `json:"guards,omitempty"`
	UndoOf  string                  `json:"undoOf,omitempty"`
}

// SourceCheckpointReceipt is the trusted operation identity the collaboration
// service forwards from the gateway; it becomes the agent_operations row.
type SourceCheckpointReceipt struct {
	ID             string `json:"id"`
	ToolVersion    int    `json:"toolVersion"`
	RequestHash    string `json:"requestHash"`
	ActorUserID    string `json:"actorUserId"`
	ConversationID string `json:"conversationId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	CallID         string `json:"callId,omitempty"`
}

func (r SourceCheckpointReceipt) operation() AgentOperation {
	return AgentOperation{
		ID: r.ID, ToolVersion: r.ToolVersion, RequestHash: r.RequestHash, ActorUserID: r.ActorUserID,
		ConversationID: r.ConversationID, MessageID: r.MessageID, CallID: r.CallID,
	}
}

// SourceEditFormat reports the direct-edit format of a source ("docx", "xlsx",
// "pptx", "text") or "" when the file is view-only (PDF, media, store-only).
func SourceEditFormat(name, kind string) string { return editableSourceFormat(name, kind) }

func editableSourceFormat(name, kind string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".docx":
		return "docx"
	case ".xlsx":
		return "xlsx"
	case ".pptx":
		return "pptx"
	}
	plan, err := sourceupload.BuildProcessingPlan(name, kind, "fast")
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
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1 AND trashed_at IS NULL`, fileID).Scan(&ws); err != nil {
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
	err = tx.QueryRow(ctx, `SELECT name,kind,COALESCE(blob_path,''),COALESCE(source_sha256,''),revision FROM files WHERE id=$1 AND trashed_at IS NULL FOR UPDATE`, fileID).Scan(&name, &kind, &path, &sha, &revision)
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

// ViewSourceSession is the viewer's read: authorization is the caller's
// (fileRead), so it takes no locks, inserts no row and never consults account
// state. State rides along only when a saved checkpoint is ahead of the
// indexed one; a file nobody has edited answers with its blob alone.
func (s *Store) ViewSourceSession(ctx context.Context, fileID string) (SourceSession, error) {
	out := SourceSession{FileID: fileID, Access: "read"}
	var name, kind string
	err := s.pool.QueryRow(ctx, `SELECT f.workspace_id,f.name,f.kind,COALESCE(d.epoch,0),COALESCE(d.checkpoint,0),COALESCE(d.indexed_checkpoint,0),COALESCE(d.base_revision,f.revision),COALESCE(d.base_blob_path,f.blob_path,''),COALESCE(d.base_source_sha256,f.source_sha256,''),CASE WHEN d.checkpoint>d.indexed_checkpoint THEN d.state END FROM files f LEFT JOIN source_documents d ON d.file_id=f.id WHERE f.id=$1 AND f.trashed_at IS NULL`, fileID).Scan(&out.WorkspaceID, &name, &kind, &out.Epoch, &out.Checkpoint, &out.IndexedCheckpoint, &out.BaseRevision, &out.BaseBlobPath, &out.BaseSourceSHA256, &out.State)
	if isNoRows(err) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	out.Format = editableSourceFormat(name, kind)
	if out.Format == "" || out.BaseBlobPath == "" {
		return out, ErrForbidden
	}
	out.Room = fmt.Sprintf("source:%s:epoch:%d", fileID, out.Epoch)
	out.SourceIdentity = fmt.Sprintf("revision:%d", out.BaseRevision)
	return out, nil
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
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1 AND d.epoch=$2 AND d.base_revision=f.revision AND f.trashed_at IS NULL)`, fileID, epoch).Scan(&current); err != nil {
		return err
	}
	if !current {
		return ErrConflict
	}
	return tx.Commit(ctx)
}

func readSourceSession(ctx context.Context, tx pgx.Tx, fileID, ws string) (SourceSession, error) {
	out := SourceSession{FileID: fileID, WorkspaceID: ws, Access: "read"}
	err := tx.QueryRow(ctx, `SELECT format,epoch,checkpoint,indexed_checkpoint,base_revision,base_blob_path,base_source_sha256,state,indexed_baseline,pending_effects,net_tokens FROM source_documents WHERE file_id=$1`, fileID).Scan(&out.Format, &out.Epoch, &out.Checkpoint, &out.IndexedCheckpoint, &out.BaseRevision, &out.BaseBlobPath, &out.BaseSourceSHA256, &out.State, &out.IndexedBaseline, &out.PendingEffects, &out.NetTokens)
	out.Room = fmt.Sprintf("source:%s:epoch:%d", fileID, out.Epoch)
	out.SourceIdentity = fmt.Sprintf("revision:%d", out.BaseRevision)
	return out, err
}

// SourceCheckpointSaved is the checkpoint receipt: the collaboration service
// already holds the state it sent, so only the new checkpoint and an edit's
// operation receipt come back.
type SourceCheckpointSaved struct {
	Checkpoint int64           `json:"checkpoint"`
	Operation  *AgentOperation `json:"operation,omitempty"`
}

func (s *Store) SaveSourceCheckpoint(ctx context.Context, fileID string, in SourceCheckpoint) (SourceCheckpointSaved, error) {
	var out SourceCheckpointSaved
	var effects []json.RawMessage
	if len(in.State) == 0 || len(in.State) > 100<<20 || in.NetTokens < 0 || json.Unmarshal(in.PendingEffects, &effects) != nil || effects == nil {
		return out, ErrConflict
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	ws, owner, err := s.sourceLockTx(ctx, tx, fileID, in.ActorIDs, !in.Initialize)
	if err != nil {
		return out, err
	}
	// Sizes only: the stored state alone may reach 100 MB.
	var format, sha string
	var epoch, baseRevision, stateBytes, oldEffectsBytes, baselineBytes int64
	if err = tx.QueryRow(ctx, `SELECT format,epoch,checkpoint,base_revision,base_source_sha256,octet_length(state),octet_length(pending_effects::text),octet_length(indexed_baseline) FROM source_documents WHERE file_id=$1`, fileID).Scan(&format, &epoch, &out.Checkpoint, &baseRevision, &sha, &stateBytes, &oldEffectsBytes, &baselineBytes); err != nil {
		return out, err
	}
	if in.Operation != nil {
		existing, err := lockAgentOperationTx(ctx, tx, in.Operation.Receipt.ID, in.Operation.Receipt.RequestHash)
		if err != nil {
			return out, err
		}
		if existing != nil {
			// Same edit already committed (a retried request): answer with the
			// recorded receipt and the current checkpoint, without saving again.
			out.Operation = existing
			return out, tx.Commit(ctx)
		}
	}
	if epoch != in.Epoch || out.Checkpoint != in.ExpectedCheckpoint {
		return out, ErrConflict
	}
	var revision int64
	if err = tx.QueryRow(ctx, `SELECT revision FROM files WHERE id=$1 AND trashed_at IS NULL FOR UPDATE`, fileID).Scan(&revision); err != nil {
		return out, err
	}
	if revision != baseRevision {
		return out, ErrConflict
	}
	if in.Initialize && (out.Checkpoint != 0 || stateBytes != 0 || len(effects) != 0 || (len(in.BaseSourceSHA256) != 64 || (sha != "" && sha != in.BaseSourceSHA256))) {
		return out, ErrConflict
	}
	var effectsBytes int64
	if err = tx.QueryRow(ctx, `SELECT octet_length($1::jsonb::text)`, in.PendingEffects).Scan(&effectsBytes); err != nil {
		return out, err
	}
	growth := int64(len(in.State)) - stateBytes - oldEffectsBytes + effectsBytes
	if in.Operation != nil {
		// The retained inverse is owner storage too: admit state and inverse
		// growth together.
		growth += int64(len(in.Operation.Inverse) + len(in.Operation.Guards))
	}
	if in.Initialize {
		if !validSourceBaseline(in.IndexedBaseline, format) {
			return out, ErrConflict
		}
		growth += int64(len(in.IndexedBaseline)) - baselineBytes
	}
	if growth > 0 {
		if err = s.gateStorageTx(ctx, tx, owner, growth); err != nil {
			return out, err
		}
	}
	if in.Initialize {
		if _, err = tx.Exec(ctx, `UPDATE files SET source_sha256=$2 WHERE id=$1 AND source_sha256 IS NULL`, fileID, in.BaseSourceSHA256); err != nil {
			return out, err
		}
		_, err = tx.Exec(ctx, `UPDATE source_documents SET state=$2,indexed_baseline=$4,base_source_sha256=$3,updated_at=now() WHERE file_id=$1`, fileID, in.State, in.BaseSourceSHA256, in.IndexedBaseline)
	} else {
		err = tx.QueryRow(ctx, `UPDATE source_documents SET state=$2,pending_effects=$3,net_tokens=$4,checkpoint=checkpoint+1,last_edited_at=now(),updated_at=now(),desired_checkpoint=CASE WHEN desired_manual THEN checkpoint+1 ELSE NULL END,refresh_error=NULL WHERE file_id=$1 RETURNING checkpoint`, fileID, in.State, in.PendingEffects, in.NetTokens).Scan(&out.Checkpoint)
	}
	if err != nil {
		return out, err
	}
	if in.Operation != nil {
		receipt, err := s.commitSourceOperationTx(ctx, tx, fileID, ws, owner, epoch, out.Checkpoint, *in.Operation)
		if err != nil {
			return out, err
		}
		out.Operation = &receipt
	}
	return out, tx.Commit(ctx)
}

// commitSourceOperationTx records the edit (receipt + inverse) or the Undo
// (receipt + consumed eligibility) in the checkpoint's transaction.
func (s *Store) commitSourceOperationTx(ctx context.Context, tx pgx.Tx, fileID, ws, owner string, epoch, checkpoint int64, op SourceCheckpointOperation) (AgentOperation, error) {
	receipt := op.Receipt.operation()
	receipt.WorkspaceID = ws
	receipt.Outcome = agenttools.OutcomeSucceeded
	var name string
	if err := tx.QueryRow(ctx, `SELECT name FROM files WHERE id=$1`, fileID).Scan(&name); err != nil {
		return AgentOperation{}, err
	}
	effect := agenttools.ResourceEffect{
		Resource:    agenttools.ResourceRef{Kind: agenttools.KindSourceFile, ID: fileID, Title: name, WorkspaceID: ws},
		OperationID: receipt.ID,
	}
	if op.UndoOf != "" {
		receipt.Kind = "undo_edit"
		effect.Operation = agenttools.EffectEditUndone
		if err := markEditInverseUndoneTx(ctx, tx, op.UndoOf, receipt.ID); err != nil {
			return AgentOperation{}, err
		}
	} else {
		receipt.Kind = "edit_document"
		effect.Operation = agenttools.EffectEdited
		effect.Undo = &agenttools.UndoRef{OperationID: receipt.ID, Status: agenttools.UndoAvailable}
	}
	receipt.Effect = &effect
	if err := insertAgentOperationTx(ctx, tx, receipt); err != nil {
		return AgentOperation{}, err
	}
	if op.UndoOf == "" {
		if err := insertEditInverseTx(ctx, tx, EditInverse{
			OperationID: receipt.ID, ResourceKind: agenttools.KindSourceFile, ResourceID: fileID,
			ActorUserID: receipt.ActorUserID, OwnerUserID: owner, WorkspaceID: ws,
			Incarnation: epoch, Revision: checkpoint, Inverse: op.Inverse, Guards: op.Guards,
			InverseBytes: int64(len(op.Inverse) + len(op.Guards)),
		}); err != nil {
			return AgentOperation{}, err
		}
	}
	return receipt, nil
}

// Automatic Office refresh: officeRefreshTokens trimmed net tokens after
// officeRefreshIdle without edits, or any saved change left unedited for
// officeRefreshStale. The collaboration scheduler query uses the same values.
const (
	officeRefreshTokens = 3000
	officeRefreshIdle   = 60 * time.Second
	officeRefreshStale  = 7 * 24 * time.Hour
)

type SourceProcessResult struct {
	FileID     string `json:"fileId"`
	Checkpoint int64  `json:"checkpoint"`
	Status     string `json:"status"`
	JobID      string `json:"jobId"`
}

// RequestSourceRefresh captures exactly one durable checkpoint. Credit admission
// happens here, never while saving edits. Automatic work is funded by the owner.
func (s *Store) RequestSourceRefresh(ctx context.Context, actor, fileID string, automatic bool) (SourceProcessResult, error) {
	return s.requestSourceRefresh(ctx, actor, fileID, automatic, models.PaidByPlatform)
}

// requestSourceRefresh with paidBy models.PaidBySystem is the maintenance
// republish, the only caller that sets it: the owner's credits are neither
// checked, reserved nor debited.
func (s *Store) requestSourceRefresh(ctx context.Context, actor, fileID string, automatic bool, paidBy string) (SourceProcessResult, error) {
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
	var ever, autoParse, autoIndex, manual bool
	var edited, lastRequested time.Time
	var running, refreshError *string
	err = tx.QueryRow(ctx, `SELECT f.name,f.kind,f.parse_mode,f.ever_parsed_successfully,w.auto_reparse,w.auto_reindex,d.last_edited_at,d.last_refresh_requested_at,d.running_job_id,d.desired_manual,d.refresh_error FROM files f JOIN workspaces w ON w.id=f.workspace_id JOIN source_documents d ON d.file_id=f.id WHERE f.id=$1 AND f.trashed_at IS NULL FOR UPDATE OF f,d`, fileID).Scan(&name, &kind, &mode, &ever, &autoParse, &autoIndex, &edited, &lastRequested, &running, &manual, &refreshError)
	if err != nil {
		return SourceProcessResult{}, err
	}
	result := SourceProcessResult{FileID: fileID, Checkpoint: doc.Checkpoint, Status: "pending"}
	// Reprocessing is owner-only whether manual or automatic; editors only see
	// the pending-context label.
	if actor != owner {
		return result, ErrForbidden
	}
	if automatic {
		if refreshError != nil {
			return result, ErrConflict
		}
		if doc.Checkpoint <= doc.IndexedCheckpoint || doc.NetTokens == 0 {
			return result, ErrConflict
		}
		if doc.Format == "text" {
			if (!autoIndex && !manual) || time.Since(lastRequested) < 15*time.Second {
				return result, ErrConflict
			}
		} else if due := doc.NetTokens >= officeRefreshTokens || time.Since(edited) >= officeRefreshStale; ((!autoParse || !ever || !due) && !manual) || time.Since(edited) < officeRefreshIdle {
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
	var reservation string
	if paidBy == models.PaidBySystem {
		reservation, err = beginSystemIngestSessionTx(ctx, tx, payer, ws)
	} else {
		reservation, err = s.beginIngestSpendTx(ctx, tx, payer, ws)
	}
	if err != nil {
		return result, err
	}
	// Manual processing explicitly permits the first parse of a store-only upload.
	if mode == "none" {
		mode = "fast"
	}
	plan, err := sourceupload.BuildProcessingPlan(name, kind, mode)
	if err != nil {
		return result, err
	}
	if err = s.gateStorageTx(ctx, tx, owner, int64(len(doc.State))); err != nil {
		return result, err
	}
	jobID := uid("job")
	lease := uid("srclease")
	// The per-page parse fee applies to a file's first parse only; a refresh of
	// a parsed file pays its provider calls and records its pages uncharged.
	payload, err := s.ingestJobPayload(ctx, payer, map[string]any{"fileId": fileID, "workspaceId": ws, "sourceRefresh": true, "sourceEpoch": doc.Epoch, "sourceCheckpoint": doc.Checkpoint, "sourceLeaseToken": lease, "sourceRevision": doc.BaseRevision, "sourceETag": "", "blobPath": doc.BaseBlobPath, "kind": kind, "format": doc.Format, "parseMode": mode, "processingPlan": plan, "reservationId": reservation, "requestedBy": actor, "automatic": automatic, "parseFee": !ever && paidBy != models.PaidBySystem, "paidBy": paidBy})
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

// The collaboration runtime owns projection; reject missing or mismatched baselines.
func validSourceBaseline(raw []byte, format string) bool {
	var baseline struct {
		Version int                `json:"version"`
		Format  string             `json:"format"`
		Text    *string            `json:"text"`
		Entries *[]json.RawMessage `json:"entries"`
	}
	if len(raw) > 100<<20 || json.Unmarshal(raw, &baseline) != nil || baseline.Version != 1 || baseline.Format != format {
		return false
	}
	if format == "text" {
		return baseline.Text != nil && baseline.Entries == nil
	}
	return baseline.Entries != nil && baseline.Text == nil
}
