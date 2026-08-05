package blob

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Memory is an in-process store for sharing E2E tests. Its presigned URLs are
// intentionally unusable outside those tests; upload/download flows require B2.
type Memory struct {
	mu      sync.RWMutex
	objects map[string]memoryObject
	ttl     time.Duration
}

type memoryObject struct {
	data        []byte
	contentType string
	etag        string
}

// NewMemory returns a ready-to-use in-memory blob store.
func NewMemory() *Memory {
	return &Memory{objects: map[string]memoryObject{}, ttl: defaultPresignTTL}
}

func (s *Memory) Put(id string, r io.Reader) (string, int64, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return "", 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[id] = memoryObject{data: data, contentType: "application/octet-stream", etag: "mem"}
	return id, int64(len(data)), nil
}

func (s *Memory) PresignGet(_ context.Context, path string) (string, error) {
	req, err := s.PresignGetWithExpiry(context.Background(), path)
	return req.URL, err
}

func (s *Memory) PresignGetWithExpiry(_ context.Context, path string) (PresignedGet, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.objects[path]; !ok {
		return PresignedGet{}, errors.New("blob: object not found")
	}
	return PresignedGet{
		URL:       "memory://" + path,
		ExpiresAt: time.Now().UTC().Add(s.ttl),
	}, nil
}

func (s *Memory) PresignPut(_ context.Context, path, contentType string) (PresignedPut, error) {
	return PresignedPut{
		URL:       "memory-put://" + path,
		Headers:   map[string]string{"Content-Type": contentType},
		ExpiresAt: time.Now().UTC().Add(s.ttl),
	}, nil
}

func (s *Memory) Head(_ context.Context, path string) (ObjectInfo, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	obj, ok := s.objects[path]
	if !ok {
		return ObjectInfo{}, errors.New("blob: object not found")
	}
	return ObjectInfo{Size: int64(len(obj.data)), ContentType: obj.contentType, ETag: obj.etag}, nil
}

func (s *Memory) ReadPrefix(_ context.Context, path string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, errors.New("blob: prefix size must be positive")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	obj, ok := s.objects[path]
	if !ok {
		return nil, errors.New("blob: object not found")
	}
	if int64(len(obj.data)) > maxBytes {
		return append([]byte(nil), obj.data[:maxBytes]...), nil
	}
	return append([]byte(nil), obj.data...), nil
}

func (s *Memory) Promote(_ context.Context, from, to string) error {
	if from == to {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	obj, ok := s.objects[from]
	if !ok {
		return errors.New("blob: object not found")
	}
	s.objects[to] = obj
	delete(s.objects, from)
	return nil
}

func (s *Memory) Delete(_ context.Context, path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, path)
	return nil
}

func (s *Memory) DeleteObjects(_ context.Context, paths []string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, path := range paths {
		delete(s.objects, path)
	}
	return nil, nil
}

func (s *Memory) ListObjects(
	_ context.Context,
	prefix, token string,
	limit int32,
) (ObjectListing, error) {
	s.mu.RLock()
	keys := make([]string, 0, len(s.objects))
	for key := range s.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	s.mu.RUnlock()
	// The token is the last key of the previous page, matching S3's ordering
	// guarantee closely enough for the sweep to be testable.
	sort.Strings(keys)
	return pageObjectKeys(keys, token, limit, func(key string) ListedObject {
		s.mu.RLock()
		defer s.mu.RUnlock()
		return ListedObject{Key: key, Size: int64(len(s.objects[key].data))}
	}), nil
}

// pageObjectKeys turns a sorted key slice into one listing page, using the last
// key emitted as the continuation token.
func pageObjectKeys(
	keys []string,
	token string,
	limit int32,
	describe func(string) ListedObject,
) ObjectListing {
	if token != "" {
		start := sort.SearchStrings(keys, token)
		for start < len(keys) && keys[start] <= token {
			start++
		}
		keys = keys[start:]
	}
	if limit <= 0 {
		limit = DeleteObjectsLimit
	}
	listing := ObjectListing{}
	if int32(len(keys)) > limit {
		listing.NextToken = keys[limit-1]
		keys = keys[:limit]
	}
	listing.Keys = make([]ListedObject, 0, len(keys))
	for _, key := range keys {
		listing.Keys = append(listing.Keys, describe(key))
	}
	return listing
}

// Disk is a filesystem-backed store for E2E tests that do not exercise
// presigned upload/download URLs.
type Disk struct {
	root string
	ttl  time.Duration
}

func NewDisk(root string) (*Disk, error) {
	if root == "" {
		return nil, errors.New("blob: disk root is required")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	return &Disk{root: root, ttl: defaultPresignTTL}, nil
}

func (s *Disk) resolve(path string) (string, error) {
	clean := filepath.Clean("/" + strings.ReplaceAll(path, "\\", "/"))
	full := filepath.Join(s.root, clean)
	if !strings.HasPrefix(full, filepath.Clean(s.root)+string(os.PathSeparator)) && full != filepath.Clean(s.root) {
		return "", errors.New("blob: path escapes root")
	}
	return full, nil
}

func (s *Disk) Put(id string, r io.Reader) (string, int64, error) {
	full, err := s.resolve(id)
	if err != nil {
		return "", 0, err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return "", 0, err
	}
	f, err := os.Create(full)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	n, err := io.Copy(f, r)
	if err != nil {
		return "", 0, err
	}
	return id, n, nil
}

func (s *Disk) PresignGet(ctx context.Context, path string) (string, error) {
	req, err := s.PresignGetWithExpiry(ctx, path)
	return req.URL, err
}

func (s *Disk) PresignGetWithExpiry(_ context.Context, path string) (PresignedGet, error) {
	full, err := s.resolve(path)
	if err != nil {
		return PresignedGet{}, err
	}
	if _, err := os.Stat(full); err != nil {
		return PresignedGet{}, err
	}
	return PresignedGet{URL: "file://" + full, ExpiresAt: time.Now().UTC().Add(s.ttl)}, nil
}

func (s *Disk) PresignPut(_ context.Context, path, contentType string) (PresignedPut, error) {
	return PresignedPut{
		URL:       "file-put://" + path,
		Headers:   map[string]string{"Content-Type": contentType},
		ExpiresAt: time.Now().UTC().Add(s.ttl),
	}, nil
}

func (s *Disk) Head(_ context.Context, path string) (ObjectInfo, error) {
	full, err := s.resolve(path)
	if err != nil {
		return ObjectInfo{}, err
	}
	info, err := os.Stat(full)
	if err != nil {
		return ObjectInfo{}, err
	}
	return ObjectInfo{Size: info.Size(), ContentType: "application/octet-stream", ETag: "disk"}, nil
}

func (s *Disk) ReadPrefix(_ context.Context, path string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, errors.New("blob: prefix size must be positive")
	}
	full, err := s.resolve(path)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(full)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, maxBytes))
}

func (s *Disk) Promote(_ context.Context, from, to string) error {
	if from == to {
		return nil
	}
	src, err := s.resolve(from)
	if err != nil {
		return err
	}
	dst, err := s.resolve(to)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		data, readErr := os.ReadFile(src)
		if readErr != nil {
			return err
		}
		if writeErr := os.WriteFile(dst, data, 0o644); writeErr != nil {
			return writeErr
		}
		_ = os.Remove(src)
	}
	return nil
}

func (s *Disk) Delete(_ context.Context, path string) error {
	full, err := s.resolve(path)
	if err != nil {
		return err
	}
	err = os.Remove(full)
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}

func (s *Disk) DeleteObjects(ctx context.Context, paths []string) ([]string, error) {
	var failed []string
	for _, path := range paths {
		if err := s.Delete(ctx, path); err != nil {
			failed = append(failed, path)
		}
	}
	return failed, nil
}

func (s *Disk) ListObjects(
	_ context.Context,
	prefix, token string,
	limit int32,
) (ObjectListing, error) {
	root := filepath.Clean(s.root)
	var keys []string
	sizes := map[string]int64{}
	modTimes := map[string]time.Time{}
	err := filepath.WalkDir(root, func(full string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(root, full)
		if relErr != nil {
			return relErr
		}
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		keys = append(keys, key)
		sizes[key] = info.Size()
		modTimes[key] = info.ModTime()
		return nil
	})
	if err != nil {
		return ObjectListing{}, err
	}
	sort.Strings(keys)
	return pageObjectKeys(keys, token, limit, func(key string) ListedObject {
		return ListedObject{Key: key, Size: sizes[key], LastModified: modTimes[key]}
	}), nil
}
