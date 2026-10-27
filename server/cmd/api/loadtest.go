//go:build loadtest

package main

import (
	"log"
	"net/http"
	_ "net/http/pprof"
	"os"

	clerk "github.com/clerk/clerk-sdk-go/v2"
)

// A loadtest build (bench/gateway) sends the Clerk SDK to the load generator,
// which signs its users' session tokens and serves their JWKS and profiles, so
// every request pays for the token check and account read production does. It
// also keeps the rate limiter on under APP_ENV=e2e and serves Go's profiles
// on :6060, inside the bench network only. Deployed images never set the tag.
const loadTest = true

func init() {
	url := os.Getenv("LOADTEST_CLERK_API_URL")
	if url == "" {
		log.Fatal("a loadtest build requires LOADTEST_CLERK_API_URL")
	}
	clerk.SetBackend(clerk.NewBackend(&clerk.BackendConfig{URL: clerk.String(url)}))
	go func() { log.Print(http.ListenAndServe(":6060", nil)) }()
}
