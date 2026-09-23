package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

func TestQuizGradeUsesSlotDefault(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if _, err := s.Pool().Exec(ctx, `
		UPDATE model_configs SET is_default_for=array_remove(is_default_for, 'quiz');
		INSERT INTO model_configs
		SELECT (jsonb_populate_record(NULL::model_configs, to_jsonb(c) ||
		  '{"version":1,"model_slug":"quiz-default-test","slots":["quiz"],"is_default_for":["quiz"]}'::jsonb)).*
		FROM model_configs c WHERE provider_slug='deepseek' AND model_slug='deepseek-flash' AND enabled`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := s.Pool().Exec(ctx, `
			DELETE FROM model_configs WHERE provider_slug='deepseek' AND model_slug='quiz-default-test';
			UPDATE model_configs SET is_default_for=array_append(is_default_for, 'quiz')
			WHERE provider_slug='deepseek' AND model_slug='deepseek-flash' AND enabled`); err != nil {
			t.Error(err)
		}
	})
	forwarded := make(chan map[string]any, 1)
	pipe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		forwarded <- body
		_, _ = w.Write([]byte(`{"award":1,"reason":"Correct"}`))
	}))
	t.Cleanup(pipe.Close)
	h := openShareAPI(t, pipeline.New(pipe.URL, ""))
	for _, body := range []map[string]any{
		{"quizModel": map[string]string{"providerSlug": "deepseek", "modelSlug": "deepseek-flash"}},
		{"quizThinking": "high"},
	} {
		if rec := doReq(t, h, http.MethodPatch, "/api/me/models", "u_editor", body); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("quiz preference accepted: %d %s", rec.Code, rec.Body.String())
		}
	}
	rec := doReq(t, h, http.MethodPost, "/api/quiz-grade", "u_editor", map[string]any{
		"prompt": "2 + 2?", "modelAnswer": "4", "userAnswer": "4",
		"hints": []string{}, "rubrics": []string{},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("grade: %d %s", rec.Code, rec.Body.String())
	}
	body := <-forwarded
	if body["providerSlug"] != "deepseek" || body["modelSlug"] != "quiz-default-test" ||
		body["configVersion"] != float64(1) || body["paidBy"] != "platform" || body["thinking"] != "high" {
		t.Fatalf("wrong quiz pin: %#v", body)
	}
}
