package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

func TestInternalProviderCallSettlementAuthenticatesAndDeduplicates(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	userID := fmt.Sprintf("u_provider_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1, 'Provider call test', $2)`,
		userID, userID+"@example.test",
	); err != nil {
		t.Fatal(err)
	}
	var sessionID string
	var err error
	t.Cleanup(func() {
		if sessionID != "" {
			_, _ = st.Pool().Exec(context.Background(), `DELETE FROM usage_events WHERE reservation_id=$1`, sessionID)
			_, _ = st.Pool().Exec(context.Background(), `DELETE FROM provider_sessions WHERE id=$1`, sessionID)
		}
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	sessionID, err = st.BeginProviderSession(
		ctx,
		userID,
		"",
		store.SurfaceChat,
		models.PaidByUser,
		store.TokenRates{Model: models.Ref{ProviderSlug: "openai", ModelSlug: "gpt-byok"}, ModelVersion: 1},
		store.TokenRates{Model: models.Ref{ProviderSlug: "deepinfra", ModelSlug: "Qwen/Qwen3-Embedding-4B"}, ModelVersion: 1},
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{
		"sessionId":   sessionID,
		"callId":      "pc_http_1",
		"kind":        "llm",
		"purpose":     "agent",
		"thinking":    "high",
		"provider":    "openai",
		"model":       "gpt-test",
		"inputTokens": 12,
	}

	unauthorized := doInternal(
		t,
		h,
		http.MethodPost,
		"/api/internal/provider-calls",
		"",
		body,
	)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}
	if _, err := st.Pool().Exec(ctx, `
		INSERT INTO provider_calls
			(id, reservation_id, actor_user_id, kind, purpose, thinking)
		VALUES ('pc_http_1', $1, $2, $3, 'agent', 'high')`,
		sessionID, userID, store.KindLLM,
	); err != nil {
		t.Fatal(err)
	}
	first := doInternal(
		t,
		h,
		http.MethodPost,
		"/api/internal/provider-calls",
		pipeSecret,
		body,
	)
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d body=%s", first.Code, first.Body.String())
	}
	replay := doInternal(
		t,
		h,
		http.MethodPost,
		"/api/internal/provider-calls",
		pipeSecret,
		body,
	)
	if replay.Code != http.StatusOK {
		t.Fatalf("replay status = %d body=%s", replay.Code, replay.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(replay.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["duplicate"] != true {
		t.Fatalf("replay body = %#v", response)
	}
	conflicting := make(map[string]any, len(body))
	for key, value := range body {
		conflicting[key] = value
	}
	conflicting["inputTokens"] = 13
	conflict := doInternal(
		t,
		h,
		http.MethodPost,
		"/api/internal/provider-calls",
		pipeSecret,
		conflicting,
	)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflicting replay status = %d body=%s", conflict.Code, conflict.Body.String())
	}
	var rows int
	if err := st.Pool().QueryRow(ctx, `
		SELECT count(*) FROM usage_events
		WHERE reservation_id=$1 AND provider_call_id='pc_http_1'`,
		sessionID,
	).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("provider call rows = %d, want 1", rows)
	}
}
