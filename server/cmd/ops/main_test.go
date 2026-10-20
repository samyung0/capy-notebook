package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Security regression (human deployment-runbook 2026-10-20): Ops refuses to
// start with APP_ENV unset or empty, so OPS_UNSAFE_DEVELOPMENT never unlocks
// from a missing value.
func TestStartupRefusesAMissingAppEnv(t *testing.T) {
	if os.Getenv("CAPY_TEST_OPS_MAIN") == "1" {
		main()
		return
	}
	for _, appEnv := range []string{"unset", "empty"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStartupRefusesAMissingAppEnv$")
		// The unsafe switches are on, so only APP_ENV stands between this
		// start and a development unlock.
		cmd.Env = []string{
			"CAPY_TEST_OPS_MAIN=1", "PATH=" + os.Getenv("PATH"), "SYSTEMROOT=" + os.Getenv("SYSTEMROOT"),
			"OPS_UNSAFE_DEVELOPMENT=true", "OPS_ACCESS_DISABLED=true", "OPS_AUTH_DISABLED=true",
		}
		if appEnv == "empty" {
			cmd.Env = append(cmd.Env, "APP_ENV=")
		}
		out, err := cmd.CombinedOutput()
		cancel()
		var exit *exec.ExitError
		if !errors.As(err, &exit) || !strings.Contains(string(out), "APP_ENV must be set") {
			t.Fatalf("APP_ENV %s: err = %v, output: %s", appEnv, err, out)
		}
	}
}
