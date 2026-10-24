package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// recorder keeps every request's latency while measuring is on (the ramp is
// left out), per endpoint label, plus a per-second count for the timeline.
type recorder struct {
	measuring atomic.Bool
	mu        sync.Mutex
	series    map[string]*series
	seconds   map[int64]*second
	samples   map[string]int
	streams   streamStats
}

type series struct {
	ms     []float32
	errors map[string]int
}

type second struct {
	Time     int64     `json:"t"`
	Requests int       `json:"requests"`
	Errors   int       `json:"errors"`
	P95      float32   `json:"p95_ms"`
	ms       []float32 // this second's latencies, for P95
}

type streamStats struct {
	Opened, Refused, Failed, Ended atomic.Int64
	Open                           atomic.Int64
}

func newRecorder() *recorder {
	return &recorder{series: map[string]*series{}, seconds: map[int64]*second{}, samples: map[string]int{}}
}

// sample logs the first few failures of each kind, with the answer's body.
func (r *recorder) sample(key string, err error) {
	r.mu.Lock()
	r.samples[key]++
	n := r.samples[key]
	r.mu.Unlock()
	if n <= 3 {
		log.Print(err)
	}
}

// record counts one request. kind is "" for an expected answer, otherwise what
// went wrong ("status 503", "timeout", ...).
func (r *recorder) record(label string, took time.Duration, kind string) {
	if !r.measuring.Load() {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.series[label]
	if s == nil {
		s = &series{errors: map[string]int{}}
		r.series[label] = s
	}
	s.ms = append(s.ms, float32(took.Seconds()*1000))
	now := time.Now().Unix()
	sec := r.seconds[now]
	if sec == nil {
		sec = &second{Time: now}
		r.seconds[now] = sec
	}
	sec.Requests++
	sec.ms = append(sec.ms, float32(took.Seconds()*1000))
	if kind != "" {
		s.errors[kind]++
		sec.Errors++
	}
}

type labelSummary struct {
	Label     string         `json:"label"`
	Count     int            `json:"count"`
	PerSecond float64        `json:"per_second"`
	P50       float32        `json:"p50_ms"`
	P95       float32        `json:"p95_ms"`
	P99       float32        `json:"p99_ms"`
	Max       float32        `json:"max_ms"`
	Errors    map[string]int `json:"errors,omitempty"`
	ErrorRate float64        `json:"error_rate"`
}

type summary struct {
	Users int `json:"users"`
	// The measured window, in Unix seconds.
	From       int64            `json:"from"`
	To         int64            `json:"to"`
	Seconds    float64          `json:"measured_seconds"`
	Overall    labelSummary     `json:"overall"`
	Labels     []labelSummary   `json:"labels"`
	Streams    map[string]int64 `json:"streams"`
	Timeline   []second         `json:"timeline"`
	Pass       bool             `json:"pass"`
	FailReason string           `json:"fail_reason,omitempty"`
}

func summarize(label string, ms []float32, errors map[string]int, seconds float64) labelSummary {
	sorted := slices.Clone(ms)
	slices.Sort(sorted)
	at := func(q float64) float32 {
		if len(sorted) == 0 {
			return 0
		}
		return sorted[min(len(sorted)-1, int(q*float64(len(sorted))))]
	}
	failed := 0
	for _, n := range errors {
		failed += n
	}
	s := labelSummary{
		Label: label, Count: len(ms), PerSecond: float64(len(ms)) / seconds,
		P50: at(0.50), P95: at(0.95), P99: at(0.99), Errors: errors,
	}
	if len(sorted) > 0 {
		s.Max = sorted[len(sorted)-1]
		s.ErrorRate = float64(failed) / float64(len(ms))
	}
	return s
}

// finish applies the video's pass rule (p95 under 500 ms, p99 under 1 s,
// under 1% of requests failing) to everything measured.
func (r *recorder) finish(users int, measured time.Duration) summary {
	r.mu.Lock()
	defer r.mu.Unlock()
	seconds := measured.Seconds()
	var all []float32
	allErrors := map[string]int{}
	now := time.Now()
	out := summary{Users: users, Seconds: seconds, From: now.Add(-measured).Unix(), To: now.Unix()}
	for label, s := range r.series {
		out.Labels = append(out.Labels, summarize(label, s.ms, s.errors, seconds))
		all = append(all, s.ms...)
		for kind, n := range s.errors {
			allErrors[kind] += n
		}
	}
	sort.Slice(out.Labels, func(i, j int) bool { return out.Labels[i].Count > out.Labels[j].Count })
	out.Overall = summarize("overall", all, allErrors, seconds)
	keys := make([]int64, 0, len(r.seconds))
	for k := range r.seconds {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		sec := *r.seconds[k]
		slices.Sort(sec.ms)
		sec.P95 = sec.ms[min(len(sec.ms)-1, int(0.95*float64(len(sec.ms))))]
		out.Timeline = append(out.Timeline, sec)
	}
	out.Streams = map[string]int64{
		"opened": r.streams.Opened.Load(), "refused": r.streams.Refused.Load(),
		"failed": r.streams.Failed.Load(), "ended": r.streams.Ended.Load(),
		"open_at_end": r.streams.Open.Load(),
	}
	o := out.Overall
	switch {
	case o.Count == 0:
		out.FailReason = "no requests measured"
	case o.P95 >= 500:
		out.FailReason = fmt.Sprintf("p95 %.0f ms", o.P95)
	case o.P99 >= 1000:
		out.FailReason = fmt.Sprintf("p99 %.0f ms", o.P99)
	case o.ErrorRate >= 0.01:
		out.FailReason = fmt.Sprintf("errors %.2f%%", o.ErrorRate*100)
	}
	out.Pass = out.FailReason == ""
	return out
}

func writeSummary(path string, s summary, w io.Writer) error {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		return err
	}
	o := s.Overall
	fmt.Fprintf(w, "users %d: %.0f req/s, p50 %.0f p95 %.0f p99 %.0f max %.0f ms, errors %.2f%%, streams %v → %s\n",
		s.Users, o.PerSecond, o.P50, o.P95, o.P99, o.Max, o.ErrorRate*100, s.Streams, map[bool]string{true: "PASS", false: "FAIL " + s.FailReason}[s.Pass])
	for _, l := range s.Labels {
		fmt.Fprintf(w, "  %-44s %7d %7.1f/s p50 %6.0f p95 %6.0f p99 %6.0f max %6.0f err %v\n",
			l.Label, l.Count, l.PerSecond, l.P50, l.P95, l.P99, l.Max, l.Errors)
	}
	return nil
}
