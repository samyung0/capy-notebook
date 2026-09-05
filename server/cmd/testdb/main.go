// Command testdb runs the Go suite against one disposable pgvector container.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

const (
	postgresImage = "pgvector/pgvector:pg16"
	testDBMarker  = "CAPY_GO_DISPOSABLE_DATABASE"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		log.Fatal(err)
	}
}

func run(ctx context.Context, testArgs []string) error {
	if _, err := exec.LookPath("docker"); err != nil {
		return fmt.Errorf("Docker is required to run Go tests: %w", err)
	}
	repositoryRoot, err := findRepositoryRoot()
	if err != nil {
		return err
	}
	name, err := containerName()
	if err != nil {
		return err
	}
	log.Printf("starting disposable Postgres %s", name)
	if output, err := docker(ctx,
		"run", "--detach", "--rm", "--name", name,
		"--env", "POSTGRES_DB=capy",
		"--env", "POSTGRES_USER=capy",
		"--env", "POSTGRES_PASSWORD=capy",
		"--publish", "127.0.0.1::5432",
		postgresImage,
	); err != nil {
		return fmt.Errorf("start Postgres: %w\n%s", err, output)
	}
	defer removeContainer(name)

	port, err := mappedPort(ctx, name)
	if err != nil {
		return err
	}
	dsn := postgresURL(port)
	if err := awaitPostgres(ctx, dsn, 2*time.Minute); err != nil {
		return err
	}
	if err := prepareDatabase(ctx, dsn, repositoryRoot); err != nil {
		return err
	}

	if len(testArgs) > 0 && testArgs[0] == "--" {
		testArgs = testArgs[1:]
	}
	goArgs := []string{"test", "-count=1", "-p", "1"}
	if len(testArgs) == 0 {
		goArgs = append(goArgs, "./...")
	} else {
		goArgs = append(goArgs, testArgs...)
	}
	command := exec.CommandContext(ctx, "go", goArgs...)
	command.Dir = filepath.Join(repositoryRoot, "server")
	command.Env = testEnvironment(os.Environ(), dsn, name)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	log.Printf("running go %s", strings.Join(goArgs, " "))
	return command.Run()
}

func containerName() (string, error) {
	random := make([]byte, 5)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("create container name: %w", err)
	}
	return "capy-go-test-" + hex.EncodeToString(random), nil
}

func docker(ctx context.Context, args ...string) (string, error) {
	output, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

func removeContainer(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if output, err := docker(ctx, "rm", "--force", name); err != nil && !strings.Contains(output, "No such container") {
		log.Printf("remove disposable Postgres: %v: %s", err, output)
	}
}

func mappedPort(ctx context.Context, name string) (string, error) {
	output, err := docker(ctx, "port", name, "5432/tcp")
	if err != nil {
		return "", fmt.Errorf("read Postgres port: %w: %s", err, output)
	}
	line := strings.Split(output, "\n")[0]
	_, port, err := net.SplitHostPort(strings.TrimSpace(line))
	if err != nil {
		return "", fmt.Errorf("parse Docker port %q: %w", line, err)
	}
	return port, nil
}

func postgresURL(port string) string {
	address := &url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword("capy", "capy"),
		Host:     net.JoinHostPort("127.0.0.1", port),
		Path:     "/capy",
		RawQuery: "sslmode=disable",
	}
	return address.String()
}

func awaitPostgres(ctx context.Context, dsn string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		store, err := store.Open(ctx, dsn)
		if err == nil {
			err = store.Pool().Ping(ctx)
			store.Close()
		}
		if err == nil {
			return nil
		}
		last = err
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("Postgres was not ready after %s: %w", timeout, last)
}

func prepareDatabase(ctx context.Context, dsn, repositoryRoot string) error {
	store, err := store.Open(ctx, dsn)
	if err != nil {
		return fmt.Errorf("open disposable Postgres: %w", err)
	}
	defer store.Close()
	if err := store.Migrate(ctx); err != nil {
		return err
	}
	if err := store.ApplyDevSeed(ctx); err != nil {
		return err
	}
	fixturePath := filepath.Join(repositoryRoot, "e2e", "fixtures", "seed.sql")
	fixture, err := os.ReadFile(fixturePath)
	if err != nil {
		return fmt.Errorf("read E2E seed: %w", err)
	}
	if _, err := store.Pool().Exec(ctx, string(fixture)); err != nil {
		return fmt.Errorf("apply E2E seed: %w", err)
	}
	return nil
}

func findRepositoryRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		serverModule := filepath.Join(dir, "server", "go.mod")
		seed := filepath.Join(dir, "e2e", "fixtures", "seed.sql")
		if fileExists(serverModule) && fileExists(seed) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("repository root not found from %s", dir)
		}
		dir = parent
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func testEnvironment(base []string, dsn, container string) []string {
	blocked := map[string]struct{}{
		"DATABASE_URL":           {},
		testDBMarker:             {},
		"CAPY_GO_TEST_CONTAINER": {},
	}
	out := make([]string, 0, len(base)+2)
	for _, item := range base {
		key, _, _ := strings.Cut(item, "=")
		if _, drop := blocked[key]; !drop {
			out = append(out, item)
		}
	}
	return append(out, "DATABASE_URL="+dsn, testDBMarker+"=1", "CAPY_GO_TEST_CONTAINER="+container)
}
