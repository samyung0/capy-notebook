// Package blob stores uploaded source bytes in Backblaze B2.
package blob

import (
	"context"
	"io"
	"time"
)

type ObjectInfo struct {
	Size        int64
	ContentType string
	ETag        string
}

type PresignedPut struct {
	URL       string
	Headers   map[string]string
	ExpiresAt time.Time
}

type PresignedGet struct {
	URL       string
	ExpiresAt time.Time
}

// ObjectListing is one page of keys.
type ObjectListing struct {
	Keys []ListedObject
	// NextToken is empty on the last page.
	NextToken string
}

type ListedObject struct {
	Key          string
	Size         int64
	LastModified time.Time
}

// DeleteObjectsLimit is the S3 batch-delete cap. Callers should size their
// batches to it so one round trip removes as much as possible.
const DeleteObjectsLimit = 1000

type Store interface {
	// Put writes r under a key derived from id and returns the storage path
	// and number of bytes written.
	Put(id string, r io.Reader) (path string, size int64, err error)
	// PutObjectOnce writes key with the given Content-Type and Cache-Control
	// in one attempt, without the SDK's retries, for writers that never retry
	// (thumbnail captures, uploads streamed through the gateway), and returns
	// the stored object's ETag.
	PutObjectOnce(ctx context.Context, key string, body io.ReadSeeker, contentType, cacheControl string) (etag string, err error)
	PresignGet(ctx context.Context, path string) (url string, err error)
	PresignGetWithExpiry(ctx context.Context, path string) (PresignedGet, error)
	// PresignStableGet signs a GET that is identical for every call within one
	// UTC hour and lasts StableLinkTTL from that hour, for list thumbnails the
	// browser should cache. It signs without checking that the object exists.
	PresignStableGet(ctx context.Context, path string) (string, error)
	// PresignPut signs an upload of path for a service that writes it (the
	// collaboration service's source refresh candidates).
	PresignPut(ctx context.Context, path, contentType string) (PresignedPut, error)
	Head(ctx context.Context, path string) (ObjectInfo, error)
	// Open streams an object's bytes; the caller closes the reader. Used to
	// hash a completed drive import once (B2's documented PutObject takes no
	// checksum header the bucket would verify).
	Open(ctx context.Context, path string) (io.ReadCloser, error)
	Promote(ctx context.Context, from, to string) error
	// Copy duplicates an object inside the bucket; no bytes pass through the
	// gateway.
	Copy(ctx context.Context, from, to string) error
	Delete(ctx context.Context, path string) error
	// DeleteObjects removes up to DeleteObjectsLimit keys in one request and
	// returns the keys the bucket refused. A per-key refusal is not an error:
	// the reaper has to distinguish "retry this one" from "the whole request
	// failed", or a single bad key would wedge the queue behind it.
	DeleteObjects(ctx context.Context, paths []string) (failed []string, err error)
	// ListObjects pages through the bucket under a prefix. Used by the orphan
	// sweep, which is the backstop for objects written without a database row.
	ListObjects(ctx context.Context, prefix, token string, limit int32) (ObjectListing, error)
}
