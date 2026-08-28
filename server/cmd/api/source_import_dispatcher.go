package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/evonotes/server/internal/relayauth"
	"github.com/evonotes/server/internal/store"
)

const sourceImportDispatchMaxAttempts = 12

func sourceImportDispatchBackoff(attempts int) time.Duration {
	delay := 10 * time.Second
	for range min(attempts, 5) {
		delay *= 2
	}
	return min(delay, 5*time.Minute)
}

func sourceImportDispatchStatusRetryable(status int) bool {
	return status == http.StatusRequestTimeout ||
		status == http.StatusConflict ||
		status == http.StatusTooEarly ||
		status == http.StatusTooManyRequests ||
		status >= http.StatusInternalServerError
}

func sourceImportDispatchHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func runSourceImportDispatcher(
	ctx context.Context,
	st *store.Store,
	enqueueURL, secret string,
) {
	client := sourceImportDispatchHTTPClient()
	dispatch := func() {
		ids, err := st.PendingSourceImportDispatches(ctx, 20)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("source import dispatch list: %v", err)
			}
			return
		}
		for _, item := range ids {
			id := item.JobID
			body, _ := json.Marshal(map[string]string{"jobId": id})
			req, err := http.NewRequestWithContext(
				ctx, http.MethodPost, enqueueURL, bytes.NewReader(body),
			)
			status := 0
			retryAfter := time.Duration(0)
			if err == nil {
				timestamp := strconv.FormatInt(time.Now().UTC().Unix(), 10)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set(relayauth.HeaderTimestamp, timestamp)
				req.Header.Set(
					relayauth.HeaderSignature,
					relayauth.Sign(
						secret,
						timestamp,
						req.Method,
						req.URL.RequestURI(),
						body,
					),
				)
				var resp *http.Response
				resp, err = client.Do(req)
				if err == nil {
					status = resp.StatusCode
					_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
					_ = resp.Body.Close()
					if resp.StatusCode < 200 || resp.StatusCode >= 300 {
						err = fmt.Errorf("enqueue status %d", resp.StatusCode)
						if seconds, parseErr := strconv.Atoi(
							resp.Header.Get("Retry-After"),
						); parseErr == nil && seconds > 0 {
							retryAfter = time.Duration(seconds) * time.Second
						}
					}
				}
			}
			if err != nil {
				attempts := item.Attempts + 1
				permanent := status >= 400 && status < 500 &&
					!sourceImportDispatchStatusRetryable(status)
				if permanent || attempts >= sourceImportDispatchMaxAttempts {
					code := "queue_dispatch_exhausted"
					if permanent {
						code = "queue_dispatch_rejected"
					}
					if failErr := st.DeadLetterSourceImport(
						ctx, id, code, "source import queue dispatch failed",
					); failErr != nil && ctx.Err() == nil {
						log.Printf("source import dispatch terminal job=%s: %v", id, failErr)
					} else if ctx.Err() == nil {
						log.Printf(
							"source import dispatch terminal job=%s status=%d code=%s",
							id, status, code,
						)
					}
					continue
				}
				delay := sourceImportDispatchBackoff(item.Attempts)
				if retryAfter > delay {
					delay = min(retryAfter, 15*time.Minute)
				}
				if markErr := st.MarkSourceImportDispatchFailed(
					ctx, id, delay, err.Error(),
				); markErr != nil && ctx.Err() == nil {
					log.Printf("source import dispatch retry job=%s: %v", id, markErr)
				}
				continue
			}
			if err := st.MarkSourceImportEnqueued(ctx, id); err != nil &&
				ctx.Err() == nil {
				log.Printf("source import mark enqueued job=%s: %v", id, err)
			}
		}
	}

	dispatch()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			dispatch()
		case <-ctx.Done():
			return
		}
	}
}
