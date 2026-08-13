package main

import (
	"context"
	"log"
	"time"

	"github.com/evonotes/server/internal/blob"
	"github.com/evonotes/server/internal/store"
)

// Bucket objects are only ever deleted here. Refcount triggers in the schema move
// unreferenced paths into pending_blob_deletions — including through the FK
// cascades of a workspace delete or an account purge, where no handler runs — and
// the reaper drains that queue.

const (
	// blobReapBatch matches the S3 DeleteObjects limit, so one claimed batch is
	// one round trip to the bucket.
	blobReapBatch = blob.DeleteObjectsLimit
	// blobReapInterval is short because the queue is normally empty; a run that
	// finds nothing is a single indexed query.
	blobReapInterval = time.Minute
)

// runBlobReaper drains the deletion outbox until the ticker stops.
func runBlobReaper(ctx context.Context, st *store.Store, bs blob.Store) {
	reapBlobs(ctx, st, bs)
	ticker := time.NewTicker(blobReapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			reapBlobs(ctx, st, bs)
		case <-ctx.Done():
			return
		}
	}
}

// reapBlobs deletes every due batch, stopping at the first short or failed one.
func reapBlobs(ctx context.Context, st *store.Store, bs blob.Store) {
	for {
		paths, err := st.ClaimBlobDeletions(ctx, blobReapBatch)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("claim blob deletions: %v", err)
			}
			return
		}
		if len(paths) == 0 {
			return
		}
		failed, err := bs.DeleteObjects(ctx, paths)
		if err != nil {
			// The whole request failed, so nothing was deleted. The claim already
			// advanced the backoff, so these come back around on a later run.
			if ctx.Err() == nil {
				log.Printf("delete blobs: %v", err)
			}
			_ = st.FailBlobDeletions(ctx, paths, err.Error())
			return
		}
		deleted := paths
		if len(failed) > 0 {
			// Only the keys the bucket rejected stay queued. Distinguishing them
			// from a whole-request failure is what stops one bad key wedging the
			// queue behind it.
			rejected := make(map[string]bool, len(failed))
			for _, key := range failed {
				rejected[key] = true
			}
			deleted = make([]string, 0, len(paths)-len(failed))
			for _, key := range paths {
				if !rejected[key] {
					deleted = append(deleted, key)
				}
			}
			_ = st.FailBlobDeletions(ctx, failed, "bucket rejected the key")
			log.Printf("reaper: bucket rejected %d key(s)", len(failed))
		}
		if err := st.FinishBlobDeletions(ctx, deleted); err != nil {
			if ctx.Err() == nil {
				log.Printf("finish blob deletions: %v", err)
			}
			return
		}
		if len(deleted) > 0 {
			log.Printf("reaped %d blob(s)", len(deleted))
		}
		// A short batch means the queue is drained for now.
		if len(paths) < blobReapBatch {
			return
		}
	}
}

// The reaper covers every object the database ever knew about. The sweep below is
// the backstop for the ones it never did: a request that dies between the
// browser's PUT and the row insert leaves an object with no reference for a
// trigger to lose.
//
// It is report-only on purpose. Deleting from a listing means trusting that the
// database view is complete at the instant of the scan, and a bug there is
// unrecoverable. A logged count is enough to show whether the trigger layer is
// holding; deletion can be turned on once it has been quiet for a few months.
const (
	// blobSweepInterval is monthly: this is a full bucket listing whose only
	// output is a number.
	blobSweepInterval = 30 * 24 * time.Hour
	// blobSweepPageSize is the page the database check is sized for — one
	// `object_path = ANY($1)` per page.
	blobSweepPageSize = 1000
	// blobSweepMinAge skips recent keys. An object written seconds ago may
	// legitimately have no row yet, since the PUT completes before the finalize
	// call, and reporting those would drown the real signal.
	blobSweepMinAge = 48 * time.Hour
	// blobSweepMaxPages bounds one run so a pathologically large bucket cannot
	// hold a connection indefinitely.
	blobSweepMaxPages = 1000
)

// sweptPrefixes are the prefixes worth scanning. incoming/ is deliberately
// excluded: a bucket lifecycle rule expires it after a day, so every key there is
// either in flight or about to disappear on its own.
var sweptPrefixes = []string{"sources/", "parsed/", "captions/", "editor-assets/"}

// runBlobSweep reports unreferenced objects on a long interval.
func runBlobSweep(ctx context.Context, st *store.Store, bs blob.Store) {
	sweep := func() {
		orphans, err := sweepOrphanedObjects(ctx, st, bs)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("blob sweep: %v", err)
			}
			return
		}
		stuck, err := st.BlobDeletionBacklog(ctx)
		if err != nil && ctx.Err() == nil {
			log.Printf("blob sweep: read deletion backlog: %v", err)
		}
		log.Printf("blob sweep: %d unreferenced object(s), %d undeletable queue entry(ies)",
			orphans, stuck)
	}
	sweep()
	ticker := time.NewTicker(blobSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			sweep()
		case <-ctx.Done():
			return
		}
	}
}

func sweepOrphanedObjects(ctx context.Context, st *store.Store, bs blob.Store) (int, error) {
	cutoff := time.Now().UTC().Add(-blobSweepMinAge)
	orphans := 0
	for _, prefix := range sweptPrefixes {
		token := ""
		for page := 0; page < blobSweepMaxPages; page++ {
			listing, err := bs.ListObjects(ctx, prefix, token, blobSweepPageSize)
			if err != nil {
				return orphans, err
			}
			found, err := reportOrphans(ctx, st, listing.Keys, cutoff)
			if err != nil {
				return orphans, err
			}
			orphans += found
			token = listing.NextToken
			if token == "" {
				break
			}
		}
	}
	return orphans, nil
}

func reportOrphans(
	ctx context.Context,
	st *store.Store,
	keys []blob.ListedObject,
	cutoff time.Time,
) (int, error) {
	candidates := make([]string, 0, len(keys))
	for _, obj := range keys {
		if obj.LastModified.After(cutoff) {
			continue
		}
		candidates = append(candidates, obj.Key)
	}
	if len(candidates) == 0 {
		return 0, nil
	}
	known, err := st.KnownObjectPaths(ctx, candidates)
	if err != nil {
		return 0, err
	}
	orphans := 0
	for _, key := range candidates {
		if known[key] {
			continue
		}
		orphans++
		// Logged individually so a systematic key-shape bug is diagnosable from
		// the output instead of just a count.
		log.Printf("blob sweep: %s has no database reference", key)
	}
	return orphans, nil
}
