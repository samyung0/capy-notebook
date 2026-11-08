package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/obs"
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

// postPaper runs /paper on the payer's credits. A failure of the whole call
// returns why (store.AIErrorCredits or store.AIErrorGrade) and the error.
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
		return reply, store.AIErrorGrade, err
	}
	if err := json.Unmarshal(raw, &reply); err != nil {
		return reply, store.AIErrorGrade, err
	}
	return reply, "", nil
}

// markPaper reads a submitted paper and grades its open parts, or with the
// paper read, grades again the open parts in again (part id to pages). What
// could not be graded waits with why, for Mark with AI.
func (a *api) markPaper(ctx context.Context, attemptID string, again map[string][]int) error {
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
	byLabel := map[string]store.PaperPart{}
	for _, p := range paper.Parts {
		byLabel[p.Label] = p
	}
	reply, reason, callErr := a.postPaper(marking, paper, body)
	saving, done := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer done()
	if callErr != nil {
		// Every part this run was for waits, saying why.
		var failures []store.AIFailure
		for _, p := range paper.Parts {
			if _, listed := again[p.PartID]; again == nil || listed {
				failures = append(failures, store.AIFailure{QuestionID: p.QuestionID, PartID: p.PartID, Reason: reason})
			}
		}
		if err := a.s.SaveAIFailures(saving, attemptID, failures); err != nil {
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
		case got.Error != "":
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
	return a.s.SaveAIFailures(saving, attemptID, failures)
}

// readPapers reads, in the background, the papers an assignment (or one
// attempt) has waiting, one at a time per payer as other marking runs.
func (a *api) readPapers(ctx context.Context, assignmentID, attemptID string) {
	report := func(err error) {
		obs.CaptureErr(ctx, err, map[string]string{"surface": store.SurfaceQuiz, "stage": "paper_marking"})
	}
	ids, err := a.s.PapersToRead(ctx, assignmentID, attemptID)
	if err != nil {
		report(err)
		return
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
			if err := a.markPaper(ctx, id, nil); err != nil {
				report(err)
			}
		}()
	}
}
