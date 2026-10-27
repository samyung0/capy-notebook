//go:build !loadtest

package main

// loadTest is true only in the bench/gateway build (loadtest.go).
const loadTest = false
