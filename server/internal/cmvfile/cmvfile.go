// Package cmvfile checks the structure of an uploaded CMV film: the file the
// cmv-manimgx exporter writes on the user's computer (https://github.com/samyung0/cmv-manim), which
// the browser plays without running the scene. The check reads only the
// header, the chunk index and the video parts' framing, so it is fast and runs
// no code: it refuses a file the player could not read, not one that draws
// something wrong. It mirrors cmv.validate in that exporter, which the
// exporter's `validate` command runs before an upload.
//
// The layout: "CMV0", the header's length (u32), the header JSON, an index of
// chunks (offset u64, draw bytes, video bytes, first frame, frames: u32 each),
// then the chunks. A chunk is a zstd draw part (drawn films only) and a video
// part: a segment count (u8), then per segment its track, first frame and unit
// count (u32 each), the unit sizes (u32 each, twice as many for a track with
// alpha) and the H.264 Annex-B units, the first of each a keyframe. A video
// film's sound (AAC in ADTS frames) may follow the last chunk, where the
// header's "sound" says; "slides" and "captions" are [start, end, text]
// rows.
package cmvfile

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

const (
	// Version is the CMV version this reads, and TakeVersion the ManimGX take
	// format a drawn film's chunks hold.
	Version     = 1
	TakeVersion = 1

	// 1080p either way round: the long side at most 1920, the short at most
	// 1080 (Epo 2026-11-27).
	MaxLongSide  = 1920
	MaxShortSide = 1080
	MaxFPS       = 60
	MaxTracks    = 16
	// MaxHeader bounds the header JSON, and MaxDrawContent the size a chunk's
	// draw part declares it inflates to.
	MaxHeader      = 64 << 10
	MaxDrawContent = 64 << 20

	indexEntry = 24
)

var (
	magic     = []byte("CMV0")
	zstdMagic = []byte{0x28, 0xb5, 0x2f, 0xfd}
)

// Invalid is a film the player could not read, with the reason.
type Invalid struct{ Reason string }

func (e *Invalid) Error() string { return "not a valid film: " + e.Reason }

func invalid(format string, args ...any) error {
	return &Invalid{Reason: fmt.Sprintf(format, args...)}
}

// Track is one video track: a video film's frames, or a drawn film's image.
type Track struct {
	Width  int  `json:"width"`
	Height int  `json:"height"`
	Alpha  bool `json:"alpha"`
}

// Meta is the part of a film's header the check reads.
type Meta struct {
	Form   string  `json:"form"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	FPS    float64 `json:"fps"`
	Frames int64   `json:"frames"`
	Chunks int64   `json:"chunks"`
	Tracks []Track `json:"tracks"`
}

type header struct {
	Meta
	CMV    *int `json:"cmv"`
	Engine *struct {
		Name string `json:"name"`
		Take int    `json:"take"`
	} `json:"engine"`
	Q     map[string]float64 `json:"q"`
	Sound *struct {
		Type   string `json:"type"`
		Offset int64  `json:"offset"`
		Bytes  int64  `json:"bytes"`
	} `json:"sound"`
	Slides   []row `json:"slides"`
	Captions []row `json:"captions"`
}

// row is a slide's or a caption's [start, end, text], in seconds.
type row struct{ start, end float64 }

func (w *row) UnmarshalJSON(b []byte) error {
	var r []any
	if err := json.Unmarshal(b, &r); err != nil || len(r) != 3 {
		return fmt.Errorf("not a [start, end, text] row")
	}
	s, okS := r[0].(float64)
	e, okE := r[1].(float64)
	_, okT := r[2].(string)
	if !okS || !okE || !okT || s < 0 || e <= s {
		return fmt.Errorf("not a [start, end, text] row")
	}
	w.start, w.end = s, e
	return nil
}

// inOrder is whether rows follow one another without overlapping.
func inOrder(rows []row) bool {
	for i := 1; i < len(rows); i++ {
		if rows[i].start < rows[i-1].end-1e-6 {
			return false
		}
	}
	return true
}

// adtsWhole is whether b is AAC in ADTS frames, end to end: each starts with
// the sync word and its stated length lands on the next.
func adtsWhole(b []byte) bool {
	for at := 0; at < len(b); {
		if at+7 > len(b) || b[at] != 0xff || b[at+1]&0xf0 != 0xf0 {
			return false
		}
		n := int(b[at+3]&0x03)<<11 | int(b[at+4])<<3 | int(b[at+5])>>5
		if n < 7 || at+n > len(b) {
			return false
		}
		at += n
	}
	return len(b) > 0
}

// Check reads a film of size bytes and returns its header, or an *Invalid.
func Check(r io.ReaderAt, size int64) (Meta, error) {
	head, err := read(r, 0, 8, size)
	if err != nil || !bytes.Equal(head[:4], magic) {
		return Meta{}, invalid("not a CMV film")
	}
	n := int64(binary.LittleEndian.Uint32(head[4:]))
	if n > MaxHeader || 8+n > size {
		return Meta{}, invalid("the header is too long")
	}
	raw, err := read(r, 8, n, size)
	if err != nil {
		return Meta{}, err
	}
	var h header
	if err := json.Unmarshal(raw, &h); err != nil {
		return Meta{}, invalid("the header is not JSON of a film")
	}
	if err := h.check(); err != nil {
		return Meta{}, err
	}
	m := h.Meta
	body := 8 + n + indexEntry*m.Chunks
	if m.Chunks > size/indexEntry || body > size {
		return Meta{}, invalid("the chunk index is cut short")
	}
	index, err := read(r, 8+n, indexEntry*m.Chunks, size)
	if err != nil {
		return Meta{}, err
	}
	var at, frame int64
	for i := range m.Chunks {
		e := index[indexEntry*i:]
		offset := int64(binary.LittleEndian.Uint64(e))
		draw := int64(binary.LittleEndian.Uint32(e[8:]))
		video := int64(binary.LittleEndian.Uint32(e[12:]))
		first := int64(binary.LittleEndian.Uint32(e[16:]))
		frames := int64(binary.LittleEndian.Uint32(e[20:]))
		if offset != at || first != frame || frames < 1 {
			return Meta{}, invalid("chunk %d is out of place", i)
		}
		if (m.Form == "video") != (draw == 0) {
			return Meta{}, invalid("chunk %d's draw part doesn't match the form", i)
		}
		start := body + offset
		if start+draw+video > size {
			return Meta{}, invalid("chunk %d runs past the end", i)
		}
		if draw > 0 {
			frameHead, err := read(r, start, min(draw, 18), size)
			if err != nil {
				return Meta{}, err
			}
			content, err := zstdContentSize(frameHead)
			if err != nil {
				return Meta{}, invalid("chunk %d's draw part %s", i, err)
			}
			if content > MaxDrawContent {
				return Meta{}, invalid("chunk %d's draw part is too large", i)
			}
		}
		if video > 0 {
			part, err := read(r, start+draw, video, size)
			if err != nil {
				return Meta{}, err
			}
			if err := checkVideo(part, m, first, frames); err != nil {
				return Meta{}, invalid("chunk %d %s", i, err)
			}
		} else if m.Form == "video" {
			return Meta{}, invalid("chunk %d has no video", i)
		}
		at += draw + video
		frame += frames
	}
	end := at
	if h.Sound != nil {
		if m.Form != "video" || h.Sound.Type != "audio/aac" || h.Sound.Offset != at || h.Sound.Bytes < 1 {
			return Meta{}, invalid("a video film's sound follows its last chunk")
		}
		sound, err := read(r, body+at, h.Sound.Bytes, size)
		if err != nil {
			return Meta{}, err
		}
		if !adtsWhole(sound) {
			return Meta{}, invalid("the sound is not whole AAC frames")
		}
		end += h.Sound.Bytes
	}
	if body+end != size || frame != m.Frames {
		return Meta{}, invalid("the chunks don't add up to the film")
	}
	return m, nil
}

func (h *header) check() error {
	if h.CMV == nil || *h.CMV != Version {
		return invalid("not a CMV version this reads")
	}
	if h.Form != "drawn" && h.Form != "video" {
		return invalid("the form is neither drawn nor video")
	}
	if h.Width != float64(int(h.Width)) || h.Height != float64(int(h.Height)) ||
		!fits(int(h.Width), int(h.Height)) || h.FPS < 1 || h.FPS > MaxFPS {
		return invalid("the size or frame rate is out of range")
	}
	if h.Frames < 1 || h.Chunks < 1 {
		return invalid("no frames or no chunks")
	}
	if !inOrder(h.Slides) {
		return invalid("the slides overlap or are out of order")
	}
	if len(h.Tracks) > MaxTracks {
		return invalid("too many tracks")
	}
	for _, t := range h.Tracks {
		if !fits(t.Width, t.Height) {
			return invalid("a track's size is out of range")
		}
	}
	if h.Form == "video" {
		if len(h.Tracks) != 1 || h.Tracks[0].Alpha {
			return invalid("a video film has one track, without alpha")
		}
		return nil
	}
	if h.Engine == nil || h.Engine.Name != "manimgx" || h.Engine.Take != TakeVersion {
		return invalid("a drawn film for a player this doesn't have")
	}
	if len(h.Q) == 0 {
		return invalid("the quantization steps are missing")
	}
	for _, q := range h.Q {
		if q <= 0 {
			return invalid("the quantization steps are missing")
		}
	}
	return nil
}

// fits is whether a film or track size is within the limits, at least 16
// pixels a side.
func fits(width, height int) bool {
	long, short := max(width, height), min(width, height)
	return short >= 16 && long <= MaxLongSide && short <= MaxShortSide
}

// checkVideo checks a chunk's video part: its segments fill it exactly, each
// starts with a keyframe, and a video film's one segment covers the chunk.
func checkVideo(part []byte, m Meta, first, frames int64) error {
	if len(part) < 1 || part[0] == 0 {
		return fmt.Errorf("has an empty video part")
	}
	at := 1
	u32 := func() (int64, bool) {
		if at+4 > len(part) {
			return 0, false
		}
		v := binary.LittleEndian.Uint32(part[at:])
		at += 4
		return int64(v), true
	}
	segments := int(part[0])
	for range segments {
		track, ok1 := u32()
		start, ok2 := u32()
		n, ok3 := u32()
		if !ok1 || !ok2 || !ok3 || track >= int64(len(m.Tracks)) || n < 1 {
			return fmt.Errorf("has a malformed video part")
		}
		count := n
		if m.Tracks[track].Alpha {
			count *= 2
		}
		if count > int64(len(part)-at)/4 {
			return fmt.Errorf("has a malformed video part")
		}
		sizes := make([]int64, count)
		for k := range sizes {
			sizes[k], _ = u32()
		}
		for k, s := range sizes {
			if s < 1 || s > int64(len(part)-at) {
				return fmt.Errorf("has a malformed video part")
			}
			// The first colour unit and the first alpha unit open a segment.
			if (int64(k) == 0 || int64(k) == n) && !keyframe(part[at:at+int(s)]) {
				return fmt.Errorf("has a video segment that doesn't start with a keyframe")
			}
			at += int(s)
		}
		if m.Form == "video" && (segments != 1 || start != first || n != frames) {
			return fmt.Errorf("has video that doesn't cover its frames")
		}
	}
	if at != len(part) {
		return fmt.Errorf("has a video part that doesn't add up")
	}
	return nil
}

// keyframe is whether an Annex-B access unit holds an IDR slice (NAL type 5).
func keyframe(unit []byte) bool {
	for {
		i := bytes.Index(unit, []byte{0, 0, 1})
		if i < 0 || i+3 >= len(unit) {
			return false
		}
		if unit[i+3]&31 == 5 {
			return true
		}
		unit = unit[i+3:]
	}
}

// zstdContentSize is the content size a zstd frame's header declares (the
// exporter always writes it).
func zstdContentSize(frame []byte) (int64, error) {
	if len(frame) < 6 || !bytes.Equal(frame[:4], zstdMagic) {
		return 0, fmt.Errorf("is not a zstd frame")
	}
	fhd := frame[4]
	fcsFlag, single, dictFlag := fhd>>6, (fhd>>5)&1, fhd&3
	at := 5 + [4]int{0, 1, 2, 4}[dictFlag]
	if single == 0 {
		at++
	}
	width := [4]int{0, 2, 4, 8}[fcsFlag]
	if fcsFlag == 0 && single == 1 {
		width = 1
	}
	if width == 0 {
		return 0, fmt.Errorf("does not declare its size")
	}
	if len(frame) < at+width {
		return 0, fmt.Errorf("ends inside its header")
	}
	var value uint64
	for k := width - 1; k >= 0; k-- {
		value = value<<8 | uint64(frame[at+k])
	}
	if width == 2 {
		value += 256
	}
	if value > 1<<62 {
		return 0, fmt.Errorf("is too large")
	}
	return int64(value), nil
}

// read reads n bytes at off, refusing a range past size.
func read(r io.ReaderAt, off, n, size int64) ([]byte, error) {
	if off < 0 || n < 0 || off+n > size {
		return nil, invalid("the file is cut short")
	}
	out := make([]byte, n)
	// A ReaderAt may answer io.EOF with every byte when the range ends the file.
	if got, err := r.ReadAt(out, off); err != nil && (err != io.EOF || int64(got) != n) {
		return nil, err
	}
	return out, nil
}
