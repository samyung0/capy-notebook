package store

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// countCloneRetries returns the serialization failures clone transactions ran
// again after while fn runs.
func countCloneRetries(t *testing.T, fn func()) []string {
	t.Helper()
	var mu sync.Mutex
	var retried []string
	previous := cloneRetried
	cloneRetried = func(err error) {
		mu.Lock()
		retried = append(retried, err.Error())
		mu.Unlock()
	}
	defer func() { cloneRetried = previous }()
	fn()
	return retried
}

// inParallel runs n clones at once and fails the test on any error.
func inParallel(t *testing.T, name string, n int, clone func(i int) error) {
	t.Helper()
	retried := countCloneRetries(t, func() {
		var wg sync.WaitGroup
		errs := make(chan error, n)
		for i := range n {
			wg.Add(1)
			go func() {
				defer wg.Done()
				errs <- clone(i)
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Errorf("%s: %v", name, err)
			}
		}
	})
	if len(retried) != 0 {
		t.Errorf("%s: %d clone transactions ran again: %v", name, len(retried), retried)
	}
}

func publicCloneSource(t *testing.T, s *Store, ownerID, name string) Workspace {
	t.Helper()
	ctx := context.Background()
	source, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: name})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public', share_role='editor' WHERE id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	return source
}

func readyCloneFile(t *testing.T, s *Store, ownerID, workspaceID, name string) (File, string) {
	t.Helper()
	path := "sources/" + uid("blob")
	file, err := s.createReadyFile(context.Background(), workspaceID, ownerID, name, "pdf", nil, "", 100, path)
	if err != nil {
		t.Fatal(err)
	}
	return file, path
}

// Clones of one source, and clones one account pays for, queue on their
// fences: none of them runs its transaction twice, and each is counted once,
// while the source's owner keeps reserving and releasing upload bytes.
func TestParallelClonesQueueInsteadOfColliding(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	const n = 8
	ownerID := newBlobTestUser(t, s, "u_queue_owner")
	source := publicCloneSource(t, s, ownerID, "Queue source")
	file, filePath := readyCloneFile(t, s, ownerID, source.ID, "deck.pdf")
	readyCloneFile(t, s, ownerID, source.ID, "notes.pdf")
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: source.ID, Kind: "note", Title: "Queue note", Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	cloners := make([]string, n)
	targets := make([]Workspace, n)
	for i := range n {
		cloners[i] = newBlobTestUser(t, s, "u_queue_cloner")
		if targets[i], err = s.CreateWorkspace(ctx, cloners[i], WorkspaceCreate{Name: "Queue target"}); err != nil {
			t.Fatal(err)
		}
	}

	// The source owner uploads into the source throughout.
	stop := make(chan struct{})
	writer := make(chan error, 1)
	go func() {
		for {
			select {
			case <-stop:
				writer <- nil
				return
			default:
			}
			upload, err := s.CreateUploadSession(ctx, NewUploadSession{
				ID: uid("up"), WorkspaceID: source.ID, CreatedBy: ownerID,
				ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
				Name: "busy.pdf", Kind: "pdf", ContentType: "application/pdf",
				DeclaredSize: 10, ParseMode: "none", ExpiresAt: time.Now().UTC().Add(time.Hour),
			})
			if err == nil {
				err = s.MarkUploadExpired(ctx, upload.ID)
			}
			if err != nil {
				writer <- err
				return
			}
		}
	}()

	// One account copies one workspace eight times at once.
	inParallel(t, "workspace clones of one source", n, func(i int) error {
		_, err := s.CloneWorkspace(ctx, cloners[0], source.ID, WorkspaceCreate{Name: fmt.Sprintf("Clone %d", i)})
		return err
	})
	// Eight accounts copy one file at once (its blob is referenced eight times).
	inParallel(t, "file clones of one file", n, func(i int) error {
		_, _, err := s.CloneFile(ctx, cloners[i], file.ID, CloneTarget{WorkspaceID: targets[i].ID, Name: "deck copy.pdf"})
		return err
	})
	// Eight accounts copy one note at once.
	inParallel(t, "material clones of one note", n, func(i int) error {
		_, err := s.CloneMaterial(ctx, cloners[i], note.ID, CloneTarget{WorkspaceID: targets[i].ID, Name: "Note copy"})
		return err
	})
	// One account copies eight sources at once: one storage counter pays.
	sources := make([]Workspace, n)
	for i := range n {
		sources[i] = publicCloneSource(t, s, ownerID, fmt.Sprintf("Source %d", i))
		readyCloneFile(t, s, ownerID, sources[i].ID, "deck.pdf")
	}
	inParallel(t, "workspace clones paid by one account", n, func(i int) error {
		_, err := s.CloneWorkspace(ctx, cloners[1], sources[i].ID, WorkspaceCreate{Name: fmt.Sprintf("Copy %d", i)})
		return err
	})

	close(stop)
	if err := <-writer; err != nil {
		t.Fatalf("source owner's uploads: %v", err)
	}

	for table, id := range map[string]string{"workspace": source.ID, "material": note.ID} {
		var count int
		if err := s.pool.QueryRow(ctx, `SELECT clone_count FROM `+table+`_clone_counts WHERE `+table+`_id=$1`, id).
			Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != n {
			t.Errorf("%s clone_count = %d, want %d", table, count, n)
		}
	}
	if got := blobRefCount(t, s, filePath); got != 1+2*n {
		t.Errorf("file blob refs = %d, want %d (source, %d workspace and %d file copies)", got, 1+2*n, n, n)
	}
}

// The clone counter is bumped after the copy commits, so a bump landing while
// the copy runs cannot fail it.
func TestCloneCounterCannotFailTheCopy(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ownerID := newBlobTestUser(t, s, "u_counter_owner")
	clonerID := newBlobTestUser(t, s, "u_counter_cloner")
	source := publicCloneSource(t, s, ownerID, "Counter source")
	readyCloneFile(t, s, ownerID, source.ID, "deck.pdf")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_clone_counts (workspace_id, clone_count) VALUES ($1, 1)`,
		source.ID); err != nil {
		t.Fatal(err)
	}

	reached := make(chan struct{})
	proceed := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		_, _, err := s.cloneWorkspaceOnce(ctx, pausingCloneStarter{
			starter: s.pool, reached: reached, proceed: proceed, pauseOn: "FROM blobs",
		}, clonerID, source.ID, WorkspaceCreate{Name: "Clone"})
		result <- err
	}()
	<-reached
	if _, err := s.pool.Exec(ctx, `UPDATE workspace_clone_counts SET clone_count=clone_count+1
		WHERE workspace_id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	close(proceed)
	if err := <-result; err != nil {
		t.Fatalf("clone with a concurrent counter bump: %v", err)
	}
}
