package httpapi

import (
	"fmt"
	"io"
	"sync"
)

// browserWriter writes a chat turn's events to the browser on its own
// goroutine, so a browser that stops reading never holds up the relay: the
// turn's save, its credit settlement and its AI request slot follow the
// pipeline (Epo 2026-10-21). Events queue without bound (a turn's events are
// bounded by the turn) and none is dropped while the browser is there; a
// write error means it is gone, and later events go nowhere. There is no
// write time limit.
type browserWriter struct {
	mu     sync.Mutex
	queue  [][]byte
	closed bool
	gone   bool
	wake   chan struct{}
	done   chan struct{}
}

func newBrowserWriter(w io.Writer, flush func()) *browserWriter {
	b := &browserWriter{wake: make(chan struct{}, 1), done: make(chan struct{})}
	go b.run(w, flush)
	return b
}

// send queues one encoded event; it never blocks on the browser.
func (b *browserWriter) send(data []byte) {
	b.mu.Lock()
	if !b.gone {
		b.queue = append(b.queue, data)
	}
	b.mu.Unlock()
	b.signal()
}

// finish ends the stream after the events already sent and waits until they
// are written or the browser is gone, so the response closes after the last.
func (b *browserWriter) finish() {
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	b.signal()
	<-b.done
}

func (b *browserWriter) signal() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

func (b *browserWriter) run(w io.Writer, flush func()) {
	defer close(b.done)
	for {
		b.mu.Lock()
		batch, closed := b.queue, b.closed
		b.queue = nil
		b.mu.Unlock()
		if len(batch) == 0 {
			if closed {
				return
			}
			<-b.wake
			continue
		}
		for _, data := range batch {
			if _, err := fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				b.mu.Lock()
				b.gone, b.queue = true, nil
				b.mu.Unlock()
				return
			}
		}
		flush()
	}
}
