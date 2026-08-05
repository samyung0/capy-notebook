// B2 uses its S3-compatible API. Stored paths are object keys, never local
// filesystem paths.
package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const defaultPresignTTL = 15 * time.Minute

// B2Config contains the B2 S3 endpoint and application-key credentials.
type B2Config struct {
	Endpoint     string
	Region       string
	Bucket       string
	KeyID        string
	AppKey       string
	UsePathStyle bool          // B2 supports virtual-hosted and path-style endpoints.
	PresignTTL   time.Duration // 0 → defaultPresignTTL.
}

type B2 struct {
	client     *s3.Client
	tm         *transfermanager.Client
	presign    *s3.PresignClient
	bucket     string
	presignTTL time.Duration
}

func NewB2(cfg B2Config) (*B2, error) {
	if cfg.Bucket == "" || cfg.KeyID == "" || cfg.AppKey == "" {
		return nil, errors.New("blob: B2 needs B2_BUCKET, B2_KEY_ID and B2_APP_KEY")
	}
	endpoint, err := url.Parse(cfg.Endpoint)
	if err != nil || endpoint.Scheme != "https" || !strings.HasSuffix(endpoint.Hostname(), ".backblazeb2.com") {
		return nil, errors.New("blob: B2_ENDPOINT must be an https://*.backblazeb2.com S3 endpoint")
	}
	if cfg.Region == "" {
		return nil, errors.New("blob: B2 needs B2_REGION")
	}
	opts := s3.Options{
		Region:       cfg.Region,
		Credentials:  credentials.NewStaticCredentialsProvider(cfg.KeyID, cfg.AppKey, ""),
		UsePathStyle: cfg.UsePathStyle,
	}
	if cfg.Endpoint != "" {
		opts.BaseEndpoint = aws.String(cfg.Endpoint)
	}
	ttl := cfg.PresignTTL
	if ttl <= 0 {
		ttl = defaultPresignTTL
	}
	client := s3.New(opts)
	return &B2{
		client:     client,
		tm:         transfermanager.New(client),
		presign:    s3.NewPresignClient(client),
		bucket:     cfg.Bucket,
		presignTTL: ttl,
	}, nil
}

// countingReader tracks bytes streamed to the uploader so Put can report size
// without buffering the whole object in memory.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func (s *B2) Put(id string, r io.Reader) (string, int64, error) {
	cr := &countingReader{r: r}
	_, err := s.tm.UploadObject(context.Background(), &transfermanager.UploadObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(id),
		Body:   cr,
	})
	if err != nil {
		return "", 0, err
	}
	return id, cr.n, nil
}

// PresignGet mints a time-limited GET URL so the gateway can redirect the
// browser straight to the bucket instead of streaming bytes through itself.
func (s *B2) PresignGet(ctx context.Context, path string) (string, error) {
	req, err := s.PresignGetWithExpiry(ctx, path)
	return req.URL, err
}

func (s *B2) PresignGetWithExpiry(ctx context.Context, path string) (PresignedGet, error) {
	req, err := s.presign.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(path),
	}, s3.WithPresignExpires(s.presignTTL))
	if err != nil {
		return PresignedGet{}, err
	}
	return PresignedGet{URL: req.URL, ExpiresAt: time.Now().UTC().Add(s.presignTTL)}, nil
}

func (s *B2) PresignPut(ctx context.Context, path, contentType string) (PresignedPut, error) {
	expiresAt := time.Now().UTC().Add(s.presignTTL)
	in := &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(path),
		ContentType: aws.String(contentType),
	}
	req, err := s.presign.PresignPutObject(ctx, in, s3.WithPresignExpires(s.presignTTL))
	if err != nil {
		return PresignedPut{}, err
	}
	headers := map[string]string{"Content-Type": contentType}
	return PresignedPut{URL: req.URL, Headers: headers, ExpiresAt: expiresAt}, nil
}

func (s *B2) Head(ctx context.Context, path string) (ObjectInfo, error) {
	out, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(path),
	})
	if err != nil {
		return ObjectInfo{}, err
	}
	return ObjectInfo{
		Size:        aws.ToInt64(out.ContentLength),
		ContentType: aws.ToString(out.ContentType),
		ETag:        strings.Trim(aws.ToString(out.ETag), `"`),
	}, nil
}

func (s *B2) ReadPrefix(ctx context.Context, path string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, errors.New("blob: prefix size must be positive")
	}
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(path),
		Range:  aws.String("bytes=0-" + strconv.FormatInt(maxBytes-1, 10)),
	})
	if err != nil {
		return nil, err
	}
	defer out.Body.Close()
	data, err := io.ReadAll(io.LimitReader(out.Body, maxBytes))
	if err != nil {
		return nil, err
	}
	return data, nil
}

// Promote copies an upload from the short-lived incoming prefix to its stable
// source key, then removes the incoming object. Copying is performed inside B2;
// no object bytes pass through the gateway.
func (s *B2) Promote(ctx context.Context, from, to string) error {
	if from == to {
		return nil
	}
	_, err := s.client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     aws.String(s.bucket),
		Key:        aws.String(to),
		CopySource: aws.String(url.PathEscape(s.bucket + "/" + from)),
	})
	if err != nil {
		return err
	}
	return s.Delete(ctx, from)
}

func (s *B2) Delete(ctx context.Context, path string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(path),
	})
	return err
}

func (s *B2) DeleteObjects(ctx context.Context, paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	if len(paths) > DeleteObjectsLimit {
		return nil, fmt.Errorf("blob: %d keys exceeds the batch limit of %d",
			len(paths), DeleteObjectsLimit)
	}
	ids := make([]s3types.ObjectIdentifier, 0, len(paths))
	for _, path := range paths {
		ids = append(ids, s3types.ObjectIdentifier{Key: aws.String(path)})
	}
	out, err := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String(s.bucket),
		// Quiet mode returns only the failures, which is all the reaper needs.
		Delete: &s3types.Delete{Objects: ids, Quiet: aws.Bool(true)},
	})
	if err != nil {
		return nil, err
	}
	var failed []string
	for _, e := range out.Errors {
		if e.Key != nil {
			failed = append(failed, *e.Key)
		}
	}
	return failed, nil
}

func (s *B2) ListObjects(
	ctx context.Context,
	prefix, token string,
	limit int32,
) (ObjectListing, error) {
	in := &s3.ListObjectsV2Input{Bucket: aws.String(s.bucket)}
	if prefix != "" {
		in.Prefix = aws.String(prefix)
	}
	if token != "" {
		in.ContinuationToken = aws.String(token)
	}
	if limit > 0 {
		in.MaxKeys = aws.Int32(limit)
	}
	out, err := s.client.ListObjectsV2(ctx, in)
	if err != nil {
		return ObjectListing{}, err
	}
	listing := ObjectListing{Keys: make([]ListedObject, 0, len(out.Contents))}
	for _, obj := range out.Contents {
		if obj.Key == nil {
			continue
		}
		item := ListedObject{Key: *obj.Key}
		if obj.Size != nil {
			item.Size = *obj.Size
		}
		if obj.LastModified != nil {
			item.LastModified = *obj.LastModified
		}
		listing.Keys = append(listing.Keys, item)
	}
	if aws.ToBool(out.IsTruncated) && out.NextContinuationToken != nil {
		listing.NextToken = *out.NextContinuationToken
	}
	return listing, nil
}

// HealthCheck verifies the bucket exists and the credentials can reach it.
func (s *B2) HealthCheck(ctx context.Context) error {
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)})
	return err
}
