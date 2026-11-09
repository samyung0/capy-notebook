package store

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
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
// (review.HistoryWeights). Groups (a topic, the items outside topics, or
// the whole workspace) sum their items' parts, so more practised content
// ranks higher, and the largest part names the suggestion's mode.

const (
	ModeTricky  = "tricky"
	ModeFading  = "fading"
	ModeLearned = "learned"

	GroupTopic     = "topic"
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

// topicSessionSize is a Practice topic session's size until the learner picks
// a session size in Settings (Epo 2026-11-04, board F1).
const topicSessionSize = 10

// topicSessionPrefs are a Practice topic session's: its questions only, at
// topicSessionSize unless a size was picked.
func topicSessionPrefs(prefs ReviewPrefs, saved StudyPreferences) ReviewPrefs {
	prefs.Items = "quiz"
	if saved.ReviewSize == 0 {
		prefs.Size = topicSessionSize
	}
	return prefs
}

// kinds are the material kinds the preference reviews.
func (p ReviewPrefs) kinds() []string {
	switch p.Items {
	case "quiz":
		return []string{"quiz"}
	case "flashcards":
		return []string{"flashcards"}
	}
	return []string{"quiz", "flashcards"}
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
	Group         string  `json:"group" enum:"topic,others,workspace"`
	TopicID       *string `json:"topicId,omitempty"`
	TopicName     string  `json:"topicName,omitempty"`
	Mode          string  `json:"mode" enum:"tricky,fading,learned"`
	// Items counts the items a session of this suggestion draws from.
	Items    int            `json:"items"`
	Evidence ReviewEvidence `json:"evidence"`
	score    float64
}

type reviewGroup struct {
	kind    string
	topicID *string
}

func (g reviewGroup) has(it ranked) bool {
	switch g.kind {
	case GroupTopic:
		return it.topicID != nil && g.topicID != nil && *it.topicID == *g.topicID
	case GroupOthers:
		return it.topicID == nil
	}
	return true
}

// groupSuggestions forms a workspace's suggestions from its scored items:
// each topic (and the items outside topics) passing the threshold, or the
// whole workspace when none does but all of it together does. A workspace
// without topics is one group. history feeds the evidence.
func groupSuggestions(items []scored, history map[string][]review.Rating, weight float64) []ReviewSuggestion {
	var due []scored
	hasTopic := false
	for _, it := range items {
		if it.r <= suggestedRecall {
			due = append(due, it)
			hasTopic = hasTopic || it.topicID != nil
		}
	}
	build := func(g reviewGroup) (ReviewSuggestion, bool) {
		out := ReviewSuggestion{Group: g.kind, TopicID: g.topicID}
		var parts, labels [3]float64
		var forgotten float64
		for _, it := range due {
			if !g.has(it.ranked) {
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
	if !hasTopic {
		if s, ok := build(reviewGroup{kind: GroupWorkspace}); ok {
			return []ReviewSuggestion{s}
		}
		return nil
	}
	var groups []reviewGroup
	seen := map[string]bool{}
	for _, it := range due {
		if it.topicID == nil {
			if !seen[""] {
				groups = append(groups, reviewGroup{kind: GroupOthers})
			}
			seen[""] = true
		} else if !seen[*it.topicID] {
			seen[*it.topicID] = true
			groups = append(groups, reviewGroup{kind: GroupTopic, topicID: it.topicID})
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
		if g.has(it.ranked) && (!due || it.r <= suggestedRecall) {
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
	Group    string          `json:"group" enum:"topic,others,workspace"`
	TopicID  *string         `json:"topicId,omitempty"`
	Mode     *string         `json:"mode,omitempty" enum:"tricky,fading,learned" doc:"Omitted for a review started from the workspace list"`
	Evidence *ReviewEvidence `json:"evidence,omitempty"`
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
	// RemovedAssetIDs are the card and question images of Items that no
	// longer exist (M16), shown as removed. Done are graded copies, whose
	// missing images keep the plain empty box (Q270).
	RemovedAssetIDs []string `json:"removedAssetIds,omitempty"`
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

// ErrReviewGroup refuses a session of a topic that is not the workspace's.
var ErrReviewGroup = errors.New("no such review group in this workspace")

// WorkspaceReview is a new session: a suggestion's items (mode set) or, from
// the workspace list, the whole workspace's. questionsOnly serves questions
// whatever the review items preference (Practice's topic sessions).
func (s *Store) WorkspaceReview(ctx context.Context, userID, wsID string, info ReviewSessionInfo, questionsOnly bool, start ReviewOptions, now time.Time) (ReviewSession, error) {
	out := ReviewSession{ReviewSessionInfo: info, Items: []ReviewItem{}, Done: []ReviewAnswer{}}
	if info.Group == GroupTopic {
		var ok bool
		if info.TopicID == nil {
			return out, ErrReviewGroup
		}
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM topics WHERE id=$1 AND workspace_id=$2)`, *info.TopicID, wsID).Scan(&ok); err != nil {
			return out, err
		}
		if !ok {
			return out, ErrReviewGroup
		}
	} else {
		out.TopicID = nil
	}
	prefsRaw, err := s.StudyPreferencesOf(ctx, userID)
	if err != nil {
		return out, err
	}
	prefs := reviewPrefsOf(prefsRaw)
	if questionsOnly {
		prefs = topicSessionPrefs(prefs, prefsRaw)
	}
	if start.Count > 0 {
		prefs.Size = start.Count
	}
	items, history, err := s.scoredWorkspace(ctx, userID, wsID, prefs, now)
	if err != nil {
		return out, err
	}
	g := reviewGroup{kind: info.Group, topicID: out.TopicID}
	if info.Mode != nil {
		// The evidence the session started from, for its record.
		for _, sg := range groupSuggestions(items, history, 1) {
			if sg.Group == g.kind && (g.topicID == nil) == (sg.TopicID == nil) && (g.topicID == nil || *g.topicID == *sg.TopicID) {
				ev := sg.Evidence
				out.Evidence = &ev
			}
		}
	} else {
		out.Evidence = nil
	}
	var fresh []ranked
	if info.Mode == nil || start.Count > 0 {
		if fresh, err = s.newPool(ctx, userID, wsID); err != nil {
			return out, err
		}
	}
	switch {
	case start.Order == ReviewOrderUnattempted || start.Order == ReviewOrderIncorrect:
		out.Items = orderedItems(start.Order, items, fresh, history, g, prefs)
	case info.Mode != nil:
		out.Items = pickItems(items, g, true, prefs.Size)
		// A size the learner picked: past the suggestion's own items, the
		// rest of the group as a manual session draws it.
		if start.Count > len(out.Items) {
			out.Items = topUp(out.Items, withNew(items, fresh, g, prefs), prefs.Size)
		}
	default:
		out.Items = withNew(items, fresh, g, prefs)
	}
	withReasons(out.Items, fresh, history)
	out.Total = len(out.Items)
	return out, nil
}

// withReasons names why each served item came: new when it is in the new
// pool, missed when a miss is among its latest answers, else fading.
func withReasons(items []ReviewItem, fresh []ranked, history map[string][]review.Rating) {
	isNew := make(map[string]bool, len(fresh))
	for _, it := range fresh {
		isNew[it.MaterialID+"/"+it.ItemID] = true
	}
	for i, it := range items {
		key := it.MaterialID + "/" + it.ItemID
		switch {
		case isNew[key]:
			items[i].Reason = ReasonNew
		case slices.Contains(history[key], review.Again):
			items[i].Reason = ReasonMissed
		default:
			items[i].Reason = ReasonFading
		}
	}
}

// How a learner asked a session to be drawn (Epo 2026-11-04): a size, and which
// items come first. The empty order is Recommended, today's draw.
const (
	ReviewOrderUnattempted = "unattempted"
	ReviewOrderIncorrect   = "incorrect"
)

// ReviewOptions are a session's start dialog choices.
type ReviewOptions struct {
	Count int
	Order string
}

// orderedItems serves the group's never answered items or its latest misses
// first, then the rest: practised by score, never answered in reading order.
func orderedItems(order string, practised []scored, fresh []ranked, history map[string][]review.Rating, g reviewGroup, prefs ReviewPrefs) []ReviewItem {
	var inGroup []scored
	for _, it := range practised {
		if g.has(it.ranked) {
			inGroup = append(inGroup, it)
		}
	}
	sort.SliceStable(inGroup, func(i, j int) bool { return inGroup[i].score() > inGroup[j].score() })
	var missed, others, unseen []ReviewItem
	for _, it := range inGroup {
		last := history[it.MaterialID+"/"+it.ItemID]
		if len(last) > 0 && (last[0] == review.Again || last[0] == review.Hard) {
			missed = append(missed, it.ReviewItem)
		} else {
			others = append(others, it.ReviewItem)
		}
	}
	for _, it := range fresh {
		if g.has(it) && prefs.takes(it.Kind) {
			unseen = append(unseen, it.ReviewItem)
		}
	}
	var out []ReviewItem
	if order == ReviewOrderUnattempted {
		out = slices.Concat(unseen, missed, others)
	} else {
		out = slices.Concat(missed, others, unseen)
	}
	if len(out) > prefs.Size {
		out = out[:prefs.Size]
	}
	return out
}

// topUp adds more's items not yet in items, up to size.
func topUp(items, more []ReviewItem, size int) []ReviewItem {
	for _, it := range more {
		if len(items) >= size {
			break
		}
		if !slices.ContainsFunc(items, func(c ReviewItem) bool { return c.MaterialID == it.MaterialID && c.ItemID == it.ItemID }) {
			items = append(items, it)
		}
	}
	return items
}

// MixInQuestions are up to n of the caller's answered questions, those most
// worth another look first, within topics when any are named: Make my own
// practice's "Mix in questions I have answered". Graded with their keys, since
// they become a quiz the caller owns.
func (s *Store) MixInQuestions(ctx context.Context, userID, wsID string, topics []string, n int, now time.Time) ([]map[string]any, error) {
	items, _, err := s.scoredWorkspace(ctx, userID, wsID, ReviewPrefs{Size: n, Items: "quiz", Focus: "balanced"}, now)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].score() > items[j].score() })
	out := []map[string]any{}
	for _, it := range items {
		if len(out) == n {
			break
		}
		if len(topics) > 0 && (it.topicID == nil || !slices.Contains(topics, *it.topicID)) {
			continue
		}
		if it.Question != nil {
			out = append(out, it.Question)
		}
	}
	return out, nil
}

// StudyQuestionCount is how many questions a group holds, which caps a session's
// size in its start dialog.
func (s *Store) StudyQuestionCount(ctx context.Context, userID, wsID, group string, topicID *string, now time.Time) (int, error) {
	pool, err := s.reviewPool(ctx, userID, wsID, now)
	if err != nil {
		return 0, err
	}
	fresh, err := s.newPool(ctx, userID, wsID)
	if err != nil {
		return 0, err
	}
	g := reviewGroup{kind: group, topicID: topicID}
	n := 0
	for _, it := range append(pool, fresh...) {
		if it.Kind == "question" && g.has(it) {
			n++
		}
	}
	return n, nil
}

// newShare is a manual session's share of never-rated items (Epo 2026-10-25:
// 60% new, 40% practised); either side fills the other's places when it runs
// short.
const newShare = 0.6

// withNew fills a manual session: practised items as pickItems ranks them and
// new ones in reading order, spread through the session in their shares.
func withNew(practised []scored, fresh []ranked, g reviewGroup, prefs ReviewPrefs) []ReviewItem {
	var newIn []ranked
	for _, it := range fresh {
		if g.has(it) && prefs.takes(it.Kind) {
			newIn = append(newIn, it)
		}
	}
	oldAvail := 0
	for _, it := range practised {
		if g.has(it.ranked) {
			oldAvail++
		}
	}
	wantNew := int(math.Round(newShare * float64(prefs.Size)))
	wantOld := prefs.Size - wantNew
	if len(newIn) < wantNew {
		wantOld += wantNew - len(newIn)
		wantNew = len(newIn)
	}
	if oldAvail < wantOld {
		wantNew = min(len(newIn), wantNew+wantOld-oldAvail)
		wantOld = oldAvail
	}
	old := pickItems(practised, g, false, wantOld)
	newIn = newIn[:wantNew]
	out := make([]ReviewItem, 0, len(old)+len(newIn))
	i, j := 0, 0
	for i < len(old) || j < len(newIn) {
		// The share taken so far decides the next one.
		if j < len(newIn) && (i >= len(old) || j*len(old) <= i*len(newIn)) {
			out = append(out, newIn[j].ReviewItem)
			j++
		} else {
			out = append(out, old[i])
			i++
		}
	}
	return out
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
	// Reason is the served item's ReviewItem.Reason, kept for Continue and
	// the result.
	Reason string `json:"reason,omitempty" enum:"new,missed,fading"`
}

// ErrReviewSession refuses an answer for someone else's session or for an
// item outside the session's workspace.
var ErrReviewSession = errors.New("not this review session")

// storedSession is a recorded session as an answer is checked against it.
type storedSession struct {
	owner, workspaceID, group string
	total                     int
}

func lockSessionTx(ctx context.Context, tx pgx.Tx, id string) (storedSession, error) {
	var st storedSession
	err := tx.QueryRow(ctx, `SELECT user_id, workspace_id, group_kind, jsonb_array_length(items)
		FROM review_sessions WHERE id=$1 FOR UPDATE`, id).
		Scan(&st.owner, &st.workspaceID, &st.group, &st.total)
	return st, err
}

// takes reports whether an answer in itemWS belongs to the stored session.
func (st storedSession) takes(userID, itemWS string, a *SessionAnswer) bool {
	return st.owner == userID && st.group == a.Info.Group && st.workspaceID == a.WorkspaceID && itemWS == st.workspaceID
}

// insertSessionTx writes the session with its first answer, checked against
// the workspace it draws from.
func insertSessionTx(ctx context.Context, tx pgx.Tx, userID string, mt Material, a *SessionAnswer, now time.Time) error {
	if mt.StudyWorkspaceID() != a.WorkspaceID {
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
	topicID := a.Info.TopicID
	if a.Info.Group != GroupTopic {
		topicID = nil
	}
	_, err = tx.Exec(ctx, `INSERT INTO review_sessions
		(id, user_id, workspace_id, topic_id, group_kind, mode, evidence, items, started_at, last_answer_at)
		SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$9
		WHERE $4::text IS NULL OR EXISTS (SELECT 1 FROM topics WHERE id=$4 AND workspace_id=$3)
		ON CONFLICT (id) DO NOTHING`,
		a.ID, userID, a.WorkspaceID, topicID, a.Info.Group, a.Info.Mode, evidence, items, now)
	return err
}

// recordAnswerTx writes the session on its first answer, then the answer, and
// finishes the session once every served item is answered.
func recordAnswerTx(ctx context.Context, tx pgx.Tx, userID string, mt Material, it studyItem, r review.Rating, a *SessionAnswer, now time.Time) error {
	// The row lock orders a session's answers, so the last one finishes it.
	stored, err := lockSessionTx(ctx, tx, a.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := insertSessionTx(ctx, tx, userID, mt, a, now); err != nil {
			return err
		}
		stored, err = lockSessionTx(ctx, tx, a.ID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrReviewSession
	}
	if err != nil {
		return err
	}
	if !stored.takes(userID, mt.StudyWorkspaceID(), a) {
		return ErrReviewSession
	}
	total := stored.total
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
// that left their material or workspace drop, as do those of a material the
// caller may not read now: hidden or assigned since it was served, or never
// theirs, since the browser sends the served list.
func (s *Store) ResumeReviewSession(ctx context.Context, userID, id string) (ReviewSession, error) {
	out := ReviewSession{Items: []ReviewItem{}, Done: []ReviewAnswer{}}
	var wsID string
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT workspace_id, group_kind, topic_id, mode, evidence, items FROM review_sessions
		WHERE id=$1 AND user_id=$2`, id, userID).
		Scan(&wsID, &out.Group, &out.TopicID, &out.Mode, &out.Evidence, &raw)
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
	reasons := make(map[string]string, len(served))
	for _, it := range served {
		reasons[it.MaterialID+"/"+it.ItemID] = it.Reason
	}
	// The served items as their materials hold them now, read once per material.
	byMaterial := map[string]map[string]studyItem{}
	current := func(materialID, itemID string) (studyItem, bool, error) {
		items, ok := byMaterial[materialID]
		if !ok {
			items = map[string]studyItem{}
			_, err := materialEffectiveAccess(ctx, s.pool, userID, materialID)
			if err != nil && !errors.Is(err, ErrNotFound) {
				return studyItem{}, false, err
			}
			var mt Material
			if err == nil {
				mt, err = s.GetMaterial(ctx, materialID)
			}
			if err != nil && !errors.Is(err, ErrNotFound) {
				return studyItem{}, false, err
			}
			if err == nil && mt.StudyWorkspaceID() == wsID && mt.ParentMaterialID == "" {
				parsed, err := itemsOf(mt)
				if err != nil && !refused(err) {
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
		done.Reason = reasons[r.MaterialID+"/"+r.ItemID]
		// A question shows as it was graded, key included, with its answers. Its
		// Question is the shared cached map until this clears it.
		if it.Kind == "question" && len(r.graded) > 0 {
			done.Question = nil
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
			item := p.ReviewItem
			item.Reason = it.Reason
			out.Items = append(out.Items, item)
		}
	}
	return out, nil
}

/* -------------------------------------------------------------- overview */

// UnfinishedSession is a session left before its end, for Continue review.
type UnfinishedSession struct {
	ID            string `json:"id"`
	WorkspaceID   string `json:"workspaceId"`
	WorkspaceName string `json:"workspaceName"`
	IconID        string `json:"iconId"`
	Group         string `json:"group" enum:"topic,others,workspace"`
	// TopicName is a topic session's topic, or a plan session's plan.
	TopicName    string    `json:"topicName,omitempty"`
	Answered     int       `json:"answered"`
	Total        int       `json:"total"`
	LastAnswerAt time.Time `json:"lastAnswerAt"`
}

// nameTopics fills in the topic names of topic suggestions.
func (s *Store) nameTopics(ctx context.Context, list []ReviewSuggestion) error {
	var ids []string
	for _, sg := range list {
		if sg.TopicID != nil {
			ids = append(ids, *sg.TopicID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id, name FROM topics WHERE id = ANY($1)`, ids)
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
		if sg.TopicID != nil {
			list[i].TopicName = names[*sg.TopicID]
		}
	}
	return rows.Err()
}

/* ---------------------------------------------------------- past reviews */

// SessionScore is a session's quiz or flashcard result: marks for questions,
// cards rated Good or Easy for flashcards.
type SessionScore struct {
	Correct float64 `json:"correct"`
	Total   float64 `json:"total"`
}

type PastReview struct {
	ID            string  `json:"id"`
	WorkspaceID   string  `json:"workspaceId"`
	WorkspaceName string  `json:"workspaceName"`
	IconID        string  `json:"iconId"`
	Group         string  `json:"group" enum:"topic,others,workspace"`
	TopicID       *string `json:"topicId,omitempty"`
	// TopicName is a topic session's topic.
	TopicName    string        `json:"topicName,omitempty"`
	Mode         *string       `json:"mode,omitempty" enum:"tricky,fading,learned"`
	StartedAt    time.Time     `json:"startedAt"`
	FinishedAt   *time.Time    `json:"finishedAt,omitempty" doc:"Omitted on the result page of a session not finished yet"`
	LastAnswerAt time.Time     `json:"lastAnswerAt"`
	Answered     int           `json:"answered"`
	Total        int           `json:"total"`
	Quiz         *SessionScore `json:"quiz,omitempty"`
	Cards        *SessionScore `json:"cards,omitempty"`
}

type PastReviewParams struct {
	Sort       string // date, quiz, cards, time, workspace, topic, status
	Ascending  bool
	Workspaces []string
	Has        []string // quiz, flashcards
	// ID reads one session, finished or not, for its result page.
	ID     string
	Offset int
	Limit  int
}

// PastReviews lists the user's finished sessions. The second value is whether
// more follow.
func (s *Store) PastReviews(ctx context.Context, userID string, p PastReviewParams) ([]PastReview, bool, error) {
	order := map[string]string{
		"date":      "s.started_at",
		"quiz":      "s.qc / NULLIF(s.qt, 0)",
		"cards":     "s.kc::float / NULLIF(s.kt, 0)",
		"time":      "s.last_answer_at - s.started_at",
		"workspace": "lower(s.name)",
		// Topic sessions by name; Others and whole-workspace ones last.
		"topic": "CASE WHEN s.group_kind = 'topic' THEN lower(s.topic) END",
		// Completed (every served item answered) before stopped, ascending.
		"status": "s.answered < s.served",
	}[p.Sort]
	if order == "" {
		order = "s.started_at"
	}
	dir := " DESC NULLS LAST"
	if p.Ascending {
		dir = " ASC NULLS LAST"
	}
	where := []string{"rs.user_id=$1"}
	args := []any{userID}
	if p.ID != "" {
		args = append(args, p.ID)
		where = append(where, "rs.id = $2")
	} else {
		where = append(where, "rs.finished_at IS NOT NULL")
	}
	if len(p.Workspaces) > 0 {
		args = append(args, p.Workspaces)
		where = append(where, "rs.workspace_id = ANY($"+strconv.Itoa(len(args))+")")
	}
	// The caller's history stays, but names it can no longer reach are blank
	// (Sam 2026-10-19), as on the Files page.
	lost := lostAccessSQL("rs.workspace_id", "$1")
	q := `WITH s AS (SELECT rs.id, rs.workspace_id,
			CASE WHEN ` + lost + ` THEN '' ELSE w.name END AS name,
			CASE WHEN ` + lost + ` THEN '' ELSE w.icon_id END AS icon_id,
			rs.group_kind, CASE WHEN ` + lost + ` THEN '' ELSE COALESCE(c.name, '') END AS topic,
			rs.mode, rs.topic_id, rs.started_at, rs.finished_at, rs.last_answer_at, jsonb_array_length(rs.items) AS served,
			(SELECT count(*) FROM review_answers WHERE session_id=rs.id) AS answered,
			(SELECT sum(correct) FROM review_answers WHERE session_id=rs.id AND kind='question') AS qc,
			(SELECT sum(total) FROM review_answers WHERE session_id=rs.id AND kind='question') AS qt,
			(SELECT count(*) FILTER (WHERE rating >= 3) FROM review_answers WHERE session_id=rs.id AND kind='card') AS kc,
			(SELECT count(*) FROM review_answers WHERE session_id=rs.id AND kind='card') AS kt
		FROM review_sessions rs JOIN workspaces w ON w.id=rs.workspace_id LEFT JOIN topics c ON c.id=rs.topic_id
		WHERE ` + strings.Join(where, " AND ") + `)
		SELECT s.id, s.workspace_id, s.name, s.icon_id, s.group_kind, s.topic_id, s.topic, s.mode, s.started_at, s.finished_at,
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
		if err := rows.Scan(&r.ID, &r.WorkspaceID, &r.WorkspaceName, &r.IconID, &r.Group, &r.TopicID, &r.TopicName, &r.Mode,
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

// ReviewResult is a session's result page: its Past reviews row, its answered
// items in answer order with their records, and Better, how many were rated
// above their latest answer before the session (gains only).
type ReviewResult struct {
	Session PastReview     `json:"session"`
	Items   []ReviewAnswer `json:"items" nullable:"false"`
	Better  int            `json:"better"`
}

func (s *Store) ReviewSessionResult(ctx context.Context, userID, id string) (ReviewResult, error) {
	out := ReviewResult{Items: []ReviewAnswer{}}
	rows, _, err := s.PastReviews(ctx, userID, PastReviewParams{ID: id, Limit: 1})
	if err != nil {
		return out, err
	}
	if len(rows) == 0 {
		return out, ErrNotFound
	}
	out.Session = rows[0]
	session, err := s.ResumeReviewSession(ctx, userID, id)
	if err != nil {
		return out, err
	}
	out.Items = session.Done
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM review_answers ra JOIN review_sessions rs ON rs.id=ra.session_id
		WHERE ra.session_id=$1 AND ra.rating > (SELECT rl.rating FROM review_log rl
			WHERE rl.user_id=rs.user_id AND rl.material_id=ra.material_id AND rl.item_id=ra.item_id
				AND rl.reviewed_at < rs.started_at
			ORDER BY rl.reviewed_at DESC LIMIT 1)`, id).Scan(&out.Better)
	return out, err
}
