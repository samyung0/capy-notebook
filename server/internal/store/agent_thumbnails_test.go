package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// One finished turn names each Office file it committed edits to once, with
// what the collaboration server checks for page 1: XLSX sheets of set_cell
// commands inside A1:H25 only, PPTX stories, nothing for DOCX. An edit whose
// inverse was released since (Undo, rebase, compaction) names its file as
// unknown, and the turn's other files still count. A file captured within
// the interval is named with the time the interval passes. A refused edit
// commits nothing, so it names nothing; neither do an XLSX file without a
// cell in the area, a PPTX file without a story, text files, other turns'
// edits or a file trashed since. An Undo of one edit names that edit's
// targets.
func TestTurnThumbnailsNameEachEditedOfficeFileOnce(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "thumb_owner")
	turn, other := uid("msg"), uid("msg")
	file := func(name, kind string) string {
		_, f := sourceTestFile(t, s, owner, name, kind)
		return f.ID
	}
	edit := func(fileID, message, inverse, guards string) (string, error) {
		t.Helper()
		doc, err := s.SourceSession(ctx, owner, fileID)
		if err != nil {
			t.Fatal(err)
		}
		op := uid("op")
		save := sourceTestSave(doc, owner, "state-"+uid("s"))
		save.Operation = &SourceCheckpointOperation{
			Receipt: SourceCheckpointReceipt{ID: op, ToolVersion: 1, RequestHash: "h", ActorUserID: owner, MessageID: message},
			Inverse: json.RawMessage(inverse), Guards: json.RawMessage(guards),
		}
		_, err = s.SaveSourceCheckpoint(ctx, fileID, save)
		return op, err
	}
	mustEdit := func(fileID, message, inverse, guards string) string {
		t.Helper()
		op, err := edit(fileID, message, inverse, guards)
		if err != nil {
			t.Fatal(err)
		}
		return op
	}
	paragraph := `{"commands":[{"type":"replace_text","targetId":"p1","expectedText":"b","text":"a"}]}`
	story := func(id string) string {
		return `[{"kind":"office","id":"p","path":["pptx:stories","` + id + `"],"range":[0,1],"runs":[]}]`
	}
	cells := func(cells ...string) string {
		out := `{"commands":[`
		for i := 0; i < len(cells); i += 2 {
			if i > 0 {
				out += ","
			}
			out += `{"type":"set_cell","sheet":"` + cells[i] + `","cell":"` + cells[i+1] + `","expectedValue":"","value":"1"}`
		}
		return out + "]}"
	}

	plan := file("plan.docx", "doc")
	mustEdit(plan, turn, paragraph, `[]`)
	mustEdit(plan, turn, paragraph, `[]`)
	grades := file("grades.xlsx", "xlsx")
	gradesEdit := mustEdit(grades, turn, cells("s1", "B3", "s1", "I3", "s2", "A26"), `[]`)
	mustEdit(grades, turn, cells("s3", "H25", "s1", "A1"), `[]`)
	far := file("far.xlsx", "xlsx")
	farEdit := mustEdit(far, turn, cells("s1", "I1", "s1", "A26", "s1", "AA1"), `[]`)
	deck := file("deck.pptx", "pptx")
	deckEdit := mustEdit(deck, turn, paragraph, story("story:a"))
	mustEdit(deck, turn, paragraph, story("story:b"))
	mustEdit(deck, turn, paragraph, story("story:a"))
	bare := file("bare.pptx", "pptx")
	mustEdit(bare, turn, paragraph, `[]`)
	notes := file("notes.txt", "txt")
	mustEdit(notes, turn, `{"commands":[]}`, `[]`)
	elsewhere := file("elsewhere.docx", "doc")
	mustEdit(elsewhere, other, paragraph, `[]`)
	recent := file("recent.docx", "doc")
	mustEdit(recent, turn, paragraph, `[]`)
	if err := s.ClaimThumbnailCapture(ctx, recent); err != nil {
		t.Fatal(err)
	}
	// Released since: an undone XLSX edit and a PPTX edit a rebase let go.
	undone := file("undone.xlsx", "xlsx")
	mustEdit(undone, turn, cells("s1", "Z99"), `[]`)
	if _, err := s.pool.Exec(ctx, `UPDATE agent_edit_inverses SET undo_status='undone', inverse='[]', guards='[]'
		WHERE resource_id=$1`, undone); err != nil {
		t.Fatal(err)
	}
	rebased := file("rebased.pptx", "pptx")
	mustEdit(rebased, turn, paragraph, story("story:z"))
	if err := s.InvalidateEditInverses(ctx, agenttools.KindSourceFile, rebased, "rebased"); err != nil {
		t.Fatal(err)
	}
	trashed := file("trashed.docx", "doc")
	mustEdit(trashed, turn, paragraph, `[]`)
	if _, err := s.TrashFile(ctx, owner, trashed, AgentOperation{ID: uid("req"), RequestHash: "h"}); err != nil {
		t.Fatal(err)
	}
	// The authority refuses this one (its checkpoint moved): nothing commits.
	refused := file("refused.pptx", "pptx")
	doc, err := s.SourceSession(ctx, owner, refused)
	if err != nil {
		t.Fatal(err)
	}
	stale := sourceTestSave(doc, owner, "state")
	stale.ExpectedCheckpoint++
	stale.Operation = &SourceCheckpointOperation{
		Receipt: SourceCheckpointReceipt{ID: uid("op"), ToolVersion: 1, RequestHash: "h", ActorUserID: owner, MessageID: turn},
		Inverse: json.RawMessage(paragraph), Guards: json.RawMessage(story("story:a")),
	}
	if _, err := s.SaveSourceCheckpoint(ctx, refused, stale); !errors.Is(err, ErrCheckpointMoved) {
		t.Fatalf("stale edit: %v", err)
	}

	read := time.Now()
	got, err := s.TurnThumbnails(ctx, turn)
	if err != nil {
		t.Fatal(err)
	}
	for i, f := range got {
		// Only the file captured just now waits, about the interval.
		if wait := f.Ready.Sub(read); (f.FileID == recent) != (wait > ThumbnailCaptureInterval/2) || wait > ThumbnailCaptureInterval {
			t.Fatalf("%s is ready in %v", f.FileID, wait)
		}
		got[i].Ready = time.Time{}
	}
	released := "the edit's inverse was released "
	want := []AgentThumbnail{
		{FileID: plan, Format: "docx", Sheets: []string{}, Stories: []string{}},
		{FileID: grades, Format: "xlsx", Sheets: []string{"s1", "s3"}, Stories: []string{}},
		{FileID: deck, Format: "pptx", Sheets: []string{}, Stories: []string{"story:a", "story:b"}},
		{FileID: recent, Format: "docx", Sheets: []string{}, Stories: []string{}},
		{FileID: undone, Format: "xlsx", Sheets: []string{}, Stories: []string{}, Unknown: true, Why: released + "(undone)"},
		{FileID: rebased, Format: "pptx", Sheets: []string{}, Stories: []string{}, Unknown: true, Why: released + "(unavailable)"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("turn thumbnails\n got %+v\nwant %+v", got, want)
	}

	// An Undo names the undone edit's own targets, read before it releases
	// them; one outside page 1 names nothing.
	for _, c := range []struct {
		op   string
		want []AgentThumbnail
	}{
		{gradesEdit, []AgentThumbnail{{FileID: grades, Format: "xlsx", Sheets: []string{"s1"}, Stories: []string{}}}},
		{deckEdit, []AgentThumbnail{{FileID: deck, Format: "pptx", Sheets: []string{}, Stories: []string{"story:a"}}}},
		{farEdit, nil},
	} {
		inv, _, err := s.GetEditInverse(ctx, c.op)
		if err != nil {
			t.Fatal(err)
		}
		got, err := s.UndoThumbnails(ctx, inv)
		for i := range got {
			got[i].Ready = time.Time{}
		}
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Fatalf("undo of %s: %+v %v, want %+v", c.op, got, err, c.want)
		}
	}
	if got, err := s.TurnThumbnails(ctx, uid("msg")); err != nil || len(got) != 0 {
		t.Fatalf("a turn without edits: %+v %v", got, err)
	}
}

func TestThumbnailAreaIsA1ToH25(t *testing.T) {
	for cell, want := range map[string]bool{
		"A1": true, "H25": true, "b3": true, "I1": false, "A26": false, "H0": false,
		"AA1": false, "A": false, "": false, "A1B": false,
	} {
		if got := inThumbnailArea(cell); got != want {
			t.Errorf("inThumbnailArea(%q) = %v", cell, got)
		}
	}
}

// A text save writes the file's list-card text with the checkpoint (an
// unchanged one writes nothing, so it raises no tree event); a save without
// one leaves it, and an Office save or a preview no card would take is
// refused.
func TestTextSavesWriteTheFilePreview(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "preview_owner")
	_, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	doc := sourceTestSeed(t, s, owner, file.ID)
	save := func(preview *string) error {
		in := sourceTestSave(doc, owner, "state-"+uid("s"))
		in.Preview = preview
		if _, err := s.SaveSourceCheckpoint(ctx, file.ID, in); err != nil {
			return err
		}
		var err error
		doc, err = s.SourceSession(ctx, owner, file.ID)
		return err
	}
	read := func() (preview *string, version int64) {
		t.Helper()
		if err := s.pool.QueryRow(ctx, `SELECT preview->>'text', xmin::text::bigint FROM files WHERE id=$1`, file.ID).Scan(&preview, &version); err != nil {
			t.Fatal(err)
		}
		return preview, version
	}
	text := func(s string) *string { return &s }

	if err := save(text("hello\nworld")); err != nil {
		t.Fatal(err)
	}
	preview, version := read()
	if preview == nil || *preview != "hello\nworld" {
		t.Fatalf("preview = %v", preview)
	}
	if err := save(text("hello\nworld")); err != nil {
		t.Fatal(err)
	}
	if _, again := read(); again != version {
		t.Fatalf("an unchanged preview rewrote the file row (%d -> %d)", version, again)
	}
	if err := save(nil); err != nil {
		t.Fatal(err)
	}
	if err := save(text("héllo 😀")); err != nil {
		t.Fatal(err)
	}
	if preview, _ := read(); preview == nil || *preview != "héllo 😀" {
		t.Fatalf("preview = %v", preview)
	}
	for _, bad := range []string{strings.Repeat("é", 601), "nul\x00", "\xff"} {
		if err := save(&bad); !errors.Is(err, ErrInvalidCheckpoint) {
			t.Fatalf("preview %q saved: %v", bad[:min(len(bad), 8)], err)
		}
	}
	if preview, _ := read(); *preview != "héllo 😀" {
		t.Fatalf("a refused save changed the preview to %q", *preview)
	}

	_, office := sourceTestFile(t, s, owner, "plan.docx", "doc")
	officeDoc := sourceTestSeed(t, s, owner, office.ID)
	in := sourceTestSave(officeDoc, owner, "state")
	in.Preview = text("text")
	if _, err := s.SaveSourceCheckpoint(ctx, office.ID, in); !errors.Is(err, ErrInvalidCheckpoint) {
		t.Fatalf("an Office save took a preview: %v", err)
	}
}
