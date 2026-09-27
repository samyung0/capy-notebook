package questions

import (
	"encoding/json"
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
					for _, key := range []string{"markscheme", "solution", "awarded", "awardReason"} {
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
	part["awardReason"] = "Partly correct"
	authored := Authored(f.Question)
	if err := Validate(authored, Policy{}); err != nil {
		t.Fatal(err)
	}
	if part["awarded"] != 0.5 || part["awardReason"] != "Partly correct" {
		t.Fatal("original snapshot was modified")
	}
	if Marks(authored) != Marks(f.Question) {
		t.Fatal("marking scheme was lost")
	}
	if err := Validate(f.Question, Policy{Snapshot: true}); err != nil {
		t.Fatal(err)
	}
}
