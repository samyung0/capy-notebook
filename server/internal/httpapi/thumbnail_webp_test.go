package httpapi

import (
	"encoding/base64"
	"encoding/binary"
	"testing"
)

// WebP fixtures: a 200x113 lossy and a 20x12 lossless image and a 20x12 lossy
// one with alpha (VP8X, ALPH, VP8) made with Pillow, and a capture as Chrome's
// OffscreenCanvas.convertToBlob encodes it (VP8X with the ICC flag, an ICCP
// sRGB profile, then VP8; the client keeps only the VP8 chunk).
var (
	webpLossy    = mustDecode("UklGRg4BAABXRUJQVlA4IAIBAACwDACdASrIAHEAPrVap04nJSOiJYgA4BaJZW7hceDl3zURipqgCnHy8RWaQOlTfArvxqxjUj6fNWdw3IjrXueOn6g+j42+TSnOpQEmsLprbSYSE1aBSxl3dWPeNgoI8iQmlXHWMe8bBQR5EhNCAAD++K4v+OSR9v/B3u6vhpGI40ONn7gF4N+S6+PduAS5A3mUDsTTiGZaNs1DqOYEW752Vbf4FJf+JZDJooD3zjv49w/ZWQyGCVOBZ4hADx3t5I6AsaXUkpstX03hiaDU/uVH5z+X1dHDtn/OOjowmulQaE7YZVWEY+5eKKFFIrVgM7qxbPVhjoAfJKtkAIaIR86QAAA=")
	webpLossless = mustDecode("UklGRi4AAABXRUJQVlA4TCIAAAAvE8ACAA/wrf9//D/5f/7jAYTZRv3N3/QkziGi/wEA6wAA")
	webpAlpha    = mustDecode("UklGRn4AAABXRUJQVlA4WAoAAAAQAAAAEwAACwAAQUxQSBYAAAABDzD/ERGCTMBi6J/ZSYSI/k9Aw/QEVlA4IEIAAADwAgCdASoUAAwAPrVInkmnJCKhMAgA4BaJZAC2yC1yAAD+6KQ//94jf+u2v2eZ9s14JMxiN+f0JSD6fyf8nbMMAAA=")
	webpChrome   = mustDecode(
		"UklGRrADAABXRUJQVlA4WAoAAAAgAAAAxwAAcAAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABh" +
			"Y3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
			"AAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAAB" +
			"UAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAA" +
			"AAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9Y" +
			"WVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAM" +
			"ZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggwgEAALAOAJ0BKsgAcQA+tVqpTyclpCIhmZmI" +
			"4BaJZ27hceDoGEu8vvgIwC6AlQPag9d9AAWEs9PvWN3rG71jd6xu9Y3esbvWN1x3MFBLEs7VRu9YdPpZbsEvzokVL5XUD88VADSC" +
			"vsrJic2UgOO89PvWN3jHYlAhx5aZsEXTJvZaAAD+/Ufrm59aRBAAAAAAQB4fgyrVmkG6Uj+JniP24m6Hz0xtSoe+jqE63Yry5bgG" +
			"E9TOq9Yzv+Lapd/fd4LjK4gKwyOWFTbi87sExgqdg/ghNjuAVFjrJ6mZn8OvetqfaxZfnZIz/oPRLQUqron71Ft7oaMnSDq4cTgt" +
			"wOe7Z4ts0WHbiLM37GVlKDwrzLdIuEyslUXRhuLa+9W3r3NconyznW3Texi66cv8zFjDcfkMCxqGFyn8AiO3hAU5KqzudLj0gs1P" +
			"pgcMwqoL/8KWqCmz5gEnRPuz4jv+TqeNBEVR1WPTiuOm4QaleDk05hrPOJSdDUK+Y0YDi71gqzs4hKvP6pQ54Xm4pVLBsxfsT1te" +
			"JtmtYD4LDooi2LHj4lUaKlSFgAAABbfkjHulNMt3C6o7q8qjuryqO6vKo7q8qjuryoOAAA==")
)

func mustDecode(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func webpChunk(id string, data []byte) []byte {
	out := append([]byte(id), binary.LittleEndian.AppendUint32(nil, uint32(len(data)))...)
	out = append(out, data...)
	if len(data)%2 == 1 {
		out = append(out, 0)
	}
	return out
}

// riffWebP wraps chunks (and any raw bytes) in a RIFF WEBP header whose size
// covers them exactly.
func riffWebP(parts ...[]byte) []byte {
	body := []byte("WEBP")
	for _, part := range parts {
		body = append(body, part...)
	}
	return append(append([]byte("RIFF"), binary.LittleEndian.AppendUint32(nil, uint32(len(body)))...), body...)
}

// vp8x is an extended-format header for a 200x113 canvas with flags set.
func vp8x(flags byte) []byte {
	return webpChunk("VP8X", []byte{flags, 0, 0, 0, 199, 0, 0, 112, 0, 0})
}

func TestCheckThumbnailWebPAcceptsOneImage(t *testing.T) {
	// A Chrome capture with only its image chunk, as the client sends it.
	chromeImage := webpChrome[len(webpChrome)-(8+450):]
	if string(chromeImage[:4]) != "VP8 " {
		t.Fatalf("the Chrome fixture ends with %q", chromeImage[:4])
	}
	for name, body := range map[string][]byte{
		"lossy":           webpLossy,
		"lossless":        webpLossless,
		"VP8X, ALPH, VP8": webpAlpha,
		"Chrome image":    riffWebP(chromeImage),
	} {
		if err := checkThumbnailWebP(body); err != nil {
			t.Errorf("%s refused: %v", name, err)
		}
	}
}

// TestCheckThumbnailWebPRefusesOtherChunks (security regression: review T3
// M1, captures are WebP only). Every body here fits its RIFF size and decodes,
// so each passes without the chunk walk.
func TestCheckThumbnailWebPRefusesOtherChunks(t *testing.T) {
	image := webpLossy[12:]
	for name, body := range map[string][]byte{
		"junk chunk":               riffWebP(webpChunk("JUNK", make([]byte, 64)), image),
		"bytes after the image":    riffWebP(image, []byte("trail!")),
		"two image chunks":         riffWebP(image, image),
		"animation flag":           riffWebP(vp8x(0x02), image),
		"ICC flag":                 riffWebP(vp8x(0x20), image),
		"EXIF flag":                riffWebP(vp8x(0x08), image),
		"ICC profile as encoded":   webpChrome,
		"metadata after the image": riffWebP(vp8x(0), image, webpChunk("EXIF", make([]byte, 16))),
	} {
		t.Run(name, func(t *testing.T) {
			if err := checkThumbnailWebP(body); err == nil {
				t.Error("accepted")
			}
		})
	}
}

// TestCheckThumbnailWebPDecodesInFull (security regression: review T3 S5).
// A lossless image cut short inside a well-formed chunk passes the header
// check and the chunk walk; only the full decode refuses it.
func TestCheckThumbnailWebPDecodesInFull(t *testing.T) {
	cut := riffWebP(webpChunk("VP8L", webpLossless[20:28]))
	if err := checkThumbnailWebP(cut); err == nil || err.Error() != "the thumbnail does not decode" {
		t.Fatalf("a cut-short lossless image: %v, want the decode to refuse it", err)
	}
}
