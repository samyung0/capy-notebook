package cover

import "testing"

func TestCoverCheck(t *testing.T) {
	for _, c := range []Cover{
		{Style: "symbols", Color: "#7866cf", Kind: "math"},
		{Style: "paper", Color: "#2a78d6", Kind: "kana", Line: "わたしは がくせいです。"},
		{Style: "geo", Color: "#1b9e6f", Pattern: "hexagons"},
		{Style: "shelf", Color: "#d0505e", Seed: "k3x9"},
		Default("hkdse"),
	} {
		if err := c.Check(); err != nil {
			t.Fatalf("%+v: %v", c, err)
		}
	}
	for _, c := range []Cover{
		{Style: "symbols", Color: "#7866CF", Kind: "math"},
		{Style: "symbols", Color: "#7866cf"},
		{Style: "type", Color: "#7866cf", Kind: "math"},
		{Style: "hero", Color: "#7866cf", Pattern: "topography"},
		{Style: "symbols", Color: "#7866cf", Kind: "math", Line: "x"},
		{Style: "photo", Color: "#7866cf"},
		{Style: "type", Color: "#7866cf", Seed: "Not-Lower"},
	} {
		if c.Check() == nil {
			t.Fatalf("accepted %+v", c)
		}
	}
}
