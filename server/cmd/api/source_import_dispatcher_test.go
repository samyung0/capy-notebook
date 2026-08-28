package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSourceImportDispatchBackoffCaps(t *testing.T) {
	cases := []struct {
		attempts int
		want     time.Duration
	}{
		{attempts: 0, want: 10 * time.Second},
		{attempts: 3, want: 80 * time.Second},
		{attempts: 20, want: 5 * time.Minute},
	}
	for _, tc := range cases {
		if got := sourceImportDispatchBackoff(tc.attempts); got != tc.want {
			t.Fatalf("attempts=%d got=%s want=%s", tc.attempts, got, tc.want)
		}
	}
}

func TestSourceImportDispatchStatusRetryable(t *testing.T) {
	for _, status := range []int{
		http.StatusRequestTimeout,
		http.StatusConflict,
		http.StatusTooManyRequests,
		http.StatusInternalServerError,
	} {
		if !sourceImportDispatchStatusRetryable(status) {
			t.Fatalf("status %d should retry", status)
		}
	}
	for _, status := range []int{
		http.StatusBadRequest,
		http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusNotFound,
	} {
		if sourceImportDispatchStatusRetryable(status) {
			t.Fatalf("status %d should fail terminally", status)
		}
	}
}

func TestSourceImportDispatchClientDoesNotFollowRedirects(t *testing.T) {
	followed := false
	dest := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		followed = true
	}))
	t.Cleanup(dest.Close)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, dest.URL+"/enqueue", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(origin.Close)

	req, err := http.NewRequest(http.MethodPost, origin.URL+"/enqueue", bytes.NewReader([]byte(`{}`)))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := sourceImportDispatchHTTPClient().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if followed {
		t.Fatal("dispatcher followed a redirect")
	}
}
