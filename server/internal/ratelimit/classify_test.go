package ratelimit

import (
	"testing"
	"time"
)

func TestClassifySplitsEditorFromChat(t *testing.T) {
	cases := map[string]class{
		"/healthz":                                          classExempt,
		"/api/internal/materials":                           classExempt,
		"/webhooks/stripe":                                  classExempt,
		"/api/workspaces/ws_1/chat/stream":                  classAI,
		"/api/workspaces/ws_1/generate":                     classAI,
		"/api/quizzes/mat_1/attempts":                       classAI,
		"/api/attempts":                                     classDefault,
		"/api/review/check":                                 classAI,
		"/api/bank/questions/q_1/check":                     classAI,
		"/api/public/quizzes/mat_1.sig/grade":               classDefault,
		"/api/questions/computation-check":                  classAI,
		"/api/workspaces/ws_1/ai/command":                   classAI,
		"/api/workspaces/ws_1/ai/copilot":                   classEditor,
		"/api/workspaces/ws_1/sources/uploads/tickets":      classUpload,
		"/api/workspaces/ws_1/sources/uploads":              classDefault,
		"/api/materials/m_1/editor-assets/uploads/tickets":  classUpload,
		"/api/workspaces/ws_1/sources/batches/sb_1/removed": classUpload,
		"/api/workspaces/ws_1/sources/import-inspect":       classUpload,
		"/api/workspaces/ws_1/sources/import-content":       classUpload,
		"/api/workspaces":                                   classDefault,
		"/api/edit-incidents":                               classIncident,
		"/api/files/f_1/thumbnail":                          classThumbnail,
		"/api/workspaces/ws_1/voice-transcriptions":         classVoice,
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
	if cfg.Incident.Limit != 60 || cfg.Incident.Window != time.Hour || cfg.Incident.Burst != 20 {
		t.Fatalf("incident = %+v", cfg.Incident)
	}
	if cfg.Thumbnail.Limit != 60 || cfg.Thumbnail.Window != time.Hour || cfg.Thumbnail.burst() != 60 {
		t.Fatalf("thumbnail = %+v", cfg.Thumbnail)
	}
	if cfg.Voice.Limit != 60 || cfg.Voice.Window != time.Hour || cfg.Voice.burst() != 6 {
		t.Fatalf("voice = %+v", cfg.Voice)
	}
}
