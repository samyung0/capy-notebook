package jev

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func stub(t *testing.T, answer func(questions map[string]any) map[string]any) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer key" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		var body struct {
			Model     string         `json:"model"`
			State     map[string]any `json:"state"`
			Questions map[string]any `json:"questions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Model != Model {
			t.Errorf("model = %q, want the pinned %q", body.Model, Model)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": Model, "answers": answer(body.Questions), "usage": map[string]any{"input_tokens": 1200},
		})
	}))
	t.Cleanup(srv.Close)
	return NewForTest("key", srv.URL)
}

func TestGradePartAwardsEachItemAndAppliesTheVocabularyGuard(t *testing.T) {
	choices := map[string]any{
		"m0_choice": map[string]any{"choice": "full"},
		"m1_choice": map[string]any{"choice": "partial"},
		"m2_choice": map[string]any{"choice": "zero"},
	}
	for _, tc := range []struct {
		guard float64
		want  []float64
	}{{0.05, []float64{1, 0.5, 0}}, {0.8, []float64{0, 0, 0}}} {
		c := stub(t, func(questions map[string]any) map[string]any {
			if len(questions) != 4 || questions["vocabulary_only"] == nil {
				t.Errorf("questions = %v", questions)
			}
			out := map[string]any{"vocabulary_only": map[string]any{"noul": tc.guard}}
			for k, v := range choices {
				out[k] = v
			}
			return out
		})
		got, usage, err := c.GradePart(context.Background(), "Q", []string{"a", "b", "c"}, "answer")
		if err != nil || usage.InputTokens != 1200 || usage.Model != Model {
			t.Fatalf("GradePart = %v, %+v, %v", got, usage, err)
		}
		for i := range tc.want {
			if got[i] != tc.want[i] {
				t.Fatalf("guard %.2f awards = %v, want %v", tc.guard, got, tc.want)
			}
		}
	}
}

func TestGradePartRejectsMalformedAnswersAndMissingKey(t *testing.T) {
	c := stub(t, func(map[string]any) map[string]any {
		return map[string]any{"vocabulary_only": map[string]any{"noul": 0.1}, "m0_choice": map[string]any{"choice": "most"}}
	})
	if _, _, err := c.GradePart(context.Background(), "Q", []string{"a"}, "x"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("invalid choice err = %v", err)
	}
	var none *Client
	if _, _, err := none.GradePart(context.Background(), "Q", []string{"a"}, "x"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("missing key err = %v", err)
	}
}

func TestRequiresComputationSendsTheSchemeWhenPresent(t *testing.T) {
	c := stub(t, func(questions map[string]any) map[string]any {
		return map[string]any{"requires_computation": map[string]any{"noul": 0.92}}
	})
	p, _, err := c.RequiresComputation(context.Background(), "Comment on profit.", []string{"Calculates 25%"})
	if err != nil || p != 0.92 || p < ComputationThreshold {
		t.Fatalf("RequiresComputation = %v, %v", p, err)
	}
}
