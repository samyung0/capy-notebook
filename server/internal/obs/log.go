package obs

import (
	"context"
	"log"
	"log/slog"
	"os"
	"strings"
)

// Init installs a process-wide structured logger and redirects the stdlib log
// package into it, so the existing log.Printf call sites keep working and land
// in the same stream with the same shape.
//
// Format defaults to JSON because the deployed services are read through
// `docker compose logs`, where grep-by-field is the only practical way to
// follow one request across seven containers. Development defaults to text.
func Init(service, appEnv string) {
	level := parseLevel(os.Getenv("LOG_LEVEL"))
	opts := &slog.HandlerOptions{Level: level}

	var handler slog.Handler
	if logFormat(appEnv) == "text" {
		handler = slog.NewTextHandler(os.Stderr, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stderr, opts)
	}
	handler = handler.WithAttrs([]slog.Attr{
		slog.String("service", service),
		slog.String("env", appEnv),
	})

	logger := slog.New(handler)
	slog.SetDefault(logger)

	// Existing call sites use the stdlib logger. Route them through slog so
	// nothing has to be rewritten to gain structure, and drop the stdlib's own
	// timestamp prefix since the handler emits one.
	log.SetFlags(0)
	log.SetOutput(stdlogWriter{logger})
}

func logFormat(appEnv string) string {
	if v := strings.ToLower(os.Getenv("LOG_FORMAT")); v != "" {
		return v
	}
	if appEnv == "development" {
		return "text"
	}
	return "json"
}

func parseLevel(v string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// stdlogWriter adapts log.Printf output into slog at info level.
type stdlogWriter struct{ logger *slog.Logger }

func (w stdlogWriter) Write(p []byte) (int, error) {
	w.logger.Info(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// Log returns a logger carrying whatever request identity the context holds.
// Use it instead of the package-level slog functions anywhere a context is in
// scope, so the line can be correlated with the trace and the usage ledger.
func Log(ctx context.Context) *slog.Logger {
	logger := slog.Default()
	if traceID := TraceID(ctx); traceID != "" {
		logger = logger.With(slog.String("trace_id", traceID))
	}
	if userID := UserID(ctx); userID != "" {
		logger = logger.With(slog.String("user_id", userID))
	}
	if component := Component(ctx); component != "" {
		logger = logger.With(slog.String("component", component))
	}
	return logger
}
