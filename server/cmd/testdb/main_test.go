package main

import (
	"slices"
	"strings"
	"testing"
)

func TestPostgresURLUsesMappedLoopbackPort(t *testing.T) {
	got := postgresURL("49152")
	if got != "postgres://capy:capy@127.0.0.1:49152/capy?sslmode=disable" {
		t.Fatalf("postgresURL() = %q", got)
	}
}

func TestTestEnvironmentOwnsDatabaseConfiguration(t *testing.T) {
	got := testEnvironment([]string{
		"PATH=/bin",
		"DATABASE_URL=postgres://existing",
		"CAPY_GO_DISPOSABLE_DATABASE=old",
		"CAPY_GO_TEST_CONTAINER=unrelated",
	}, "postgres://disposable", "capy-go-test-0123456789")
	if !slices.Contains(got, "PATH=/bin") ||
		!slices.Contains(got, "DATABASE_URL=postgres://disposable") ||
		!slices.Contains(got, "CAPY_GO_DISPOSABLE_DATABASE=1") ||
		!slices.Contains(got, "CAPY_GO_TEST_CONTAINER=capy-go-test-0123456789") ||
		slices.Contains(got, "CAPY_GO_TEST_CONTAINER=unrelated") {
		t.Fatalf("testEnvironment() = %#v", got)
	}
	for _, item := range got {
		if strings.HasPrefix(item, "DATABASE_URL=postgres://existing") {
			t.Fatalf("existing database configuration leaked: %q", item)
		}
	}
}
