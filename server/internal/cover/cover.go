// Package cover is the art config behind bank exam strips and workspace card
// covers. The browser draws it (src/lib/coverArt.ts), so the pattern lists
// here must match the ones there.
package cover

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"regexp"
	"slices"
)

type Cover struct {
	Style   string `json:"style" enum:"symbols,doodles,shelf,paper,type,geo,hero"`
	Color   string `json:"color" pattern:"^#[0-9a-f]{6}$"`
	Kind    string `json:"kind,omitempty" enum:"math,latin,kana" doc:"The symbols, icons or paper of a symbols, doodles or paper cover"`
	Pattern string `json:"pattern,omitempty" doc:"The GeoPattern generator of a geo cover, or the Hero Patterns pattern of a hero cover"`
	Line    string `json:"line,omitempty" maxLength:"40" doc:"A paper cover's handwritten line"`
	Seed    string `json:"seed,omitempty" maxLength:"16" pattern:"^[a-z0-9]*$" doc:"Varies the generated art (Shuffle); empty uses the owner's id"`
}

var (
	color        = regexp.MustCompile(`^#[0-9a-f]{6}$`)
	seed         = regexp.MustCompile(`^[a-z0-9]{0,16}$`)
	GeoPatterns  = []string{"octogons", "overlappingCircles", "plusSigns", "xes", "sineWaves", "hexagons", "overlappingRings", "plaid", "triangles", "squares", "concentricCircles", "diamonds", "tessellation", "nestedSquares", "mosaicSquares", "chevrons"}
	HeroPatterns = []string{"bankNote", "bubbles", "current", "diagonalLines", "endlessClouds", "formalInvitation", "fourPointStars", "graphPaper", "hexagons", "jigsaw", "overlappingCircles", "plus", "polkaDots", "signal", "texture", "wiggle", "xEquals", "zigZag"}
	// Palette is the covers' colour choice in the app and for defaults.
	Palette = []string{"#7866cf", "#2a78d6", "#1b9e6f", "#d0505e", "#eb6834", "#c48a00", "#5b6472"}
)

// Default is a GeoPattern in a palette colour, both picked from the id so it
// is the same every time.
func Default(id string) Cover {
	sum := sha256.Sum256([]byte(id))
	return Cover{Style: "geo", Color: Palette[int(sum[0])%len(Palette)], Pattern: GeoPatterns[int(sum[1])%len(GeoPatterns)]}
}

// Check accepts only the fields the cover's style draws.
func (c Cover) Check() error {
	if !color.MatchString(c.Color) {
		return errors.New("cover color must be #rrggbb in lower case")
	}
	if !seed.MatchString(c.Seed) {
		return errors.New("cover seed must be at most 16 lower-case letters and digits")
	}
	kinded := c.Style == "symbols" || c.Style == "doodles" || c.Style == "paper"
	if kinded != slices.Contains([]string{"math", "latin", "kana"}, c.Kind) {
		return fmt.Errorf("a %s cover takes kind only for symbols, doodles and paper", c.Style)
	}
	switch c.Style {
	case "geo":
		if !slices.Contains(GeoPatterns, c.Pattern) {
			return fmt.Errorf("unknown geo pattern %q", c.Pattern)
		}
	case "hero":
		if !slices.Contains(HeroPatterns, c.Pattern) {
			return fmt.Errorf("unknown hero pattern %q", c.Pattern)
		}
	case "symbols", "doodles", "paper", "shelf", "type":
		if c.Pattern != "" {
			return errors.New("only geo and hero covers take a pattern")
		}
	default:
		return fmt.Errorf("unknown cover style %q", c.Style)
	}
	if c.Line != "" && (c.Style != "paper" || len([]rune(c.Line)) > 40) {
		return errors.New("only a paper cover takes a line, of at most 40 characters")
	}
	return nil
}
