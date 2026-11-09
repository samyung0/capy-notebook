package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Marking a paper (todo-file-submissions.md 5a): one pipeline call, /paper,
// reads every page (prompt R) and grades the open and drawn parts four to a
// call on their pages (P1 + B), all on the member's credits. Closed answers are
// marked here against the key, as typed ones are.

// paperIngestPoll is how often marking looks again for a paper's files to
// finish their ingest, the normal upload's, within markingAttemptTimeout.
var paperIngestPoll = 10 * time.Second

type paperReply struct {
	Parts []struct {
		ID      string          `json:"id"`
		Pages   []int           `json:"pages"`
		Answer  json.RawMessage `json:"answer"`
		Shares  []float64       `json:"shares"`
		Comment string          `json:"comment"`
		Flag    string          `json:"flag"`
		Error   string          `json:"error"`
	} `json:"parts"`
}

// paperBody lists every part to read a paper, or only the open and drawn ones
// it grades again (again, part id to pages), with their pages.
func paperBody(paper store.Paper, again map[string][]int) map[string]any {
	files := make([]map[string]any, len(paper.Files))
	for i, f := range paper.Files {
		files[i] = map[string]any{"fileId": f.ID, "name": f.Name}
	}
	parts := []map[string]any{}
	var pages map[string][]int
	if again != nil {
		pages = map[string][]int{}
	}
	for _, p := range paper.Parts {
		if again != nil {
			if _, listed := again[p.PartID]; !listed {
				continue
			}
			pages[p.Label] = again[p.PartID]
		}
		items := make([]map[string]any, len(p.Items))
		for i, text := range p.Items {
			items[i] = map[string]any{"text": text, "marks": p.ItemMarks[i]}
		}
		parts = append(parts, map[string]any{
			"id": p.Label, "type": p.Type, "label": p.Listing, "question": p.Question, "items": items,
		})
	}
	return map[string]any{"files": files, "parts": parts, "pages": pages}
}

// waitForPaperFiles waits until none of the paper's files is still in ingest.
func (a *api) waitForPaperFiles(ctx context.Context, attemptID string) (store.Paper, error) {
	for {
		paper, err := a.s.GetPaper(ctx, attemptID)
		if err != nil {
			return paper, err
		}
		settled := true
		for _, f := range paper.Files {
			if f.Status == string(store.FilePending) || f.Status == string(store.FileProcessing) {
				settled = false
			}
		}
		if settled {
			return paper, nil
		}
		select {
		case <-ctx.Done():
			return paper, ctx.Err()
		case <-time.After(paperIngestPoll):
		}
	}
}

// unreadablePaperCodes are /paper's refusals of a file it can't open or render
// (the pipeline's ExtractionRefused): the owner's rows say Can't read file
// (Q730).
var unreadablePaperCodes = map[string]bool{
	"file_unreadable": true, "file_unavailable": true, "unsupported_format": true, "unavailable_target": true,
}

// postPaper runs /paper on the payer's credits. A failure of the whole call
// returns why (store.AIErrorCredits, store.AIErrorFile or store.AIErrorGrade)
// and the error.
func (a *api) postPaper(ctx context.Context, paper store.Paper, body map[string]any) (paperReply, string, error) {
	var reply paperReply
	llm, err := a.gradingLLM(ctx, paper.PayerID)
	if err != nil {
		return reply, store.AIErrorGrade, err
	}
	charge, err := a.beginProviderSession(ctx, paper.PayerID, paper.WorkspaceID, store.SurfaceQuiz, llm.Rates, store.TokenRates{}, llm.Thinking)
	if err != nil {
		if errors.Is(err, store.ErrCreditsExhausted) {
			return reply, store.AIErrorCredits, err
		}
		return reply, store.AIErrorGrade, err
	}
	defer charge.settle(ctx)
	body["spendSessionId"] = charge.id
	llm.attach(body)
	raw, err := a.pipe.PostRawUntil(ctx, "/paper", body)
	if err != nil {
		if errors.Is(err, store.ErrCreditsExhausted) {
			return reply, store.AIErrorCredits, err
		}
		var refused *pipeline.Error
		if errors.As(err, &refused) && refused.Status == http.StatusBadRequest && unreadablePaperCodes[refused.Decode().Code] {
			return reply, store.AIErrorFile, err
		}
		return reply, store.AIErrorGrade, err
	}
	if err := json.Unmarshal(raw, &reply); err != nil {
		return reply, store.AIErrorGrade, err
	}
	return reply, "", nil
}

// markPaper reads a submitted paper and grades its open parts, or with the
// paper read, grades again the open parts in again (part id to pages). What
// could not be graded waits with why, for Mark with AI. Under manual marking
// nothing is noted: a failed read leaves its parts waiting for hand marking
// with no badge, and Read papers again reads it (Q730).
func (a *api) markPaper(ctx context.Context, assignmentID, attemptID string, again map[string][]int) error {
	marking, cancel := context.WithTimeout(ctx, markingAttemptTimeout)
	defer cancel()
	paper, err := a.waitForPaperFiles(marking, attemptID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !paper.Read && again != nil {
		return nil
	}
	if paper.Read && again == nil {
		return nil
	}
	body := paperBody(paper, again)
	// Under manual marking the read maps parts to pages and marks closed
	// parts; staff mark the open ones (Q716).
	body["grade"] = !paper.Manual
	byLabel := map[string]store.PaperPart{}
	for _, p := range paper.Parts {
		byLabel[p.Label] = p
	}
	saving, done := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer done()
	// Every part this run is for waits, saying why.
	waitAll := func(reason string) error {
		if paper.Manual {
			return nil
		}
		var failures []store.AIFailure
		for _, p := range paper.Parts {
			if _, listed := again[p.PartID]; again == nil || listed {
				failures = append(failures, store.AIFailure{QuestionID: p.QuestionID, PartID: p.PartID, Reason: reason})
			}
		}
		return a.s.SaveAIFailures(saving, attemptID, failures)
	}
	// A text or Office file with no text would read as blank and score
	// nothing (finding 8).
	if paper.TextGap != "" {
		return waitAll(paper.TextGap)
	}
	reply, reason, callErr := a.postPaper(marking, paper, body)
	if callErr != nil {
		if err := waitAll(reason); err != nil {
			return err
		}
		return fmt.Errorf("paper %s: %w", attemptID, callErr)
	}
	reads := map[string]store.PaperFinding{}
	var marks []store.AIMark
	var failures []store.AIFailure
	for _, got := range reply.Parts {
		part, known := byLabel[got.ID]
		if !known {
			continue
		}
		var answer any
		if len(got.Answer) > 0 {
			_ = json.Unmarshal(got.Answer, &answer)
		}
		reads[part.PartID] = store.PaperFinding{Pages: got.Pages, Answer: answer}
		switch {
		case got.Error != "" && !paper.Manual:
			failures = append(failures, store.AIFailure{QuestionID: part.QuestionID, PartID: part.PartID, Reason: got.Error})
		case len(got.Shares) == len(part.ItemMarks) && len(got.Shares) > 0:
			items := make([]float64, len(got.Shares))
			for i, share := range got.Shares {
				items[i] = share * part.ItemMarks[i]
			}
			marks = append(marks, store.AIMark{QuestionID: part.QuestionID, PartID: part.PartID, Items: items, Comment: got.Comment, Flag: got.Flag})
		}
	}
	if !paper.Read {
		if err := a.s.SavePaperRead(saving, attemptID, reads, time.Now()); err != nil {
			return err
		}
	}
	if err := a.s.SaveAIMarks(saving, attemptID, marks, time.Now()); err != nil {
		return err
	}
	if err := a.s.SaveAIFailures(saving, attemptID, failures); err != nil {
		return err
	}
	// A read paper's closed parts are marked and its open ones may be: staff
	// and the member refetch To do, as for typed answers.
	a.publishTodo(saving, append(a.todoAudience(saving, assignmentID, true), paper.PayerID)...)
	return nil
}

// readPapers reads, in the background, the papers ids (PapersToRead) one at a
// time per payer as other marking runs, releasing each read's hold as it ends.
func (a *api) readPapers(ctx context.Context, assignmentID string, ids []string, held map[string]func()) {
	report := func(err error) {
		obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz, "stage": "paper_marking"})
	}
	for _, id := range ids {
		paper, err := a.s.GetPaper(ctx, id)
		if err != nil {
			report(err)
			continue
		}
		lock := a.marking.payer(paper.PayerID)
		func() {
			lock.Lock()
			defer lock.Unlock()
			defer func() {
				if r := recover(); r != nil {
					report(panicError("reading a paper", r))
				}
			}()
			if err := a.markPaper(ctx, assignmentID, id, nil); err != nil {
				report(err)
			}
		}()
		held[id]()
	}
}
