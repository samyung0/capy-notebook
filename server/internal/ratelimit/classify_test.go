package ratelimit

import (
	"testing"
	"time"
)

func TestClassifySplitsEditorFromChat(t *testing.T) {
	cases := map[string]class{
		"/healthz":                                    classExempt,
		"/api/internal/materials":                     classExempt,
		"/webhooks/stripe":                            classExempt,
		"/api/workspaces/ws_1/chat/stream":            classAI,
		"/api/workspaces/ws_1/generate":               classAI,
		"/api/quiz-grade":                             classAI,
		"/api/workspaces/ws_1/ai/command":             classAI,
		"/api/workspaces/ws_1/ai/copilot":             classEditor,
		"/api/workspaces/ws_1/sources/uploads":        classUpload,
		"/api/workspaces/ws_1/sources/import-inspect": classUpload,
		"/api/workspaces/ws_1/sources/import-content": classUpload,
		"/api/workspaces":                             classDefault,
	}
	for path, want := range cases {
		if got := classify(path); got != want {
			t.Errorf("classify(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestDefaultConfigRaisesAIAndAddsBurst(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.AI.Limit != 200 || cfg.AI.Window != time.Hour || cfg.AI.Burst != 15 {
		t.Fatalf("AI hourly = %+v", cfg.AI)
	}
	if cfg.AIBurst.Limit != 15 || cfg.AIBurst.Window != time.Minute {
		t.Fatalf("AI burst = %+v", cfg.AIBurst)
	}
	if cfg.Editor.Limit != 120 || cfg.Editor.Window != time.Minute {
		t.Fatalf("editor = %+v", cfg.Editor)
	}
}
