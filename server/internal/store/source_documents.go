package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

// BrowserSourceSession is the browser's read of a source; the viewer read
// sends null state unless a checkpoint is ahead of the indexed one. A null
// state is seed(base). An Office state is its change over seed(base), whose
// SHA-256 stateSeedSHA256 is; a text state is complete. Every save since
// appends a row (delta saves): the saved document is the state, then
// stateRows in order, which browser reads carry with the state. The indexed
// baseline is derived from the base.
type BrowserSourceSession struct {
	FileID            string   `json:"fileId"`
	WorkspaceID       string   `json:"workspaceId"`
	Format            string   `json:"format" enum:"docx,xlsx,pptx,text"`
	Room              string   `json:"room"`
	Epoch             int64    `json:"epoch"`
	Checkpoint        int64    `json:"checkpoint"`
	IndexedCheckpoint int64    `json:"indexedCheckpoint"`
	BaseRevision      int64    `json:"baseRevision"`
	SourceIdentity    string   `json:"sourceIdentity"`
	BaseSourceSHA256  string   `json:"baseSourceSHA256"`
	SourceURL         string   `json:"sourceURL"`
	State             []byte   `json:"state" nullable:"true"`
	StateSeedSHA256   *string  `json:"stateSeedSHA256" nullable:"true"`
	StateRows         [][]byte `json:"stateRows,omitempty"`
	NetTokens         int64    `json:"netTokens"`
	BaseBlobPath      string   `json:"-"`
	// BaseBytes is the base file's size when it is the file's current
	// revision (files.size_bytes); nil while editing stays on an older one.
	BaseBytes *int64 `json:"-"`
	// GrownBytes is the durable state's growth over seed(base)
	// (sourceGrowthSQL), which the growth budget subtracts.
	GrownBytes int64  `json:"-"`
	Access     string `json:"access" enum:"write,read"`
	// StorageFull: an editor's read access because the file's payer is at its
	// storage limit; "self" when the editor pays for it.
	StorageFull StorageFullBy `json:"storageFull,omitempty"`
	// ImageMaxBytes: the browser's Office edit read only. The plan image cap
	// of the file's payer (its uploader): inserted images over it are shrunk
	// in the browser first.
	ImageMaxBytes int64 `json:"imageMaxBytes,omitempty"`
	// GrowthBudgetBytes: the browser's edit read only. What the room's state
	// may still grow by as of the durable state (SourceGrowthBudget): 0 opens
	// the file to view only, and the Office editor refuses an inserted image
	// past it.
	GrowthBudgetBytes *int64 `json:"growthBudgetBytes,omitempty"`
	// AtSizeLimit: the browser's view read only. The file has no growth
	// budget left, so the view shows it cannot be edited before any attempt
	// (Epo 2026-10-20). Known on the current base only; editing that stays
	// on an older one learns it from the edit read.
	AtSizeLimit bool `json:"atSizeLimit,omitempty"`
	// ThumbnailStale: the browser's Office edit read only. The file's card is
	// older than its saved document (ThumbnailStale), so the editor uploads
	// the page 1 it draws, once per open.
	ThumbnailStale bool `json:"thumbnailStale,omitempty"`
	// OwnerID is the file's payer (files.user_id, its uploader).
	OwnerID string `json:"-"`
	// RebuildPending: the file and its index were published while editing
	// stayed on this base; the collaboration service rebuilds the editing
	// state onto the published file once the room is empty. PublishedState is
	// the published (captured) state as its change over seed(base) (nil:
	// seed(base)), which pending effects are measured against meanwhile.
	// Collaboration service only; the browser never sees these.
	RebuildPending           bool    `json:"rebuildPending,omitempty"`
	PublishedState           []byte  `json:"publishedState,omitempty"`
	PublishedStateSeedSHA256 *string `json:"publishedStateSeedSHA256,omitempty"`
	PublishedSourceSHA256    string  `json:"publishedSourceSHA256,omitempty"`
	PublishedSourceURL       string  `json:"publishedSourceURL,omitempty"`
	PublishedBlobPath        string  `json:"-"`
}

// SourceSession is the collaboration service's read: the browser's. Pending
// effects stay server-side: text's in source_documents, Office's read by the
// collaboration service when the agent reads the file (Q405).
type SourceSession struct {
	BrowserSourceSession
}

// sourceGrowthMarginBytes: what a room's growth stays under the export cap
// by. IMPORTANT: KEEP IN SYNC WITH STATE_GROWTH_MARGIN_BYTES IN
// collaboration-rs/crates/sources/src/lib.rs
const sourceGrowthMarginBytes = 1 << 20

// sourceCeilingBytes: the most any source state or published source file
// may be. IMPORTANT: KEEP IN SYNC WITH MAX_SOURCE_STATE_BYTES IN
// collaboration-rs/crates/sources/src/lib.rs
const sourceCeilingBytes = 100 << 20

// sourceWriteReserveBytes: what room admission keeps free under the cap for
// the room's own writes. IMPORTANT: KEEP IN SYNC WITH
// STATE_WRITE_RESERVE_BYTES IN collaboration-rs/crates/sources/src/lib.rs
const sourceWriteReserveBytes = 64 << 10

// SourceGrowthBudget is what a source room may still admit: the export cap
// (the largest plan source file) less the base file, the margin, admission's
// write reserve and the durable growth over seed(base) (Epo 2026-10-17; the
// collaboration server's admission_cap of state_cap). Never negative; 0
// means nothing would be admitted, so the file opens to view only.
func SourceGrowthBudget(exportCap, baseBytes, grownBytes int64) int64 {
	return max(0, exportCap-baseBytes-sourceGrowthMarginBytes-sourceWriteReserveBytes-grownBytes)
}

// sourceGrowthSQL is a source row's durable growth over seed(base), as the
// collaboration server's room estimate counts it: an Office state and its
// rows are the change itself; a text state is the whole text with its
// history, so its seed (seed_bytes) comes off. 0 for a file with no row.
const sourceGrowthSQL = `GREATEST(0,COALESCE(octet_length(d.state),0)+COALESCE((SELECT sum(octet_length(u.update)) FROM source_document_updates u WHERE u.file_id=d.file_id AND u.epoch=d.epoch)::bigint,0)-CASE WHEN d.format='text' THEN d.seed_bytes ELSE 0 END)`

type SourceCheckpoint struct {
	ActorIDs           []string `json:"actorIds" minItems:"1"`
	Epoch              int64    `json:"epoch" minimum:"1"`
	ExpectedCheckpoint int64    `json:"expectedCheckpoint" minimum:"0"`
	// The base revision the effects were measured under: a publication in
	// between (which keeps epoch and checkpoint) refuses the save, whose
	// effects are then stale.
	BaseRevision int64 `json:"baseRevision" minimum:"1"`
	// The room's update since its durable state (a delta save), appended to
	// the source's rows at the new checkpoint.
	Update         []byte          `json:"update"`
	PendingEffects json.RawMessage `json:"pendingEffects"`
	NetTokens      int64           `json:"netTokens" minimum:"0"`
	// Required for an Office source, whose saved document is a change over
	// seed(base): the seed's SHA-256, which must match the stored one.
	StateSeedSHA256 string `json:"stateSeedSHA256,omitempty"`
	// The first save over a null state (seed(base)) binds the SHA the service
	// computed from the source bytes when the file has none yet (a store-only
	// upload); a text source also records its seed's size, which its charge
	// is measured from.
	SeedBytes        int64  `json:"seedBytes,omitempty" minimum:"0"`
	BaseSourceSHA256 string `json:"baseSourceSHA256,omitempty"`
	// A direct AI edit commits its receipt with the checkpoint so the saved
	// state and the durable effect cannot diverge.
	Operation *SourceCheckpointOperation `json:"operation,omitempty"`
	// A text source's opening characters as saved (openwiki/thumbnails.md),
	// written to files.preview with the checkpoint. The collaboration server
	// sends it with every text save; an Office save carries none.
	Preview *string `json:"preview,omitempty"`
}

// sourcePreviewChars is the most characters a saved text preview holds, the
// collaboration server's PREVIEW_CHARS and ingest's TEXT_PREVIEW_CHARS.
const sourcePreviewChars = 600

// SourceCheckpointOperation is the receipt side of a source edit checkpoint.
// The receipt commits without an Undo ref: the collaboration service adds it
// once the source's live room took the edit (its Undo lives there).
type SourceCheckpointOperation struct {
	Receipt SourceCheckpointReceipt `json:"receipt"`
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
	// Access first, so a caller who cannot reach the file learns nothing about
	// the owner's account; checked again under the account locks below.
	if err = sourceActorsAllowed(ctx, tx, ws, actors, edit); err != nil {
		return "", "", err
	}
	accounts := append([]string{owner}, actors...)
	if edit {
		// An edit charges the file's payer (its update log), so its row joins
		// the batch, as material writes lock theirs. The payer is set
		// once at insert, so the unlocked read is stable.
		payer, err := filePayer(ctx, tx, fileID)
		if err != nil {
			return "", "", err
		}
		accounts = append(accounts, payer)
	}
	if err = s.lockAccountSessionsTx(ctx, tx, accounts...); err != nil {
		return "", "", err
	}
	return ws, owner, sourceActorsAllowed(ctx, tx, ws, actors, edit)
}

// filePayer is the account a file is charged to, its uploader (Sam
// 2026-10-18): its account state and storage level gate content edits.
func filePayer(ctx context.Context, q rowQueryer, fileID string) (string, error) {
	var payer string
	err := q.QueryRow(ctx, `SELECT user_id FROM files WHERE id=$1`, fileID).Scan(&payer)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return payer, err
}

// sourceActorsAllowed refuses an actor without read (edit: write) access to
// the workspace, and every actor while the workspace owner is deleted or
// pending deletion, every actor but the owner while the owner is suspended:
// that content is gone for members too, as on every other path.
func sourceActorsAllowed(ctx context.Context, q rowQueryer, ws string, actors []string, edit bool) error {
	for _, actor := range actors {
		if actor == "" {
			return ErrForbidden
		}
		var allowed bool
		err := q.QueryRow(ctx, `SELECT (w.user_id=$2 OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$2 AND (NOT $3 OR m.role IN ('owner','editor'))) OR (w.privacy IN ('link','public') AND (NOT $3 OR w.share_role='editor') AND `+linkReachSQL("w", "$2")+`)) AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL AND (owner.suspended_at IS NULL OR owner.id=$2) FROM workspaces w JOIN users owner ON owner.id=w.user_id WHERE w.id=$1`, ws, actor, edit).Scan(&allowed)
		if err != nil {
			return err
		}
		if !allowed {
			return ErrNotFound
		}
	}
	return nil
}

// sourceEditLockTx admits a refresh: sourceLockTx with edit access, refused
// when the file's payer or the actor is frozen (another account's lifecycle
// lock answers not found, HideOtherAccountLock). Room edits are
// admitted by CheckSourceAccess, which also refuses at the storage limit; a
// checkpoint saves edits the room already admitted, so it takes sourceLockTx
// alone (frozen and the limit are enforced at admission only).
func (s *Store) sourceEditLockTx(ctx context.Context, tx pgx.Tx, fileID string, actor string) (string, string, error) {
	ws, owner, err := s.sourceLockTx(ctx, tx, fileID, []string{actor}, true)
	if err != nil {
		return "", "", HideOtherAccountLock(err, actor)
	}
	// Nobody edits what a frozen account pays for (per item, Sam 2026-10-18).
	payer, err := filePayer(ctx, tx, fileID)
	if err != nil {
		return "", "", err
	}
	if err := s.assertEditableTx(ctx, tx, payer, actor); err != nil {
		return "", "", HideOtherAccountLock(err, actor)
	}
	return ws, owner, nil
}

func (s *Store) SourceSession(ctx context.Context, actor, fileID string) (SourceSession, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceSession{}, err
	}
	defer tx.Rollback(ctx)
	ws, _, err := s.sourceLockTx(ctx, tx, fileID, []string{actor}, false)
	if err != nil {
		return SourceSession{}, err
	}
	var name, kind, path, sha string
	var revision, size int64
	err = tx.QueryRow(ctx, `SELECT name,kind,COALESCE(blob_path,''),COALESCE(source_sha256,''),revision,size_bytes FROM files WHERE id=$1 AND trashed_at IS NULL FOR UPDATE`, fileID).Scan(&name, &kind, &path, &sha, &revision, &size)
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
	if out.BaseRevision == revision {
		out.BaseBytes = &size
	}
	payer, err := filePayer(ctx, tx, fileID)
	if err != nil {
		return out, err
	}
	out.OwnerID = payer
	var canEdit bool
	err = tx.QueryRow(ctx, `SELECT w.user_id=$2 OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$2 AND m.role IN ('owner','editor')) OR(w.privacy IN ('link','public') AND w.share_role='editor' AND `+linkReachSQL("w", "$2")+`) FROM workspaces w WHERE id=$1`, ws, actor).Scan(&canEdit)
	if err != nil {
		return out, err
	}
	out.Access = "read"
	if canEdit {
		var locked *AccountLockedError
		var full *QuotaExceededError
		switch err := s.assertContentEditableTx(ctx, tx, payer, actor); {
		case err == nil:
			out.Access = "write"
		case errors.As(err, &full):
			out.StorageFull = FullBy(true, payer, actor)
		case !errors.As(err, &locked):
			return out, err
		}
	}
	return out, tx.Commit(ctx)
}

// ViewSourceSession is the viewer's read: authorization is the caller's
// (fileRead), so it takes no locks, inserts no row and never consults account
// state. State rides along only when a saved checkpoint is ahead of the
// indexed one, or while a rebuild is pending (the base is the old file, the
// published edits live in the state); a file nobody has edited answers with
// its blob alone.
func (s *Store) ViewSourceSession(ctx context.Context, fileID string) (BrowserSourceSession, error) {
	out := BrowserSourceSession{FileID: fileID, Access: "read"}
	var name, kind string
	var revision, size int64
	err := s.pool.QueryRow(ctx, `SELECT f.revision,f.size_bytes,`+sourceGrowthSQL+`,f.workspace_id,f.name,f.kind,COALESCE(d.epoch,0),COALESCE(d.checkpoint,0),COALESCE(d.indexed_checkpoint,0),COALESCE(d.base_revision,f.revision),COALESCE(d.base_blob_path,f.blob_path,''),COALESCE(d.base_source_sha256,f.source_sha256,''),CASE WHEN d.checkpoint>d.indexed_checkpoint OR d.rebuild_pending THEN d.state END,CASE WHEN d.checkpoint>d.indexed_checkpoint OR d.rebuild_pending THEN d.state_seed_sha256 END,CASE WHEN d.checkpoint>d.indexed_checkpoint OR d.rebuild_pending THEN `+sourceStateRowsSQL+` END FROM files f LEFT JOIN source_documents d ON d.file_id=f.id WHERE f.id=$1 AND f.trashed_at IS NULL`, fileID).Scan(&revision, &size, &out.GrownBytes, &out.WorkspaceID, &name, &kind, &out.Epoch, &out.Checkpoint, &out.IndexedCheckpoint, &out.BaseRevision, &out.BaseBlobPath, &out.BaseSourceSHA256, &out.State, &out.StateSeedSHA256, &out.StateRows)
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
	if out.BaseRevision == revision {
		out.BaseBytes = &size
	}
	out.Room = fmt.Sprintf("source:%s:epoch:%d", fileID, out.Epoch)
	out.SourceIdentity = fmt.Sprintf("revision:%d", out.BaseRevision)
	return out, nil
}

// CheckSourceAccess revalidates each incoming edit without loading or encoding
// the complete current and indexed document states. It is a read and takes no
// locks: it commits nothing, so a lock would only make it wait for a
// concurrent ACL, account or publication change, and a change committing just
// after the check is missed either way. Its reads share one snapshot, so the
// owner it reads is the one whose account state it tests. The save that
// persists the edit rechecks every contributor's role and locked account
// (deleted, deletion pending, suspended) under sourceLockTx, and ACL and
// account changes evict the room; frozen accounts and the storage limit are
// enforced at admission only, so they rely on this 5 s recheck window. Locking
// here serialized every writer's recheck with every write in the workspace.
func (s *Store) CheckSourceAccess(ctx context.Context, actor, fileID string, epoch int64, edit bool) error {
	if actor == "" {
		return ErrForbidden
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var ws, owner string
	var current bool
	var payer string
	err = tx.QueryRow(ctx, `SELECT f.workspace_id,w.user_id,f.user_id,EXISTS(SELECT 1 FROM source_documents d WHERE d.file_id=f.id AND d.epoch=$2 AND d.base_revision=f.revision) FROM files f JOIN workspaces w ON w.id=f.workspace_id WHERE f.id=$1 AND f.trashed_at IS NULL`, fileID, epoch).Scan(&ws, &owner, &payer, &current)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if err = sourceActorsAllowed(ctx, tx, ws, []string{actor}, edit); err != nil {
		return err
	}
	if err = checkAccountSessions(ctx, tx, false, owner, actor); err != nil {
		return err
	}
	if edit {
		if err = s.assertContentEditableTx(ctx, tx, payer, actor); err != nil {
			return err
		}
	}
	if !current {
		return ErrConflict
	}
	return tx.Commit(ctx)
}

// sourceStateRowsSQL: the rows saved over d.state, in order, read in the
// statement that reads the state (a fold moves rows into it meanwhile).
const sourceStateRowsSQL = `ARRAY(SELECT u.update FROM source_document_updates u WHERE u.file_id=d.file_id AND u.epoch=d.epoch ORDER BY u.checkpoint)`

func readSourceSession(ctx context.Context, tx pgx.Tx, fileID, ws string) (SourceSession, error) {
	out := SourceSession{BrowserSourceSession: BrowserSourceSession{FileID: fileID, WorkspaceID: ws, Access: "read"}}
	err := tx.QueryRow(ctx, `SELECT d.format,d.epoch,d.checkpoint,d.indexed_checkpoint,d.base_revision,d.base_blob_path,d.base_source_sha256,d.state,d.state_seed_sha256,`+sourceStateRowsSQL+`,d.net_tokens,d.rebuild_pending,d.published_state,d.published_state_seed_sha256,CASE WHEN d.rebuild_pending THEN COALESCE(f.blob_path,'') ELSE '' END,CASE WHEN d.rebuild_pending THEN COALESCE(f.source_sha256,'') ELSE '' END,`+sourceGrowthSQL+` FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1`, fileID).Scan(&out.Format, &out.Epoch, &out.Checkpoint, &out.IndexedCheckpoint, &out.BaseRevision, &out.BaseBlobPath, &out.BaseSourceSHA256, &out.State, &out.StateSeedSHA256, &out.StateRows, &out.NetTokens, &out.RebuildPending, &out.PublishedState, &out.PublishedStateSeedSHA256, &out.PublishedBlobPath, &out.PublishedSourceSHA256, &out.GrownBytes)
	out.Room = fmt.Sprintf("source:%s:epoch:%d", fileID, out.Epoch)
	out.SourceIdentity = fmt.Sprintf("revision:%d", out.BaseRevision)
	return out, err
}

// sha256Hex reports whether s is a lowercase hex SHA-256 digest.
func sha256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
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
	if len(in.Update) == 0 || len(in.Update) > 100<<20 || in.NetTokens < 0 || json.Unmarshal(in.PendingEffects, &effects) != nil || effects == nil {
		return out, ErrInvalidCheckpoint
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	ws, _, err := s.sourceLockTx(ctx, tx, fileID, in.ActorIDs, true)
	if err != nil {
		return out, err
	}
	// Sizes only: the stored state alone may reach 100 MB.
	var format, sha string
	var storedSeed *string
	var epoch, baseRevision, seedBytes int64
	var seeded bool
	if err = tx.QueryRow(ctx, `SELECT format,epoch,checkpoint,base_revision,base_source_sha256,seed_bytes,state IS NULL AND log_rows=0,state_seed_sha256 FROM source_documents WHERE file_id=$1`, fileID).Scan(&format, &epoch, &out.Checkpoint, &baseRevision, &sha, &seedBytes, &seeded, &storedSeed); err != nil {
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
	// The maintenance pause refuses committing an Office agent edit (a
	// replayed receipt above still answers); saves of rooms already open still
	// land, so the pause's flush persists.
	if in.Operation != nil && format != "text" {
		var paused bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM office_editing_pause)`).Scan(&paused); err != nil {
			return out, err
		}
		if paused {
			return out, ErrOfficeEditingPaused
		}
	}
	if epoch != in.Epoch {
		return out, ErrSourceEpochChanged
	}
	if out.Checkpoint != in.ExpectedCheckpoint {
		return out, ErrCheckpointMoved
	}
	var revision int64
	// The stored preview is read with the lock, so an unchanged one costs no
	// statement below.
	var preview *string
	if err = tx.QueryRow(ctx, `SELECT revision, preview->>'text' FROM files WHERE id=$1 AND trashed_at IS NULL FOR UPDATE`, fileID).Scan(&revision, &preview); err != nil {
		return out, err
	}
	if revision != baseRevision || in.BaseRevision != baseRevision {
		return out, ErrCheckpointMoved
	}
	// The first save over seed(base) binds the session's base SHA once (the
	// one the upload recorded, when there is one), and a text source records
	// its seed's size then; later saves carry neither, and Office sources never
	// carry a seed size. The file's own SHA is the upload's and ingest's to
	// write (Epo 2026-10-17).
	text := format == "text"
	if (seeded && text) != (in.SeedBytes > 0) || (!seeded && in.BaseSourceSHA256 != "") {
		return out, ErrInvalidCheckpoint
	}
	if in.Preview != nil && (!text || !validSourcePreview(*in.Preview)) {
		return out, ErrInvalidCheckpoint
	}
	if seeded {
		if len(in.BaseSourceSHA256) != 64 || (sha != "" && sha != in.BaseSourceSHA256) {
			return out, ErrInvalidCheckpoint
		}
		sha = in.BaseSourceSHA256
		if text {
			seedBytes = in.SeedBytes
		}
	}
	// An Office document is a change over seed(base), every row over the seed
	// the stored state names (the first row names it over a NULL state); text
	// is complete.
	if text != (in.StateSeedSHA256 == "") || (!text && !sha256Hex(in.StateSeedSHA256)) || (storedSeed != nil && *storedSeed != in.StateSeedSHA256) {
		return out, ErrInvalidCheckpoint
	}
	// The row goes in at the next checkpoint; a capture keeps reading the rows
	// up to its own (the collaboration service materializes it at export).
	if _, err = tx.Exec(ctx, `INSERT INTO source_document_updates(file_id,epoch,checkpoint,update) VALUES($1,$2,$3,$4)`, fileID, epoch, out.Checkpoint+1, in.Update); err != nil {
		return out, err
	}
	err = tx.QueryRow(ctx, `UPDATE source_documents SET effects_cache=NULL,state_seed_sha256=NULLIF($7,''),seed_bytes=$5,base_source_sha256=$6,pending_effects=$3,net_tokens=$4,log_bytes=log_bytes+$2,log_rows=log_rows+1,checkpoint=checkpoint+1,last_edited_at=now(),updated_at=now(),desired_checkpoint=CASE WHEN desired_manual THEN checkpoint+1 ELSE NULL END,refresh_error=NULL WHERE file_id=$1 RETURNING checkpoint`, fileID, int64(len(in.Update)), in.PendingEffects, in.NetTokens, seedBytes, sha, in.StateSeedSHA256).Scan(&out.Checkpoint)
	if err != nil {
		return out, err
	}
	// The list card's text follows every save, not only the next ingest; an
	// unchanged preview writes nothing (and raises no tree event).
	if in.Preview != nil && (preview == nil || *preview != *in.Preview) {
		if _, err = tx.Exec(ctx, `UPDATE files SET preview=jsonb_build_object('text', $2::text) WHERE id=$1`, fileID, *in.Preview); err != nil {
			return out, err
		}
	}
	if in.Operation != nil {
		receipt, err := s.commitSourceOperationTx(ctx, tx, fileID, ws, *in.Operation)
		if err != nil {
			return out, err
		}
		out.Operation = &receipt
	}
	return out, tx.Commit(ctx)
}

// validSourcePreview: at most sourcePreviewChars characters of UTF-8 with no
// NUL, which jsonb cannot hold.
func validSourcePreview(preview string) bool {
	return utf8.ValidString(preview) && utf8.RuneCountInString(preview) <= sourcePreviewChars &&
		!strings.ContainsRune(preview, 0)
}

// commitSourceOperationTx records the edit's receipt in the checkpoint's
// transaction.
func (s *Store) commitSourceOperationTx(ctx context.Context, tx pgx.Tx, fileID, ws string, op SourceCheckpointOperation) (AgentOperation, error) {
	receipt := op.Receipt.operation()
	receipt.WorkspaceID = ws
	receipt.Outcome = agenttools.OutcomeSucceeded
	var name string
	err := tx.QueryRow(ctx, `SELECT name FROM files WHERE id=$1`, fileID).Scan(&name)
	if err != nil {
		return AgentOperation{}, err
	}
	effect := agenttools.ResourceEffect{
		Resource:    agenttools.ResourceRef{Kind: agenttools.KindSourceFile, ID: fileID, Title: name, WorkspaceID: ws},
		OperationID: receipt.ID,
	}
	receipt.Kind = "edit_document"
	effect.Operation = agenttools.EffectEdited
	receipt.Effect = &effect
	if err := insertAgentOperationTx(ctx, tx, receipt); err != nil {
		return AgentOperation{}, err
	}
	return receipt, nil
}

// Automatic Office refresh: officeRefreshTokens tokens of edited text (the
// count each save adds, Q405) after officeRefreshIdle without edits, or any
// counted change left unedited for officeRefreshStale. The collaboration
// scheduler query uses the same values.
const (
	officeRefreshTokens = 3000
	officeRefreshIdle   = 60 * time.Second
	officeRefreshStale  = 7 * 24 * time.Hour
	// A text source refreshes once its saves pause this long (a note's
	// projection idle); the scheduler query's text branch uses the same.
	textRefreshIdle = 30 * time.Second
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
	return s.requestSourceRefresh(ctx, actor, fileID, automatic, models.PaidByPlatform, false)
}

// requestSourceRefresh with paidBy models.PaidBySystem is the maintenance
// publication (PublishAllOfficeSources), the only caller that sets it: the
// owner's credits are neither checked, reserved nor debited, and neither the
// owner's account state, the trash nor the storage quota refuses it.
// exportOnly publishes the saved state as the file's bytes without parsing
// (publishExportTx); automatic admission also chooses it for store-only files.
func (s *Store) requestSourceRefresh(ctx context.Context, actor, fileID string, automatic bool, paidBy string, exportOnly bool) (SourceProcessResult, error) {
	system := paidBy == models.PaidBySystem
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceProcessResult{}, err
	}
	defer tx.Rollback(ctx)
	var ws, owner string
	if system {
		ws, owner, err = s.maintenanceLockTx(ctx, tx, fileID)
	} else {
		ws, owner, err = s.sourceEditLockTx(ctx, tx, fileID, actor)
	}
	if err != nil {
		return SourceProcessResult{}, err
	}
	doc, err := readSourceSession(ctx, tx, fileID, ws)
	if isNoRows(err) {
		return SourceProcessResult{}, ErrNothingToProcess
	}
	if err != nil {
		return SourceProcessResult{}, err
	}
	var name, kind, mode, status string
	var ever, indexed, reprocess, autoProcess, manual bool
	var edited time.Time
	var running, refreshError, rebuildRefusal *string
	err = tx.QueryRow(ctx, `SELECT f.name,f.kind,f.parse_mode,f.status,f.ever_parsed_successfully,f.indexed,COALESCE(d.reprocess_at<=now(),false),w.auto_process,d.last_edited_at,d.running_job_id,d.desired_manual,d.refresh_error,d.rebuild_refusal FROM files f JOIN workspaces w ON w.id=f.workspace_id JOIN source_documents d ON d.file_id=f.id WHERE f.id=$1 AND (f.trashed_at IS NULL OR $2) FOR UPDATE OF f,d`, fileID, system).Scan(&name, &kind, &mode, &status, &ever, &indexed, &reprocess, &autoProcess, &edited, &running, &manual, &refreshError, &rebuildRefusal)
	if isNoRows(err) {
		return SourceProcessResult{}, ErrNothingToProcess
	}
	if err != nil {
		return SourceProcessResult{}, err
	}
	result := SourceProcessResult{FileID: fileID, Checkpoint: doc.Checkpoint, Status: "pending"}
	// Reprocessing is owner-only whether manual or automatic; editors only see
	// the pending-context label.
	if actor != owner {
		return result, ErrForbidden
	}
	storeOnly := mode == "none" && !ever
	if automatic {
		// An export-only publication left unindexed bytes: the scheduler's
		// reprocess branch indexes them at platform cost before anything else.
		if reprocess && !indexed && ever && doc.Format != "text" && running == nil {
			return s.reprocessTx(ctx, tx, result, ws, owner, name, kind, mode)
		}
		// A failed file is processed only when the owner asks (Retry
		// processing, or Process queued behind a running job), unless it is
		// partial: still indexed with a part missing (parts design Q1), which
		// the next refresh may fill.
		if refreshError != nil || (status == string(FileFailed) && !indexed && !manual) {
			return result, ErrConflict
		}
		// A text file's edits worth no tokens (undone) never refresh. An
		// Office save counts the text it inserted and deleted (Q405), so
		// pictures or formatting alone count 0: such a file waits for the
		// stale rule (Q435). A refused rebuild (RefuseSourceRebuild) makes
		// the file due whatever its edits weigh.
		refused := rebuildRefusal != nil
		if doc.Checkpoint <= doc.IndexedCheckpoint || (!refused && doc.NetTokens == 0 && doc.Format == "text") {
			return result, ErrConflict
		}
		if doc.Format == "text" {
			if (!autoProcess && !manual) || time.Since(edited) < textRefreshIdle {
				return result, ErrConflict
			}
		} else {
			// Store-only files publish export-only under the same trigger,
			// whatever auto-process says; the owner's Process stays their
			// opt-in first parse.
			exportOnly = storeOnly && !manual
			due := doc.NetTokens >= officeRefreshTokens || time.Since(edited) >= officeRefreshStale || refused
			if ((!due || !(exportOnly || autoProcess && ever)) && !manual) || time.Since(edited) < officeRefreshIdle {
				return result, ErrConflict
			}
		}
	}
	if running != nil {
		result.JobID = *running
		if system {
			return result, tx.Commit(ctx) // publish-all runs again once it finishes
		}
		if !automatic {
			if _, err = s.upgradeExportTx(ctx, tx, *running, actor, ws, name, kind, mode, ever); err != nil {
				return result, err
			}
		}
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
	switch {
	case exportOnly: // no parser or provider call
	case system:
		reservation, err = beginSystemIngestSessionTx(ctx, tx, payer, ws)
	default:
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
	jobID := uid("job")
	lease := uid("srclease")
	// The per-page parse fee applies to a file's first parse only; a refresh of
	// a parsed file pays its provider calls and records its pages uncharged.
	fields := map[string]any{"fileId": fileID, "workspaceId": ws, "sourceRefresh": true, "sourceEpoch": doc.Epoch, "sourceCheckpoint": doc.Checkpoint, "sourceLeaseToken": lease, "sourceRevision": doc.BaseRevision, "sourceETag": "", "blobPath": doc.BaseBlobPath, "kind": kind, "format": doc.Format, "parseMode": mode, "processingPlan": plan, "reservationId": reservation, "requestedBy": actor, "automatic": automatic, "parseFee": !ever && !system && !exportOnly, "paidBy": paidBy, "exportOnly": exportOnly}
	// The republication of a refused rebuild records the refusal it replaces.
	if rebuildRefusal != nil {
		fields["rebuildRefusal"] = *rebuildRefusal
	}
	payload, err := s.ingestJobPayload(ctx, tx, payer, fields)
	if err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO jobs(id,type,payload) VALUES($1,'source_refresh',$2)`, jobID, payload); err != nil {
		return result, err
	}
	// The candidate's state stays NULL until finalize records the capture its
	// export was built from (null there too: seed(base)). A transient
	// candidate is uncharged; publication gates the net growth.
	if _, err = tx.Exec(ctx, `INSERT INTO source_refresh_candidates(file_id,job_id,epoch,checkpoint,lease_token) VALUES($1,$2,$3,$4,$5)`, fileID, jobID, doc.Epoch, doc.Checkpoint, lease); err != nil {
		return result, err
	}
	// A maintenance request is not the owner's Process: a failed one must not
	// turn the next automatic refresh into a manual one.
	if _, err = tx.Exec(ctx, `UPDATE source_documents SET running_job_id=$2,desired_checkpoint=$3,desired_manual=desired_manual OR $4,refresh_error=NULL,last_refresh_requested_at=now() WHERE file_id=$1`, fileID, jobID, doc.Checkpoint, !automatic && !system); err != nil {
		return result, err
	}
	result.JobID = jobID
	return result, tx.Commit(ctx)
}
