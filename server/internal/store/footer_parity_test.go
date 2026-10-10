package store

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// footerParityCase is one row of testdata/footer_union_parity.json, which the
// app's footer union (src/features/materials/footerUnion.test.ts) reads too:
// both sides credit the same sources under the same licence line.
type footerParityCase struct {
	Name   string        `json:"name"`
	Own    *Provenance   `json:"own"`
	Embeds []*Provenance `json:"embeds"`
	Want   *struct {
		Books   []string `json:"books"`
		Web     []string `json:"web"`
		License string   `json:"license"`
	} `json:"want"`
}

func TestFooterUnionParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/footer_union_parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []footerParityCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		got := WithEmbedSources(c.Own, c.Embeds)
		if c.Want == nil {
			if got != nil {
				t.Errorf("%s: footer = %+v, want none", c.Name, got)
			}
			continue
		}
		if got == nil {
			t.Errorf("%s: no footer, want %+v", c.Name, c.Want)
			continue
		}
		books, web := []string{}, []string{}
		for _, book := range got.Books {
			books = append(books, book.ID)
		}
		for _, page := range got.Web {
			web = append(web, page.URL)
		}
		if !slices.Equal(books, c.Want.Books) || !slices.Equal(web, c.Want.Web) || got.License != c.Want.License {
			t.Errorf("%s: footer books %v web %v licence %q, want %v %v %q",
				c.Name, books, web, got.License, c.Want.Books, c.Want.Web, c.Want.License)
		}
	}
}
