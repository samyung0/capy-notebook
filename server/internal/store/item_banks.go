package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// Item banks (Epo 2026-11-14, todo-graded-quizzes.md): questions in the shared
// question format with free-text tags, kept for reuse. There are two: the
// caller's own ("me"), which nobody else sees, and a class workspace's, which
// its owner and editor members see and edit; anyone else is answered not
// found. A question comes in as a copy and goes into a quiz as a copy, so a
// bank edit never reaches a quiz. Its images and drawn samples are copies
// too, charged to whoever put them there (uploader pays).

// PersonalBank names the caller's own bank in a bank route; any other value
// is a class workspace's id.
const PersonalBank = "me"

// BankQuestionsPerBank bounds one bank: its page reads a filtered count.
const BankQuestionsPerBank = 2_000

var (
	ErrTooManyBankQuestions = errors.New("this bank holds the most questions it can")
	// ErrBankQuestionAssets: copying the question left a part with nothing in
	// it, because its only figure could not be copied.
	ErrBankQuestionAssets = errors.New("an image of this question could not be copied")
)

// ItemBank is one bank the caller may use.
type ItemBank struct {
	ID    string `json:"id" doc:"me for the caller's own bank, else the class workspace's id"`
	Kind  string `json:"kind" enum:"personal,workspace"`
	Name  string `json:"name" doc:"The workspace's name; empty for the caller's own bank"`
	Count int    `json:"count" doc:"Questions in it"`
}

// ItemBankQuestion is one question of a bank, keys and all: only its editors
// read a bank. A class bank's question may carry topics of its own
// (`topicIds`, the workspace's topics; Epo 2026-11-15); My bank's carry none.
type ItemBankQuestion struct {
	ID        string         `json:"id"`
	Question  map[string]any `json:"question"`
	Tags      []string       `json:"tags" nullable:"false"`
	CreatedAt time.Time      `json:"createdAt"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

type ItemBankPage struct {
	Items []ItemBankQuestion `json:"items" nullable:"false"`
	// Total counts every question matching the filter, across pages.
	Total      int    `json:"total"`
	NextCursor string `json:"nextCursor,omitempty"`
}

// ItemBankFilter narrows a bank's list: Query matches its words (SearchText),
// Tags keeps questions holding any of them, Topics those with any of them as
// a topic of their own.
type ItemBankFilter struct {
	Query  string
	Tags   []string
	Topics []string
	Limit  int
	Cursor string
}

// bankScope is a bank's rows: user_id for a personal bank, workspace_id for a
// class's.
type bankScope struct {
	column, value string
}

var bankQuestionSort = listSort{column: "created_at", kind: "time"}

// bankQuestionRead is a bank question (aliased q) as read: a topic its bank's
// workspace does not hold (deleted since, or any in My bank) is left out, as a
// quiz question's is ignored, and the list with it once empty.
const bankQuestionRead = `CASE WHEN q.question ? 'topicIds' THEN (
		SELECT CASE WHEN count(t.id) = 0 THEN q.question - 'topicIds'
			ELSE jsonb_set(q.question, '{topicIds}', jsonb_agg(t.id ORDER BY o.n)) END
		FROM jsonb_array_elements_text(q.question->'topicIds') WITH ORDINALITY o(id, n)
		JOIN topics t ON t.id = o.id AND t.workspace_id = q.workspace_id)
	ELSE q.question END`

// itemBankScope admits the caller to a bank: their own, or a class's they are
// an owner or editor member of (assignmentStaff); anything else is not found.
func (s *Store) itemBankScope(ctx context.Context, q rowQueryer, actorID, bank string) (bankScope, error) {
	if bank == PersonalBank {
		return bankScope{"user_id", actorID}, nil
	}
	staff, err := s.assignmentStaff(ctx, q, actorID, bank)
	if err != nil {
		return bankScope{}, err
	}
	if !staff {
		return bankScope{}, ErrNotFound
	}
	return bankScope{"workspace_id", bank}, nil
}

// lockItemBankTx admits a write to a bank: the caller's live, editable account
// for their own; for a class's, its workspace's editor lock and the caller
// still staff once it is held.
func (s *Store) lockItemBankTx(ctx context.Context, tx pgx.Tx, actorID, bank string) (bankScope, error) {
	if bank == PersonalBank {
		if err := s.lockAccountSessionsTx(ctx, tx, actorID); err != nil {
			return bankScope{}, err
		}
		if err := s.assertEditableTx(ctx, tx, actorID); err != nil {
			return bankScope{}, err
		}
		return bankScope{"user_id", actorID}, nil
	}
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, bank, actorID); err != nil {
		if errors.Is(err, ErrForbidden) {
			return bankScope{}, ErrNotFound
		}
		return bankScope{}, err
	}
	return s.itemBankScope(ctx, tx, actorID, bank)
}

// ItemBanks lists the banks the caller may use from a workspace: the class's
// own when they are its staff, then their own. With no workspace, their own.
func (s *Store) ItemBanks(ctx context.Context, actorID, workspaceID string) ([]ItemBank, error) {
	var banks []ItemBank
	if workspaceID != "" {
		if _, err := s.itemBankScope(ctx, s.pool, actorID, workspaceID); err == nil {
			bank := ItemBank{ID: workspaceID, Kind: "workspace"}
			if err := s.pool.QueryRow(ctx, `SELECT w.name,
					(SELECT count(*) FROM item_bank_questions q WHERE q.workspace_id=w.id)
				FROM workspaces w WHERE w.id=$1`, workspaceID).Scan(&bank.Name, &bank.Count); err != nil {
				return nil, err
			}
			banks = append(banks, bank)
		} else if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
	}
	own := ItemBank{ID: PersonalBank, Kind: "personal"}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM item_bank_questions WHERE user_id=$1`, actorID).Scan(&own.Count); err != nil {
		return nil, err
	}
	return append(banks, own), nil
}

// ListItemBankQuestions pages through a bank, newest first; a search pages
// through its hits by relevance (listBankSearch).
func (s *Store) ListItemBankQuestions(ctx context.Context, actorID, bank string, f ItemBankFilter) (ItemBankPage, error) {
	scope, err := s.itemBankScope(ctx, s.pool, actorID, bank)
	if err != nil {
		return ItemBankPage{}, err
	}
	limit := f.Limit
	if limit <= 0 || limit > listPageMax {
		limit = listPageMax
	}
	where := scope.column + `=$1`
	args := []any{scope.value}
	if len(f.Tags) > 0 {
		args = append(args, f.Tags)
		where += fmt.Sprintf(` AND tags && $%d::text[]`, len(args))
	}
	if len(f.Topics) > 0 {
		args = append(args, f.Topics)
		where += fmt.Sprintf(` AND EXISTS (SELECT 1 FROM topics t
			WHERE t.workspace_id = q.workspace_id AND t.id = ANY($%d::text[]) AND q.question->'topicIds' ? t.id)`, len(args))
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		return s.listBankSearch(ctx, where, args, q, limit, f.Cursor)
	}
	page := ItemBankPage{Items: []ItemBankQuestion{}}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM item_bank_questions q WHERE `+where, args...).Scan(&page.Total); err != nil {
		return ItemBankPage{}, err
	}
	clause, cursorArgs, err := cursorClause(bankQuestionSort, "id", false, f.Cursor, len(args)+1)
	if err != nil {
		return ItemBankPage{}, err
	}
	args = append(args, cursorArgs...)
	args = append(args, limit+1)
	rows, err := s.pool.Query(ctx, `SELECT id, `+bankQuestionRead+`, tags, created_at, updated_at
		FROM item_bank_questions q WHERE `+where+clause+orderClause(bankQuestionSort, "id", false)+
		fmt.Sprintf(` LIMIT $%d`, len(args)), args...)
	if err != nil {
		return ItemBankPage{}, err
	}
	items, err := pgx.CollectRows(rows, scanBankQuestion)
	if err != nil {
		return ItemBankPage{}, err
	}
	page.Items = items
	if len(items) > limit {
		last := items[limit-1]
		page.Items = items[:limit]
		page.NextCursor = encodeListCursor(cursorPrimary(bankQuestionSort, last.CreatedAt, "", 0), last.ID)
	}
	return page, nil
}

// bankSearchCursor marks a search page's cursor, which carries its offset:
// the hits are re-ranked on every page, a bank holding at most
// BankQuestionsPerBank of them.
const bankSearchCursor = "search"

// listBankSearch is a bank search with typos tolerated as global search does
// them (search_typos, migration 0172; Epo 2026-11-15, "can u see the commit
// f24396c9c and whether we can added something similar"): a question matches
// when its text holds the query or each query word is within the edits its
// length allows. Hits holding the query as typed come first, then fewer
// typos, then the newest; a hit with typos shows only while fewer than
// searchFewHits hits are closer (Search's fewestTypos), so a close match is
// not buried under loose ones.
func (s *Store) listBankSearch(ctx context.Context, where string, args []any, query string, limit int, cursor string) (ItemBankPage, error) {
	offset := 0
	if primary, id, ok, err := decodeListCursor(cursor); err != nil {
		return ItemBankPage{}, err
	} else if ok {
		n, err := strconv.Atoi(primary)
		if id != bankSearchCursor || err != nil || n < 0 {
			return ItemBankPage{}, ErrInvalidCursor
		}
		offset = n
	}
	args = append(args, containsPattern(query), strings.ToLower(query), searchFewHits, limit+1, offset)
	n := len(args)
	// One pass: search_typos is skipped for a question holding the query, and
	// closer counts the hits with fewer typos by a window, not per row.
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`WITH matched AS (
			SELECT * FROM (
				SELECT q.*, q.search_text LIKE $%[1]d AS phrase,
					CASE WHEN q.search_text LIKE $%[1]d THEN 0 ELSE search_typos(q.search_text, $%[2]d) END AS typos
				FROM item_bank_questions q WHERE %[6]s) m
			WHERE typos IS NOT NULL),
		ranked AS (SELECT *, count(*) OVER (ORDER BY typos RANGE BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS closer
			FROM matched)
		SELECT id, `+bankQuestionRead+`, tags, created_at, updated_at, count(*) OVER ()
		FROM ranked q WHERE closer < $%[3]d
		ORDER BY phrase DESC, typos, created_at DESC, id DESC LIMIT $%[4]d OFFSET $%[5]d`,
		n-4, n-3, n-2, n-1, n, where), args...)
	if err != nil {
		return ItemBankPage{}, err
	}
	// The total rides on every row; a page past the end has none, and the
	// lists read the total from their first page.
	page := ItemBankPage{Items: []ItemBankQuestion{}}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (ItemBankQuestion, error) {
		var item ItemBankQuestion
		var raw []byte
		if err := row.Scan(&item.ID, &raw, &item.Tags, &item.CreatedAt, &item.UpdatedAt, &page.Total); err != nil {
			return item, err
		}
		return item, json.Unmarshal(raw, &item.Question)
	})
	if err != nil {
		return ItemBankPage{}, err
	}
	page.Items = items
	if len(items) > limit {
		page.Items = items[:limit]
		page.NextCursor = encodeListCursor(strconv.Itoa(offset+limit), bankSearchCursor)
	}
	return page, nil
}

func scanBankQuestion(row pgx.CollectableRow) (ItemBankQuestion, error) {
	var item ItemBankQuestion
	var raw []byte
	if err := row.Scan(&item.ID, &raw, &item.Tags, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	return item, json.Unmarshal(raw, &item.Question)
}

// ItemBankTags is every tag a bank's questions hold, in name order, for its
// Tags filter.
func (s *Store) ItemBankTags(ctx context.Context, actorID, bank string) ([]string, error) {
	scope, err := s.itemBankScope(ctx, s.pool, actorID, bank)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT t FROM item_bank_questions, unnest(tags) t
		WHERE `+scope.column+`=$1 ORDER BY t`, scope.value)
	if err != nil {
		return nil, err
	}
	return scanIDs(rows)
}

// CreateItemBankQuestion copies a question into a bank (New question, Add to
// bank). The images and drawn samples it names that the caller may read are
// copied for it, charged to the caller.
func (s *Store) CreateItemBankQuestion(ctx context.Context, actorID, bank string, question map[string]any, tags []string) (ItemBankQuestion, error) {
	var item ItemBankQuestion
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		scope, err := s.lockItemBankTx(ctx, tx, actorID, bank)
		if err != nil {
			return err
		}
		var held int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM item_bank_questions WHERE `+scope.column+`=$1`, scope.value).Scan(&held); err != nil {
			return err
		}
		if held >= BankQuestionsPerBank {
			return ErrTooManyBankQuestions
		}
		id := uid("bq")
		column := scope.column
		if _, err := tx.Exec(ctx, `INSERT INTO item_bank_questions (id, `+column+`, question, created_by)
			VALUES ($1, $2, '{}', $3)`, id, scope.value, actorID); err != nil {
			return err
		}
		item, err = s.writeBankQuestionTx(ctx, tx, actorID, id, question, tags)
		return err
	})
	return item, err
}

// UpdateItemBankQuestion replaces a bank question and its tags. Images it no
// longer names are deleted; new ones are copied as on create.
func (s *Store) UpdateItemBankQuestion(ctx context.Context, actorID, bank, id string, question map[string]any, tags []string) (ItemBankQuestion, error) {
	var item ItemBankQuestion
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		scope, err := s.lockItemBankTx(ctx, tx, actorID, bank)
		if err != nil {
			return err
		}
		var found bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM item_bank_questions
			WHERE id=$1 AND `+scope.column+`=$2)`, id, scope.value).Scan(&found); err != nil {
			return err
		}
		if !found {
			return ErrNotFound
		}
		item, err = s.writeBankQuestionTx(ctx, tx, actorID, id, question, tags)
		return err
	})
	return item, err
}

// DeleteItemBankQuestion deletes a bank question; its images go with it.
func (s *Store) DeleteItemBankQuestion(ctx context.Context, actorID, bank, id string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		scope, err := s.lockItemBankTx(ctx, tx, actorID, bank)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM item_bank_questions WHERE id=$1 AND `+scope.column+`=$2`, id, scope.value)
		if err == nil && tag.RowsAffected() == 0 {
			err = ErrNotFound
		}
		return err
	})
}

// writeBankQuestionTx stores an admitted question on row id: it keeps the
// row's own images, copies the others the caller may read, drops the rest
// (RewriteAssetIDs), deletes the row's images it no longer names, then saves
// the content, tags and search text.
func (s *Store) writeBankQuestionTx(ctx context.Context, tx pgx.Tx, actorID, id string, question map[string]any, tags []string) (ItemBankQuestion, error) {
	idMap, err := s.adoptBankAssetsTx(ctx, tx, actorID, id, questions.AssetIDs(question))
	if err != nil {
		return ItemBankQuestion{}, err
	}
	if !questions.RewriteAssetIDs(question, idMap) {
		return ItemBankQuestion{}, ErrBankQuestionAssets
	}
	kept := make([]string, 0, len(idMap))
	for _, assetID := range idMap {
		kept = append(kept, assetID)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM editor_assets WHERE bank_question_id=$1 AND NOT (id = ANY($2::text[]))`, id, kept); err != nil {
		return ItemBankQuestion{}, err
	}
	content, err := json.Marshal(question)
	if err != nil {
		return ItemBankQuestion{}, err
	}
	if tags == nil {
		tags = []string{}
	}
	rows, err := tx.Query(ctx, `UPDATE item_bank_questions q
		SET question=$2, tags=$3, search_text=$4, updated_at=now()
		WHERE id=$1 RETURNING id, `+bankQuestionRead+`, tags, created_at, updated_at`,
		id, content, tags, questions.SearchText(question))
	if err != nil {
		return ItemBankQuestion{}, err
	}
	return pgx.CollectExactlyOneRow(rows, scanBankQuestion)
}

// adoptBankAssetsTx maps each asset id the question names to the bank
// question's own: its own keeps its id; another the caller may read (the
// resolve rule), ready and under the caller's plan cap becomes a new ready
// row sharing the stored object, charged to the caller after the storage gate.
// Anything else maps to nothing.
func (s *Store) adoptBankAssetsTx(ctx context.Context, tx pgx.Tx, actorID, questionID string, ids []string) (map[string]string, error) {
	idMap := map[string]string{}
	if len(ids) == 0 {
		return idMap, nil
	}
	limits, err := s.PayerPlanLimits(ctx, actorID)
	if err != nil {
		return nil, err
	}
	// Share-locking the sources holds off their deletion, so each copied path
	// still has a blob reference when the copies add theirs.
	rows, err := tx.Query(ctx, `SELECT `+editorAssetCols+` FROM editor_assets
		WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, ids)
	if err != nil {
		return nil, err
	}
	sources, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (EditorAsset, error) { return scanEditorAsset(row) })
	if err != nil {
		return nil, err
	}
	var copies []EditorAsset
	var paths []string
	var bytes int64
	for _, asset := range sources {
		if asset.BankQuestionID == questionID {
			idMap[asset.ID] = asset.ID
			continue
		}
		if asset.Status != "ready" || asset.SizeBytes > limits.EditorAssetBytes(asset.Purpose) {
			continue
		}
		readable, err := s.editorAssetReadable(ctx, tx, actorID, asset)
		if err != nil {
			return nil, err
		}
		if !readable {
			continue
		}
		copies = append(copies, asset)
		paths = append(paths, asset.ObjectPath)
		bytes += asset.SizeBytes
	}
	if len(copies) == 0 {
		return idMap, nil
	}
	if err := lockCloneBlobPathsTx(ctx, tx, paths); err != nil {
		return nil, err
	}
	if err := s.gateStorageTx(ctx, tx, actorID, bytes); err != nil {
		return nil, err
	}
	for _, asset := range copies {
		newID := uid("asset")
		if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
			(id, bank_question_id, user_id, created_by, name, purpose, object_path,
			 content_type, size_bytes, status, etag, completed_at, thumbnail_key)
			VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,'ready',$9,now(),
			 (SELECT thumbnail_key FROM editor_assets WHERE id=$10))`,
			newID, questionID, actorID, asset.Name, asset.Purpose, asset.ObjectPath,
			asset.ContentType, asset.SizeBytes, nullStr(asset.ETag), asset.ID); err != nil {
			return nil, err
		}
		idMap[asset.ID] = newID
	}
	return idMap, nil
}

// bankAssetReadable admits who may read the bank question's images: the
// bank's own readers (itemBankScope).
func (s *Store) bankAssetReadable(ctx context.Context, q rowQueryer, actorID string, asset EditorAsset) (bool, error) {
	var userID, workspaceID string
	err := q.QueryRow(ctx, `SELECT COALESCE(user_id,''), COALESCE(workspace_id,'')
		FROM item_bank_questions WHERE id=$1`, asset.BankQuestionID).Scan(&userID, &workspaceID)
	if err != nil {
		if isNoRows(err) {
			return false, ErrNotFound
		}
		return false, err
	}
	if userID != "" {
		return userID == actorID, nil
	}
	_, err = s.itemBankScope(ctx, q, actorID, workspaceID)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}

// BankQuiz is a quiz made from picked bank questions (Add quiz's From the
// bank) in workspace WorkspaceID.
type BankQuiz struct {
	ActorID, Bank              string
	WorkspaceID, WorkspaceName string
	QuestionIDs                []string
	Title                      string
	// GradedPending: made for a graded quiz (Material.GradedPending).
	GradedPending bool
	// Hidden: starts hidden from members (the request handler sets it).
	Hidden bool
}

// CreateQuizFromBank copies the picked questions, in the order given, into a
// new quiz material in the workspace (readBankCopies, copyBankAssetsTx).
func (s *Store) CreateQuizFromBank(ctx context.Context, in BankQuiz) (Material, error) {
	picked, err := s.readBankCopies(ctx, in.ActorID, in.Bank, in.QuestionIDs, in.WorkspaceID)
	if err != nil {
		return Material{}, err
	}
	encoded, err := json.Marshal(picked.questions)
	if err != nil {
		return Material{}, err
	}
	content, err := materialdoc.QuizDocument(encoded, nil)
	if err != nil {
		return Material{}, err
	}
	var id string
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		// The material's workspace and account locks come first, as for a
		// pasted image (AdoptEditorAssets).
		id, err = s.createMaterialTx(ctx, tx, Material{
			CreatedBy: in.ActorID, WorkspaceID: in.WorkspaceID, WorkspaceName: in.WorkspaceName,
			Kind: "quiz", Title: in.Title, Content: content, Privacy: "private", GradedPending: in.GradedPending,
			Hidden: in.Hidden,
		})
		if err != nil {
			return err
		}
		return s.copyBankAssetsTx(ctx, tx, in.ActorID, in.WorkspaceID, id, picked)
	})
	if err != nil {
		return Material{}, err
	}
	return s.GetMaterial(ctx, id)
}

// CopyBankQuestionsToQuiz copies the picked questions, in the order given, for
// the quiz editor's From the bank (Epo 2026-11-15): their images become the
// quiz's own (readBankCopies, copyBankAssetsTx), and the copies come back for
// the editor to insert through its live rooms, which own the quiz's content;
// nothing here writes it. An image copy the editor never inserts is trashed
// by the quiz's next save that does not name it (pruneMaterialAssetsTx), as an
// uploaded image left out is. The caller edits the quiz (the handler's check).
func (s *Store) CopyBankQuestionsToQuiz(ctx context.Context, actorID, quizID, bank string, questionIDs []string) ([]map[string]any, error) {
	quiz, err := s.GetMaterial(ctx, quizID)
	if err != nil {
		return nil, err
	}
	if quiz.Kind != MaterialQuiz {
		return nil, ErrNotFound
	}
	picked, err := s.readBankCopies(ctx, actorID, bank, questionIDs, quiz.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if len(picked.assets) > 0 {
		err = s.inTx(ctx, func(tx pgx.Tx) error {
			// The quiz's own upload locks, which also find it live there.
			if _, err := s.lockEditorAssetScopeTx(ctx, tx, quiz.WorkspaceID, quizID, actorID); err != nil {
				return err
			}
			return s.copyBankAssetsTx(ctx, tx, actorID, quiz.WorkspaceID, quizID, picked)
		})
		if err != nil {
			return nil, err
		}
	}
	return picked.questions, nil
}

// bankCopies is picked bank questions rewritten for a quiz, with the images
// to copy for it.
type bankCopies struct {
	questions []map[string]any
	assets    map[string]string // source asset id -> the quiz's copy
	owners    map[string]string // source asset id -> its bank question
}

// readBankCopies reads the picked questions, in the order given, for a quiz in
// workspace workspaceID ("" for none). The caller must read the bank; each
// question gets fresh question and part ids (one question may sit in a bank
// twice), and each image or drawn sample still there is named by the quiz copy
// copyBankAssetsTx makes, charged to the caller (uploader pays). An image no
// longer there (its payer's account was purged) is dropped, as a re-save drops
// it (Epo 2026-11-14); a part left with nothing in it refuses the copy. A
// question keeps its topics only in its class's own workspace; elsewhere it
// follows the quiz's. The copies hold within a quiz's bounds.
func (s *Store) readBankCopies(ctx context.Context, actorID, bank string, questionIDs []string, workspaceID string) (bankCopies, error) {
	scope, err := s.itemBankScope(ctx, s.pool, actorID, bank)
	if err != nil {
		return bankCopies{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT id, `+bankQuestionRead+` FROM item_bank_questions q
		WHERE id = ANY($1::text[]) AND `+scope.column+`=$2`, questionIDs, scope.value)
	if err != nil {
		return bankCopies{}, err
	}
	byID := map[string]map[string]any{}
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return bankCopies{}, err
		}
		var q map[string]any
		if err := json.Unmarshal(raw, &q); err != nil {
			rows.Close()
			return bankCopies{}, err
		}
		byID[id] = q
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return bankCopies{}, err
	}
	var named []string
	for _, q := range byID {
		named = append(named, questions.AssetIDs(q)...)
	}
	// Each named image still there, by the bank question it belongs to.
	present := map[string]string{}
	rows, err = s.pool.Query(ctx, `SELECT id, bank_question_id FROM editor_assets
		WHERE id=ANY($1::text[]) AND status='ready' AND bank_question_id IS NOT NULL`, named)
	if err != nil {
		return bankCopies{}, err
	}
	for rows.Next() {
		var assetID, questionID string
		if err := rows.Scan(&assetID, &questionID); err != nil {
			rows.Close()
			return bankCopies{}, err
		}
		present[assetID] = questionID
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return bankCopies{}, err
	}
	out := bankCopies{
		questions: make([]map[string]any, 0, len(questionIDs)),
		assets:    map[string]string{},
		owners:    map[string]string{},
	}
	for _, id := range questionIDs {
		q, ok := byID[id]
		if !ok {
			return bankCopies{}, ErrNotFound
		}
		q = cloneQuestion(q)
		q["id"] = uuid.NewString()
		if scope.column != "workspace_id" || scope.value != workspaceID {
			delete(q, "topicIds")
		}
		for _, raw := range q["parts"].([]any) {
			raw.(map[string]any)["id"] = uuid.NewString()
		}
		for _, assetID := range questions.AssetIDs(q) {
			if present[assetID] == id && out.assets[assetID] == "" {
				out.owners[assetID] = id
				out.assets[assetID] = uid("asset")
			}
		}
		if !questions.RewriteAssetIDs(q, out.assets) {
			return bankCopies{}, ErrBankQuestionAssets
		}
		out.questions = append(out.questions, q)
	}
	if err := questions.QuizBounds(out.questions); err != nil {
		return bankCopies{}, fmt.Errorf("%w: %v", materialdoc.ErrInvalid, err)
	}
	return out, nil
}

// copyBankAssetsTx makes the copies' images the quiz material's own, under ids
// readBankCopies chose, charged to the caller after the storage gate. Call it
// after the material's locks.
func (s *Store) copyBankAssetsTx(ctx context.Context, tx pgx.Tx, actorID, workspaceID, materialID string, picked bankCopies) error {
	if len(picked.assets) == 0 {
		return nil
	}
	limits, err := s.PayerPlanLimits(ctx, actorID)
	if err != nil {
		return err
	}
	sourceIDs := make([]string, 0, len(picked.assets))
	for sourceID := range picked.assets {
		sourceIDs = append(sourceIDs, sourceID)
	}
	// Share-locking the sources holds off their deletion, so each copied
	// path still has a blob reference when the copies add theirs. One
	// deleted since it was read refuses the copy, to be tried again.
	rows, err := tx.Query(ctx, `SELECT `+editorAssetCols+` FROM editor_assets
		WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, sourceIDs)
	if err != nil {
		return err
	}
	sources, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (EditorAsset, error) { return scanEditorAsset(row) })
	if err != nil {
		return err
	}
	if len(sources) != len(picked.assets) {
		return ErrBankQuestionAssets
	}
	var paths []string
	var bytes int64
	for _, asset := range sources {
		if asset.BankQuestionID != picked.owners[asset.ID] || asset.Status != "ready" ||
			asset.SizeBytes > limits.EditorAssetBytes(asset.Purpose) {
			return ErrBankQuestionAssets
		}
		paths = append(paths, asset.ObjectPath)
		bytes += asset.SizeBytes
	}
	if err := lockCloneBlobPathsTx(ctx, tx, paths); err != nil {
		return err
	}
	if err := s.gateStorageTx(ctx, tx, actorID, bytes); err != nil {
		return err
	}
	for _, asset := range sources {
		if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
			(id, workspace_id, material_id, user_id, created_by, name, purpose, object_path,
			 content_type, size_bytes, status, etag, completed_at, thumbnail_key)
			VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,'ready',$10,now(),
			 (SELECT thumbnail_key FROM editor_assets WHERE id=$11))`,
			picked.assets[asset.ID], nullStr(workspaceID), materialID, actorID, asset.Name, asset.Purpose,
			asset.ObjectPath, asset.ContentType, asset.SizeBytes, nullStr(asset.ETag), asset.ID); err != nil {
			return err
		}
	}
	return nil
}

// cloneQuestion deep-copies a decoded question so its ids can change.
func cloneQuestion(q map[string]any) map[string]any {
	raw, _ := json.Marshal(q)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}
