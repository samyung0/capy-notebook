package httpapi

import (
	"context"
	"strings"
	"testing"
)

func TestPlateCommandReqValidation(t *testing.T) {
	valid := plateCommandReq{
		Messages: []plateMessage{{
			Role:  "user",
			Parts: []platePart{{Type: "text", Text: "Improve this"}},
		}},
		Context: plateContext{Children: []byte(`[{"type":"p","children":[{"text":"Draft"}]}]`)},
	}
	if err := valid.validate(); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}

	noInstruction := valid
	noInstruction.Messages = []plateMessage{{Role: "assistant", Parts: []platePart{{Type: "text", Text: "x"}}}}
	if err := noInstruction.validate(); err == nil {
		t.Fatal("request without a user instruction was accepted")
	}

	badTool := valid
	badTool.Context.ToolName = "delete-document"
	if err := badTool.validate(); err == nil {
		t.Fatal("unknown tool name was accepted")
	}
}

func TestCopyAIDataStream(t *testing.T) {
	input := strings.NewReader(
		": ping\n\n" +
			"data: {\"type\":\"start\"}\n\n" +
			"event: ignored\n" +
			"data: {\"type\":\"text-delta\",\"id\":\"x\",\"delta\":\"hello\"}\n\n" +
			"data: [DONE]\n\n",
	)
	var got []string
	_, err := copyAIDataStream(context.Background(), input, func(payload []byte) {
		got = append(got, string(payload))
	})
	if err != nil {
		t.Fatalf("copyAIDataStream failed: %v", err)
	}
	want := []string{
		`{"type":"start"}`,
		`{"type":"text-delta","id":"x","delta":"hello"}`,
		`[DONE]`,
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("events = %#v, want %#v", got, want)
	}
}

func TestCopyAIDataStreamRejectsMalformedEvent(t *testing.T) {
	_, err := copyAIDataStream(
		context.Background(),
		strings.NewReader("data: not-json\n\n"),
		func([]byte) {},
	)
	if err == nil {
		t.Fatal("malformed event was accepted")
	}
}

func TestCopyAIDataStreamRejectsMissingDone(t *testing.T) {
	_, err := copyAIDataStream(
		context.Background(),
		strings.NewReader("data: {\"type\":\"start\"}\n\n"),
		func([]byte) {},
	)
	if err == nil {
		t.Fatal("truncated stream was accepted")
	}
}

func TestPlateCopilotReqValidation(t *testing.T) {
	if err := (plateCopilotReq{Prompt: "Continue"}).validate(); err != nil {
		t.Fatalf("valid copilot request rejected: %v", err)
	}
	if err := (plateCopilotReq{}).validate(); err == nil {
		t.Fatal("empty prompt was accepted")
	}
}
