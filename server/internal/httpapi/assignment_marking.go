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
// assignment, and one lock per payer, since a payer's sessions are few
// (store.ConcurrentLLMLeases) and thirty submissions at once would use them all.
type assignmentMarking struct {
	mu     sync.Mutex
	runs   map[string]*markingRun
	payers map[string]*sync.Mutex
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
func (a *api) markAnswersSoon(assignmentID, attemptID string) {
	go a.markAnswers(context.Background(), assignmentID, attemptID)
}

// markAnswers marks an assignment's waiting answers, or one attempt's, one attempt
// at a time per payer. It reads each attempt again once its turn comes, so a
// repeated submit or a second press of Mark with AI finds it marked and pays for
// nothing. One attempt's failure leaves the rest to go on.
func (a *api) markAnswers(ctx context.Context, assignmentID, attemptID string) {
	report := func(err error) {
		obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz, "stage": "assignment_marking"})
	}
	payer, _, listed, err := a.s.AnswersToMark(ctx, assignmentID, attemptID)
	if err != nil {
		report(err)
		return
	}
	if len(listed) == 0 {
		return
	}
	a.marking.start(assignmentID, len(listed))
	defer a.marking.finish(assignmentID)
	var order []string
	counts := map[string]int{}
	for _, answer := range listed {
		if counts[answer.AttemptID] == 0 {
			order = append(order, answer.AttemptID)
		}
		counts[answer.AttemptID]++
	}
	lock := a.marking.payer(payer)
	for _, id := range order {
		lock.Lock()
		err := a.markAttemptAnswers(ctx, assignmentID, id)
		lock.Unlock()
		if err != nil {
			report(err)
		}
		a.marking.progressed(assignmentID, counts[id])
	}
}

func (a *api) markAttemptAnswers(ctx context.Context, assignmentID, attemptID string) error {
	marking, cancel := context.WithTimeout(ctx, markingAttemptTimeout)
	defer cancel()
	payer, workspaceID, answers, err := a.s.AnswersToMark(marking, assignmentID, attemptID)
	if err != nil || len(answers) == 0 {
		return err
	}
	parts := make(map[string]openPart, len(answers))
	byPart := make(map[string]store.AnswerToMark, len(answers))
	for _, answer := range answers {
		parts[answer.PartID] = openPart{
			question: answer.Question, markscheme: answer.Items, itemMarks: answer.ItemMarks, answer: answer.Answer,
		}
		byPart[answer.PartID] = answer
	}
	grades := a.gradeWithModel(marking, payer, workspaceID, parts)
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
	return a.s.SaveAIMarks(saving, attemptID, marks, time.Now())
}
