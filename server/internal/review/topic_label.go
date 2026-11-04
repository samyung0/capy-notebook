package review

import (
	"math"
	"sort"
	"time"
)

// A topic's label (todo-study-tracking.md section 5, thresholds Epo 2026-11-03)
// is counted from its graded parts, with no fitted model and no stored state:
// success follows Beta(1+right, 1+wrong) over weighted marks. It ignores
// question difficulty; the mastery model replaces it once it exists.
const (
	LabelNotStarted    = "not_started"
	LabelAttempted     = "attempted"
	LabelNeedsPractice = "needs_practice"
	LabelFamiliar      = "familiar"
	LabelProficient    = "proficient"
	LabelMastered      = "mastered"

	ResultRight   = "right"
	ResultPartial = "partial"
	ResultWrong   = "wrong"

	topicMinQuestions  = 3    // different questions before a label means anything
	topicNeedsBelow    = 0.6  // Needs practice: success under this
	topicProficient    = 0.7  // Proficient: success over this
	topicSure          = 0.8  // how sure both must be
	topicClearsAt      = 0.5  // Needs practice leaves below this, so it does not flicker
	topicHalfLifeDays  = 30.0 // older evidence fades (Claude's value)
	topicLaterCheck    = 3 * 24 * time.Hour
	topicLaterScore    = 0.7
	topicRepeatWeight  = 0.5
	topicPartsCounted  = 3.0 // a long question counts like at most this many parts
	topicRecentResults = 6
)

// PartAnswer is one graded part, as answer_events holds it. The parts of one
// check share QuestionID and At.
type PartAnswer struct {
	QuestionID string
	Hash       string
	Awarded    float64
	Marks      float64
	KeySeen    bool
	At         time.Time
}

// TopicStanding is what a topic's answers add up to.
type TopicStanding struct {
	Label string
	// Right of Asked counts each question's latest check: full marks of the
	// different questions answered.
	Right int
	Asked int
	// Recent are the latest checks' results, oldest first.
	Recent []string
	LastAt time.Time
}

type topicCheck struct {
	questionID string
	awarded    float64
	marks      float64
	parts      []PartAnswer
	keySeen    bool
	at         time.Time
}

// TopicLabel replays a topic's parts, oldest first, into its standing at now.
// Replaying is what lets Needs practice stick and Mastered wait for a later
// check. Only a question's latest content counts: an edit starts it again.
func TopicLabel(parts []PartAnswer, now time.Time) TopicStanding {
	if len(parts) == 0 {
		return TopicStanding{Label: LabelNotStarted}
	}
	checks := groupChecks(parts)
	var right, wrong float64
	var at, proficientAt time.Time
	previous := map[string]time.Time{}
	label := LabelAttempted
	mastered := false
	for _, c := range checks {
		fade := fadeOver(at, c.at)
		right, wrong = right*fade, wrong*fade
		at = c.at
		last, seen := previous[c.questionID]
		w := repeatWeight(seen, c.keySeen, c.at.Sub(last))
		previous[c.questionID] = c.at
		for _, p := range c.parts {
			pw := w * min(1, topicPartsCounted/float64(len(c.parts)))
			share := p.Awarded / p.Marks
			right += pw * share
			wrong += pw * (1 - share)
		}
		label = nextLabel(label, right, wrong, len(previous))
		if label != LabelProficient {
			proficientAt, mastered = time.Time{}, false
			continue
		}
		switch {
		case proficientAt.IsZero():
			proficientAt = c.at
		case c.at.Sub(proficientAt) >= topicLaterCheck && c.awarded/c.marks >= topicLaterScore:
			mastered = true
		}
	}
	fade := fadeOver(at, now)
	label = nextLabel(label, right*fade, wrong*fade, len(previous))
	if label == LabelProficient && mastered {
		label = LabelMastered
	}
	out := TopicStanding{Label: label, LastAt: at}
	latest := map[string]topicCheck{}
	for _, c := range checks {
		latest[c.questionID] = c
	}
	out.Asked = len(latest)
	for _, c := range latest {
		if resultOf(c) == ResultRight {
			out.Right++
		}
	}
	recent := checks
	if len(recent) > topicRecentResults {
		recent = recent[len(recent)-topicRecentResults:]
	}
	for _, c := range recent {
		out.Recent = append(out.Recent, resultOf(c))
	}
	return out
}

// groupChecks folds parts into checks in time order, dropping each question's
// checks of content it no longer has.
func groupChecks(parts []PartAnswer) []topicCheck {
	sorted := append([]PartAnswer(nil), parts...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At.Before(sorted[j].At) })
	latestHash := map[string]string{}
	for _, p := range sorted {
		latestHash[p.QuestionID] = p.Hash
	}
	var checks []topicCheck
	type key struct {
		question string
		at       int64
	}
	seen := map[key]int{}
	for _, p := range sorted {
		if latestHash[p.QuestionID] != p.Hash || p.Marks <= 0 {
			continue
		}
		k := key{p.QuestionID, p.At.UnixMicro()}
		i, ok := seen[k]
		if !ok {
			i = len(checks)
			seen[k] = i
			checks = append(checks, topicCheck{questionID: p.QuestionID, keySeen: p.KeySeen, at: p.At})
		}
		checks[i].parts = append(checks[i].parts, p)
		checks[i].awarded += p.Awarded
		checks[i].marks += p.Marks
	}
	return checks
}

func resultOf(c topicCheck) string {
	switch {
	case c.awarded >= c.marks:
		return ResultRight
	case c.awarded > 0:
		return ResultPartial
	}
	return ResultWrong
}

// repeatWeight is 1 for a question's first check, 0 for a same-day repeat
// after seeing the key, and a half otherwise.
func repeatWeight(seen, keySeen bool, since time.Duration) float64 {
	switch {
	case !seen && !keySeen:
		return 1
	case seen && keySeen && since < 24*time.Hour:
		return 0
	}
	return topicRepeatWeight
}

func fadeOver(from, to time.Time) float64 {
	if from.IsZero() || !to.After(from) {
		return 1
	}
	return math.Pow(0.5, to.Sub(from).Hours()/24/topicHalfLifeDays)
}

// nextLabel reads the label from the evidence; current only matters for
// Needs practice, which holds until its certainty falls below topicClearsAt.
func nextLabel(current string, right, wrong float64, questions int) string {
	if questions < topicMinQuestions {
		return LabelAttempted
	}
	a, b := 1+right, 1+wrong
	under := betaCDF(topicNeedsBelow, a, b)
	if under >= topicSure || (current == LabelNeedsPractice && under >= topicClearsAt) {
		return LabelNeedsPractice
	}
	if 1-betaCDF(topicProficient, a, b) >= topicSure {
		return LabelProficient
	}
	return LabelFamiliar
}

// betaCDF is the regularized incomplete beta function I_x(a, b), by its
// continued fraction.
func betaCDF(x, a, b float64) float64 {
	if x <= 0 {
		return 0
	}
	if x >= 1 {
		return 1
	}
	la, _ := math.Lgamma(a)
	lb, _ := math.Lgamma(b)
	lab, _ := math.Lgamma(a + b)
	front := math.Exp(lab - la - lb + a*math.Log(x) + b*math.Log(1-x))
	if x < (a+1)/(a+b+2) {
		return front * betaFraction(x, a, b) / a
	}
	return 1 - front*betaFraction(1-x, b, a)/b
}

func betaFraction(x, a, b float64) float64 {
	const tiny = 1e-30
	guard := func(v float64) float64 {
		if math.Abs(v) < tiny {
			return tiny
		}
		return v
	}
	c, d := 1.0, 1/guard(1-(a+b)*x/(a+1))
	h := d
	for m := 1.0; m <= 200; m++ {
		num := m * (b - m) * x / ((a + 2*m - 1) * (a + 2*m))
		d = 1 / guard(1+num*d)
		c = guard(1 + num/c)
		h *= d * c
		num = -(a + m) * (a + b + m) * x / ((a + 2*m) * (a + 2*m + 1))
		d = 1 / guard(1+num*d)
		c = guard(1 + num/c)
		delta := d * c
		h *= delta
		if math.Abs(delta-1) < 1e-10 {
			break
		}
	}
	return h
}
