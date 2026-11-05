package httpapi

import (
	"context"
	"sync"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// How long one run may take: thirty members handing in one paper together take
// about 15 minutes (2026-11-04 concurrency run).
const markingRunTimeout = 30 * time.Minute

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
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), markingRunTimeout)
		defer cancel()
		if _, err := a.markAnswers(ctx, assignmentID, attemptID); err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz, "stage": "assignment_marking"})
		}
	}()
}

// markAnswers marks an assignment's waiting answers, or one attempt's, one
// attempt at a time per payer, and returns how many it found.
func (a *api) markAnswers(ctx context.Context, assignmentID, attemptID string) (int, error) {
	payer, workspaceID, answers, err := a.s.AnswersToMark(ctx, assignmentID, attemptID)
	if err != nil || len(answers) == 0 {
		return 0, err
	}
	a.marking.start(assignmentID, len(answers))
	defer a.marking.finish(assignmentID)
	byAttempt := map[string][]store.AnswerToMark{}
	var order []string
	for _, answer := range answers {
		if byAttempt[answer.AttemptID] == nil {
			order = append(order, answer.AttemptID)
		}
		byAttempt[answer.AttemptID] = append(byAttempt[answer.AttemptID], answer)
	}
	lock := a.marking.payer(payer)
	for _, id := range order {
		lock.Lock()
		err := a.markAttemptAnswers(ctx, assignmentID, payer, workspaceID, id, byAttempt[id])
		lock.Unlock()
		if err != nil {
			return len(answers), err
		}
	}
	return len(answers), nil
}

func (a *api) markAttemptAnswers(ctx context.Context, assignmentID, payer, workspaceID, attemptID string, answers []store.AnswerToMark) error {
	parts := make(map[string]openPart, len(answers))
	byPart := make(map[string]store.AnswerToMark, len(answers))
	for _, answer := range answers {
		parts[answer.PartID] = openPart{
			question: answer.Question, markscheme: answer.Items, itemMarks: answer.ItemMarks, answer: answer.Answer,
		}
		byPart[answer.PartID] = answer
	}
	grades := a.gradeWithModel(ctx, payer, workspaceID, parts)
	marks := make([]store.AIMark, 0, len(grades))
	for id, grade := range grades {
		answer := byPart[id]
		marks = append(marks, store.AIMark{QuestionID: answer.QuestionID, PartID: id, Items: grade.Items, Comment: grade.Comment})
	}
	a.marking.progressed(assignmentID, len(answers))
	return a.s.SaveAIMarks(ctx, attemptID, marks, time.Now())
}
