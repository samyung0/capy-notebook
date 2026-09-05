package blob

import (
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
)

func TestNewB2RequiresB2Configuration(t *testing.T) {
	if _, err := NewB2(B2Config{}); err == nil {
		t.Fatal("NewB2 accepted missing B2 configuration")
	}
}

func TestNewB2RejectsNonB2Endpoint(t *testing.T) {
	_, err := NewB2(B2Config{
		Endpoint: "https://s3.amazonaws.com",
		Region:   "us-east-1",
		Bucket:   "capy-notebook",
		KeyID:    "test-key-id",
		AppKey:   "test-app-key",
	})
	if err == nil {
		t.Fatal("NewB2 accepted a non-B2 endpoint")
	}
}

func TestNewB2BuildsB2Client(t *testing.T) {
	store, err := NewB2(B2Config{
		Endpoint: "https://s3.us-west-004.backblazeb2.com",
		Region:   "us-west-004",
		Bucket:   "capy-notebook",
		KeyID:    "test-key-id",
		AppKey:   "test-app-key",
	})
	if err != nil {
		t.Fatalf("NewB2: %v", err)
	}
	if store.bucket != "capy-notebook" {
		t.Errorf("bucket = %q, want %q", store.bucket, "capy-notebook")
	}
	if store.presignTTL != defaultPresignTTL {
		t.Errorf("presignTTL = %s, want %s", store.presignTTL, defaultPresignTTL)
	}
	if got := aws.ToString(store.client.Options().BaseEndpoint); got != "https://s3.us-west-004.backblazeb2.com" {
		t.Errorf("BaseEndpoint = %q", got)
	}
}

func TestReadPrefixRejectsNonPositiveLimit(t *testing.T) {
	store := &B2{}
	if _, err := store.ReadPrefix(t.Context(), "editor-assets/asset_1/blob_1.png", 0); err == nil {
		t.Fatal("ReadPrefix accepted a zero byte limit")
	}
}
