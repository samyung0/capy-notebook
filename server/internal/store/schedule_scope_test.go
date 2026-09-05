package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Schedule rows carry no share model, so the owner id in the WHERE clause is
// the only thing standing between a caller and someone else's calendar. These
// mutations were previously keyed on the row id alone.
func TestScheduleMutationsAreScopedToTheOwner(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := uid("schedule-owner")
	intruder := uid("schedule-intruder")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1,$2,$3),($4,$5,$6)`,
		owner, "Schedule Owner", owner+"@example.test",
		intruder, "Schedule Intruder", intruder+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM users WHERE id IN ($1,$2)`, owner, intruder)
	})

	labelID := uid("lb")
	if _, err := s.pool.Exec(ctx, `INSERT INTO labels (id, user_id, name, color)
		VALUES ($1,$2,'Biology','green')`, labelID, owner); err != nil {
		t.Fatal(err)
	}
	taskID := uid("tk")
	if _, err := s.pool.Exec(ctx, `INSERT INTO tasks (id, user_id, title, done, due_date)
		VALUES ($1,$2,'Read chapter 3',false,now())`, taskID, owner); err != nil {
		t.Fatal(err)
	}
	eventID := uid("ev")
	if _, err := s.pool.Exec(ctx, `INSERT INTO events (id, user_id, title, start_at, end_at)
		VALUES ($1,$2,'Lab',now(),now()+interval '1 hour')`, eventID, owner); err != nil {
		t.Fatal(err)
	}

	renamed := "Chemistry"
	if _, err := s.UpdateLabel(ctx, intruder, labelID, LabelPatch{Name: &renamed}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder renamed a label: %v", err)
	}
	if _, err := s.UpdateTask(ctx, intruder, taskID, TaskPatch{Title: &renamed}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder renamed a task: %v", err)
	}
	if _, err := s.UpdateEvent(ctx, intruder, eventID, EventPatch{Title: &renamed}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder renamed an event: %v", err)
	}
	if err := s.DeleteLabel(ctx, intruder, labelID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteTask(ctx, intruder, taskID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteEvent(ctx, intruder, eventID); err != nil {
		t.Fatal(err)
	}

	labels, err := s.ListLabels(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(labels) != 1 || labels[0].Name != "Biology" {
		t.Fatalf("owner label was modified by a stranger: %#v", labels)
	}
	tasks, err := s.ListTasks(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].Title != "Read chapter 3" {
		t.Fatalf("owner task was modified by a stranger: %#v", tasks)
	}
	events, err := s.ListEvents(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Title != "Lab" {
		t.Fatalf("owner event was modified by a stranger: %#v", events)
	}
}

func TestOwnerEditsAndDeletesScheduleRows(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := uid("schedule-editor")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1,$2,$3)`, owner, "Schedule Editor", owner+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, owner)
	})

	labelID := uid("lb")
	if _, err := s.pool.Exec(ctx, `INSERT INTO labels (id, user_id, name, color)
		VALUES ($1,$2,'Biology','green')`, labelID, owner); err != nil {
		t.Fatal(err)
	}
	name := "Molecular Biology"
	color := ColorPurple
	label, err := s.UpdateLabel(ctx, owner, labelID, LabelPatch{Name: &name, Color: &color})
	if err != nil {
		t.Fatal(err)
	}
	if label.Name != name || label.Color != color {
		t.Fatalf("label patch not applied: %#v", label)
	}

	// A label the calendar still references must disappear from its events too.
	eventID := uid("ev")
	if _, err := s.pool.Exec(ctx, `INSERT INTO events (id, user_id, title, start_at, end_at)
		VALUES ($1,$2,'Lab',now(),now()+interval '1 hour')`, eventID, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateEvent(ctx, owner, eventID, EventPatch{LabelIDs: &[]string{labelID}}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteLabel(ctx, owner, labelID); err != nil {
		t.Fatal(err)
	}
	events, err := s.ListEvents(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || len(events[0].LabelIDs) != 0 {
		t.Fatalf("deleted label still linked to its event: %#v", events)
	}

	taskID := uid("tk")
	if _, err := s.pool.Exec(ctx, `INSERT INTO tasks (id, user_id, title, done, due_date)
		VALUES ($1,$2,'Read chapter 3',false,$3)`, taskID, owner, time.Now()); err != nil {
		t.Fatal(err)
	}
	done := true
	task, err := s.UpdateTask(ctx, owner, taskID, TaskPatch{Done: &done})
	if err != nil {
		t.Fatal(err)
	}
	if !task.Done {
		t.Fatalf("task patch not applied: %#v", task)
	}
	if err := s.DeleteTask(ctx, owner, taskID); err != nil {
		t.Fatal(err)
	}
	tasks, err := s.ListTasks(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 0 {
		t.Fatalf("task survived its own delete: %#v", tasks)
	}
}

func TestScheduleMutationsRecheckAccountLifecycle(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "schedule-locked")
	labelID := uid("lb")
	taskID := uid("tk")
	eventID := uid("ev")
	if _, err := s.pool.Exec(ctx, `INSERT INTO labels (id, user_id, name, color)
		VALUES ($1,$2,'Biology','green')`, labelID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO tasks (id, user_id, title, done, due_date)
		VALUES ($1,$2,'Read',false,now())`, taskID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO events (id, user_id, title, start_at, end_at)
		VALUES ($1,$2,'Lab',now(),now()+interval '1 hour')`, eventID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='test suspension' WHERE id=$1`,
		userID); err != nil {
		t.Fatal(err)
	}
	name := "Blocked"
	assertLocked := func(err error) {
		t.Helper()
		var locked *AccountLockedError
		if !errors.As(err, &locked) || locked.State != AccountSuspended {
			t.Fatalf("mutation error = %v, want suspended account", err)
		}
	}
	_, err := s.UpdateLabel(ctx, userID, labelID, LabelPatch{Name: &name})
	assertLocked(err)
	_, err = s.UpdateTask(ctx, userID, taskID, TaskPatch{Title: &name})
	assertLocked(err)
	_, err = s.UpdateEvent(ctx, userID, eventID, EventPatch{Title: &name})
	assertLocked(err)
	assertLocked(s.DeleteLabel(ctx, userID, labelID))
	assertLocked(s.DeleteTask(ctx, userID, taskID))
	assertLocked(s.DeleteEvent(ctx, userID, eventID))
	_, err = s.CreateEvent(ctx, userID, Event{
		Title: "Blocked", Start: time.Now(), End: time.Now().Add(time.Hour),
	})
	assertLocked(err)
}
