package store

import (
	"encoding/json"
	"testing"
)

// An account chat citation keeps "" as the workspace of a file with no
// workspace; the chat draws its "No workspace" place from it.
func TestAccountCitationKeepsNoWorkspace(t *testing.T) {
	var c Citation
	if err := json.Unmarshal([]byte(`{"chunkId":"c1","workspaceId":"","workspaceName":""}`), &c); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}
	if id, ok := back["workspaceId"]; !ok || id != "" {
		t.Fatalf("workspaceId = %v (present %v), want \"\"", id, ok)
	}
}
