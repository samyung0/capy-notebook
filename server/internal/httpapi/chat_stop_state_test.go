package httpapi

import "testing"

// A stopped turn keeps a finished narration once, in its activity, and keeps
// as its body only the text of a block still streaming at the stop.
func TestStoppedTurnSavesItsNarrationOnce(t *testing.T) {
	var s turnState
	for _, ev := range []pipeChatEvent{
		{Type: "block_start", BlockID: "b1"},
		{Type: "block_delta", BlockID: "b1", Text: "I will search your sources first."},
		{Type: "block_end", BlockID: "b1", Kind: "narration"},
	} {
		s.hear(ev)
	}
	if body := s.save("aborted").content; body != "" {
		t.Fatalf("a finished narration became the body: %q", body)
	}
	s.hear(pipeChatEvent{Type: "block_start", BlockID: "b2"})
	s.hear(pipeChatEvent{Type: "block_delta", BlockID: "b2", Text: "Partial answer"})
	if body := s.save("aborted").content; body != "Partial answer" {
		t.Fatalf("body = %q, want the streaming text", body)
	}
}
