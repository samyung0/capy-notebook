package httpapi

import (
	"fmt"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

func book(id, license string, excerpts ...string) store.ProvenanceBook {
	if len(excerpts) == 0 {
		excerpts = []string{"e_" + id}
	}
	return store.ProvenanceBook{
		ID: id, Title: strings.ToUpper(id), Version: 1, License: license, ExcerptIDs: excerpts,
	}
}

// A curated work carries the newest ShareAlike version of one copyleft family,
// written exactly as its book wrote it. Two families have no single answer.
func TestProvenanceLicenseFollowsOneCopyleftFamily(t *testing.T) {
	for _, tc := range []struct {
		name    string
		books   []store.ProvenanceBook
		license string
		code    string
		// families the refusal message must name.
		families []string
	}{
		{
			name:    "newest version of the family wins",
			books:   []store.ProvenanceBook{book("osp", "CC BY-SA 3.0"), book("ahss", "CC BY-SA 4.0")},
			license: "CC BY-SA 4.0",
		},
		{
			name:    "spelling and separators do not split the family",
			books:   []store.ProvenanceBook{book("osp", "CC-BY-SA-4.0"), book("ahss", "CC BY-SA 4.0 ")},
			license: "CC-BY-SA-4.0",
		},
		{
			name:    "a permissive source does not dilute the copyleft licence",
			books:   []store.ProvenanceBook{book("oi", "CC BY 4.0"), book("ahss", "CC BY-SA 3.0")},
			license: "CC BY-SA 3.0",
		},
		{
			name:     "two families are refused",
			books:    []store.ProvenanceBook{book("wiki", "GFDL 1.3"), book("ahss", "CC BY-SA 4.0")},
			code:     "lifecycle_rejected",
			families: []string{"GFDL", "CC BY-SA"},
		},
		{
			name:    "the spelled-out GFDL is the same family as the abbreviation",
			books:   []store.ProvenanceBook{book("wiki", "GNU Free Documentation License 1.3")},
			license: "GNU Free Documentation License 1.3",
		},
		{
			name:    "the spelled-out Open Database License licenses the work",
			books:   []store.ProvenanceBook{book("osm", "Open Database License 1.0")},
			license: "Open Database License 1.0",
		},
		{
			name:     "noncommercial sharealike is not the sharealike family",
			books:    []store.ProvenanceBook{book("nc", "CC BY-NC-SA 4.0"), book("ahss", "CC BY-SA 4.0")},
			code:     "lifecycle_rejected",
			families: []string{"CC BY-NC-SA", "CC BY-SA"},
		},
		{
			name:    "noncommercial sharealike keeps its own newest version",
			books:   []store.ProvenanceBook{book("nc3", "CC BY-NC-SA 3.0"), book("nc4", "CC BY-NC-SA 4.0")},
			license: "CC BY-NC-SA 4.0",
		},
		{
			name:    "an unversioned copyleft licence still licenses the work",
			books:   []store.ProvenanceBook{book("wiki", "GFDL")},
			license: "GFDL",
		},
		{
			name:    "no copyleft source leaves the licence empty",
			books:   []store.ProvenanceBook{book("oi", "CC BY 4.0"), book("ck", "")},
			license: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			record := &store.Provenance{Books: tc.books}
			code, err := validateProvenance(record)
			if code != tc.code {
				t.Fatalf("code = %q, want %q (err %v)", code, tc.code, err)
			}
			if tc.code != "" {
				if err == nil {
					t.Fatal("want a refusal error")
				}
				for _, family := range tc.families {
					if !strings.Contains(err.Error(), family) {
						t.Fatalf("message %q does not name %s", err.Error(), family)
					}
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if record.License != tc.license {
				t.Fatalf("license = %q, want %q", record.License, tc.license)
			}
		})
	}
}

// An edit credits its own books on top of the ones already stored.
func TestMergeProvenanceUnionsBooksAndRecomputesTheLicense(t *testing.T) {
	stored := &store.Provenance{Books: []store.ProvenanceBook{book("ahss", "CC BY-SA 3.0", "e_1")}}
	if _, err := validateProvenance(stored); err != nil {
		t.Fatal(err)
	}
	merged, code, err := mergeProvenance(stored, &store.Provenance{Books: []store.ProvenanceBook{
		book("ahss", "CC BY-SA 3.0", "e_1", "e_2"),
		book("osp", "CC BY-SA 4.0", "e_9"),
	}})
	if err != nil {
		t.Fatalf("merge: %q %v", code, err)
	}
	if len(merged.Books) != 2 || merged.Books[0].ID != "ahss" || merged.Books[1].ID != "osp" {
		t.Fatalf("books = %+v", merged.Books)
	}
	if got := merged.Books[0].ExcerptIDs; len(got) != 2 || got[0] != "e_1" || got[1] != "e_2" {
		t.Fatalf("excerpt ids = %v, want the union in reading order", got)
	}
	if merged.License != "CC BY-SA 4.0" {
		t.Fatalf("license = %q, want the newest version of the family", merged.License)
	}
	if len(stored.Books[0].ExcerptIDs) != 1 {
		t.Fatalf("the stored record was mutated: %+v", stored.Books[0])
	}

	if _, code, err = mergeProvenance(stored, &store.Provenance{
		Books: []store.ProvenanceBook{book("wiki", "GFDL 1.3")},
	}); code != "lifecycle_rejected" || err == nil {
		t.Fatalf("a second family: code = %q err = %v", code, err)
	}
}

// A curated note is written section by section, so its stored excerpt ids
// accumulate well past what any one call may name. Only the book ceiling
// bounds the merged record; the per-call cap would make a long note
// un-editable, with no way for the model to shrink its own history.
func TestMergedProvenanceBoundsBooksNotExcerpts(t *testing.T) {
	grown := make([]string, 0, maxProvenanceEntries+8)
	for i := range cap(grown) {
		grown = append(grown, fmt.Sprintf("e_%d", i))
	}
	stored := &store.Provenance{Books: []store.ProvenanceBook{book("ahss", "CC BY-SA 4.0", grown...)}}

	merged, code, err := mergeProvenance(stored, &store.Provenance{
		Books: []store.ProvenanceBook{book("ahss", "CC BY-SA 4.0", "e_next")},
	})
	if err != nil {
		t.Fatalf("a grown note refused a further edit: %q %v", code, err)
	}
	if len(merged.Books[0].ExcerptIDs) != len(grown)+1 {
		t.Fatalf("excerpt ids = %d, want the union", len(merged.Books[0].ExcerptIDs))
	}

	full := &store.Provenance{Books: make([]store.ProvenanceBook, maxProvenanceBooks)}
	for i := range full.Books {
		full.Books[i] = book(fmt.Sprintf("b_%d", i), "CC BY 4.0")
	}
	if _, code, err = mergeProvenance(full, &store.Provenance{
		Books: []store.ProvenanceBook{book("one_too_many", "CC BY 4.0")},
	}); code != "invalid_input" || err == nil {
		t.Fatalf("a 33rd book: code = %q err = %v", code, err)
	}
}
