package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/review"
)

// Study progress and review state are per user and private: anyone who can
// read the workspace records their own, frozen accounts included. Nothing here
// is copied by clone or charged to storage.

// StudyItem is one touched file or material; untouched items have no row.
type StudyItem struct {
	FileID     *string `json:"fileId,omitempty"`
	MaterialID *string `json:"materialId,omitempty"`
	State      string  `json:"state" enum:"started,done,removed"`
}

type StudySummary struct {
	Enabled        bool        `json:"enabled"`
	Items          []StudyItem `json:"items" nullable:"false"`
	RecentAttempts []Attempt   `json:"recentAttempts" nullable:"false"`
	// Reviewable counts the rated questions and cards a review session draws on.
	Reviewable int `json:"reviewable"`
	// QuickReview is the Study tab's cards to revisit: flashcards of the sets in
	// progress missed at least once, the one most likely forgotten first, so a
	// card rated Good drops down.
	QuickReview []ReviewItem `json:"quickReview" nullable:"false"`
	// Suggestion is the workspace's strongest suggested review, for the
	// refresh row; nil when nothing is worth reviewing.
	Suggestion *ReviewSuggestion `json:"suggestion,omitempty"`
}

// ReviewItem is one card or question in a review session, with the content
// needed to show and grade it.
type ReviewItem struct {
	MaterialID    string         `json:"materialId"`
	MaterialTitle string         `json:"materialTitle"`
	ItemID        string         `json:"itemId"`
	Kind          string         `json:"kind" enum:"card,question"`
	Front         string         `json:"front,omitempty"`
	Back          string         `json:"back,omitempty"`
	Question      map[string]any `json:"question,omitempty"`
}

const quickReviewSize = 20

// studyItem is a reviewable item read from a material's document.
type studyItem struct {
	ReviewItem
	hash string
}

// parsedItems keeps each material's items for one revision, so the Study tab
// and review parse a document again only after it changes; every content
// write bumps the revision. Items are shared: callers never modify them.
// ponytail: one process-wide map dropped when full; an LRU if it churns.
var parsedItems = struct {
	sync.Mutex
	m     map[string]parsedMaterial
	bytes int
}{m: map[string]parsedMaterial{}}

type parsedMaterial struct {
	revision int64
	items    []studyItem
	bytes    int
}

// parsedItemsBytes bounds the cache by the documents' JSON size; parsed items
// take several times that in memory (about 7.6x for a 2 MiB quiz).
const parsedItemsBytes = 32 << 20

// itemsOf is materialItems through the cache. Titles are not cached: a rename
// does not bump the revision.
func itemsOf(mt Material) ([]studyItem, error) {
	parsedItems.Lock()
	hit, ok := parsedItems.m[mt.ID]
	parsedItems.Unlock()
	if ok && hit.revision == mt.Revision {
		return hit.items, nil
	}
	items, err := materialItems(mt)
	if err != nil {
		return nil, err
	}
	size := len(mt.Content)
	parsedItems.Lock()
	if old, ok := parsedItems.m[mt.ID]; ok {
		parsedItems.bytes -= old.bytes
	}
	if parsedItems.bytes+size > parsedItemsBytes {
		parsedItems.m = map[string]parsedMaterial{}
		parsedItems.bytes = 0
	}
	parsedItems.m[mt.ID] = parsedMaterial{mt.Revision, items, size}
	parsedItems.bytes += size
	parsedItems.Unlock()
	return items, nil
}

func materialItems(mt Material) ([]studyItem, error) {
	var out []studyItem
	base := ReviewItem{MaterialID: mt.ID}
	switch mt.Kind {
	case "flashcards":
		cards, err := materialdoc.ExtractFlashcards(mt.Content)
		if err != nil {
			return nil, err
		}
		for _, c := range cards {
			// A card with both sides blank is a new set's placeholder.
			if strings.TrimSpace(c.Front) == "" && strings.TrimSpace(c.Back) == "" {
				continue
			}
			it := base
			it.ItemID, it.Kind, it.Front, it.Back = c.ID, "card", c.Front, c.Back
			out = append(out, studyItem{it, review.CardHash(c.Front, c.Back)})
		}
	case "quiz":
		raw, _, err := materialdoc.ExtractQuiz(mt.Content)
		if err != nil {
			return nil, err
		}
		var qs []map[string]any
		if err := json.Unmarshal(raw, &qs); err != nil {
			return nil, err
		}
		for _, q := range qs {
			id, _ := q["id"].(string)
			if id == "" {
				continue
			}
			it := base
			it.ItemID, it.Kind, it.Question = id, "question", q
			out = append(out, studyItem{it, review.QuestionHash(q)})
		}
	}
	return out, nil
}

type storedState struct {
	review.State
	hash string
}

func reviewStates(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, userID, materialID string) (map[string]storedState, error) {
	rows, err := q.Query(ctx, `SELECT item_id, item_hash, stability, difficulty, reps, lapses, fsrs_state, last_review
		FROM review_states WHERE user_id=$1 AND material_id=$2`, userID, materialID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]storedState{}
	for rows.Next() {
		var id string
		var st storedState
		if err := rows.Scan(&id, &st.hash, &st.Stability, &st.Difficulty, &st.Reps, &st.Lapses, &st.FSRSState, &st.LastReview); err != nil {
			return nil, err
		}
		out[id] = st
	}
	return out, rows.Err()
}

func (s *Store) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

/* ------------------------------------------------------------- settings */

func (s *Store) SetStudyProgressDefault(ctx context.Context, userID string, enabled bool) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET study_progress=$2, updated_at=now() WHERE id=$1`, userID, enabled)
	return err
}

func (s *Store) SetStudyPreferences(ctx context.Context, userID string, prefs StudyPreferences) error {
	_, err := s.pool.Exec(ctx, `UPDATE users SET study_preferences=$2, updated_at=now() WHERE id=$1`, userID, prefs)
	return err
}

func (s *Store) StudyPreferencesOf(ctx context.Context, userID string) (StudyPreferences, error) {
	var prefs StudyPreferences
	err := s.pool.QueryRow(ctx, `SELECT study_preferences FROM users WHERE id=$1`, userID).Scan(&prefs)
	return prefs, err
}

func (s *Store) SetWorkspaceStudy(ctx context.Context, userID, wsID string, enabled bool) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO workspace_study (user_id, workspace_id, enabled) VALUES ($1,$2,$3)
		ON CONFLICT (user_id, workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled`, userID, wsID, enabled)
	return err
}

/* ------------------------------------------------------------- progress */

// StudyEnabled is the workspace's own switch, else the user's default.
func (s *Store) StudyEnabled(ctx context.Context, userID, wsID string) (bool, error) {
	var on bool
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(
		(SELECT enabled FROM workspace_study WHERE user_id=$1 AND workspace_id=$2),
		(SELECT study_progress FROM users WHERE id=$1))`, userID, wsID).Scan(&on)
	return on, err
}

func (s *Store) StudySummary(ctx context.Context, userID, wsID string, now time.Time) (StudySummary, error) {
	out := StudySummary{Items: []StudyItem{}, RecentAttempts: []Attempt{}, QuickReview: []ReviewItem{}}
	var err error
	if out.Enabled, err = s.StudyEnabled(ctx, userID, wsID); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT sp.file_id, sp.material_id, sp.state FROM study_progress sp
		LEFT JOIN files f ON f.id=sp.file_id LEFT JOIN materials m ON m.id=sp.material_id
		WHERE sp.user_id=$1 AND sp.workspace_id=$2 AND f.trashed_at IS NULL AND m.trashed_at IS NULL`, userID, wsID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var it StudyItem
		if err := rows.Scan(&it.FileID, &it.MaterialID, &it.State); err != nil {
			rows.Close()
			return out, err
		}
		out.Items = append(out.Items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows, err = s.pool.Query(ctx, `SELECT a.id, a.material_id, a.quiz_name, a.workspace_name, a.chapters, a.correct, a.total, a.pct, a.taken_at
		FROM attempts a JOIN materials m ON m.id=a.material_id
		WHERE a.user_id=$1 AND m.workspace_id=$2 AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
		ORDER BY a.taken_at DESC LIMIT 5`, userID, wsID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var a Attempt
		if err := rows.Scan(&a.ID, &a.MaterialID, &a.QuizName, &a.WorkspaceName, &a.Chapters, &a.Correct, &a.Total, &a.Pct, &a.TakenAt); err != nil {
			rows.Close()
			return out, err
		}
		if a.Chapters == nil {
			a.Chapters = []string{}
		}
		out.RecentAttempts = append(out.RecentAttempts, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	pool, err := s.reviewPool(ctx, userID, wsID, now)
	if err != nil {
		return out, err
	}
	out.Reviewable = len(pool)
	for _, it := range pool {
		if it.Kind == "card" && it.lapses > 0 && len(out.QuickReview) < quickReviewSize {
			out.QuickReview = append(out.QuickReview, it.ReviewItem)
		}
	}
	if out.Enabled && out.Reviewable > 0 {
		if out.Suggestion, err = s.workspaceSuggestion(ctx, userID, wsID, now); err != nil {
			return out, err
		}
	}
	return out, nil
}

// questionText is the first text block of the stem or the first part.
func questionText(q map[string]any) string {
	blocks, _ := q["stem"].([]any)
	if parts, _ := q["parts"].([]any); len(parts) > 0 {
		first, _ := parts[0].(map[string]any)
		more, _ := first["blocks"].([]any)
		blocks = append(append([]any{}, blocks...), more...)
	}
	for _, raw := range blocks {
		b, _ := raw.(map[string]any)
		if text, _ := b["text"].(string); b["type"] == "text" && strings.TrimSpace(text) != "" {
			return text
		}
	}
	return ""
}

// ErrStudyTarget means the file or material is not a trackable item of the
// workspace: missing, trashed, or embedded in a note.
var ErrStudyTarget = errors.New("not a study item in this workspace")

// SetStudyItem marks a file or material done or removed; a nil state deletes
// the row (Mark as unread).
func (s *Store) SetStudyItem(ctx context.Context, userID, wsID string, fileID, materialID *string, state *string) error {
	var ok bool
	var err error
	if fileID != nil {
		err = s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM files WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL)`, *fileID, wsID).Scan(&ok)
	} else {
		err = s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM materials WHERE id=$1 AND workspace_id=$2
			AND trashed_at IS NULL AND parent_material_id IS NULL)`, *materialID, wsID).Scan(&ok)
	}
	if err != nil {
		return err
	}
	if !ok {
		return ErrStudyTarget
	}
	col, id := "material_id", materialID
	if fileID != nil {
		col, id = "file_id", fileID
	}
	if state == nil {
		_, err = s.pool.Exec(ctx, `DELETE FROM study_progress WHERE user_id=$1 AND `+col+`=$2`, userID, *id)
		return err
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO study_progress (user_id, workspace_id, `+col+`, state) VALUES ($1,$2,$3,$4)
		ON CONFLICT (user_id, `+col+`) WHERE `+col+` IS NOT NULL
		DO UPDATE SET state=EXCLUDED.state, updated_at=now()`, userID, wsID, *id, *state)
	return err
}

// ResetStudy clears done marks and review state for the workspace; attempts
// and the review log stay.
func (s *Store) ResetStudy(ctx context.Context, userID, wsID string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM study_progress WHERE user_id=$1 AND workspace_id=$2`, userID, wsID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM review_states WHERE user_id=$1
			AND material_id IN (SELECT id FROM materials WHERE workspace_id=$2)`, userID, wsID)
		return err
	})
}

// markProgressTx records practice on a workspace material that is not
// embedded. A done set stays done, and a removed one comes back.
func markProgressTx(ctx context.Context, tx pgx.Tx, userID string, mt Material, state string) error {
	if mt.WorkspaceID == "" || mt.ParentMaterialID != "" {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO study_progress (user_id, workspace_id, material_id, state) VALUES ($1,$2,$3,$4)
		ON CONFLICT (user_id, material_id) WHERE material_id IS NOT NULL
		DO UPDATE SET state=CASE WHEN study_progress.state='done' THEN 'done' ELSE EXCLUDED.state END, updated_at=now()`,
		userID, mt.WorkspaceID, mt.ID, state)
	return err
}

/* --------------------------------------------------------------- review */

// rateTx rates one item against its current content and logs the rating.
func rateTx(ctx context.Context, tx pgx.Tx, userID string, it studyItem, prev map[string]storedState, r review.Rating, now time.Time) error {
	var last *review.State
	if st, ok := prev[it.ItemID]; ok && st.hash == it.hash {
		last = &st.State
	}
	next := review.Rate(last, r, now)
	if _, err := tx.Exec(ctx, `INSERT INTO review_states
		(user_id, material_id, item_id, item_hash, stability, difficulty, reps, lapses, fsrs_state, last_review)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (user_id, material_id, item_id) DO UPDATE SET item_hash=EXCLUDED.item_hash,
			stability=EXCLUDED.stability, difficulty=EXCLUDED.difficulty, reps=EXCLUDED.reps,
			lapses=EXCLUDED.lapses, fsrs_state=EXCLUDED.fsrs_state, last_review=EXCLUDED.last_review`,
		userID, it.MaterialID, it.ItemID, it.hash, next.Stability, next.Difficulty, next.Reps, next.Lapses, next.FSRSState, next.LastReview); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO review_log (user_id, material_id, item_id, rating, reviewed_at) VALUES ($1,$2,$3,$4,$5)`,
		userID, it.MaterialID, it.ItemID, int(r), now)
	return err
}

// Rating is a flashcard rating (1-4) or a question score (0-1); exactly one
// is set.
type Rating struct {
	MaterialID string
	ItemID     string
	Rating     *int
	Score      *float64
	// Session records the answer in its review session, when it has one.
	Session *SessionAnswer
}

// RateItem records one review rating and the progress it implies.
func (s *Store) RateItem(ctx context.Context, userID string, in Rating, now time.Time) error {
	mt, err := s.GetMaterial(ctx, in.MaterialID)
	if err != nil {
		return err
	}
	// A set or quiz embedded in a note records nothing.
	if mt.ParentMaterialID != "" {
		return ErrStudyEmbedded
	}
	items, err := itemsOf(mt)
	if err != nil {
		return err
	}
	var target *studyItem
	for i := range items {
		if items[i].ItemID == in.ItemID {
			target = &items[i]
		}
	}
	if target == nil {
		return ErrNotFound
	}
	var r review.Rating
	switch {
	case target.Kind == "card" && in.Rating != nil:
		r = review.Rating(*in.Rating)
	case target.Kind == "question" && in.Score != nil:
		r = review.ScoreRating(*in.Score)
	default:
		return ErrStudyRating
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockRating(ctx, tx, userID, mt.ID); err != nil {
			return err
		}
		prev, err := reviewStates(ctx, tx, userID, mt.ID)
		if err != nil {
			return err
		}
		if err := rateTx(ctx, tx, userID, *target, prev, r, now); err != nil {
			return err
		}
		if in.Session != nil {
			if err := recordAnswerTx(ctx, tx, userID, mt, *target, r, in.Session, now); err != nil {
				return err
			}
		}
		state := "done"
		if mt.Kind == "flashcards" {
			// Done once every current card has been seen.
			prev[target.ItemID] = storedState{hash: target.hash}
			for _, it := range items {
				if st, ok := prev[it.ItemID]; !ok || st.hash != it.hash {
					state = "started"
					break
				}
			}
		}
		return markProgressTx(ctx, tx, userID, mt, state)
	})
}

// ReviewQuestion returns one question of a quiz, in full, for grading a review
// check, with the quiz's workspace. A card is ErrStudyRating: cards take a
// rating.
func (s *Store) ReviewQuestion(ctx context.Context, materialID, itemID string) (map[string]any, string, error) {
	mt, err := s.GetMaterial(ctx, materialID)
	if err != nil {
		return nil, "", err
	}
	items, err := itemsOf(mt)
	if err != nil {
		return nil, "", err
	}
	for _, it := range items {
		if it.ItemID != itemID {
			continue
		}
		if it.Kind != "question" {
			return nil, "", ErrStudyRating
		}
		return it.Question, mt.WorkspaceID, nil
	}
	return nil, "", ErrNotFound
}

// ErrStudyRating means a card got a score or a question got a button rating.
var ErrStudyRating = errors.New("cards take a rating and questions take a score")

// ErrStudyEmbedded refuses a rating of a set or quiz embedded in a note, which
// records nothing.
var ErrStudyEmbedded = errors.New("embedded quizzes and flashcards record nothing")

// rateAttemptTx rates every question of a workspace quiz from an attempt's
// snapshot and marks the quiz done. Embedded and standalone quizzes record
// nothing.
// lockRating serializes one user's ratings of one material, so ratings of a
// set's last cards made at once still see each other and mark it done, and a
// quiz attempt and a review rating of the same question do not lose a review.
func lockRating(ctx context.Context, tx pgx.Tx, userID, materialID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "study-rating:"+userID+":"+materialID)
	return err
}

func rateAttemptTx(ctx context.Context, tx pgx.Tx, userID string, mt Material, snapshot json.RawMessage, now time.Time) error {
	if mt.Kind != "quiz" || mt.WorkspaceID == "" || mt.ParentMaterialID != "" {
		return nil
	}
	if err := lockRating(ctx, tx, userID, mt.ID); err != nil {
		return err
	}
	items, err := itemsOf(mt)
	if err != nil {
		return err
	}
	byID := map[string]studyItem{}
	for _, it := range items {
		byID[it.ItemID] = it
	}
	var qs []map[string]any
	if err := json.Unmarshal(snapshot, &qs); err != nil {
		return err
	}
	prev, err := reviewStates(ctx, tx, userID, mt.ID)
	if err != nil {
		return err
	}
	for _, q := range qs {
		id, _ := q["id"].(string)
		it, ok := byID[id]
		score, scored := review.QuestionScore(q)
		if !ok || !scored {
			continue
		}
		if err := rateTx(ctx, tx, userID, it, prev, review.ScoreRating(score), now); err != nil {
			return err
		}
	}
	return markProgressTx(ctx, tx, userID, mt, "done")
}

type ranked struct {
	studyItem
	r          float64
	lapses     int
	reps       int
	lastReview time.Time
	// chapterID is the material's chapter, nil outside chapters.
	chapterID *string
}

// reviewPool is every rated item of the quizzes and sets in progress (not
// removed, trashed or embedded) whose content still matches what was rated,
// least retained first. Only rated materials are read, in one query, and a
// document is loaded and parsed only when the cache misses its revision.
func (s *Store) reviewPool(ctx context.Context, userID, wsID string, now time.Time) ([]ranked, error) {
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.title, m.revision, m.chapter_id, rs.item_id, rs.item_hash,
			rs.stability, rs.difficulty, rs.reps, rs.lapses, rs.fsrs_state, rs.last_review
		FROM materials m
		JOIN study_progress sp ON sp.material_id=m.id AND sp.user_id=$1
		JOIN review_states rs ON rs.material_id=m.id AND rs.user_id=$1
		WHERE m.workspace_id=$2 AND m.kind IN ('quiz','flashcards') AND m.trashed_at IS NULL
			AND m.parent_material_id IS NULL AND sp.state <> 'removed'
		ORDER BY m.position, m.created_at, m.id`, userID, wsID)
	if err != nil {
		return nil, err
	}
	type ratedMaterial struct {
		title     string
		revision  int64
		chapterID *string
		states    map[string]storedState
		items     []studyItem
	}
	var order []*ratedMaterial
	byID := map[string]*ratedMaterial{}
	for rows.Next() {
		var id, title, itemID string
		var revision int64
		var chapterID *string
		var st storedState
		if err := rows.Scan(&id, &title, &revision, &chapterID, &itemID, &st.hash, &st.Stability, &st.Difficulty, &st.Reps, &st.Lapses, &st.FSRSState, &st.LastReview); err != nil {
			rows.Close()
			return nil, err
		}
		rm := byID[id]
		if rm == nil {
			rm = &ratedMaterial{title: title, revision: revision, chapterID: chapterID, states: map[string]storedState{}}
			byID[id] = rm
			order = append(order, rm)
		}
		rm.states[itemID] = st
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var missing []string
	for id, rm := range byID {
		parsedItems.Lock()
		hit, ok := parsedItems.m[id]
		parsedItems.Unlock()
		if ok && hit.revision == rm.revision {
			rm.items = hit.items
		} else {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		rows, err := s.pool.Query(ctx, `SELECT `+materialCols+` FROM materials WHERE id = ANY($1)`, missing)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			mt, err := scanMaterial(rows)
			if err != nil {
				rows.Close()
				return nil, err
			}
			if byID[mt.ID].items, err = itemsOf(mt); err != nil {
				rows.Close()
				return nil, err
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	var all []ranked
	for _, rm := range order {
		for _, it := range rm.items {
			if st, ok := rm.states[it.ItemID]; ok && st.hash == it.hash {
				it.MaterialTitle = rm.title
				all = append(all, ranked{it, review.Retrievability(st.State, now), st.Lapses, st.Reps, st.LastReview, rm.chapterID})
			}
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].r < all[j].r })
	return all, nil
}

/* ------------------------------------------------------------ agent read */

// AgentProgress is what the chat agent reads of the requester's progress in a
// workspace. The agent never writes progress.
type AgentProgress struct {
	Enabled        bool                `json:"enabled"`
	Items          []AgentProgressItem `json:"items"`
	RecentAttempts []Attempt           `json:"recentAttempts"`
	WeakChapters   []WeakChapter       `json:"weakChapters"`
}

type AgentProgressItem struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Title string `json:"title"`
	State string `json:"state"`
}

// WeakChapter is a chapter whose rated questions and cards are least retained.
type WeakChapter struct {
	Chapter   string  `json:"chapter"`
	Retention float64 `json:"retention"`
	Items     int     `json:"items"`
}

func (s *Store) AgentStudyProgress(ctx context.Context, userID, wsID string, now time.Time) (AgentProgress, error) {
	summary, err := s.StudySummary(ctx, userID, wsID, now)
	if err != nil {
		return AgentProgress{}, err
	}
	out := AgentProgress{Enabled: summary.Enabled, Items: []AgentProgressItem{}, RecentAttempts: summary.RecentAttempts, WeakChapters: []WeakChapter{}}
	rows, err := s.pool.Query(ctx, `SELECT COALESCE(sp.file_id, sp.material_id),
			CASE WHEN sp.file_id IS NULL THEN 'material' ELSE 'file' END,
			COALESCE(f.name, m.title, ''), sp.state
		FROM study_progress sp
		LEFT JOIN files f ON f.id=sp.file_id LEFT JOIN materials m ON m.id=sp.material_id
		WHERE sp.user_id=$1 AND sp.workspace_id=$2 AND f.trashed_at IS NULL AND m.trashed_at IS NULL
		ORDER BY sp.updated_at DESC`, userID, wsID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var it AgentProgressItem
		if err := rows.Scan(&it.ID, &it.Kind, &it.Title, &it.State); err != nil {
			rows.Close()
			return out, err
		}
		out.Items = append(out.Items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	// ponytail: averages stored states without re-reading documents, so an
	// edited item still counts until it is rated again; read the documents if
	// the ranking ever needs to be exact.
	rows, err = s.pool.Query(ctx, `SELECT COALESCE(c.name, ''), rs.stability, rs.difficulty, rs.reps, rs.lapses, rs.fsrs_state, rs.last_review
		FROM review_states rs JOIN materials m ON m.id=rs.material_id
		LEFT JOIN chapters c ON c.id=m.chapter_id
		WHERE rs.user_id=$1 AND m.workspace_id=$2 AND m.trashed_at IS NULL AND m.parent_material_id IS NULL`, userID, wsID)
	if err != nil {
		return out, err
	}
	sums := map[string]*WeakChapter{}
	for rows.Next() {
		var chapter string
		var st review.State
		if err := rows.Scan(&chapter, &st.Stability, &st.Difficulty, &st.Reps, &st.Lapses, &st.FSRSState, &st.LastReview); err != nil {
			rows.Close()
			return out, err
		}
		w := sums[chapter]
		if w == nil {
			w = &WeakChapter{Chapter: chapter}
			sums[chapter] = w
		}
		w.Retention += review.Retrievability(st, now)
		w.Items++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	for _, w := range sums {
		w.Retention /= float64(w.Items)
		out.WeakChapters = append(out.WeakChapters, *w)
	}
	sort.Slice(out.WeakChapters, func(i, j int) bool { return out.WeakChapters[i].Retention < out.WeakChapters[j].Retention })
	if len(out.WeakChapters) > 3 {
		out.WeakChapters = out.WeakChapters[:3]
	}
	return out, nil
}
