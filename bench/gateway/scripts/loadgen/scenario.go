package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// One simulated browser tab. The requests per page and action follow what the
// frontend sends (mapped from src/ on 2026-10-24): the root /me, the shell's
// queries, each route's loader and mounted queries, react-query's five-minute
// staleness, the event stream's reconnect on every move into or out of a
// workspace and its refetches on open and on tree and notification events,
// and the pages that fetch the same data twice. Chat, uploads, Office and the
// question bank's own pages are left out: their cost is in other services.

const staleAfter = 5 * time.Minute

type material struct {
	ID    string `json:"id"`
	Kind  string `json:"type"`
	Title string `json:"title"`
}

type space struct {
	id                          string
	notes, quizzes, decks, pdfs []string
}

// tab is the per-session state the browser would hold: its query cache's
// fetch times and the stream it has open.
type tab struct {
	mu         sync.Mutex
	fetched    map[string]time.Time
	spaces     []string
	pdfs       map[string][]string // per workspace, from its last file list
	stopStream context.CancelFunc
}

// get fetches path unless the cache still holds it fresh; force refetches
// regardless, as an invalidation or a page's always-refetch does. out is
// left alone when nothing is fetched.
func (u *user) get(ctx context.Context, path, label string, force bool, out any) error {
	u.tab.mu.Lock()
	at, ok := u.tab.fetched[path]
	if !force && ok && time.Since(at) < staleAfter {
		u.tab.mu.Unlock()
		return nil
	}
	u.tab.fetched[path] = time.Now()
	u.tab.mu.Unlock()
	return u.call(ctx, http.MethodGet, path, label, nil, out)
}

// all runs requests at once, as a route's loader and its mounted queries do.
func all(fns ...func()) {
	var wg sync.WaitGroup
	for _, fn := range fns {
		wg.Go(fn)
	}
	wg.Wait()
}

func (u *user) shell(ctx context.Context) {
	all(
		func() {
			_ = u.get(ctx, "/api/notifications/unread-count", "/api/notifications/unread-count", false, nil)
		},
		func() { _ = u.get(ctx, "/api/bank/progress", "/api/bank/progress", false, nil) },
		func() { _ = u.get(ctx, "/api/learning/progress", "/api/learning/progress", false, nil) },
	)
}

const workspaceList = "/api/workspaces?sort=accessed"

const dashboardMaterials = "/api/materials?kind=note,quiz,flashcards,mindmap,diagram&location=workspace,standalone&scope=member&sort=created"

func (u *user) dashboard(ctx context.Context) {
	all(
		func() { u.shell(ctx) },
		func() {
			u.tab.mu.Lock()
			at, ok := u.tab.fetched[workspaceList]
			fresh := ok && len(u.tab.spaces) > 0 && time.Since(at) < staleAfter
			u.tab.fetched[workspaceList] = time.Now()
			u.tab.mu.Unlock()
			if fresh {
				return
			}
			var list []struct {
				ID string `json:"id"`
			}
			if u.call(ctx, http.MethodGet, workspaceList, "/api/workspaces", nil, &list) == nil {
				u.tab.mu.Lock()
				u.tab.spaces = u.tab.spaces[:0]
				for _, w := range list {
					u.tab.spaces = append(u.tab.spaces, w.ID)
				}
				u.tab.mu.Unlock()
			}
		},
		func() { _ = u.get(ctx, "/api/files?scope=member", "/api/files?scope=member", false, nil) },
		func() { _ = u.get(ctx, dashboardMaterials, "/api/materials?scope=member", false, nil) },
		func() { _ = u.get(ctx, "/api/thinking", "/api/thinking", false, nil) },
	)
	u.openStream(ctx, "")
}

// workspaceFileList fetches a workspace's files and keeps its PDFs to open.
func (u *user) workspaceFileList(ctx context.Context, ws string, force bool) {
	var files []workspaceFile
	if u.get(ctx, "/api/workspaces/"+ws+"/files", "/api/workspaces/{id}/files", force, &files) != nil || files == nil {
		return
	}
	var pdfs []string
	for _, f := range files {
		if f.Kind == "pdf" {
			pdfs = append(pdfs, f.ID)
		}
	}
	u.tab.mu.Lock()
	u.tab.pdfs[ws] = pdfs
	u.tab.mu.Unlock()
}

func (u *user) refetchTree(ctx context.Context, ws string) {
	all(
		func() { u.workspaceFileList(ctx, ws, true) },
		func() {
			_ = u.get(ctx, "/api/workspaces/"+ws+"/materials", "/api/workspaces/{id}/materials", true, nil)
		},
		func() { _ = u.get(ctx, "/api/workspaces/"+ws+"/chapters", "/api/workspaces/{id}/chapters", true, nil) },
	)
}

func (u *user) openWorkspace(ctx context.Context, ws string) *space {
	sp := &space{id: ws}
	var items []material
	all(
		func() { _ = u.get(ctx, "/api/workspaces/"+ws, "/api/workspaces/{id}", true, nil) },
		func() { _ = u.get(ctx, "/api/workspaces/"+ws+"/chapters", "/api/workspaces/{id}/chapters", false, nil) },
		func() { u.workspaceFileList(ctx, ws, false) },
		func() {
			_ = u.get(ctx, "/api/workspaces/"+ws+"/materials", "/api/workspaces/{id}/materials", true, &items)
		},
		func() {
			_ = u.get(ctx, "/api/workspaces/"+ws+"/conversations", "/api/workspaces/{id}/conversations", false, nil)
		},
		func() { _ = u.get(ctx, workspaceList, "/api/workspaces", false, nil) },
	)
	u.tab.mu.Lock()
	sp.pdfs = u.tab.pdfs[ws]
	u.tab.mu.Unlock()
	for _, m := range items {
		switch m.Kind {
		case "note":
			sp.notes = append(sp.notes, m.ID)
		case "quiz":
			sp.quizzes = append(sp.quizzes, m.ID)
		case "flashcards":
			sp.decks = append(sp.decks, m.ID)
		}
	}
	// Mounted after the page renders; members only on a wide screen with the
	// left panel open.
	all(
		func() { _ = u.get(ctx, "/api/workspaces/"+ws+"/study", "/api/workspaces/{id}/study", false, nil) },
		func() { _ = u.get(ctx, "/api/workspaces/"+ws+"/recent", "/api/workspaces/{id}/recent", false, nil) },
		func() {
			if u.rng.IntN(2) == 0 {
				_ = u.get(ctx, "/api/workspaces/"+ws+"/members", "/api/workspaces/{id}/members", false, nil)
			}
		},
	)
	u.openStream(ctx, ws)
	return sp
}

// openStream replaces the tab's stream, as a move into or out of a workspace
// does, refetching the active lists once it opens.
func (u *user) openStream(ctx context.Context, ws string) {
	u.tab.mu.Lock()
	if u.tab.stopStream != nil {
		u.tab.stopStream()
	}
	streamCtx, stop := context.WithCancel(ctx)
	u.tab.stopStream = stop
	u.tab.mu.Unlock()
	go u.stream(streamCtx, ws, func(event string) {
		switch event {
		case "open":
			_ = u.get(ctx, "/api/notifications/unread-count", "/api/notifications/unread-count", true, nil)
			if ws != "" {
				u.refetchTree(ctx, ws)
			}
		case "tree":
			u.sleep(ctx, 300*time.Millisecond)
			u.refetchTree(ctx, ws)
		case "notification":
			_ = u.get(ctx, "/api/notifications/unread-count", "/api/notifications/unread-count", true, nil)
		}
	})
}

func pick(u *user, ids []string) string {
	if len(ids) == 0 {
		return ""
	}
	return ids[u.rng.IntN(len(ids))]
}

func (u *user) openNote(ctx context.Context, sp *space) {
	id := pick(u, sp.notes)
	if id == "" {
		return
	}
	_ = u.call(ctx, http.MethodGet, "/api/materials/"+id, "/api/materials/{id}", nil, nil)
	all(
		func() {
			_ = u.get(ctx, "/api/materials/"+id+"/discussions", "/api/materials/{id}/discussions", false, nil)
		},
		func() {
			_ = u.call(ctx, http.MethodPost, "/api/materials/"+id+"/collaboration-token",
				"/api/materials/{id}/collaboration-token", nil, nil, http.StatusCreated)
		},
	)
	u.think(ctx, 90*time.Second)
}

func (u *user) readToken(ctx context.Context, id string) {
	_ = u.call(ctx, http.MethodPost, "/api/materials/"+id+"/collaboration-token",
		"/api/materials/{id}/collaboration-token (read)", map[string]string{"access": "read"}, nil, http.StatusCreated)
}

func (u *user) takeQuiz(ctx context.Context, sp *space) {
	id := pick(u, sp.quizzes)
	if id == "" {
		return
	}
	// The loader's fetch, then the page's always-refetch on mount.
	_ = u.get(ctx, "/api/quizzes/"+id, "/api/quizzes/{id}", false, nil)
	var quiz quizBody
	_ = u.get(ctx, "/api/quizzes/"+id, "/api/quizzes/{id}", true, &quiz)
	u.readToken(ctx, id)
	started := time.Now().UTC()
	u.think(ctx, 60*time.Second)
	if u.call(ctx, http.MethodPost, "/api/quizzes/"+id+"/attempts", "/api/quizzes/{id}/attempts",
		map[string]any{"answers": quiz.answers(u), "startedAt": started.Format(time.RFC3339)}, nil, http.StatusCreated) == nil {
		all(
			func() { _ = u.get(ctx, "/api/learning/progress", "/api/learning/progress", true, nil) },
			func() { _ = u.get(ctx, "/api/workspaces/"+sp.id+"/study", "/api/workspaces/{id}/study", true, nil) },
		)
	}
	u.think(ctx, 20*time.Second)
}

func (u *user) studyCards(ctx context.Context, sp *space) {
	id := pick(u, sp.decks)
	if id == "" {
		return
	}
	var cards []struct {
		ID string `json:"id"`
	}
	all(
		func() { _ = u.get(ctx, "/api/flashcards/"+id, "/api/flashcards/{id}", false, nil) },
		func() { _ = u.get(ctx, "/api/flashcards/"+id+"/cards", "/api/flashcards/{id}/cards", false, nil) },
	)
	all(
		func() { _ = u.get(ctx, "/api/flashcards/"+id, "/api/flashcards/{id}", true, nil) },
		func() { _ = u.get(ctx, "/api/flashcards/"+id+"/cards", "/api/flashcards/{id}/cards", true, &cards) },
	)
	u.readToken(ctx, id)
	attempt := map[string]string{"id": randomID(), "startedAt": time.Now().UTC().Format(time.RFC3339)}
	for _, card := range cards[:min(len(cards), 3+u.rng.IntN(8))] {
		u.think(ctx, 6*time.Second)
		if ctx.Err() != nil {
			return
		}
		if u.call(ctx, http.MethodPost, "/api/review/ratings", "/api/review/ratings", map[string]any{
			"itemId": card.ID, "materialId": id, "rating": 1 + u.rng.IntN(4), "attempt": attempt,
		}, nil, http.StatusNoContent) == nil {
			_ = u.get(ctx, "/api/learning/progress", "/api/learning/progress", true, nil)
		}
	}
	u.think(ctx, 10*time.Second)
}

// learning is a page outside the workspace: the stream reconnects without
// it, and again with it on the way back. Its result lists page by offset; a
// heavy user reads them to the end, and now and then opens Past reviews.
func (u *user) learning(ctx context.Context, sp *space) {
	u.openStream(ctx, "")
	all(
		func() { _ = u.get(ctx, "/api/attempts?limit=30", "/api/attempts p1", false, nil) },
		func() { _ = u.get(ctx, "/api/learning/progress", "/api/learning/progress", false, nil) },
		func() { _ = u.get(ctx, "/api/review/overview", "/api/review/overview", false, nil) },
		func() { _ = u.get(ctx, "/api/learning/plans", "/api/learning/plans", false, nil) },
	)
	// The Results tab's list under a second cache key.
	_ = u.get(ctx, "/api/attempts?limit=30&kinds=", "/api/attempts p1", false, nil)
	if u.heavy {
		u.scrollOffset(ctx, "/api/attempts?limit=30", "/api/attempts", 2, 0, 4*time.Second)
	}
	if u.rng.IntN(3) == 0 {
		pages := 1
		if u.heavy {
			pages = 0
		}
		u.scrollOffset(ctx, "/api/review/sessions?limit=30", "/api/review/sessions", 1, pages, 4*time.Second)
	}
	u.think(ctx, 30*time.Second)
	u.openWorkspace(ctx, sp.id)
}

// pageLabel names a page of a list by its number, the 6th and later together.
func pageLabel(label string, n int) string {
	if n >= 6 {
		return label + " p6+"
	}
	return fmt.Sprintf("%s p%d", label, n)
}

func withQuery(path, param string) string {
	if strings.Contains(path, "?") {
		return path + "&" + param
	}
	return path + "?" + param
}

// scroll reads a cursor-paged list the way its infinite query does as the
// user scrolls: a page, a look at its rows, the next page, up to pages (0
// for all of them, as select all fetches them).
func (u *user) scroll(ctx context.Context, path, label string, pages int, look time.Duration) {
	cursor := ""
	for n := 1; ctx.Err() == nil; n++ {
		p := path
		if cursor != "" {
			p = withQuery(path, "cursor="+url.QueryEscape(cursor))
		}
		var page struct {
			NextCursor string `json:"nextCursor"`
		}
		if u.call(ctx, http.MethodGet, p, pageLabel(label, n), nil, &page) != nil || page.NextCursor == "" || n == pages {
			return
		}
		cursor = page.NextCursor
		u.think(ctx, look)
	}
}

// scrollOffset is scroll for Learning's lists, 30 to a page by offset, from
// page first.
func (u *user) scrollOffset(ctx context.Context, path, label string, first, pages int, look time.Duration) {
	for n := first; ctx.Err() == nil; n++ {
		p := path
		if n > 1 {
			p = withQuery(path, "offset="+strconv.Itoa((n-1)*30))
		}
		var page struct {
			More bool `json:"more"`
		}
		if u.call(ctx, http.MethodGet, p, pageLabel(label, n), nil, &page) != nil || !page.More || n-first+1 == pages {
			return
		}
		u.think(ctx, look)
	}
}

// fileListPaths are the Files page's lists as its tabs send them: files by
// each sort (name and workspace ascending first), Blocks by its default
// sort, Embeds and Trash.
var fileListPaths = []struct{ path, label string }{
	{"/api/files?dir=desc&sort=added", "/api/files sort=added"},
	{"/api/files?dir=asc&sort=name", "/api/files sort=name"},
	{"/api/files?dir=asc&sort=workspace", "/api/files sort=workspace"},
	{"/api/files?dir=desc&sort=size", "/api/files sort=size"},
	{"/api/materials?dir=desc&sort=updated", "/api/materials sort=updated"},
	{"/api/materials?dir=asc&sort=title", "/api/materials sort=title"},
	{"/api/materials?dir=asc&sort=workspace", "/api/materials sort=workspace"},
	{"/api/editor-assets", "/api/editor-assets"},
	{"/api/trash", "/api/trash"},
}

// filesPage is the Files page outside any workspace: one of its tabs and
// sorts, read down as far as the user scrolls (a heavy user to the end), and
// one visit in twenty a select all, which loads every page at once.
func (u *user) filesPage(ctx context.Context, sp *space) {
	u.openStream(ctx, "")
	_ = u.get(ctx, workspaceList, "/api/workspaces", false, nil)
	pages, look := 1+u.rng.IntN(2), 4*time.Second
	if u.heavy {
		pages = 0
	}
	if u.rng.IntN(20) == 0 {
		pages, look = 0, 0
	}
	var list = fileListPaths[0]
	switch n := u.rng.IntN(100); {
	case n < 35:
	case n < 50:
		list = fileListPaths[1+u.rng.IntN(3)]
	case n < 70:
		list = fileListPaths[4]
	case n < 75:
		list = fileListPaths[5+u.rng.IntN(2)]
	case n < 85:
		list = fileListPaths[7]
	default:
		list = fileListPaths[8]
	}
	u.scroll(ctx, list.path, list.label, pages, look)
	u.think(ctx, 20*time.Second)
	u.openWorkspace(ctx, sp.id)
}

// openFile opens one of the workspace's PDFs: its row, then its links and
// annotations together (src/features/files/FileViewer.tsx). The bytes come
// from B2, not the gateway.
func (u *user) openFile(ctx context.Context, sp *space) {
	id := pick(u, sp.pdfs)
	if id == "" {
		return
	}
	_ = u.call(ctx, http.MethodGet, "/api/files/"+id, "/api/files/{id}", nil, nil)
	all(
		func() { _ = u.get(ctx, "/api/files/"+id+"/links", "/api/files/{id}/links", false, nil) },
		func() { _ = u.get(ctx, "/api/files/"+id+"/annotations", "/api/files/{id}/annotations", false, nil) },
	)
	u.think(ctx, 60*time.Second)
}

func (u *user) studyTab(ctx context.Context, sp *space) {
	all(
		func() { _ = u.get(ctx, "/api/workspaces/"+sp.id+"/study", "/api/workspaces/{id}/study", false, nil) },
		func() {
			_ = u.get(ctx, "/api/workspaces/"+sp.id+"/study/attempts", "/api/workspaces/{id}/study/attempts", false, nil)
		},
		func() {
			_ = u.get(ctx, "/api/workspaces/"+sp.id+"/study/plans", "/api/workspaces/{id}/study/plans", false, nil)
		},
	)
	u.think(ctx, 30*time.Second)
}

func (u *user) createNote(ctx context.Context, sp *space) {
	var created material
	if u.call(ctx, http.MethodPost, "/api/workspaces/"+sp.id+"/materials", "/api/workspaces/{id}/materials",
		noteBody("Lecture "+randomID()[:8]), &created, http.StatusCreated) != nil {
		return
	}
	sp.notes = append(sp.notes, created.ID)
	// The mutation's own refetch; the stream's tree event brings another.
	all(
		func() {
			_ = u.get(ctx, "/api/workspaces/"+sp.id+"/materials", "/api/workspaces/{id}/materials", true, nil)
		},
		func() {
			_ = u.get(ctx, "/api/workspaces/"+sp.id+"/chapters", "/api/workspaces/{id}/chapters", true, nil)
		},
		func() {
			_ = u.call(ctx, http.MethodPost, "/api/materials/"+created.ID+"/collaboration-token",
				"/api/materials/{id}/collaboration-token", nil, nil, http.StatusCreated)
		},
		func() {
			_ = u.get(ctx, "/api/materials/"+created.ID+"/discussions", "/api/materials/{id}/discussions", false, nil)
		},
	)
	u.think(ctx, 120*time.Second)
}

func (u *user) rename(ctx context.Context, sp *space) {
	id := pick(u, sp.notes)
	if id == "" {
		return
	}
	if u.call(ctx, http.MethodPatch, "/api/materials/"+id+"/metadata", "/api/materials/{id}/metadata",
		map[string]string{"title": "Week notes " + randomID()[:8]}, nil) == nil {
		_ = u.get(ctx, "/api/workspaces/"+sp.id+"/materials", "/api/workspaces/{id}/materials", true, nil)
	}
	u.think(ctx, 15*time.Second)
}

func (u *user) notifications(ctx context.Context) {
	_ = u.get(ctx, "/api/notifications?limit=30", "/api/notifications", true, nil)
	u.think(ctx, 8*time.Second)
	if u.call(ctx, http.MethodPost, "/api/notifications/read", "/api/notifications/read", nil, nil, http.StatusNoContent) == nil {
		_ = u.get(ctx, "/api/notifications/unread-count", "/api/notifications/unread-count", true, nil)
	}
	u.think(ctx, 10*time.Second)
}

// idle is a tab left open on a workspace: after the page's loads it costs
// only its stream's keep-alive and access recheck.
func (u *user) idle(ctx context.Context) {
	u.tab.fetched = map[string]time.Time{}
	u.tab.pdfs = map[string][]string{}
	if u.call(ctx, http.MethodGet, "/api/me", "/api/me", nil, nil) != nil {
		return
	}
	u.dashboard(ctx)
	u.tab.mu.Lock()
	ws := pick(u, u.tab.spaces)
	u.tab.mu.Unlock()
	if ws != "" {
		u.openWorkspace(ctx, ws)
	}
	<-ctx.Done()
	u.tab.mu.Lock()
	if u.tab.stopStream != nil {
		u.tab.stopStream()
	}
	u.tab.mu.Unlock()
}

// session is the tab's life: sign-in lands on the dashboard, then the user
// works inside workspaces, now and then refocusing the window (GET /me).
func (u *user) session(ctx context.Context) {
	u.tab.fetched = map[string]time.Time{}
	u.tab.pdfs = map[string][]string{}
	defer func() {
		u.tab.mu.Lock()
		if u.tab.stopStream != nil {
			u.tab.stopStream()
		}
		u.tab.mu.Unlock()
	}()
	if u.call(ctx, http.MethodGet, "/api/me", "/api/me", nil, nil) != nil {
		return
	}
	u.dashboard(ctx)
	u.think(ctx, 10*time.Second)
	for ctx.Err() == nil {
		u.tab.mu.Lock()
		spaces := append([]string(nil), u.tab.spaces...)
		u.tab.mu.Unlock()
		ws := pick(u, spaces)
		if ws == "" {
			u.think(ctx, 30*time.Second)
			u.dashboard(ctx)
			continue
		}
		sp := u.openWorkspace(ctx, ws)
		u.think(ctx, 5*time.Second)
		// A stretch of work in this workspace before going back to the dashboard.
		for range 4 + u.rng.IntN(8) {
			if ctx.Err() != nil {
				return
			}
			if u.rng.IntN(10) < 3 {
				_ = u.call(ctx, http.MethodGet, "/api/me", "/api/me", nil, nil)
			}
			switch n := u.rng.IntN(100); {
			case n < 30:
				u.openNote(ctx, sp)
			case n < 43:
				u.takeQuiz(ctx, sp)
			case n < 56:
				u.studyCards(ctx, sp)
			case n < 64:
				u.learning(ctx, sp)
			case n < 70:
				u.studyTab(ctx, sp)
			case n < 75:
				u.createNote(ctx, sp)
			case n < 80:
				u.rename(ctx, sp)
			case n < 87:
				u.notifications(ctx)
			case n < 95:
				u.openFile(ctx, sp)
			default:
				u.filesPage(ctx, sp)
			}
		}
		u.dashboard(ctx)
		u.think(ctx, 15*time.Second)
	}
}

// randomID is a version 4 UUID, as the browser's crypto.randomUUID makes.
func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

type quizBody struct {
	Questions []struct {
		ID    string `json:"id"`
		Parts []struct {
			ID     string `json:"id"`
			Answer struct {
				Type string `json:"type"`
			} `json:"answer"`
		} `json:"parts"`
	} `json:"questions"`
}

// answers gives every true/false part an answer; the setup's quizzes have no
// other kind.
func (q quizBody) answers(u *user) map[string]any {
	out := map[string]any{}
	for _, question := range q.Questions {
		for _, part := range question.Parts {
			out[part.ID] = u.rng.IntN(2) == 0
		}
	}
	return out
}

// provision is a user's first sign-in, which creates the account and its
// starter workspace through the Clerk path, then a second workspace and some
// notes, a quiz and a flashcard set in each, and one attempt per quiz so the
// study lists have history.
func (u *user) provision(ctx context.Context) error {
	if err := u.call(ctx, http.MethodGet, "/api/me", "/api/me", nil, nil); err != nil {
		return err
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := u.call(ctx, http.MethodPost, "/api/workspaces", "/api/workspaces",
		map[string]string{"name": "Biology"}, &created, http.StatusCreated); err != nil {
		return err
	}
	var list []struct {
		ID string `json:"id"`
	}
	if err := u.call(ctx, http.MethodGet, "/api/workspaces?sort=accessed", "/api/workspaces", nil, &list); err != nil {
		return err
	}
	for _, w := range list {
		path := "/api/workspaces/" + w.ID + "/materials"
		bodies := []any{noteBody("Cell structure"), noteBody("Photosynthesis"), noteBody("Genetics"), quizMaterial(), deckMaterial("Cell terms")}
		for _, body := range bodies {
			if err := u.call(ctx, http.MethodPost, path, "/api/workspaces/{id}/materials", body, nil, http.StatusCreated); err != nil {
				return err
			}
		}
		var items []material
		if err := u.call(ctx, http.MethodGet, path, "/api/workspaces/{id}/materials", nil, &items); err != nil {
			return err
		}
		for _, m := range items {
			if m.Kind != "quiz" {
				continue
			}
			var quiz quizBody
			if err := u.call(ctx, http.MethodGet, "/api/quizzes/"+m.ID, "/api/quizzes/{id}", nil, &quiz); err != nil {
				return err
			}
			if err := u.call(ctx, http.MethodPost, "/api/quizzes/"+m.ID+"/attempts", "/api/quizzes/{id}/attempts",
				map[string]any{"answers": quiz.answers(u)}, nil, http.StatusCreated); err != nil {
				return err
			}
		}
	}
	return nil
}

const lorem = "Cells are the basic unit of life. Each one keeps its contents apart from its surroundings with a membrane, " +
	"reads its genes to build proteins, and uses energy to keep itself in order. "

func noteBody(title string) map[string]any {
	paragraphs := []any{map[string]any{"type": "h1", "id": "title", "children": []any{map[string]string{"text": title}}}}
	for i := range 8 {
		paragraphs = append(paragraphs, map[string]any{
			"type": "p", "id": fmt.Sprintf("p%d", i), "children": []any{map[string]string{"text": strings.Repeat(lorem, 2)}},
		})
	}
	return map[string]any{"kind": "note", "title": title, "content": map[string]any{"schemaVersion": 1, "value": paragraphs}}
}

func quizMaterial() map[string]any {
	var questions []any
	for i := 1; i <= 6; i++ {
		id := fmt.Sprintf("q%d", i)
		questions = append(questions, map[string]any{
			"type": "quiz_question", "id": id, "children": []any{map[string]string{"text": ""}},
			"question": map[string]any{
				"id": id, "stem": []any{}, "layout": "paper", "labels": "letters",
				"parts": []any{map[string]any{
					"id": id + ":part:1", "marks": 1, "solution": []any{},
					"blocks": []any{map[string]string{"type": "text", "text": fmt.Sprintf("Statement %d holds?", i)}},
					"answer": map[string]any{"type": "boolean", "correct": i%2 == 0},
				}},
			},
		})
	}
	return map[string]any{"kind": "quiz", "title": "Cells quiz", "content": map[string]any{
		"schemaVersion": 1, "value": []any{map[string]any{"type": "quiz", "id": "quiz", "children": questions}},
	}}
}

func deckMaterial(title string) map[string]any {
	var cards []any
	for i := 1; i <= 12; i++ {
		cards = append(cards, map[string]any{
			"type": "flashcard", "id": fmt.Sprintf("c%d", i), "children": []any{
				map[string]any{"type": "flashcard_front", "children": []any{map[string]string{"text": fmt.Sprintf("Term %d", i)}}},
				map[string]any{"type": "flashcard_back", "children": []any{map[string]string{"text": "Its definition, in a sentence or two."}}},
			},
		})
	}
	return map[string]any{"kind": "flashcards", "title": title, "content": map[string]any{
		"schemaVersion": 1, "value": []any{map[string]any{"type": "flashcards", "id": "deck", "children": cards}},
	}}
}
