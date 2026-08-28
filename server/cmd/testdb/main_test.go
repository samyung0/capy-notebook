package main

import (
	"slices"
	"strings"
	"testing"
)

func TestPostgresURLUsesMappedLoopbackPort(t *testing.T) {
	got := postgresURL("49152")
	if got != "postgres://evo:evo@127.0.0.1:49152/evo?sslmode=disable" {
		t.Fatalf("postgresURL() = %q", got)
	}
}

func TestTestEnvironmentOwnsDatabaseConfiguration(t *testing.T) {
	got := testEnvironment([]string{
		"PATH=/bin",
		"DATABASE_URL=postgres://existing",
		"EVO_GO_DISPOSABLE_DATABASE=old",
	}, "postgres://disposable")
	if !slices.Contains(got, "PATH=/bin") ||
		!slices.Contains(got, "DATABASE_URL=postgres://disposable") ||
		!slices.Contains(got, "EVO_GO_DISPOSABLE_DATABASE=1") {
		t.Fatalf("testEnvironment() = %#v", got)
	}
	for _, item := range got {
		if strings.HasPrefix(item, "DATABASE_URL=postgres://existing") {
			t.Fatalf("existing database configuration leaked: %q", item)
		}
	}
}
