package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"slices"
	"strings"
	"time"
)

type user struct {
	id, token, target string
	api, streams      *http.Client
	rec               *recorder
	rng               *rand.Rand
	tab               tab
	skip              map[string]bool
}

// call sends one request and records it under label (the route template).
// An answer outside want counts as an error; out, when given, receives the
// decoded JSON body.
func (u *user) call(ctx context.Context, method, path, label string, body, out any, want ...int) error {
	if u.skip[method+" "+label] {
		return nil
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.target+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+u.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	started := time.Now()
	res, err := u.api.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		kind := "transport"
		if errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "Timeout") {
			kind = "timeout"
		}
		u.rec.record(method+" "+label, time.Since(started), kind)
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	took := time.Since(started)
	if err != nil {
		u.rec.record(method+" "+label, took, "read")
		return err
	}
	if len(want) == 0 {
		want = []int{http.StatusOK}
	}
	if !slices.Contains(want, res.StatusCode) {
		kind := fmt.Sprintf("status %d", res.StatusCode)
		u.rec.record(method+" "+label, took, kind)
		err := fmt.Errorf("%s %s: %d %s", method, path, res.StatusCode, bytes.TrimSpace(raw[:min(len(raw), 300)]))
		u.rec.sample(method+" "+label+" "+kind, err)
		return err
	}
	u.rec.record(method+" "+label, took, "")
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

// stream holds the tab's event stream open until ctx ends, reconnecting when
// the server ends or refuses it. on hears "open" once each connection is set
// up, then each event's name; it runs apart from the reading.
func (u *user) stream(ctx context.Context, workspace string, on func(event string)) {
	path := "/api/stream"
	if workspace != "" {
		path += "?workspace=" + workspace
	}
	for ctx.Err() == nil {
		u.streamOnce(ctx, path, on)
		u.sleep(ctx, 3*time.Second)
	}
}

func (u *user) streamOnce(ctx context.Context, path string, on func(event string)) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.target+path, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+u.token)
	req.Header.Set("Accept", "text/event-stream")
	started := time.Now()
	res, err := u.streams.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			u.rec.streams.Failed.Add(1)
			u.rec.record("GET /api/stream (open)", time.Since(started), "transport")
		}
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, res.Body)
		if res.StatusCode == http.StatusTooManyRequests {
			u.rec.streams.Refused.Add(1)
		} else {
			u.rec.streams.Failed.Add(1)
		}
		u.rec.record("GET /api/stream (open)", time.Since(started), fmt.Sprintf("status %d", res.StatusCode))
		return
	}
	// The first comment arrives once the stream is set up.
	lines := bufio.NewScanner(res.Body)
	if !lines.Scan() {
		u.rec.streams.Failed.Add(1)
		return
	}
	u.rec.record("GET /api/stream (open)", time.Since(started), "")
	u.rec.streams.Opened.Add(1)
	u.rec.streams.Open.Add(1)
	defer u.rec.streams.Open.Add(-1)
	go on("open")
	for lines.Scan() {
		if event, ok := strings.CutPrefix(lines.Text(), "event: "); ok {
			go on(event)
		}
	}
	if ctx.Err() == nil {
		u.rec.streams.Ended.Add(1)
	}
}

func (u *user) sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

// think waits an exponentially distributed time with the given mean, capped
// at five means, as people read and answer between requests.
func (u *user) think(ctx context.Context, mean time.Duration) {
	u.sleep(ctx, min(time.Duration(u.rng.ExpFloat64()*float64(mean)), 5*mean))
}
