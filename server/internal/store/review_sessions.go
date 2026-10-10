package store

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/review"
)

// Review sessions, suggested reviews and their records (human/study-progress.md,
// 2026-10-10). Every item is scored (1 - R) x (1 + tricky + learned): fading is
// the base, tricky and learned come from the item's latest answers
// (review.HistoryWeights). Groups (a chapter, the items outside chapters, or
// the whole workspace) sum their items' parts, so more practised content
// ranks higher, and the largest part names the suggestion's mode.

const (
	ModeTricky  = "tricky"
	ModeFading  = "fading"
	ModeLearned = "learned"

	GroupChapter   = "chapter"
	GroupOthers    = "others"
	GroupWorkspace = "workspace"
)

var reviewModes = [3]string{ModeFading, ModeTricky, ModeLearned}

const (
	// suggestedRecall keeps items the learner most likely still recalls out of
	// suggested sessions and their counts: FSRS's own target retention.
	suggestedRecall = 0.9
	// suggestionThreshold is the group score (about three items' worth of
	// likely forgetting) a suggestion needs.
	suggestionThreshold = 3
	suggestionsShown    = 5
	suggestionsPerWS    = 2
	// interestFull and interestFloorAt bound the fall of a workspace's weight
	// after its last activity, from 1 down to interestFloor, flat after.
	interestFull    = 30 * 24 * time.Hour
	interestFloorAt = 90 * 24 * time.Hour
	interestFloor   = 0.25
	// focusBoost multiplies the part the learner's focus preference names.
	focusBoost = 2
	// fadingLabel weighs time against history when naming the mode: a single
	// first miss reads Fading below about 60% recall (Epo, 2026-10-10).
	fadingLabel = 2
)

// ReviewPrefs are the review fields of StudyPreferences with their defaults.
type ReviewPrefs struct {
	Size  int
	Items string // both, quiz, flashcards
	Focus string // balanced, tricky, fading, learned
}

func reviewPrefsOf(p StudyPreferences) ReviewPrefs {
	out := ReviewPrefs{Size: 20, Items: "both", Focus: "balanced"}
	if p.ReviewSize > 0 {
		out.Size = p.ReviewSize
	}
	if p.ReviewItems != "" {
		out.Items = p.ReviewItems
	}
	if p.ReviewFocus != "" {
		out.Focus = p.ReviewFocus
	}
	return out
}

func (p ReviewPrefs) takes(kind string) bool {
	switch p.Items {
	case "quiz":
		return kind == "question"
	case "flashcards":
		return kind == "card"
	}
	return true
}

// scored is a pool item with its three parts (fading, tricky, learned), each
// already times (1 - R) and the focus boost, and the signals that name its
// mode. The parts rank; the signals label. (1 - R) scales every part alike,
// so the label compares time, fadingLabel x (1 - R), with the bare history
// weights instead: the same history reads Fading once enough time passed.
type scored struct {
	ranked
	parts  [3]float64
	labels [3]float64
}

func (s scored) score() float64 { return s.parts[0] + s.parts[1] + s.parts[2] }

func (s scored) mode() string { return reviewModes[largest(s.labels)] }

func largest(parts [3]float64) int {
	best := 0
	for i := 1; i < 3; i++ {
		if parts[i] > parts[best] {
			best = i
		}
	}
	return best
}

// scoreItems weighs the pool's items the preferences let in.
func scoreItems(pool []ranked, history map[string][]review.Rating, prefs ReviewPrefs) []scored {
	out := make([]scored, 0, len(pool))
	for _, it := range pool {
		if !prefs.takes(it.Kind) {
			continue
		}
		w := review.HistoryWeights(history[it.MaterialID+"/"+it.ItemID])
		forget := 1 - it.r
		parts := [3]float64{forget, forget * w.Tricky, forget * w.Learned}
		for i, mode := range reviewModes {
			if prefs.Focus == mode {
				parts[i] *= focusBoost
			}
		}
		labels := [3]float64{fadingLabel * forget, w.Tricky, w.Learned}
		out = append(out, scored{it, parts, labels})
	}
	return out
}

// interest discounts a workspace the learner has drifted from: 1 until
// interestFull without activity, easing down to interestFloor at
// interestFloorAt, flat after. It never reaches zero: nothing assumes a
// workspace is finished.
func interest(since time.Duration) float64 {
	switch {
	case since <= interestFull:
		return 1
	case since >= interestFloorAt:
		return interestFloor
	}
	t := float64(since-interestFull) / float64(interestFloorAt-interestFull)
	return interestFloor + (1-interestFloor)*(1+math.Cos(math.Pi*t))/2
}

// ReviewEvidence backs a suggestion's reason; the browser words it by mode.
type ReviewEvidence struct {
	// Missed counts items whose latest answer was a miss.
	Missed int `json:"missed"`
	// Repeated counts items missed at least twice in their latest answers.
	Repeated int `json:"repeated"`
	// Forgotten is how many items are probably forgotten, rounded.
	Forgotten int `json:"forgotten"`
	// Young counts items answered at most twice.
	Young           int       `json:"young"`
	LastPractisedAt time.Time `json:"lastPractisedAt"`
}

type ReviewSuggestion struct {
	WorkspaceID   string  `json:"workspaceId"`
	WorkspaceName string  `json:"workspaceName"`
	IconID        string  `json:"iconId"`
	Group         string  `json:"group" enum:"chapter,others,workspace"`
	ChapterID     *string `json:"chapterId,omitempty"`
	ChapterName   string  `json:"chapterName,omitempty"`
	Mode          string  `json:"mode" enum:"tricky,fading,learned"`
	// Items counts the items a session of this suggestion draws from.
	Items    int            `json:"items"`
	Evidence ReviewEvidence `json:"evidence"`
	score    float64
}

type reviewGroup struct {
	kind      string
	chapterID *string
}

func (g reviewGroup) has(it scored) bool {
	switch g.kind {
	case GroupChapter:
		return it.chapterID != nil && g.chapterID != nil && *it.chapterID == *g.chapterID
	case GroupOthers:
		return it.chapterID == nil
	}
	return true
}

// groupSuggestions forms a workspace's suggestions from its scored items:
// each chapter (and the items outside chapters) passing the threshold, or the
// whole workspace when none does but all of it together does. A workspace
// without chapters is one group. history feeds the evidence.
func groupSuggestions(items []scored, history map[string][]review.Rating, weight float64) []ReviewSuggestion {
	var due []scored
	chaptered := false
	for _, it := range items {
		if it.r <= suggestedRecall {
			due = append(due, it)
			chaptered = chaptered || it.chapterID != nil
		}
	}
	build := func(g reviewGroup) (ReviewSuggestion, bool) {
		out := ReviewSuggestion{Group: g.kind, ChapterID: g.chapterID}
		var parts, labels [3]float64
		var forgotten float64
		for _, it := range due {
			if !g.has(it) {
				continue
			}
			out.Items++
			for i := range parts {
				parts[i] += it.parts[i]
				labels[i] += it.labels[i]
			}
			forgotten += 1 - it.r
			if it.reps <= 2 {
				out.Evidence.Young++
			}
			if it.lastReview.After(out.Evidence.LastPractisedAt) {
				out.Evidence.LastPractisedAt = it.lastReview
			}
			misses := 0
			for k, r := range history[it.MaterialID+"/"+it.ItemID] {
				if r == review.Again {
					misses++
					if k == 0 {
						out.Evidence.Missed++
					}
				}
			}
			if misses >= 2 {
				out.Evidence.Repeated++
			}
		}
		out.Evidence.Forgotten = int(math.Round(forgotten))
		out.Mode = reviewModes[largest(labels)]
		out.score = (parts[0] + parts[1] + parts[2]) * weight
		return out, out.Items > 0 && out.score >= suggestionThreshold
	}
	if !chaptered {
		if s, ok := build(reviewGroup{kind: GroupWorkspace}); ok {
			return []ReviewSuggestion{s}
		}
		return nil
	}
	var groups []reviewGroup
	seen := map[string]bool{}
	for _, it := range due {
		if it.chapterID == nil {
			if !seen[""] {
				groups = append(groups, reviewGroup{kind: GroupOthers})
			}
			seen[""] = true
		} else if !seen[*it.chapterID] {
			seen[*it.chapterID] = true
			groups = append(groups, reviewGroup{kind: GroupChapter, chapterID: it.chapterID})
		}
	}
	var out []ReviewSuggestion
	for _, g := range groups {
		if s, ok := build(g); ok {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		if s, ok := build(reviewGroup{kind: GroupWorkspace}); ok {
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	return out
}

// pickItems is a session: the group's items by score, at most size, the
// modes interleaved so a run of missed items is broken up. due keeps only
// items at or below suggestedRecall.
func pickItems(items []scored, g reviewGroup, due bool, size int) []ReviewItem {
	var in []scored
	for _, it := range items {
		if g.has(it) && (!due || it.r <= suggestedRecall) {
			in = append(in, it)
		}
	}
	sort.SliceStable(in, func(i, j int) bool { return in[i].score() > in[j].score() })
	if len(in) > size {
		in = in[:size]
	}
	var order []string
	byMode := map[string][]ReviewItem{}
	for _, it := range in {
		m := it.mode()
		if byMode[m] == nil {
			order = append(order, m)
		}
		byMode[m] = append(byMode[m], it.ReviewItem)
	}
	out := make([]ReviewItem, 0, len(in))
	for len(out) < len(in) {
		for _, m := range order {
			if q := byMode[m]; len(q) > 0 {
				out = append(out, q[0])
				byMode[m] = q[1:]
			}
		}
	}
	return out
}

// reviewHistory is each pool item's latest ratings, newest first, keyed
// material/item.
func (s *Store) reviewHistory(ctx context.Context, userID string, pool []ranked) (map[string][]review.Rating, error) {
	out := map[string][]review.Rating{}
	ids := map[string]bool{}
	var materials []string
	for _, it := range pool {
		if !ids[it.MaterialID] {
			ids[it.MaterialID] = true
			materials = append(materials, it.MaterialID)
		}
	}
	if len(materials) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT material_id, item_id, rating FROM (
			SELECT material_id, item_id, rating,
				row_number() OVER (PARTITION BY material_id, item_id ORDER BY reviewed_at DESC) AS n
			FROM review_log WHERE user_id=$1 AND material_id = ANY($2)) h
		WHERE n <= 8 ORDER BY material_id, item_id, n`, userID, materials)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var materialID, itemID string
		var rating int16
		if err := rows.Scan(&materialID, &itemID, &rating); err != nil {
			return nil, err
		}
		key := materialID + "/" + itemID
		out[key] = append(out[key], review.Rating(rating))
	}
	return out, rows.Err()
}

// scoredWorkspace is a workspace's review pool, scored with the user's
// preferences, and the history that scored it.
func (s *Store) scoredWorkspace(ctx context.Context, userID, wsID string, prefs ReviewPrefs, now time.Time) ([]scored, map[string][]review.Rating, error) {
	pool, err := s.reviewPool(ctx, userID, wsID, now)
	if err != nil {
		return nil, nil, err
	}
	history, err := s.reviewHistory(ctx, userID, pool)
	if err != nil {
		return nil, nil, err
	}
	return scoreItems(pool, history, prefs), history, nil
}

/* -------------------------------------------------------------- sessions */

// ReviewSessionInfo describes what a session draws from; the browser sends it
// back with each answer, and the first answer records it.
type ReviewSessionInfo struct {
	Group     string          `json:"group" enum:"chapter,others,workspace"`
	ChapterID *string         `json:"chapterId,omitempty"`
	Mode      *string         `json:"mode,omitempty" enum:"tricky,fading,learned" doc:"Omitted for a review started from the workspace list"`
	Evidence  *ReviewEvidence `json:"evidence,omitempty"`
}

type ReviewSession struct {
	ReviewSessionInfo
	// Items are the items still to answer; Answered of Total counts a resumed
	// session's progress.
	Items []ReviewItem `json:"items" nullable:"false"`
	// Done are a resumed session's answered items in answer order, so
	// Previous can show them again, read only. Empty for a new session.
	Done     []ReviewAnswer `json:"done" nullable:"false"`
	Answered int            `json:"answered"`
	Total    int            `json:"total"`
}

// ReviewAnswer is an item answered earlier in a session with what was
// recorded: a card's rating, or a question's rating, marks and answers, its
// Question the graded one with its key.
type ReviewAnswer struct {
	ReviewItem
	Rating  int            `json:"rating" minimum:"1" maximum:"4"`
	Correct *float64       `json:"correct,omitempty"`
	Total   *float64       `json:"total,omitempty"`
	Answers map[string]any `json:"answers,omitempty"`
}

// ErrReviewGroup refuses a session of a chapter that is not the workspace's.
var ErrReviewGroup = errors.New("no such review group in this workspace")

// WorkspaceReview is a new session: a suggestion's items (mode set) or, from
// the workspace list, the whole workspace's.
func (s *Store) WorkspaceReview(ctx context.Context, userID, wsID string, info ReviewSessionInfo, now time.Time) (ReviewSession, error) {
	out := ReviewSession{ReviewSessionInfo: info, Items: []ReviewItem{}, Done: []ReviewAnswer{}}
	if info.Group == GroupChapter {
		var ok bool
		if info.ChapterID == nil {
			return out, ErrReviewGroup
		}
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM chapters WHERE id=$1 AND workspace_id=$2)`, *info.ChapterID, wsID).Scan(&ok); err != nil {
			return out, err
		}
		if !ok {
			return out, ErrReviewGroup
		}
	} else {
		out.ChapterID = nil
	}
	prefsRaw, err := s.StudyPreferencesOf(ctx, userID)
	if err != nil {
		return out, err
	}
	prefs := reviewPrefsOf(prefsRaw)
	if info.Mode == nil {
		prefs.Focus = "balanced"
	}
	items, history, err := s.scoredWorkspace(ctx, userID, wsID, prefs, now)
	if err != nil {
		return out, err
	}
	g := reviewGroup{kind: info.Group, chapterID: out.ChapterID}
	if info.Mode != nil {
		// The evidence the session started from, for its record.
		for _, sg := range groupSuggestions(items, history, 1) {
			if sg.Group == g.kind && (g.chapterID == nil) == (sg.ChapterID == nil) && (g.chapterID == nil || *g.chapterID == *sg.ChapterID) {
				ev := sg.Evidence
				out.Evidence = &ev
			}
		}
	} else {
		out.Evidence = nil
	}
	out.Items = pickItems(items, g, info.Mode != nil, prefs.Size)
	out.Total = len(out.Items)
	return out, nil
}

// SessionAnswer ties an answer to its session. Items are the session's served
// items, recorded with the first answer so Continue can resume.
type SessionAnswer struct {
	ID          string
	WorkspaceID string
	Info        ReviewSessionInfo
	Items       []SessionItem
	// Answers and Graded are a question's, with Correct of Total marks.
	Answers json.RawMessage
	Graded  map[string]any
	Correct float64
	Total   float64
}

type SessionItem struct {
	MaterialID string `json:"materialId" minLength:"1"`
	ItemID     string `json:"itemId" minLength:"1"`
}

// ErrReviewSession refuses an answer for someone else's session or for an
// item outside the session's workspace.
var ErrReviewSession = errors.New("not this review session")

// recordAnswerTx writes the session on its first answer, then the answer, and
// finishes the session once every served item is answered.
func recordAnswerTx(ctx context.Context, tx pgx.Tx, userID string, mt Material, it studyItem, r review.Rating, a *SessionAnswer, now time.Time) error {
	if mt.WorkspaceID != a.WorkspaceID {
		return ErrReviewSession
	}
	items, err := json.Marshal(a.Items)
	if err != nil {
		return err
	}
	var evidence any
	if a.Info.Evidence != nil {
		evidence = a.Info.Evidence
	}
	chapterID := a.Info.ChapterID
	if a.Info.Group != GroupChapter {
		chapterID = nil
	}
	if _, err := tx.Exec(ctx, `INSERT INTO review_sessions
		(id, user_id, workspace_id, chapter_id, group_kind, mode, evidence, items, started_at, last_answer_at)
		SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$9
		WHERE $4::text IS NULL OR EXISTS (SELECT 1 FROM chapters WHERE id=$4 AND workspace_id=$3)
		ON CONFLICT (id) DO NOTHING`,
		a.ID, userID, a.WorkspaceID, chapterID, a.Info.Group, a.Info.Mode, evidence, items, now); err != nil {
		return err
	}
	// The row lock orders a session's answers, so the last one finishes it.
	var owner, wsID string
	var total int
	err = tx.QueryRow(ctx, `SELECT user_id, workspace_id, jsonb_array_length(items) FROM review_sessions WHERE id=$1 FOR UPDATE`, a.ID).
		Scan(&owner, &wsID, &total)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (owner != userID || wsID != mt.WorkspaceID)) {
		return ErrReviewSession
	}
	if err != nil {
		return err
	}
	var correct, totalMarks *float64
	var graded any
	var answers []byte
	if it.Kind == "question" {
		correct, totalMarks, graded, answers = &a.Correct, &a.Total, a.Graded, a.Answers
	}
	if _, err := tx.Exec(ctx, `INSERT INTO review_answers
		(session_id, material_id, item_id, kind, rating, correct, total, answers, graded, answered_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
		a.ID, mt.ID, it.ItemID, it.Kind, int(r), correct, totalMarks, answers, graded, now); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE review_sessions SET last_answer_at=$2,
		finished_at = CASE WHEN finished_at IS NULL
			AND (SELECT count(*) FROM review_answers WHERE session_id=$1) >= $3 THEN $2 ELSE finished_at END
		WHERE id=$1`, a.ID, now, total)
	return err
}

// FinishReviewSession ends a session before every item is answered (Done).
func (s *Store) FinishReviewSession(ctx context.Context, userID, id string, now time.Time) error {
	tag, err := s.pool.Exec(ctx, `UPDATE review_sessions SET finished_at=COALESCE(finished_at, $3) WHERE id=$1 AND user_id=$2`, id, userID, now)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ReviewSessionWorkspace is the session's workspace, for its access check;
// ErrNotFound when it is not the user's.
func (s *Store) ReviewSessionWorkspace(ctx context.Context, userID, id string) (string, error) {
	var wsID string
	err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM review_sessions WHERE id=$1 AND user_id=$2`, id, userID).Scan(&wsID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return wsID, err
}

// ResumeReviewSession is an unfinished session's answered items with their
// records and the items still to answer, read from their materials now; items
// that left their material or workspace drop.
func (s *Store) ResumeReviewSession(ctx context.Context, userID, id string) (ReviewSession, error) {
	out := ReviewSession{Items: []ReviewItem{}, Done: []ReviewAnswer{}}
	var wsID string
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT workspace_id, group_kind, chapter_id, mode, evidence, items FROM review_sessions
		WHERE id=$1 AND user_id=$2`, id, userID).
		Scan(&wsID, &out.Group, &out.ChapterID, &out.Mode, &out.Evidence, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	var served []SessionItem
	if err := json.Unmarshal(raw, &served); err != nil {
		return out, err
	}
	// The served items as their materials hold them now, read once per material.
	byMaterial := map[string]map[string]studyItem{}
	current := func(materialID, itemID string) (studyItem, bool, error) {
		items, ok := byMaterial[materialID]
		if !ok {
			items = map[string]studyItem{}
			mt, err := s.GetMaterial(ctx, materialID)
			if err != nil && !errors.Is(err, ErrNotFound) {
				return studyItem{}, false, err
			}
			if err == nil && mt.WorkspaceID == wsID && mt.ParentMaterialID == "" {
				parsed, err := itemsOf(mt)
				if err != nil {
					return studyItem{}, false, err
				}
				for _, p := range parsed {
					p.MaterialTitle = mt.Title
					items[p.ItemID] = p
				}
			}
			byMaterial[materialID] = items
		}
		it, ok := items[itemID]
		return it, ok, nil
	}

	answered := map[string]bool{}
	rows, err := s.pool.Query(ctx, `SELECT material_id, item_id, rating, correct, total, answers, graded
		FROM review_answers WHERE session_id=$1 ORDER BY answered_at, material_id, item_id`, id)
	if err != nil {
		return out, err
	}
	type record struct {
		ReviewAnswer
		graded  []byte
		answers []byte
	}
	var records []record
	for rows.Next() {
		var r record
		if err := rows.Scan(&r.MaterialID, &r.ItemID, &r.Rating, &r.Correct, &r.Total, &r.answers, &r.graded); err != nil {
			rows.Close()
			return out, err
		}
		answered[r.MaterialID+"/"+r.ItemID] = true
		records = append(records, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	out.Total, out.Answered = len(served), len(answered)
	for _, r := range records {
		it, ok, err := current(r.MaterialID, r.ItemID)
		if err != nil {
			return out, err
		}
		if !ok {
			continue
		}
		done := r.ReviewAnswer
		done.ReviewItem = it.ReviewItem
		// A question shows as it was graded, key included, with its answers.
		if it.Kind == "question" && len(r.graded) > 0 {
			if err := json.Unmarshal(r.graded, &done.Question); err != nil {
				return out, err
			}
			if len(r.answers) > 0 {
				if err := json.Unmarshal(r.answers, &done.Answers); err != nil {
					return out, err
				}
			}
		}
		out.Done = append(out.Done, done)
	}
	for _, it := range served {
		if answered[it.MaterialID+"/"+it.ItemID] {
			continue
		}
		p, ok, err := current(it.MaterialID, it.ItemID)
		if err != nil {
			return out, err
		}
		if ok {
			out.Items = append(out.Items, p.ReviewItem)
		}
	}
	return out, nil
}

/* -------------------------------------------------------------- overview */

// UnfinishedSession is a session left before its end, for Continue review.
type UnfinishedSession struct {
	ID            string    `json:"id"`
	WorkspaceID   string    `json:"workspaceId"`
	WorkspaceName string    `json:"workspaceName"`
	IconID        string    `json:"iconId"`
	Group         string    `json:"group" enum:"chapter,others,workspace"`
	ChapterName   string    `json:"chapterName,omitempty"`
	Answered      int       `json:"answered"`
	Total         int       `json:"total"`
	LastAnswerAt  time.Time `json:"lastAnswerAt"`
}

// ReviewWorkspace is one workspace of the Review tab's manual list.
type ReviewWorkspace struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
	IconID      string `json:"iconId"`
	// Reviewable counts the items a manual review draws from.
	Reviewable int `json:"reviewable"`
	// LastReviewedAt is the latest answer of any recorded session; nil when
	// none exists.
	LastReviewedAt *time.Time `json:"lastReviewedAt,omitempty"`
}

type ReviewOverview struct {
	Suggestions []ReviewSuggestion  `json:"suggestions" nullable:"false"`
	Unfinished  []UnfinishedSession `json:"unfinished" nullable:"false"`
	Workspaces  []ReviewWorkspace   `json:"workspaces" nullable:"false"`
}

type reviewableWorkspace struct {
	id, name, iconID string
	lastStudied      time.Time
	lastReviewed     *time.Time
}

// reviewableWorkspaces are the workspaces the user tracks progress in, can
// still read and has progress on, by name.
func (s *Store) reviewableWorkspaces(ctx context.Context, userID string) ([]reviewableWorkspace, error) {
	rows, err := s.pool.Query(ctx, `SELECT w.id, w.name, w.icon_id,
			(SELECT max(sp.updated_at) FROM study_progress sp
				WHERE sp.user_id=$1 AND sp.workspace_id=w.id AND sp.state <> 'removed'),
			(SELECT max(rs.last_answer_at) FROM review_sessions rs WHERE rs.user_id=$1 AND rs.workspace_id=w.id)
		FROM workspaces w
		WHERE EXISTS (SELECT 1 FROM study_progress sp WHERE sp.user_id=$1 AND sp.workspace_id=w.id AND sp.state <> 'removed')
		ORDER BY w.name, w.id`, userID)
	if err != nil {
		return nil, err
	}
	var all []reviewableWorkspace
	for rows.Next() {
		var ws reviewableWorkspace
		if err := rows.Scan(&ws.id, &ws.name, &ws.iconID, &ws.lastStudied, &ws.lastReviewed); err != nil {
			rows.Close()
			return nil, err
		}
		all = append(all, ws)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var out []reviewableWorkspace
	for _, ws := range all {
		// Access can end after progress was recorded; progress can be off.
		if _, err := s.WorkspaceEffectiveRole(ctx, userID, ws.id); err != nil {
			if errors.Is(err, ErrNotFound) || errors.Is(err, ErrForbidden) {
				continue
			}
			return nil, err
		}
		on, err := s.StudyEnabled(ctx, userID, ws.id)
		if err != nil {
			return nil, err
		}
		if on {
			out = append(out, ws)
		}
	}
	return out, nil
}

// ReviewOverview is Learning's Review tab: suggestions across workspaces,
// sessions to continue, and every workspace for a manual review.
func (s *Store) ReviewOverview(ctx context.Context, userID string, now time.Time) (ReviewOverview, error) {
	out := ReviewOverview{Suggestions: []ReviewSuggestion{}, Unfinished: []UnfinishedSession{}, Workspaces: []ReviewWorkspace{}}
	prefsRaw, err := s.StudyPreferencesOf(ctx, userID)
	if err != nil {
		return out, err
	}
	prefs := reviewPrefsOf(prefsRaw)
	manual := prefs
	manual.Focus = "balanced"
	list, err := s.reviewableWorkspaces(ctx, userID)
	if err != nil {
		return out, err
	}
	var all []ReviewSuggestion
	readable := map[string]reviewableWorkspace{}
	for _, ws := range list {
		readable[ws.id] = ws
		items, history, err := s.scoredWorkspace(ctx, userID, ws.id, prefs, now)
		if err != nil {
			return out, err
		}
		out.Workspaces = append(out.Workspaces, ReviewWorkspace{
			WorkspaceID: ws.id, Name: ws.name, IconID: ws.iconID,
			Reviewable: len(items), LastReviewedAt: ws.lastReviewed,
		})
		for _, sg := range groupSuggestions(items, history, interest(now.Sub(ws.lastStudied))) {
			sg.WorkspaceID, sg.WorkspaceName, sg.IconID = ws.id, ws.name, ws.iconID
			all = append(all, sg)
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].score > all[j].score })
	perWS := map[string]int{}
	for _, sg := range all {
		if len(out.Suggestions) == suggestionsShown {
			break
		}
		if perWS[sg.WorkspaceID] == suggestionsPerWS {
			continue
		}
		perWS[sg.WorkspaceID]++
		out.Suggestions = append(out.Suggestions, sg)
	}
	if err := s.nameChapters(ctx, out.Suggestions); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT rs.id, rs.workspace_id, rs.group_kind, COALESCE(c.name, ''),
			(SELECT count(*) FROM review_answers ra WHERE ra.session_id=rs.id), jsonb_array_length(rs.items), rs.last_answer_at
		FROM review_sessions rs LEFT JOIN chapters c ON c.id=rs.chapter_id
		WHERE rs.user_id=$1 AND rs.finished_at IS NULL ORDER BY rs.last_answer_at DESC`, userID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var u UnfinishedSession
		if err := rows.Scan(&u.ID, &u.WorkspaceID, &u.Group, &u.ChapterName, &u.Answered, &u.Total, &u.LastAnswerAt); err != nil {
			return out, err
		}
		ws, ok := readable[u.WorkspaceID]
		if !ok {
			continue
		}
		u.WorkspaceName, u.IconID = ws.name, ws.iconID
		out.Unfinished = append(out.Unfinished, u)
	}
	return out, rows.Err()
}

// nameChapters fills in the chapter names of chapter suggestions.
func (s *Store) nameChapters(ctx context.Context, list []ReviewSuggestion) error {
	var ids []string
	for _, sg := range list {
		if sg.ChapterID != nil {
			ids = append(ids, *sg.ChapterID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id, name FROM chapters WHERE id = ANY($1)`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	names := map[string]string{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return err
		}
		names[id] = name
	}
	for i, sg := range list {
		if sg.ChapterID != nil {
			list[i].ChapterName = names[*sg.ChapterID]
		}
	}
	return rows.Err()
}

// workspaceSuggestion is the Study tab's: the workspace's strongest
// suggestion, nil when none passes.
func (s *Store) workspaceSuggestion(ctx context.Context, userID, wsID string, now time.Time) (*ReviewSuggestion, error) {
	prefsRaw, err := s.StudyPreferencesOf(ctx, userID)
	if err != nil {
		return nil, err
	}
	items, history, err := s.scoredWorkspace(ctx, userID, wsID, reviewPrefsOf(prefsRaw), now)
	if err != nil {
		return nil, err
	}
	// The learner is in the workspace now, so its interest is full.
	list := groupSuggestions(items, history, 1)
	if len(list) == 0 {
		return nil, nil
	}
	top := list[:1]
	top[0].WorkspaceID = wsID
	if err := s.pool.QueryRow(ctx, `SELECT name, icon_id FROM workspaces WHERE id=$1`, wsID).Scan(&top[0].WorkspaceName, &top[0].IconID); err != nil {
		return nil, err
	}
	if err := s.nameChapters(ctx, top); err != nil {
		return nil, err
	}
	return &top[0], nil
}

/* ---------------------------------------------------------- past reviews */

// SessionScore is a session's quiz or flashcard result: marks for questions,
// cards rated Good or Easy for flashcards.
type SessionScore struct {
	Correct float64 `json:"correct"`
	Total   float64 `json:"total"`
}

type PastReview struct {
	ID            string        `json:"id"`
	WorkspaceID   string        `json:"workspaceId"`
	WorkspaceName string        `json:"workspaceName"`
	IconID        string        `json:"iconId"`
	Group         string        `json:"group" enum:"chapter,others,workspace"`
	ChapterID     *string       `json:"chapterId,omitempty"`
	ChapterName   string        `json:"chapterName,omitempty"`
	Mode          *string       `json:"mode,omitempty" enum:"tricky,fading,learned"`
	StartedAt     time.Time     `json:"startedAt"`
	FinishedAt    time.Time     `json:"finishedAt"`
	LastAnswerAt  time.Time     `json:"lastAnswerAt"`
	Answered      int           `json:"answered"`
	Total         int           `json:"total"`
	Quiz          *SessionScore `json:"quiz,omitempty"`
	Cards         *SessionScore `json:"cards,omitempty"`
}

type PastReviewParams struct {
	Sort       string // date, quiz, cards, time
	Ascending  bool
	Workspaces []string
	Has        []string // quiz, flashcards
	Offset     int
	Limit      int
}

// PastReviews lists the user's finished sessions. The second value is whether
// more follow.
func (s *Store) PastReviews(ctx context.Context, userID string, p PastReviewParams) ([]PastReview, bool, error) {
	order := map[string]string{
		"date":  "s.started_at",
		"quiz":  "s.qc / NULLIF(s.qt, 0)",
		"cards": "s.kc::float / NULLIF(s.kt, 0)",
		"time":  "s.last_answer_at - s.started_at",
	}[p.Sort]
	if order == "" {
		order = "s.started_at"
	}
	dir := " DESC NULLS LAST"
	if p.Ascending {
		dir = " ASC NULLS LAST"
	}
	where := []string{"rs.user_id=$1", "rs.finished_at IS NOT NULL"}
	args := []any{userID}
	if len(p.Workspaces) > 0 {
		args = append(args, p.Workspaces)
		where = append(where, "rs.workspace_id = ANY($2)")
	}
	q := `WITH s AS (SELECT rs.id, rs.workspace_id, w.name, w.icon_id, rs.group_kind, COALESCE(c.name, '') AS chapter,
			rs.mode, rs.chapter_id, rs.started_at, rs.finished_at, rs.last_answer_at, jsonb_array_length(rs.items) AS served,
			(SELECT count(*) FROM review_answers WHERE session_id=rs.id) AS answered,
			(SELECT sum(correct) FROM review_answers WHERE session_id=rs.id AND kind='question') AS qc,
			(SELECT sum(total) FROM review_answers WHERE session_id=rs.id AND kind='question') AS qt,
			(SELECT count(*) FILTER (WHERE rating >= 3) FROM review_answers WHERE session_id=rs.id AND kind='card') AS kc,
			(SELECT count(*) FROM review_answers WHERE session_id=rs.id AND kind='card') AS kt
		FROM review_sessions rs JOIN workspaces w ON w.id=rs.workspace_id LEFT JOIN chapters c ON c.id=rs.chapter_id
		WHERE ` + strings.Join(where, " AND ") + `)
		SELECT s.id, s.workspace_id, s.name, s.icon_id, s.group_kind, s.chapter_id, s.chapter, s.mode, s.started_at, s.finished_at,
			s.last_answer_at, s.answered, s.served, s.qc, s.qt, s.kc, s.kt
		FROM s`
	var filters []string
	for _, h := range p.Has {
		switch h {
		case "quiz":
			filters = append(filters, "s.qt > 0")
		case "flashcards":
			filters = append(filters, "s.kt > 0")
		}
	}
	if len(filters) > 0 {
		q += " WHERE " + strings.Join(filters, " OR ")
	}
	q += " ORDER BY " + order + dir + ", s.started_at DESC, s.id"
	args = append(args, p.Limit+1, p.Offset)
	q += " LIMIT $" + strconv.Itoa(len(args)-1) + " OFFSET $" + strconv.Itoa(len(args))
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := []PastReview{}
	for rows.Next() {
		var r PastReview
		var qc, qt *float64
		var kc, kt *int64
		if err := rows.Scan(&r.ID, &r.WorkspaceID, &r.WorkspaceName, &r.IconID, &r.Group, &r.ChapterID, &r.ChapterName, &r.Mode,
			&r.StartedAt, &r.FinishedAt, &r.LastAnswerAt, &r.Answered, &r.Total, &qc, &qt, &kc, &kt); err != nil {
			return nil, false, err
		}
		if qt != nil && *qt > 0 {
			r.Quiz = &SessionScore{Correct: orZero(qc), Total: *qt}
		}
		if kt != nil && *kt > 0 {
			r.Cards = &SessionScore{Correct: float64(orZero(kc)), Total: float64(*kt)}
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	more := len(out) > p.Limit
	if more {
		out = out[:p.Limit]
	}
	return out, more, nil
}

func orZero[T any](v *T) T {
	var zero T
	if v == nil {
		return zero
	}
	return *v
}
