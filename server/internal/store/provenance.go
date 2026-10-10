package store

import (
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
)

const MaxProvenanceBooks = 32
const maxProvenanceTextLen = 300

// licenseVersionPattern reads the first number of a licence string, so
// `CC BY-SA 4.0` is version 4.0 and `GFDL` has none.
var licenseVersionPattern = regexp.MustCompile(`[0-9]+(\.[0-9]+)?`)

// normalizeLicense upper-cases the licence and collapses every run of space,
// `-` and `_` into one space, so `CC-BY-SA-4.0` and `CC BY-SA 4.0 ` are the
// same licence.
func normalizeLicense(license string) string {
	var out strings.Builder
	separated := false
	for _, r := range strings.ToUpper(license) {
		if r == ' ' || r == '\t' || r == '-' || r == '_' {
			separated = true
			continue
		}
		if separated && out.Len() > 0 {
			out.WriteRune(' ')
		}
		separated = false
		out.WriteRune(r)
	}
	return out.String()
}

// licenseFamily names the copyleft family of a normalized licence, or "" when
// the licence is not copyleft. A curated work inherits one family only.
// NonCommercial ShareAlike is matched first: it is a family of its own, and a
// work may not mix it with plain ShareAlike.
func licenseFamily(normalized string) string {
	switch {
	case strings.Contains(normalized, "BY NC SA"), strings.Contains(normalized, "NONCOMMERCIAL SHAREALIKE"):
		return "CC BY-NC-SA"
	case strings.Contains(normalized, "BY SA"), strings.Contains(normalized, "SHAREALIKE"):
		return "CC BY-SA"
	case strings.Contains(normalized, "GFDL"), strings.Contains(normalized, "GNU FREE DOCUMENTATION LICENSE"):
		return "GFDL"
	case strings.Contains(normalized, "ODBL"), strings.Contains(normalized, "OPEN DATABASE LICENSE"):
		return "ODbL"
	}
	return ""
}

func licenseVersion(normalized string) float64 {
	value, err := strconv.ParseFloat(licenseVersionPattern.FindString(normalized), 64)
	if err != nil {
		return 0
	}
	return value
}

// ValidateStoredProvenance bounds the record a material keeps and computes the
// work's own licence from its books and web pages: empty unless a source is copyleft, in which case the
// work carries that family's newest version written exactly as its book wrote
// it (CC BY-SA 3.0 plus 4.0 is the 4.0 book's string). Sources from two
// different copyleft families have no single answer, so the work is refused.
// Excerpt ids accumulate over a material's edits and are deduplicated on merge,
// so only the book count and the field lengths are bounded here. Each copied
// bank question's credit is bounded and licensed the same way, on its own. The
// returned code is the tool error code the model sees.
func ValidateStoredProvenance(p *Provenance) (string, error) {
	// A quiz of copied bank questions may credit only its questions.
	count := len(p.Books) + len(p.Web)
	if (count == 0 && len(p.Questions) == 0) || count > MaxProvenanceBooks {
		return "invalid_input", errors.New("provenance must name one to 32 sources")
	}
	if len(p.Questions) > fieldlimits.QuizParts {
		return "invalid_input", errors.New("provenance credits too many questions")
	}
	license, code, err := validateSources(p.Books, p.Web)
	if err != nil {
		return code, err
	}
	// A model-supplied licence never survives; the server computes it.
	p.License = license
	for id, credit := range p.Questions {
		if id == "" || len(id) > fieldlimits.QuestionID {
			return "invalid_input", errors.New("a question credit needs the question's id")
		}
		if n := len(credit.Books) + len(credit.Web); n == 0 || n > MaxProvenanceBooks {
			return "invalid_input", errors.New("a question credit must name one to 32 sources")
		}
		if credit.License, code, err = validateSources(credit.Books, credit.Web); err != nil {
			return code, err
		}
		p.Questions[id] = credit
	}
	return "", nil
}

// validateSources bounds books and web pages and computes their licence:
// empty unless a source is copyleft, in which case the newest version of that
// family, written exactly as its source wrote it.
func validateSources(books []ProvenanceBook, web []ProvenanceWeb) (string, string, error) {
	licenses := []string{}
	for i := range books {
		book := &books[i]
		if book.ID == "" || book.Title == "" || len(book.ExcerptIDs) == 0 {
			return "", "invalid_input", errors.New("each provenance book needs an id, a title and excerpt ids")
		}
		if book.Version < 1 {
			return "", "invalid_input", errors.New("each provenance book needs the book version it was read from")
		}
		for _, value := range append([]string{
			book.ID, book.Title, book.Edition, book.License, book.LicenseURL, book.SourceURL,
		}, append(book.Authors, book.ExcerptIDs...)...) {
			if len(value) > maxProvenanceTextLen {
				return "", "invalid_input", errors.New("provenance field is too long")
			}
		}
		if book.Authors == nil {
			book.Authors = []string{}
		}
		licenses = append(licenses, book.License)
	}
	for i := range web {
		page := &web[i]
		if !strings.HasPrefix(page.URL, "https://") || page.Title == "" || page.License == "" || page.RetrievedAt == "" {
			return "", "invalid_input", errors.New("each web source needs an https url, a title, a licence and a retrieval date")
		}
		for _, value := range append([]string{
			page.URL, page.Title, page.Publisher, page.License, page.LicenseURL, page.RetrievedAt,
		}, page.Authors...) {
			if len(value) > maxProvenanceTextLen {
				return "", "invalid_input", errors.New("provenance field is too long")
			}
		}
		if page.Authors == nil {
			page.Authors = []string{}
		}
		licenses = append(licenses, page.License)
	}
	return familyLicence(licenses)
}

// familyLicence is the licence a work written from sources under these
// licences carries: empty unless one is copyleft, then the newest version of
// that family written exactly as its source wrote it; two families refuse.
func familyLicence(licenses []string) (string, string, error) {
	var (
		family string
		newest float64
		chosen string
	)
	for _, license := range licenses {
		normalized := normalizeLicense(license)
		current := licenseFamily(normalized)
		switch {
		case current == "":
		case family == "":
			family, chosen, newest = current, license, licenseVersion(normalized)
		case current != family:
			return "", "lifecycle_rejected", fmt.Errorf(
				"sources carry two copyleft licence families (%s and %s); one material cannot be licensed under both",
				family, current)
		default:
			// Ties keep the first source's wording; only a newer version replaces it.
			if version := licenseVersion(normalized); version > newest {
				chosen, newest = license, version
			}
		}
	}
	return chosen, "", nil
}

// WithEmbedSources is a note's attribution as its footer reads it: its own
// record plus every source of its live embeds (EmbedSources), their copied
// bank questions' included, each source once and the note's own first, with
// the licence computed over all of them. It is computed for each read and
// never stored, so an embed removed or trashed drops out and returns on
// restore. Writes keep the union to one copyleft family (FooterLicence); a
// union that still has two (an embed restored by undo after a conflicting
// write) has no single licence, so it gets no licence line and each embed
// shows its own.
func WithEmbedSources(own *Provenance, embeds []*Provenance) *Provenance {
	if len(embeds) == 0 {
		return own
	}
	books, web := footerSources(own, embeds)
	if own == nil && len(books) == 0 && len(web) == 0 {
		return nil
	}
	merged := &Provenance{Books: books, Web: web}
	if own != nil {
		merged.Questions = own.Questions
	}
	merged.License, _ = FooterLicence(own, embeds)
	return merged
}

// FooterLicence is the licence of a note's footer over its own record and its
// embeds' (with what a write is about to add), refused with lifecycle_rejected
// when two copyleft families meet, as on one material's record.
func FooterLicence(own *Provenance, embeds []*Provenance) (string, error) {
	books, web := footerSources(own, embeds)
	licenses := make([]string, 0, len(books)+len(web))
	for _, book := range books {
		licenses = append(licenses, book.License)
	}
	for _, page := range web {
		licenses = append(licenses, page.License)
	}
	license, _, err := familyLicence(licenses)
	if err != nil {
		return "", fmt.Errorf("with its note and the note's other embedded quizzes and flashcard sets, %w", err)
	}
	return license, nil
}

// footerSources lists a note footer's sources: the note's own books and web
// pages, then each embed's own and its copied bank questions', each book (by
// id) and page (by URL) once.
func footerSources(own *Provenance, embeds []*Provenance) ([]ProvenanceBook, []ProvenanceWeb) {
	books, web := []ProvenanceBook{}, []ProvenanceWeb{}
	add := func(b []ProvenanceBook, w []ProvenanceWeb) {
		for _, book := range b {
			if !slices.ContainsFunc(books, func(x ProvenanceBook) bool { return x.ID == book.ID }) {
				books = append(books, book)
			}
		}
		for _, page := range w {
			if !slices.ContainsFunc(web, func(x ProvenanceWeb) bool { return x.URL == page.URL }) {
				web = append(web, page)
			}
		}
	}
	for _, p := range append([]*Provenance{own}, embeds...) {
		if p == nil {
			continue
		}
		add(p.Books, p.Web)
		ids := slices.Sorted(maps.Keys(p.Questions))
		for _, id := range ids {
			add(p.Questions[id].Books, p.Questions[id].Web)
		}
	}
	if len(web) == 0 {
		web = nil
	}
	return books, web
}
