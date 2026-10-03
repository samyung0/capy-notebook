package store

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
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
// so only the book count and the field lengths are bounded here. The returned
// code is the tool error code the model sees.
func ValidateStoredProvenance(p *Provenance) (string, error) {
	if count := len(p.Books) + len(p.Web); count == 0 || count > MaxProvenanceBooks {
		return "invalid_input", errors.New("provenance must name one to 32 sources")
	}
	licenses := []string{}
	for i := range p.Books {
		book := &p.Books[i]
		if book.ID == "" || book.Title == "" || len(book.ExcerptIDs) == 0 {
			return "invalid_input", errors.New("each provenance book needs an id, a title and excerpt ids")
		}
		if book.Version < 1 {
			return "invalid_input", errors.New("each provenance book needs the book version it was read from")
		}
		for _, value := range append([]string{
			book.ID, book.Title, book.Edition, book.License, book.LicenseURL, book.SourceURL,
		}, append(book.Authors, book.ExcerptIDs...)...) {
			if len(value) > maxProvenanceTextLen {
				return "invalid_input", errors.New("provenance field is too long")
			}
		}
		if book.Authors == nil {
			book.Authors = []string{}
		}
		licenses = append(licenses, book.License)
	}
	for i := range p.Web {
		page := &p.Web[i]
		if !strings.HasPrefix(page.URL, "https://") || page.Title == "" || page.License == "" || page.RetrievedAt == "" {
			return "invalid_input", errors.New("each web source needs an https url, a title, a licence and a retrieval date")
		}
		for _, value := range append([]string{
			page.URL, page.Title, page.Publisher, page.License, page.LicenseURL, page.RetrievedAt,
		}, page.Authors...) {
			if len(value) > maxProvenanceTextLen {
				return "invalid_input", errors.New("provenance field is too long")
			}
		}
		if page.Authors == nil {
			page.Authors = []string{}
		}
		licenses = append(licenses, page.License)
	}
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
			return "lifecycle_rejected", fmt.Errorf(
				"sources carry two copyleft licence families (%s and %s); one material cannot be licensed under both",
				family, current)
		default:
			// Ties keep the first source's wording; only a newer version replaces it.
			if version := licenseVersion(normalized); version > newest {
				chosen, newest = license, version
			}
		}
	}
	// A model-supplied licence never survives; the server computes it.
	p.License = chosen
	return "", nil
}
