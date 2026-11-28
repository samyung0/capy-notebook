package agenttools

import (
	"encoding/json"
	"strings"
	"testing"
)

// edit_office_document is not offered while files are view-only (Q854 A):
// it is neither a definition nor in the generated contract; the reading
// tools, edit_document (materials) and the deck tools stay.
func TestEditOfficeDocumentIsNotOffered(t *testing.T) {
	if Lookup("edit_office_document") != nil {
		t.Fatal("edit_office_document is defined")
	}
	for _, name := range []string{"inspect_office_document", "inspect_document", "edit_document", "read_document", "create_deck", "write_slide"} {
		if Lookup(name) == nil {
			t.Fatalf("%s is missing", name)
		}
	}
	out, err := Marshal([]byte(`{"commands":50,"shapeText":{"paragraphs":7,"characters":1234},` +
		`"formats":{"pptx":[{"count":"slides added","limit":20,"commands":["add_slide"]}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	var contract Contract
	if err := json.Unmarshal(out, &contract); err != nil {
		t.Fatal(err)
	}
	for _, def := range contract.Tools {
		if def.Name == "edit_office_document" {
			t.Fatal("the contract offers edit_office_document")
		}
	}
	if strings.Contains(string(out), `"name": "edit_office_document"`) {
		t.Fatal("the contract names edit_office_document")
	}
}
