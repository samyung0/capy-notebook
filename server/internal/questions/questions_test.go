package questions

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestSharedFixtures(t *testing.T) {
	paths, err := filepath.Glob("testdata/*.json")
	if err != nil || len(paths) == 0 {
		t.Fatal("question fixtures unavailable", err)
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var fixture struct {
				Valid    bool
				Question map[string]any
				Policy   struct {
					Bank          bool
					BankAssetsURL string `json:"bankAssetsUrl"`
					Snapshot      bool
				}
			}
			if err := json.Unmarshal(raw, &fixture); err != nil {
				t.Fatal(err)
			}
			err = Validate(fixture.Question, Policy{Bank: fixture.Policy.Bank, BankAssetsURL: fixture.Policy.BankAssetsURL, Snapshot: fixture.Policy.Snapshot})
			if (err == nil) != fixture.Valid {
				t.Fatalf("valid=%v: %v", fixture.Valid, err)
			}
			if fixture.Valid {
				learner := LearnerView(fixture.Question)
				for _, raw := range learner["parts"].([]any) {
					p := raw.(map[string]any)
					for _, key := range []string{"markscheme", "solution", "awarded", "itemAwards"} {
						if _, ok := p[key]; ok {
							t.Fatalf("leaked %s", key)
						}
					}
					a := p["answer"].(map[string]any)
					for _, key := range []string{"correct", "accepted", "hints", "pairs"} {
						if _, ok := a[key]; ok {
							t.Fatalf("leaked answer %s", key)
						}
					}
				}
			}
		})
	}
}

func TestMaterialPartIDsAndAssetBoundary(t *testing.T) {
	raw, err := os.ReadFile("testdata/short.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Question map[string]any }
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	var other struct{ Question map[string]any }
	if err := json.Unmarshal(raw, &other); err != nil {
		t.Fatal(err)
	}
	other.Question["id"] = "other"
	if err := ValidateAll([]map[string]any{f.Question, other.Question}, Policy{}); err == nil {
		t.Fatal("accepted shared part ID")
	}
	for _, base := range []string{"https://bank.example", "https://bank.example/", "https://bank.example/assets"} {
		if !assetURL("https://bank.example/assets/a.svg", base) {
			t.Fatalf("rejected asset under %s", base)
		}
	}
	for _, bad := range []string{"https://bank.example.evil/assets/a.svg", "https://bank.example/assets-evil/a.svg", "https://bank.example/assets/a.svg?redirect=evil", "http://bank.example/assets/a.svg"} {
		if assetURL(bad, "https://bank.example/assets") {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestAuthoredSnapshotKeepsContentAndLeavesScoresOnOriginal(t *testing.T) {
	raw, err := os.ReadFile("testdata/snapshot-score.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Question map[string]any }
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	part := f.Question["parts"].([]any)[0].(map[string]any)
	part["itemAwards"] = []any{0.5}
	authored := Authored(f.Question)
	if err := Validate(authored, Policy{}); err != nil {
		t.Fatal(err)
	}
	if part["awarded"] != 0.5 || part["itemAwards"] == nil {
		t.Fatal("original snapshot was modified")
	}
	if Marks(authored) != Marks(f.Question) {
		t.Fatal("marking scheme was lost")
	}
	if err := Validate(f.Question, Policy{Snapshot: true}); err != nil {
		t.Fatal(err)
	}
}

func TestQuizBoundsCapPartsAndOpenParts(t *testing.T) {
	question := func(id string, open int, closed int) map[string]any {
		parts := []any{}
		for i := 0; i < open+closed; i++ {
			kind := "boolean"
			if i < open {
				kind = "open"
			}
			parts = append(parts, map[string]any{"id": fmt.Sprintf("%s-%d", id, i), "answer": map[string]any{"type": kind}})
		}
		return map[string]any{"id": id, "parts": parts}
	}
	many := func(n int, open int) []map[string]any {
		qs := []map[string]any{}
		for i := 0; i < n; i++ {
			o := 0
			if i < open {
				o = 1
			}
			qs = append(qs, question(fmt.Sprint(i), o, 1-o))
		}
		return qs
	}
	if err := QuizBounds(many(100, 20)); err != nil {
		t.Fatalf("100 parts with 20 open rejected: %v", err)
	}
	if QuizBounds(many(101, 0)) == nil {
		t.Fatal("accepted 101 parts")
	}
	if QuizBounds(many(30, 21)) == nil {
		t.Fatal("accepted 21 open parts")
	}
}

// Mirrors the prompt src/features/quizzes/scoreAttempt.ts used to build.
func TestGradingTextIncludesStemEarlierPartsAndFigures(t *testing.T) {
	q := map[string]any{
		"stem": []any{
			map[string]any{"type": "text", "label": "Source A", "text": "Prices rose."},
			map[string]any{"type": "image", "description": "A demand curve"},
			map[string]any{"type": "chart", "title": "Sales", "unit": "kg", "labels": []any{"Jan", "Feb"},
				"series": []any{map[string]any{"name": "Shop", "values": []any{1.5, 2.0}}}},
		},
		"parts": []any{
			map[string]any{"blocks": []any{map[string]any{"type": "table", "rows": []any{[]any{"a", "b"}, []any{"c", "d"}}}}},
			map[string]any{"blocks": []any{map[string]any{"type": "text", "text": "Explain."}}},
		},
	}
	want := "Source A\nPrices rose.\n\n[Figure: A demand curve]\n\nSales (kg)\nShop: Jan=1.5, Feb=2\n\nEarlier part 1: a | b\nc | d\n\nPart to grade: Explain."
	if got := GradingText(q, 1); got != want {
		t.Fatalf("GradingText =\n%q\nwant\n%q", got, want)
	}
}

// A question copied from the bank keeps linking its figures, and only there.
func TestQuizQuestionsLinkFiguresOnlyUnderTheBank(t *testing.T) {
	question := func(url string) map[string]any {
		var q map[string]any
		raw := `{"id":"q","stem":[{"type":"image","image":{"url":"` + url + `"},"width":4,"height":3,"description":"Fig"}],"parts":[{"id":"p","blocks":[{"type":"text","text":"?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}`
		if err := json.Unmarshal([]byte(raw), &q); err != nil {
			t.Fatal(err)
		}
		return q
	}
	if err := Validate(question("https://bank.example/assets/f.png"), Policy{}); err == nil {
		t.Fatal("a figure link was accepted with no bank configured")
	}
	QuizBankAssetsURL = "https://bank.example/assets"
	defer func() { QuizBankAssetsURL = "" }()
	if err := Validate(question("https://bank.example/assets/f.png"), Policy{}); err != nil {
		t.Fatal(err)
	}
	if err := Validate(question("https://elsewhere.example/f.png"), Policy{}); err == nil {
		t.Fatal("a figure link outside the bank was accepted")
	}
}

func TestClosedPartMarkschemeNamesThePartAndTheRule(t *testing.T) {
	raw, err := os.ReadFile("testdata/short.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ Question map[string]any }
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	part := f.Question["parts"].([]any)[0].(map[string]any)
	part["markscheme"] = []any{map[string]any{"text": "right", "marks": part["marks"]}}
	err = Validate(f.Question, Policy{})
	want := fmt.Sprintf("part %v: a short answer has no markscheme; explain it in solution", part["id"])
	if err == nil || err.Error() != "invalid question: "+want {
		t.Fatalf("got %v, want %q", err, want)
	}
}
