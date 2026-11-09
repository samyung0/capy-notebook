package httpapi

import (
	"context"
	"sync"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// markingAttemptTimeout bounds one attempt from when its turn comes, however long
// the line of attempts before it (thirty members handing in one paper took about
// 15 minutes in the 2026-11-04 concurrency run). A 40-part paper took under 90 s.
var markingAttemptTimeout = 10 * time.Minute

// assignmentMarking is what the gateway is marking: the run's progress per
// assignment, the answers its runs hold, and one lock per payer (the member
// attempting), since a payer's sessions are few (store.ConcurrentLLMLeases) and
// thirty submissions at once would use them all. In memory: one gateway
// process marks, and a restart leaves nothing held (Q729).
type assignmentMarking struct {
	mu     sync.Mutex
	runs   map[string]*markingRun
	payers map[string]*sync.Mutex
	held   map[string]*heldAnswers
}

// heldAnswers is what runs hold of one attempt, from queued until their call
// returns or fails, each counted since runs may overlap: the attempt queued
// before its parts are listed, its whole paper being read, or parts by id.
type heldAnswers struct {
	queued, whole int
	parts         map[string]int
}

// hold notes attemptID as being marked until the returned release (which may
// run more than once): parts by id, or with whole every part (a paper read),
// or with neither the attempt alone.
func (m *assignmentMarking) hold(attemptID string, whole bool, parts ...string) func() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.held == nil {
		m.held = map[string]*heldAnswers{}
	}
	h := m.held[attemptID]
	if h == nil {
		h = &heldAnswers{parts: map[string]int{}}
		m.held[attemptID] = h
	}
	add := func(n int) {
		switch {
		case whole:
			h.whole += n
		case len(parts) > 0:
			for _, p := range parts {
				h.parts[p] += n
				if h.parts[p] == 0 {
					delete(h.parts, p)
				}
			}
		default:
			h.queued += n
		}
	}
	add(1)
	var once sync.Once
	return func() {
		once.Do(func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			add(-1)
			if h.queued == 0 && h.whole == 0 && len(h.parts) == 0 && m.held[attemptID] == h {
				delete(m.held, attemptID)
			}
		})
	}
}

// markingOf reads what runs hold of attemptID: whether any, and whether a part
// is among them (every part while its paper is read).
func (m *assignmentMarking) markingOf(attemptID string) (bool, func(partID string) bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := m.held[attemptID]
	if h == nil {
		return false, func(string) bool { return false }
	}
	whole := h.whole > 0
	parts := make(map[string]bool, len(h.parts))
	for p := range h.parts {
		parts[p] = true
	}
	return true, func(partID string) bool { return whole || parts[partID] }
}

type markingRun struct {
	total, done, running int
}

// AssignmentMarkingProgress is "Marking 12 of 40 answers…".
type AssignmentMarkingProgress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

func (m *assignmentMarking) payer(id string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.payers == nil {
		m.payers = map[string]*sync.Mutex{}
	}
	if m.payers[id] == nil {
		m.payers[id] = &sync.Mutex{}
	}
	return m.payers[id]
}

func (m *assignmentMarking) start(assignmentID string, total int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runs == nil {
		m.runs = map[string]*markingRun{}
	}
	run := m.runs[assignmentID]
	if run == nil {
		run = &markingRun{}
		m.runs[assignmentID] = run
	}
	run.total += total
	run.running++
}

func (m *assignmentMarking) progressed(assignmentID string, done int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if run := m.runs[assignmentID]; run != nil {
		run.done += done
	}
}

func (m *assignmentMarking) finish(assignmentID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if run := m.runs[assignmentID]; run != nil {
		run.running--
		if run.running == 0 {
			delete(m.runs, assignmentID)
		}
	}
}

func (m *assignmentMarking) progress(assignmentID string) *AssignmentMarkingProgress {
	m.mu.Lock()
	defer m.mu.Unlock()
	run := m.runs[assignmentID]
	if run == nil {
		return nil
	}
	return &AssignmentMarkingProgress{Done: run.done, Total: run.total}
}

// markAnswersSoon marks what waits, in the background: nobody waits on the page
// for it, and a submission never fails for it. Whatever it leaves (no credits, a
// failed part, a restart) stays "Not marked" for Mark with AI (Epo 2026-11-03).
// One attempt is held at once, so its page reads Marking right after Submit.
func (a *api) markAnswersSoon(assignmentID, attemptID string) {
	queued := func() {}
	if attemptID != "" {
		queued = a.marking.hold(attemptID, false)
	}
	a.markAnswersAfter(assignmentID, attemptID, queued)
}

// markAnswersAfter is markAnswersSoon with what the caller already holds,
// released once the run holds its own.
func (a *api) markAnswersAfter(assignmentID, attemptID string, queued func()) {
	go a.markAnswers(context.Background(), assignmentID, attemptID, queued)
}

// markAnswers marks an assignment's waiting answers, or one attempt's, one attempt
// at a time per payer. It reads each attempt again once its turn comes, so a
// repeated submit or a second press of Mark with AI finds it marked and pays for
// nothing. One attempt's failure leaves the rest to go on. What it lists it
// holds (assignmentMarking.hold) until that attempt's call ends; queued, the
// caller's hold, gives way once it does.
func (a *api) markAnswers(ctx context.Context, assignmentID, attemptID string, queued func()) {
	defer queued()
	report := func(err error) {
		obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz, "stage": "assignment_marking"})
	}
	// Nothing above this goroutine catches a panic, so one would stop the whole
	// server for everyone. The answers stay Not marked instead.
	defer func() {
		if r := recover(); r != nil {
			report(panicError("marking", r))
		}
	}()
	// Listed before any paper is read: a part its read leaves unmarked waits
	// for the next Mark with AI rather than trying again at once.
	_, listed, err := a.s.AnswersToMark(ctx, assignmentID, attemptID)
	if err != nil {
		report(err)
		return
	}
	papers, err := a.s.PapersToRead(ctx, assignmentID, attemptID)
	if err != nil {
		report(err)
		return
	}
	// Every part listed is held until its attempt's call ends, a paper's whole
	// paper until its read does.
	parts := map[string][]string{}
	for _, answer := range listed {
		parts[answer.AttemptID] = append(parts[answer.AttemptID], answer.PartID)
	}
	releases := make(map[string]func(), len(parts))
	for id, ids := range parts {
		releases[id] = a.marking.hold(id, false, ids...)
	}
	reads := make(map[string]func(), len(papers))
	for _, id := range papers {
		reads[id] = a.marking.hold(id, true)
	}
	defer func() {
		for _, release := range releases {
			release()
		}
		for _, release := range reads {
			release()
		}
	}()
	queued()
	a.readPapers(ctx, assignmentID, papers, reads)
	if len(listed) == 0 {
		return
	}
	a.marking.start(assignmentID, len(listed))
	defer a.marking.finish(assignmentID)
	var order []string
	counts := map[string]int{}
	payers := map[string]string{}
	for _, answer := range listed {
		if counts[answer.AttemptID] == 0 {
			order = append(order, answer.AttemptID)
		}
		counts[answer.AttemptID]++
		payers[answer.AttemptID] = answer.PayerID
	}
	for _, id := range order {
		if err := a.markAttemptInTurn(ctx, a.marking.payer(payers[id]), assignmentID, id); err != nil {
			report(err)
		}
		releases[id]()
		a.marking.progressed(assignmentID, counts[id])
	}
}

// markAttemptInTurn marks one attempt under its payer's lock. A panic is that
// attempt's failure: it frees the lock for the payer's other runs, and the rest go on.
func (a *api) markAttemptInTurn(ctx context.Context, lock *sync.Mutex, assignmentID, attemptID string) (err error) {
	lock.Lock()
	defer lock.Unlock()
	defer func() {
		if r := recover(); r != nil {
			err = panicError("marking an attempt", r)
		}
	}()
	return a.markAttemptAnswers(ctx, assignmentID, attemptID)
}

func (a *api) markAttemptAnswers(ctx context.Context, assignmentID, attemptID string) error {
	marking, cancel := context.WithTimeout(ctx, markingAttemptTimeout)
	defer cancel()
	workspaceID, answers, err := a.s.AnswersToMark(marking, assignmentID, attemptID)
	if err != nil || len(answers) == 0 {
		return err
	}
	// The person attempting pays for all of it (Epo 2026-11-08).
	payer := answers[0].PayerID
	parts := make(map[string]openPart, len(answers))
	byPart := make(map[string]store.AnswerToMark, len(answers))
	var drawn []string
	// A paper's parts are graded on their pages, by /paper.
	again := map[string][]int{}
	typed := answers[:0]
	for _, answer := range answers {
		if len(answer.Pages) > 0 {
			again[answer.PartID] = answer.Pages
			continue
		}
		typed = append(typed, answer)
		if answer.Drawing {
			drawn = append(drawn, answer.PartID)
		}
	}
	answers = typed
	if len(again) > 0 {
		if err := a.markPaper(ctx, assignmentID, attemptID, again); err != nil {
			return err
		}
	}
	if len(answers) == 0 {
		return nil
	}
	// Only the drawings being marked are read; one unreadable stays Not marked.
	images, err := a.keptDrawingImages(marking, attemptID, drawn)
	if err != nil {
		return err
	}
	for _, answer := range answers {
		part := openPart{
			question: answer.Question, markscheme: answer.Items, itemMarks: answer.ItemMarks, answer: answer.Answer,
			sample: sampleOwner{assetID: answer.SampleImage, assignmentID: assignmentID},
		}
		if answer.Drawing {
			image, kept := images[answer.PartID]
			if !kept {
				continue
			}
			part.image, part.imageType = image.data, image.contentType
		}
		parts[answer.PartID] = part
		byPart[answer.PartID] = answer
	}
	grades, failed := a.gradeWithModel(marking, payer, workspaceID, parts)
	marks := make([]store.AIMark, 0, len(grades))
	for id, grade := range grades {
		answer := byPart[id]
		marks = append(marks, store.AIMark{
			QuestionID: answer.QuestionID, PartID: id, Items: grade.Items, Comment: grade.Comment, Flag: grade.Flag,
		})
	}
	// Paid for, so they are kept even if the attempt's time ran out meanwhile.
	saving, done := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer done()
	if err := a.s.SaveAIMarks(saving, attemptID, marks, time.Now()); err != nil {
		return err
	}
	// What could not be marked says why on the owner's rows (mock T3).
	reasons := make([]store.AIFailure, 0, len(failed))
	for id, reason := range failed {
		reasons = append(reasons, store.AIFailure{QuestionID: byPart[id].QuestionID, PartID: id, Reason: reason})
	}
	if err := a.s.SaveAIFailures(saving, attemptID, reasons); err != nil {
		return err
	}
	// Marks that need no approval clear answers waiting: staff and the member
	// refetch To do (Epo 2026-11-08).
	if member, err := a.s.AttemptUserID(saving, attemptID); err == nil {
		a.publishTodo(saving, append(a.todoAudience(saving, assignmentID, true), member)...)
	}
	// The AI marking landed: its images go, whether or not staff approve it yet.
	var marked []string
	for id := range grades {
		if byPart[id].Drawing {
			marked = append(marked, id)
		}
	}
	return a.s.DropDrawingImages(saving, attemptID, marked)
}

// withMarking flags the attempt and each part a marking run holds (Q729).
func (a *api) withMarking(res store.AssignmentAttempt) store.AssignmentAttempt {
	held, part := a.marking.markingOf(res.ID)
	if !held {
		return res
	}
	res.Marking = true
	for _, q := range res.Questions {
		parts, _ := q["parts"].([]any)
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			if id, _ := p["id"].(string); p != nil && part(id) {
				p["marking"] = true
			}
		}
	}
	return res
}

// reportMarking flags each answer row with a part a marking run holds, and
// each member with an attempt held (Q729).
func (a *api) reportMarking(res store.AssignmentReport) store.AssignmentReport {
	parts := make(map[string][]string, len(res.Questions))
	for _, q := range res.Questions {
		id, _ := q.Question["id"].(string)
		list, _ := q.Question["parts"].([]any)
		for _, raw := range list {
			p, _ := raw.(map[string]any)
			if partID, _ := p["id"].(string); partID != "" {
				parts[id] = append(parts[id], partID)
			}
		}
	}
	busy := map[string]bool{}
	for i := range res.Answers {
		row := &res.Answers[i]
		held, part := a.marking.markingOf(row.AttemptID)
		if !held {
			continue
		}
		busy[row.UserID] = true
		for _, id := range parts[row.QuestionID] {
			row.Marking = row.Marking || part(id)
		}
	}
	for i := range res.Members {
		row := &res.Members[i]
		if row.AttemptID != nil {
			held, _ := a.marking.markingOf(*row.AttemptID)
			busy[row.UserID] = busy[row.UserID] || held
		}
		row.Marking = busy[row.UserID]
	}
	return res
}
