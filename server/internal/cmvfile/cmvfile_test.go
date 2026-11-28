package cmvfile

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"testing"
)

// The fixtures are a 96×64, 10 fps circle drawn in 0.9 s, exported by
// cmv-manimgx in each form (--form drawn, --form video).
func film(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func check(data []byte) (Meta, error) {
	return Check(bytes.NewReader(data), int64(len(data)))
}

func TestCheckReadsBothForms(t *testing.T) {
	for _, form := range []string{"drawn", "video"} {
		m, err := check(film(t, form+".cmv"))
		if err != nil {
			t.Fatalf("%s: %v", form, err)
		}
		if m.Form != form || m.Width != 96 || m.Height != 64 || m.FPS != 10 || m.Frames != 9 {
			t.Fatalf("%s: header %+v", form, m)
		}
	}
}

// video-sound.cmv is the exporter's 7-slide demo as a video film: slides,
// captions and its AAC sound after the last chunk.
func TestCheckReadsAVideoFilmsSound(t *testing.T) {
	if _, err := check(film(t, "video-sound.cmv")); err != nil {
		t.Fatal(err)
	}
}

func TestCheckRefusesBrokenFilms(t *testing.T) {
	drawn := film(t, "drawn.cmv")
	video := film(t, "video.cmv")
	headerEnd := 8 + int(binary.LittleEndian.Uint32(drawn[4:]))
	cases := map[string][]byte{
		"magic":     append([]byte("CMV1"), drawn[4:]...),
		"cut short": drawn[:len(drawn)-1],
		"trailing":  append(append([]byte{}, drawn...), 0),
		// 99 fps, past the 60 allowed (the same length, so the film still adds up)
		"fps":    bytes.Replace(drawn, []byte(`"fps":10.0`), []byte(`"fps":99.0`), 1),
		"header": append(append(append([]byte{}, drawn[:8]...), bytes.Repeat([]byte{' '}, headerEnd-8)...), drawn[headerEnd:]...),
		// The video film's first unit is its keyframe; a non-IDR NAL type replaces it.
		"keyframe": func() []byte {
			out := append([]byte{}, video...)
			i := bytes.Index(out, []byte{0, 0, 1, 0x65})
			out[i+3] = 0x41
			return out
		}(),
	}
	for name, data := range cases {
		var bad *Invalid
		if _, err := check(data); !errors.As(err, &bad) {
			t.Errorf("%s: got %v, want *Invalid", name, err)
		}
	}
}
