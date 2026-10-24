package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// runningTurn is one chat turn this process relays (api.turns, by assistant
// message id). The stop request reaches the turn only through the process
// relaying it: one API instance today; several would need a shared channel
// to the instance holding the turn.
type runningTurn struct {
	convID     string
	cancelPipe context.CancelFunc

	mu       sync.Mutex
	state    turnState
	stopped  bool
	finished bool
}

// turnState is what the relay has heard of a turn so far.
type turnState struct {
	currentText strings.Builder
	// open says currentText is a block still streaming; a finished narration
	// block is in activity already.
	open         bool
	answer       strings.Builder
	citations    []store.Citation
	activity     []store.ActivityBlock
	toolEvidence json.RawMessage
	genID        string
	tokens       int
	usage        pipeUsage
	errorCode    string
}

// hear takes one pipeline event into the turn's state and says whether the
// browser is sent it.
func (s *turnState) hear(ev pipeChatEvent) bool {
	switch ev.Type {
	case "turn_checkpoint":
		// The turn so far, kept for any ending (Epo 2026-10-21); after a stop
		// the last one carries the calls that were still running.
		s.activity, s.toolEvidence = ev.Activity, ev.ToolEvidence
		s.usageFrom(ev)
	case "block_start":
		s.currentText.Reset()
		s.open = true
		return true
	case "block_delta":
		s.currentText.WriteString(ev.Text)
		return true
	case "block_end":
		s.open = false
		if ev.Kind == "answer" {
			s.answer.Reset()
			s.answer.WriteString(s.currentText.String())
		}
		return true
	case "citations":
		s.citations = ev.Citations
		return true
	case "phase", "tool_start", "tool_progress", "tool_end":
		return true
	case "done", "error":
		if ev.Type == "error" {
			s.errorCode = ev.Code
			if ev.Code == "response_flagged" {
				s.answer.Reset()
				s.currentText.Reset()
				s.citations = nil
			}
		}
		if len(ev.Activity) > 0 {
			s.activity = ev.Activity
		}
		if len(ev.ToolEvidence) > 0 {
			s.toolEvidence = ev.ToolEvidence
		}
		s.usageFrom(ev)
		if ev.Type == "done" {
			if ev.Answer != "" {
				s.answer.Reset()
				s.answer.WriteString(ev.Answer)
			}
			s.genID = ev.GenerationID
		}
	}
	return false
}

func (s *turnState) usageFrom(ev pipeChatEvent) {
	if !ev.Usage.empty() {
		s.usage = ev.Usage
	}
	if ev.TokenCount > 0 {
		s.tokens = ev.TokenCount
	}
}

// turnSave is the assistant row a turn is saved as.
type turnSave struct {
	content      string
	citations    []store.Citation
	activity     []store.ActivityBlock
	toolEvidence json.RawMessage
	genID        string
	tokens       int
	errorCode    string
}

// save is the row for a turn ending with status: an aborted turn without an
// answer keeps the text of the block it was streaming, and no finished
// narration, which its activity holds.
func (s *turnState) save(status string) turnSave {
	content := s.answer.String()
	if status == "aborted" && content == "" && s.open {
		content = s.currentText.String()
	}
	tokens := s.tokens
	if tokens == 0 {
		tokens = int(s.usage.InputTokens + s.usage.OutputTokens)
	}
	return turnSave{
		content: content, citations: s.citations, activity: s.activity, toolEvidence: s.toolEvidence,
		genID: s.genID, tokens: tokens, errorCode: s.errorCode,
	}
}

func (a *api) finalizeTurn(ctx context.Context, msgID, status string, s turnSave) {
	if err := a.s.FinalizeAssistantMessage(ctx, msgID, s.content, status, s.tokens, s.citations, s.genID, s.activity, s.toolEvidence, s.errorCode); err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "chat_finalize"})
	}
}

type stopTurnInput struct {
	ID        string `path:"id" doc:"Conversation id"`
	MessageID string `path:"messageId" doc:"The turn's assistant message id"`
}

// stopTurn ends a running turn at once (Epo 2026-10-21): its row is saved
// aborted with the turn so far, so history lists it now, and the pipeline
// starts no further model or tool call. Calls already running finish; the
// relay adds them to the row when the pipeline ends, then settles credits.
// Stopping a finished or already stopped turn does nothing.
func (a *api) stopTurn(ctx context.Context, in *stopTurnInput) (*Empty, error) {
	// The conversation's owner, while they may still chat in its workspace.
	if _, err := a.s.GetConversation(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	found, _ := a.turns.Load(in.MessageID)
	run, _ := found.(*runningTurn)
	if run == nil || run.convID != in.ID {
		mine, err := a.s.IsAssistantMessageOf(ctx, in.ID, in.MessageID)
		if err != nil {
			return nil, hErr(err)
		}
		if !mine {
			return nil, hErr(store.ErrNotFound)
		}
		return &Empty{}, nil
	}
	saveCtx, cancel := obs.Detach(ctx, 10*time.Second)
	defer cancel()
	// Saved under the lock, so the relay's end finds the row aborted.
	run.mu.Lock()
	if run.stopped || run.finished {
		run.mu.Unlock()
		return &Empty{}, nil
	}
	run.stopped = true
	a.finalizeTurn(saveCtx, in.MessageID, "aborted", run.state.save("aborted"))
	run.mu.Unlock()
	if a.pipe == nil {
		run.cancelPipe()
		return &Empty{}, nil
	}
	if _, err := a.pipe.PostRaw(saveCtx, "/chat/stop", map[string]string{"assistantMessageId": in.MessageID}); err != nil {
		// Not running there (yet or any more) or out of reach: hanging up
		// ends the turn as well.
		run.cancelPipe()
	}
	return &Empty{}, nil
}
