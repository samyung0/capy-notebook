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
	PresignGet(ctx context.Context, path string) (url string, err error)
	PresignGetWithExpiry(ctx context.Context, path string) (PresignedGet, error)
	PresignPut(ctx context.Context, path, contentType string) (PresignedPut, error)
	Head(ctx context.Context, path string) (ObjectInfo, error)
	// ReadPrefix returns at most maxBytes from the beginning of an object.
	// It is intended for bounded post-upload signature inspection.
	ReadPrefix(ctx context.Context, path string, maxBytes int64) ([]byte, error)
	Promote(ctx context.Context, from, to string) error
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
