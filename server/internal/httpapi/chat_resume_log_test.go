package httpapi

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// A browser reading when an edit's tool_end is sent gets its Undo payloads;
// one that joins later gets every event again without them (Epo 2026-10-27,
// T19).
func TestTurnLogKeepsEventsWithoutUndoPayloads(t *testing.T) {
	run := newRunningTurn("u", "conv", func() {})
	var live, late bytes.Buffer
	liveReader := newBrowserWriter(&live, func() {})
	run.join(liveReader)
	run.send(map[string]any{"type": "start", "messageId": "m"})
	run.send(pipeChatEvent{Type: "tool_end", CallID: "c1", Outcome: "succeeded", UndoPayloads: []json.RawMessage{json.RawMessage(`{"op":"u1"}`)}})

	lateReader := newBrowserWriter(&late, func() {})
	if run.join(lateReader) {
		t.Fatal("the turn is over before its end")
	}
	run.send(map[string]any{"type": "done", "status": "complete"})
	run.end()
	liveReader.finish()
	lateReader.finish()

	if !strings.Contains(live.String(), `"undoPayloads":[{"op":"u1"}]`) {
		t.Fatalf("the live browser lost the Undo payload: %s", live.String())
	}
	if strings.Contains(late.String(), "undoPayloads") || strings.Count(late.String(), "data: ") != 3 {
		t.Fatalf("the late browser got %s", late.String())
	}
	after := newBrowserWriter(&bytes.Buffer{}, func() {})
	defer after.finish()
	if over := run.join(after); !over {
		t.Fatal("a browser joined a turn that is over")
	}
}
