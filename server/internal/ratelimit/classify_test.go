package ratelimit

import (
	"net/http"
	"testing"
	"time"
)

func TestClassifySplitsEditorFromChat(t *testing.T) {
	cases := map[string]class{
		"/healthz":                                          classExempt,
		"/readyz":                                           classExempt,
		"/api/internal/materials":                           classExempt,
		"/webhooks/stripe":                                  classExempt,
		"/api/workspaces/ws_1/chat/stream":                  classAI,
		"/api/chat/stream":                                  classAI,
		"/api/workspaces/ws_1/generate":                     classAI,
		"/api/quizzes/mat_1/check":                          classAI,
		"/api/attempts":                                     classDefault,
		"/api/review/check":                                 classAI,
		"/api/bank/questions/q_1/check":                     classAI,
		"/api/public/quizzes/mat_1.sig/grade":               classDefault,
		"/api/questions/computation-check":                  classAI,
		"/api/workspaces/ws_1/ai/copilot":                   classEditor,
		"/api/workspaces/ws_1/sources/uploads/tickets":      classDefault,
		"/api/workspaces/ws_1/sources/uploads":              classDefault,
		"/api/materials/m_1/editor-assets/uploads/tickets":  classDefault,
		"/api/workspaces/ws_1/sources/batches/sb_1/removed": classUpload,
		"/api/workspaces/ws_1/sources/import":               classImport,
		"/api/workspaces/ws_1/sources/import-inspect":       classImport,
		"/api/workspaces/ws_1/sources/import-content":       classImport,
		"/api/workspaces/ws_1/sources/imports/job_1":        classDefault,
		"/api/workspaces/ws_1/files/blank":                  classUpload,
		"/api/integrations":                                 classIntegration,
		"/api/integrations/google/picker-token":             classIntegration,
		"/api/me":                                           classDefault,
		"/api/workspaces":                                   classDefault,
		"/api/edit-incidents":                               classIncident,
		"/api/files/f_1/thumbnail":                          classThumbnail,
		"/api/workspaces/ws_1/voice-transcriptions":         classVoice,
		"/api/workspaces/ws_1/review":                       classReview,
		"/api/review/sessions/rs_1":                         classDefault,
	}
	for path, want := range cases {
		if got := classify(http.MethodGet, path); got != want {
			t.Errorf("classify(%q) = %v, want %v", path, got, want)
		}
	}
}

// TestClassifyNamesTheLimiterRules (security regression: rate-limit audit L3,
// M12): only the exact health paths are exempt, and a profile save takes the
// integration class.
func TestClassifyNamesTheLimiterRules(t *testing.T) {
	// No route ends in /sources: the suffix was dead and is gone.
	for _, path := range []string{"/healthz/x", "/healthzz", "/readyz/x", "/api/workspaces/ws_1/sources"} {
		if got := classify(http.MethodGet, path); got != classDefault {
			t.Errorf("classify(%q) = %v, want the default class", path, got)
		}
	}
	if got := classify(http.MethodPatch, "/api/me"); got != classIntegration {
		t.Errorf("PATCH /api/me = %v, want the integration class", got)
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
	if cfg.Integration.Limit != 30 || cfg.Integration.Window != time.Minute {
		t.Fatalf("integration = %+v", cfg.Integration)
	}
	if cfg.Voice.Limit != 60 || cfg.Voice.Window != time.Hour || cfg.Voice.burst() != 6 {
		t.Fatalf("voice = %+v", cfg.Voice)
	}
	if cfg.Review.Limit != 60 || cfg.Review.Window != time.Hour || cfg.Review.burst() != 10 {
		t.Fatalf("review = %+v", cfg.Review)
	}
}
