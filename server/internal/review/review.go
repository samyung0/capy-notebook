// Package review rates quiz questions and flashcards with FSRS. Nothing is
// scheduled by date: callers store the memory state and order items by how
// likely the learner is to have forgotten them (Retrievability).
package review

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"time"

	fsrs "github.com/open-spaced-repetition/go-fsrs/v3"
)

// Rating is a flashcard button: 1 Again, 2 Hard, 3 Good, 4 Easy.
type Rating = fsrs.Rating

const (
	Again = fsrs.Again
	Hard  = fsrs.Hard
	Good  = fsrs.Good
	Easy  = fsrs.Easy
)

// State is one item's stored memory state for one user.
type State struct {
	Stability  float64
	Difficulty float64
	Reps       int
	Lapses     int
	FSRSState  int16
	LastReview time.Time
}

var scheduler = func() *fsrs.FSRS {
	p := fsrs.DefaultParam() // target retention 0.9, fuzz off
	p.MaximumInterval = 365
	// No same-day learning steps: nothing is scheduled by time, and a miss on
	// any rated item counts as a lapse, which ranks the hardest items.
	p.EnableShortTerm = false
	return fsrs.NewFSRS(p)
}()

func card(s *State) fsrs.Card {
	if s == nil {
		return fsrs.NewCard()
	}
	c := fsrs.NewCard()
	c.Stability, c.Difficulty = s.Stability, s.Difficulty
	c.Reps, c.Lapses = uint64(s.Reps), uint64(s.Lapses)
	c.State, c.LastReview = fsrs.State(s.FSRSState), s.LastReview
	return c
}

// Rate returns the state after rating; prev is nil for an item never rated.
// A miss on a new item is a lapse too: go-fsrs counts lapses only on items it
// has seen, and Quick review ranks the hardest items by lapses.
func Rate(prev *State, r Rating, now time.Time) State {
	c := scheduler.Next(card(prev), now, r).Card
	if prev == nil && r == Again {
		c.Lapses = 1
	}
	return State{
		Stability: c.Stability, Difficulty: c.Difficulty,
		Reps: int(c.Reps), Lapses: int(c.Lapses),
		FSRSState: int16(c.State), LastReview: c.LastReview,
	}
}

// Retrievability is the chance the learner still recalls the item now.
func Retrievability(s State, now time.Time) float64 {
	return scheduler.GetRetrievability(card(&s), now)
}

// ScoreRating maps a question's score (awarded / max, 0 to 1) to a rating.
// A question is never Easy.
func ScoreRating(score float64) Rating {
	switch {
	case score < 0.5:
		return Again
	case score < 0.7:
		return Hard
	default:
		return Good
	}
}

// CardHash identifies a card's content; an edit to either side makes it new.
func CardHash(front, back string) string {
	return hash([]string{front, back})
}

// QuestionHash identifies what a quiz question asks: the text of its stem and
// of each part's prompt. Answers, options, marking schemes, hints, images and
// styling are left out, so editing them keeps the learner's progress.
func QuestionHash(q map[string]any) string {
	parts, _ := q["parts"].([]any)
	prompts := make([][]string, 0, len(parts))
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		prompts = append(prompts, blockText(p["blocks"]))
	}
	return hash(map[string]any{"stem": blockText(q["stem"]), "parts": prompts})
}

// blockText is the text of a block list's text blocks.
func blockText(v any) []string {
	blocks, _ := v.([]any)
	out := []string{}
	for _, raw := range blocks {
		if b, _ := raw.(map[string]any); b["type"] == "text" {
			text, _ := b["text"].(string)
			out = append(out, text)
		}
	}
	return out
}

// QuestionScore is the question's awarded marks over its marks, from an
// attempt snapshot; ok is false when the question carries no marks.
func QuestionScore(q map[string]any) (score float64, ok bool) {
	var awarded, max float64
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		a, _ := p["awarded"].(float64)
		m, _ := p["marks"].(float64)
		awarded, max = awarded+a, max+m
	}
	if max <= 0 {
		return 0, false
	}
	return awarded / max, true
}

func hash(v any) string {
	b, _ := json.Marshal(v) // map keys marshal sorted, so equal content hashes equal
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// Suggested reviews (human/study-progress.md, 2026-10-10) weigh each item by
// how likely it is forgotten (1 - R) and by its answer history: a miss rate
// over the last answers, newest weighted most, pulled towards "probably not
// known yet" until enough answers are in.
const (
	historyLen   = 8    // answers that count, newest first
	historyDecay = 0.9  // weight of each older answer
	priorMiss    = 2    // pseudo-answers assumed missed
	priorKnown   = 0.75 // pseudo-answers assumed known
	weightScale  = 2    // the most a history adds over a never-missed item
)

// Weights are an item's two history parts on top of the base 1 (fading): Tricky
// is the misses seen, Learned the "not known yet" assumption that answers have
// not worn down. Eight straight correct answers give zero for both.
type Weights struct {
	Tricky  float64
	Learned float64
}

// historyFloor is the miss rate after historyLen straight correct answers.
var historyFloor = func() float64 {
	var w float64
	for k := range historyLen {
		w += math.Pow(historyDecay, float64(k))
	}
	return priorMiss / (w + priorMiss + priorKnown)
}()

// missOf is how much a rating counts as a miss: Again fully, Hard half.
func missOf(r Rating) float64 {
	switch r {
	case Again:
		return 1
	case Hard:
		return 0.5
	}
	return 0
}

// HistoryWeights weighs ratings given newest first; only the first historyLen
// count. An empty history is all assumption.
func HistoryWeights(newestFirst []Rating) Weights {
	if len(newestFirst) > historyLen {
		newestFirst = newestFirst[:historyLen]
	}
	var w, missed float64
	for k, r := range newestFirst {
		dw := math.Pow(historyDecay, float64(k))
		w += dw
		missed += dw * missOf(r)
	}
	// The miss rate is (missed + priorMiss) / (w + prior); split into what was
	// seen and what is still assumed, less the floor, scaled to weightScale.
	prior := priorMiss + priorKnown
	scale := weightScale / (1 - historyFloor)
	return Weights{
		Tricky: scale * missed / (w + prior),
		// Rounding can leave a hair below zero after a full window.
		Learned: max(scale*(priorMiss/(w+prior)-historyFloor), 0),
	}
}
